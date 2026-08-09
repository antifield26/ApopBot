// 脚本任务执行器（v1.0.0 C6）：BaseTask 状态机外壳 + 脚本 DSL 解释器。
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

export class ScriptTask extends BaseTask {
  /**
   * @param {string} id
   * @param {string} type
   * @param {object} options
   * @param {{ bot, logger, config, getConfig }} ctx
   * @param {object} scriptDef 脚本定义（scripts/*.js 默认导出）
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
    for (const [name, handler] of Object.entries(task.scriptDef.ops ?? {})) {
      this.executor.primitives.set(name, {
        description: `任务局部原语 ${name}`,
        schema: { type: 'object', properties: {} },
        permission: 'op',
        exclusiveClass: 'flow',
        guardText: '',
        timeoutMs: 30000,
        handler
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
      this.task.log.warn({ max, count: this.actionCount }, `脚本动作数超上限（疑似死循环）——任务停止`)
      throw new Error(`脚本动作数超上限 ${max}（疑似死循环，已停止）`)
    }
    const args = this.resolveValue(step.args ?? {})
    const r = await this.executor.executeBatch([{ op: step.op, args }], {
      user: 'system', // 脚本通道（任务只能由 op 启动/配置——见 executor 权限门）
      source: 'script',
      taskId: this.task.id,
      bypassExclusive: true, // owner 是自己——任务互斥由 manager 仲裁
      signal: this.task._abort.signal,
      isPaused: () => this.task._pauseRequested,
      waitIfPaused: () => this.task._waitIfPaused()
    })
    const entry = r.results[0]
    this.lastResult = entry
    if (step.as) this.results.set(step.as, entry)
    // 软失败：entry.ok=false 记录在 lastResult（含结果文案），脚本用
    // { ctrl:'if', cond:{type:'last', ok:false} } 显式处理（重试/等待/退出）——
    // 与原任务循环的容错语义一致（如 mine 的 collect 失败等下一轮）；
    // 没有任何 if 处理时任务继续循环，由 maxActions 兜底防死循环
    if (!entry.ok) {
      this.task.log.warn({ op: step.op, result: entry.result }, '脚本动作失败（软失败，由脚本条件处理）')
    } else if (step.count) {
      this.task.incr(step.count)
    }
  }

  /** 控制步解释。 */
  async runCtrl (step) {
    switch (step.ctrl) {
      case 'loop': {
        const max = step.max === 'infinite' ? Infinity : (Number(step.max) || 1)
        for (let i = 0; i < max; i++) {
          if (!this.task._alive(this.gen)) return
          await this.task._waitIfPaused()
          try {
            await this.runSteps(step.body ?? [])
          } catch (err) {
            if (err instanceof ScriptBreak) break
            throw err
          }
        }
        return
      }
      case 'break':
        throw new ScriptBreak()
      case 'if': {
        if (evalCond(step.cond, this)) await this.runSteps(step.then ?? [])
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

  /** 参数模板求值（递归）：$引用 / ${options} / {expr}。 */
  resolveValue (v) {
    if (typeof v === 'string') {
      if (v.startsWith('$')) return resolveRef(v, this)
      if (v.includes('${')) {
        // 整串 ${key} → 保留原始类型（数字/布尔直传）；混合串 → 字符串化内插
        const only = v.match(/^\$\{([^}]+)\}$/)
        if (only) {
          const val = this.task.options[only[1]]
          return val === undefined ? undefined : val
        }
        return v.replace(/\$\{([^}]+)\}/g, (_, k) => {
          const val = this.task.options[k]
          return val === undefined ? '' : String(val)
        })
      }
      return v
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && 'expr' in v) {
      return evalExpr(v.expr, this.task.options)
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
    case 'config':
      return runner.task.options[cond.key] === cond.equals
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
function evalExpr (expr, options) {
  let s = String(expr)
  s = s.replace(/\$\{([^}]+)\}/g, (_, k) => {
    const val = options[k]
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
