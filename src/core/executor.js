// 动作执行器：LLM act 动作数组与任务脚本共用的统一执行管线。
// executeBatch(actions, opts)：
//   - 逐动作执行单动作管线（解析→权限门→exclusive 守卫→参数校验→冷却→执行→审计）
//   - 默认 fail-fast（首个失败即停，返回 failedAt）；continueOnError 可续
//   - 动作数受 cfg.l2.maxActionsPerCall 上限（解析期拒绝，不半执行）
//   - runtime.signal 贯通（脚本 stop/断线可中断长时动作）；脚本暂停钩子
//     isPaused/waitIfPaused 在动作间调用
//   - 审计唯一挂点：每个动作结果 fire-and-forget 写入 audit（来源 llm|script|act）
// 永不抛出——单动作错误转 { ok:false, result }；批量只返回失败信息。

import { withTimeout } from '../util/promise-timeout.js'
import { isOp } from '../commands/permissions.js'
import { hasExclusiveActive, getExclusiveOwner } from './arbiter.js'
import { createPrimitiveRegistry } from './primitives/index.js'
import { createAuditLogger } from './audit.js'

/**
 * 创建动作执行器。
 * @param {{ bot, cfg, logger, tasks, conn, plugins }} ctx
 * @param {{ primitives?: Map, audit?: object|null }} deps 测试注入（缺省真实实例）
 */
export function createActionExecutor (ctx, deps = {}) {
  const primitives = deps.primitives ?? createPrimitiveRegistry(ctx)
  const audit = deps.audit === undefined ? createAuditLogger({ dir: ctx.cfg?.log?.dir, logger: ctx.logger }) : deps.audit
  const maxActionsPerCall = ctx.cfg?.l2?.maxActionsPerCall ?? 8
  // follow_player 的"跟随我"指代消解（executor 注入 user——经 ctx._caller 交给 handler）
  let execUser = null

  /**
   * 单动作执行管线（每动作独立 try/catch，永不外抛）。
   * @returns {Promise<{op, args, ok, result, durationMs}>}
   */
  async function runAction (op, args, { user, source, taskId, signal, bypassExclusive }) {
    const t0 = Date.now()
    const entry = { op, args: args ?? {}, ok: false, result: null, durationMs: 0 }
    const finish = async () => {
      entry.durationMs = Date.now() - t0
      if (audit) {
        try { audit.append({ ...entry, source, user, taskId }) } catch (err) { ctx.logger.warn({ err: err.message }, '审计写入失败') }
      }
      return entry
    }
    const p = primitives.get(op)
    try {
      if (!p) {
        entry.result = `未知动作: ${op}（observe_* / goto / dig / place / collect_blocks / attack / equip / reply...）`
        return finish()
      }
      // 权限门（op 原语仅白名单玩家；'system' = 脚本任务通道——任务本身只能由
      // op 启动/配置，脚本内动作不再逐层重复校验）
      if (p.permission === 'op' && user !== 'system' && !isOp(user, ctx.cfg)) {
        entry.result = `权限不足：${user} 不在 ops 白名单`
        return finish()
      }
      // exclusive 守卫（任务互斥——readonly/item/flow 不拦）
      if (!bypassExclusive && p.exclusiveClass !== 'readonly' && p.exclusiveClass !== 'item' && p.exclusiveClass !== 'flow' && hasExclusiveActive()) {
        entry.result = `exclusive 任务 ${getExclusiveOwner()} 运行中，无法${p.guardText || op}（任务结束后可试）`
        return finish()
      }
      // 参数校验（极简 JSONSchema：type + required + min/max + isFinite）
      const v = validateParams(p.schema, args)
      if (!v.ok) {
        entry.result = v.error
        return finish()
      }
      // 冷却由原语 handler 内部自理（"只对实际执行生效"——业务性校验失败不占，
      // 见 primitives.js dig/place/attack）
      // 执行（withTimeout 兜底 + runtime.signal 贯通）
      const prevCaller = ctx._caller
      ctx._caller = user ?? execUser
      execUser = user ?? execUser
      let result
      try {
        result = await withTimeout(p.handler(ctx, args ?? {}, { signal, user, taskId }), p.timeoutMs, `${op} timeout`)
      } finally {
        ctx._caller = prevCaller
      }
      entry.ok = true
      entry.result = result
    } catch (err) {
      entry.result = err.message
    }
    return finish()
  }

  /**
   * 批量执行动作数组。
   * @param {Array<{op: string, args?: object}>} actions
   * @param {{ user?: string, source: 'llm'|'script'|'act', taskId?: string,
   *           signal?: AbortSignal|null, bypassExclusive?: boolean,
   *           continueOnError?: boolean,
   *           isPaused?: () => boolean, waitIfPaused?: () => Promise<void> }} opts
   * @returns {Promise<{ ok, results: Array, failedAt: number|null, rejected: string|null }>}
   *          rejected = 解析期拒绝原因（超预算/非法数组），results 为空
   */
  async function executeBatch (actions, opts = {}) {
    // 解析期拒绝也写审计——自主行为追溯不得有静默空洞（整批拒/缺 op 也留痕）
    const logRejected = (result) => {
      if (!audit) return
      try {
        audit.append({ op: 'batch', args: null, ok: false, result, durationMs: 0, source: opts.source ?? 'llm', user: opts.user, taskId: opts.taskId })
      } catch (err) { ctx.logger.warn({ err: err.message }, '审计写入失败') }
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      return { ok: false, results: [], failedAt: null, rejected: '动作数组为空或格式错误' }
    }
    if (actions.length > maxActionsPerCall) {
      logRejected(`rejected: 动作数超限 ${actions.length}/${maxActionsPerCall}`)
      return { ok: false, results: [], failedAt: null, rejected: `动作数 ${actions.length} 超过单次上限 ${maxActionsPerCall}` }
    }
    // 解析期 shape 预校验：全部元素先过 op/args 形状检查，保证"全执行或全拒绝"——
    // 边执行边校验时，第 k 个元素非法会导致前 k-1 个已真实执行（dig/place 已生效）
    // 而结果整体丢弃（rejected）→ LLM 不知情重复副作用
    for (let i = 0; i < actions.length; i++) {
      const step = actions[i]
      if (!step || typeof step.op !== 'string') {
        logRejected(`rejected: 第 ${i + 1} 个动作缺少 op`)
        return { ok: false, results: [], failedAt: i, rejected: `第 ${i + 1} 个动作缺少 op` }
      }
      if (step.args !== undefined && (typeof step.args !== 'object' || step.args === null || Array.isArray(step.args))) {
        logRejected(`rejected: 第 ${i + 1} 个动作参数必须是对象`)
        return { ok: false, results: [], failedAt: i, rejected: `第 ${i + 1} 个动作参数必须是对象` }
      }
    }
    const results = []
    for (let i = 0; i < actions.length; i++) {
      const step = actions[i]
      // 脚本暂停钩子（任务 pause——动作间检查，批内由原语内部处理）
      if (opts.waitIfPaused) await opts.waitIfPaused()
      if (opts.signal?.aborted) {
        results.push({ op: step.op, args: step.args, ok: false, result: '动作被中断', durationMs: 0 })
        return { ok: false, results, failedAt: i, rejected: 'interrupted' }
      }
      const entry = await runAction(step.op, step.args, {
        user: opts.user,
        source: opts.source ?? 'llm',
        taskId: opts.taskId,
        signal: opts.signal ?? null,
        bypassExclusive: opts.bypassExclusive === true
      })
      results.push(entry)
      if (!entry.ok && opts.continueOnError !== true) {
        return { ok: false, results, failedAt: i, rejected: null }
      }
    }
    return { ok: true, results, failedAt: null, rejected: null }
  }

  /** 单动作（!agent act 与 LLM 观察工具共用）。 */
  async function executeOne (op, args, opts = {}) {
    const r = await executeBatch([{ op, args }], { ...opts, source: opts.source ?? 'act' })
    if (r.rejected) return { ok: false, result: r.rejected }
    return r.results[0]
  }

  return { executeBatch, executeOne, primitives, setExecUser: (u) => { execUser = u }, audit }
}

/** 极简 JSONSchema 校验（type + required + min/max）。 */
export function validateParams (schema, params) {
  if (!schema) return { ok: true }
  params = params ?? {}
  // 顶层类型检查——非对象参数（如 args:123）会漏进 handler（String 有索引访问
  // 不抛，字符串/数字/数组能遍历"属性"）→ NaN 坐标/神秘错误不可归因
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return { ok: false, error: '参数必须是对象' }
  }
  for (const k of schema.required ?? []) {
    if (params[k] === undefined) return { ok: false, error: `缺少参数: ${k}` }
  }
  for (const [k, def] of Object.entries(schema.properties ?? {})) {
    if (params[k] === undefined) continue
    const v = params[k]
    // type 支持联合（['string','array']——observe_entities 的 filter）
    const types = Array.isArray(def.type) ? def.type : [def.type]
    const ok = types.some(t => ({
      number: typeof v === 'number',
      integer: Number.isInteger(v),
      string: typeof v === 'string',
      boolean: typeof v === 'boolean',
      object: typeof v === 'object' && v !== null && !Array.isArray(v),
      array: Array.isArray(v)
    }[t]))
    if (!ok) return { ok: false, error: `${k} 必须是 ${types.join('/')}` }
    if ((def.type === 'number' || def.type === 'integer') && typeof v === 'number') {
      // NaN/Infinity 兜底（JSON 无法携带但防御直传/未来入口）
      if (!Number.isFinite(v)) return { ok: false, error: `${k} 必须是有限数值` }
      if (def.min !== undefined && v < def.min) return { ok: false, error: `${k} 不能小于 ${def.min}` }
      if (def.max !== undefined && v > def.max) return { ok: false, error: `${k} 不能大于 ${def.max}` }
    }
  }
  return { ok: true }
}
