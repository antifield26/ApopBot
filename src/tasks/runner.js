// @ts-check
// 脚本任务执行器：BaseTask 状态机外壳 + 脚本 DSL 解释器。
//
// 脚本化重构的核心理念：任务 = 动作原语脚本，与 LLM 的 act 动作数组共用同一
// 执行层（executor/executor.js）。BaseTask 的全部语义（暂停/恢复/取消/代际/
// stop 10s 上限/终态重启/计数器）原样继承，只把 run() 的内容从手写 JS 循环
// 换成脚本解释。
//
// 脚本定义（src/tasks/scripts/*.js，导出 { id, exclusive, naturalCompletion,
// maxActions, script }）：
//   script.steps 为步骤数组：
//     动作步 { op, args, as?, count? }          —— 原语动作（executor 执行）
//     ctrl 步 { ctrl, ... }：loop{max,body} / break / if{cond,then,else} /
//                            wait{ms} / count{name,by} / return{value}
//   cond 六型：last{ok} / result{ref,field,gte|equals} / counter{name,gte} /
//              config{key,equals} / deadline{passed} / not{cond}
//   args 模板：'$name'/'$name.field' 结果引用（前序 as 步）、'${key}' 任务
//              options 引用、{expr:'${a} * 1000'} 白名单四则表达式
//
// 超界兜底：有状态算法（explore 螺旋）用"任务局部 op"（scriptDef.ops）——
// 经同一 executor 执行（权限/守卫/审计一致），closure 状态随任务实例存活。

import { BaseTask } from './base.js'
import { createActionExecutor } from '../core/executor.js'
import { stopPathfinding } from '../core/movement.js'

/** 脚本 return 信号（值 'completed' 或任意）。 */
class ScriptReturn { constructor (value) { this.value = value } }
/** 脚本 break 信号（跳出当前 loop）。 */
class ScriptBreak {}
/** 脚本 continue 信号（跳到当前 loop 下一轮——farm 收获后跳过种植/等待语义）。 */
class ScriptContinue {}

export class ScriptTask extends BaseTask {
  /**
   * @param {string} id
   * @param {string} type
   * @param {object} options
   * @param {{ bot, logger, config, getConfig }} ctx
   * @param {{ exclusive?: boolean, script?: { steps: Array<object> }, init?: Function, maxActions?: number, defaultOptions?: object, ops?: object }} scriptDef 脚本定义（scripts/*.js 默认导出）
   */
  constructor (id, type, options, ctx, scriptDef) {
    super(id, type, options, ctx)
    this.scriptDef = scriptDef
    this.exclusive = scriptDef.exclusive === true
    this._abort = new AbortController()
  }

  async init () {
    super.init()
    // 校验脚本结构（防配置错误静默空转）
    if (!this.scriptDef?.script?.steps || !Array.isArray(this.scriptDef.script.steps)) {
      throw new Error(`任务类型 ${this.type} 脚本定义缺失 steps`)
    }
    // 脚本级 init 钩子（options 语义/插件依赖/未知方块类型等校验在脚本定义里
    // 显式声明）
    if (typeof this.scriptDef.init === 'function') {
      await this.scriptDef.init(this)
    }
  }

  async run (gen) {
    await super.run()
    const runner = new ScriptRunner(this, gen)
    await runner.execute()
  }

  /** 取消进行中的动作（stop 时基类调用）：abort 贯通 executor 的 signal + 插件清理。 */
  async _cancel () {
    this._abort.abort()
    try { this.bot.collectBlock?.cancelTask() } catch { /* 插件可能已卸载 */ }
    stopPathfinding(this.bot)
  }

  /** 终态重启时重建 _abort：stop 已 abort 旧控制器，不复建则重启后 signal.aborted
   *  恒真 → executor 每个动作步立即软失败（'动作被中断'）→ scheduled 任务第二次
   *  及以后触发全部僵尸（永不做事、永不自然完成）。 */
  _reset () {
    super._reset()
    this._abort = new AbortController()
  }
}

/**
 * 脚本解释器（每任务实例一个）。
 */
export class ScriptRunner {
  /**
   * @param {ScriptTask} task
   * @param {number} gen BaseTask 代际（_alive 检查）
   */
  constructor (task, gen) {
    this.task = task
    this.gen = gen
    this.results = new Map() // as 名 → 动作结果 entry
    this.lastResult = null // 上个动作结果（$last）
    this.actionCount = 0 // 动作步计数（maxActions 死循环兜底）
    // 任务局部 op（scriptDef.ops）合并进执行器原语表
    const taskCtx = {
      bot: task.bot,
      cfg: task.ctx.getConfig?.() ?? task.ctx.config ?? {},
      logger: task.ctx.logger,
      // 脚本不调 start_task/observe_status 等需 tasks/conn 的原语——防御性占位
      tasks: null,
      conn: { getStatus: () => ({ state: 'connected' }) },
      plugins: null
    }
    this.executor = createActionExecutor(taskCtx)
    for (const [name, def] of Object.entries(task.scriptDef.ops ?? {})) {
      // ops 值支持函数（简写）或 { handler, timeoutMs }——timeoutMs 必须 ≥ 内部
      // 动作最坏时长（explore spiral_step 内层 gotoPoint 45s——外层 30s 先触发会
      // 造成"超时报失败但 handler 仍在走"的幽灵移动 + setGoal 竞态连坑下一站）
      const handler = typeof def === 'function' ? def : def.handler
      const timeoutMs = typeof def === 'function' ? 30000 : (def.timeoutMs ?? 30000)
      this.executor.primitives.set(name, {
        description: `任务局部原语 ${name}`,
        schema: { type: 'object', properties: {} },
        permission: 'op',
        exclusiveClass: 'flow',
        guardText: '',
        timeoutMs,
        // 第四参注入任务实例（有状态算法如 explore 螺旋用）
        handler: async (ctx, args, runtime) => handler(ctx, args, runtime, this.task)
      })
    }
  }

  /** 执行整个脚本（return 信号在顶层消化）。 */
  async execute () {
    try {
      await this.runSteps(this.task.scriptDef.script.steps)
    } catch (err) {
      if (err instanceof ScriptReturn) return // return = 自然完成（BaseTask 判定）
      throw err
    }
  }

  /** 顺序执行步骤数组（每步前暂停/存活检查）。 */
  async runSteps (steps) {
    for (const step of steps ?? []) {
      if (!this.task._alive(this.gen)) return
      await this.task._waitIfPaused()
      if (step.ctrl !== undefined) await this.runCtrl(step)
      else await this.runAction(step)
    }
  }

  /** 动作步：模板求值 → executor 执行 → 结果链/计数。失败软记录（if 条件处理）。 */
  async runAction (step) {
    this.actionCount++
    const max = this.task.scriptDef.maxActions ?? Infinity
    if (this.actionCount > max) {
      this.task.log.warn({ max, count: this.actionCount }, '脚本动作数超上限（疑似死循环）——任务停止')
      throw new Error(`脚本动作数超上限 ${max}（疑似死循环，已停止）`)
    }
    const args = this.resolveValue(step.args ?? {})
    const r = await this.executor.executeBatch([{ op: step.op, args }], {
      user: 'system', // 脚本通道（任务只能由 op 启动/配置——见 executor 权限门）
      source: 'script',
      taskId: this.task.id,
      // exclusive 任务（owner 自己）跳过守卫；非 exclusive 任务（mine/fish/afk）
      // 不 bypass——其 build/movement 类动作在 exclusive 任务运行中被守卫软拒绝
      //（脚本 if 重试，mine 的 collect-retry 30s 语义天然承接），与 LLM act 语义
      // 一致；否则 mine 可与 farm/chop 并发抢 pathfinder/collectBlock（互设
      // setGoal → GoalChanged 抖动/饥饿）
      bypassExclusive: this.task.exclusive === true,
      signal: this.task._abort.signal,
      isPaused: () => this.task._pauseRequested,
      waitIfPaused: () => this.task._waitIfPaused()
    })
    const entry = r.results[0]
    this.lastResult = entry
    if (step.as) this.results.set(step.as, entry)
    // 软失败：entry.ok=false 记录在 lastResult（含结果文案），脚本用
    // { ctrl:'if', cond:{type:'last', ok:false} } 显式处理（重试/等待/退出）；
    // 没有任何 if 处理时任务继续循环，由 maxActions 兜底防死循环
    if (!entry.ok) {
      this.task.log.warn({ op: step.op, result: entry.result }, '脚本动作失败（软失败，由脚本条件处理）')
    } else if (step.count) {
      // count 支持两种形态：'name'（成功 +1）或 {name, field}（从结果取数值，
      // 如 collect_blocks 的 collected——每批按实际采集数计数）
      const by = typeof step.count === 'object'
        ? (Number(entry.result?.[step.count.field]) || 0)
        : 1
      if (by > 0) this.task.incr(typeof step.count === 'object' ? step.count.name : step.count, by)
    }
  }

  /** 控制步解释。 */
  async runCtrl (step) {
    switch (step.ctrl) {
      case 'loop': {
        // max: 'infinite' 或 0 → 无限循环（farm 的 maxCycles 0 = 不限轮数语义）；
        // 支持模板（'${maxCycles}' → options 值）
        const maxRaw = this.resolveValue(step.max)
        const max = (maxRaw === 'infinite' || Number(maxRaw) === 0) ? Infinity : (Number(maxRaw) || 1)
        for (let i = 0; i < max; i++) {
          if (!this.task._alive(this.gen)) return
          await this.task._waitIfPaused()
          try {
            await this.runSteps(step.body ?? [])
          } catch (err) {
            if (err instanceof ScriptBreak) break
            if (err instanceof ScriptContinue) continue // 跳到下一轮（farm 收获后不种植语义）
            throw err
          }
        }
        return
      }
      case 'break':
        throw new ScriptBreak()
      case 'continue':
        throw new ScriptContinue()
      case 'if': {
        // cond 参数模板化（gte/equals/value 支持 '${minHealth}' 等 options 引用；
        // ref 的 '$last'/'$name' 是条件语义标识——不得被模板解析）
        if (evalCond(this.resolveCond(step.cond), this)) await this.runSteps(step.then ?? [])
        else await this.runSteps(step.else ?? [])
        return
      }
      case 'wait': {
        const ms = Number(this.resolveValue(step.ms)) || 0
        await this.task._internalWait(Math.max(0, ms), 'script-wait') // stop/pause 可打断
        return
      }
      case 'count':
        this.task.incr(step.name, step.by ?? 1)
        return
      case 'return':
        throw new ScriptReturn(step.value)
      default:
        throw new Error(`未知 ctrl: ${step.ctrl}`)
    }
  }

  /** 条件模板化（只处理 gte/equals/value——ref 的 '$last' 是语义标识）。 */
  resolveCond (cond) {
    if (!cond || typeof cond !== 'object') return cond
    const out = { ...cond }
    for (const k of ['gte', 'equals', 'value']) {
      if (out[k] !== undefined) out[k] = this.resolveValue(out[k])
    }
    if (cond.type === 'not' && cond.cond) out.cond = this.resolveCond(cond.cond)
    return out
  }

  /** 参数模板求值（递归）：$引用 / ${options} / {expr}。 */
  resolveValue (v) {
    if (typeof v === 'string') {
      // ${options} 优先于 $引用（'${x}' 也以 $ 开头——顺序错误会把 options
      // 引用误判为结果引用 → 解析为 undefined）
      if (v.includes('${')) {
        // 整串 ${key} → 保留原始类型（数字/布尔直传）；混合串 → 字符串化内插。
        // 查找链：任务 options → 脚本 defaultOptions（如 mine 的 radius 缺省 32）
        const lookup = (k) => this.task.options[k] !== undefined ? this.task.options[k] : this.task.scriptDef.defaultOptions?.[k]
        const only = v.match(/^\$\{([^}]+)\}$/)
        if (only) {
          const val = lookup(only[1])
          return val === undefined ? undefined : val
        }
        return v.replace(/\$\{([^}]+)\}/g, (_, k) => {
          const val = lookup(k)
          return val === undefined ? '' : String(val)
        })
      }
      // $引用（结果链）——在 ${options} 之后判断（'${x}' 不以结果引用解析）
      if (v.startsWith('$')) return resolveRef(v, this)
      return v
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && 'expr' in v) {
      return evalExpr(v.expr, this.task.options, this.task.scriptDef.defaultOptions)
    }
    if (Array.isArray(v)) return v.map(x => this.resolveValue(x))
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.resolveValue(x)]))
    }
    return v
  }
}

/** 结果引用求值：'$name' / '$name.field.path' / '$last'。 */
function resolveRef (ref, runner) {
  const [name, ...fields] = ref.slice(1).split('.')
  const entry = name === 'last' ? runner.lastResult : runner.results.get(name)
  if (!entry) return undefined
  let val = entry.result
  for (const f of fields) {
    if (val === null || val === undefined) return undefined
    val = val[f]
  }
  return val
}

/** 条件表达式求值（六型）。 */
function evalCond (cond, runner) {
  if (!cond || typeof cond !== 'object') return false
  switch (cond.type) {
    case 'last':
      return (runner.lastResult?.ok ?? false) === (cond.ok ?? true)
    case 'result': {
      const entry = cond.ref === '$last' ? runner.lastResult : runner.results.get(cond.ref)
      const val = entry ? getPath(entry.result, cond.field) : undefined
      if (cond.gte !== undefined) return typeof val === 'number' && val >= cond.gte
      return val === (cond.equals ?? cond.value)
    }
    case 'counter':
      return (runner.task.counters[cond.name] ?? 0) >= (cond.gte ?? 1)
    case 'config': {
      // config 条件回退 defaultOptions：combat 未显式配置 maxTargets 时
      // options[key] 是 undefined，`undefined === 0` 恒 false → `not` 取反进入
      // 内圈 → kills >= 0（defaultOptions 的 0）恒真 → 首杀即完成（默认 0=不限
      // 语义失效）。回退使未配置行为与 defaultOptions 声明一致；chop logTypes /
      // farm replant（无默认）等条件不受影响。
      const opt = runner.task.options[cond.key] !== undefined
        ? runner.task.options[cond.key]
        : runner.task.scriptDef.defaultOptions?.[cond.key]
      return opt === cond.equals
    }
    case 'deadline': {
      const dm = runner.task.options.durationMinutes
      if (typeof dm !== 'number' || !runner.task.startedAt) return false
      return Date.now() >= runner.task.startedAt + dm * 60000
    }
    case 'not':
      return !evalCond(cond.cond, runner)
    default:
      return false
  }
}

/** 点路径取值（'candidates.length' → result.candidates.length）。 */
function getPath (obj, path) {
  if (!path) return obj
  let val = obj
  for (const f of String(path).split('.')) {
    if (val === null || val === undefined) return undefined
    val = val[f]
  }
  return val
}

/**
 * 白名单四则表达式求值（{expr:'${growthCheckSeconds} * 1000'}）：
 * 先把 ${key} 替换为 options 数值，再校验剩余字符只含数字/四则/括号/空白，
 * 最后 Function 求值（输入经白名单钳制，无任意代码执行面）。
 */
function evalExpr (expr, options, defaultOptions = null) {
  let s = String(expr)
  s = s.replace(/\$\{([^}]+)\}/g, (_, k) => {
    const val = options[k] !== undefined ? options[k] : defaultOptions?.[k]
    if (typeof val !== 'number') throw new Error(`表达式引用 ${k} 不是数字（options.${k}=${JSON.stringify(val)}）`)
    return String(val)
  })
  if (!/^[\d\s+\-*/().]*$/.test(s) || s.includes('**')) {
    throw new Error(`表达式含非法字符: ${expr}`)
  }
  const result = Function(`"use strict"; return (${s})`)()
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error(`表达式结果非法: ${expr} → ${result}`)
  }
  return result
}
