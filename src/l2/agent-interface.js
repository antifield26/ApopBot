// L2 Agent 接口：进程内 LLM 工具循环（不引入子进程/IPC——单 bot、maxSteps 有界，
// Node 22 全局 fetch 零新依赖；mindcraft 的 AgentProcess 模式在此规模无收益，见 docs/l2.md）。
//
// chat(user, text)：cooldown 门 + busy 拒并发 → 循环 ≤maxSteps：provider.chat →
//   执行 toolCalls（≤4/轮，权限与参数校验在 skills.execute）→ 续；无工具调用即回复。
// act(user, name, params)：直调技能（!agent act，不经 LLM）。
// stop()：AbortController 中止进行中的请求。
//
// 错误永不向上抛——以友好回复返回（配合 logger.error 留痕）。

import { isOp } from '../commands/permissions.js'
import { environmentLine } from './environment.js'

// 文本长度上限（低配 4B 模型上下文与聊天消息长度双重约束；B6 从硬编码提为常量）
const INPUT_MAX_CHARS = 1000 // 用户消息截断
const REPLY_MAX_CHARS = 250 // 回复截断（与 chat.maxLength 默认一致）
const TOOL_RESULT_MAX_CHARS = 2000 // 工具结果回填截断上限（预算裁剪的硬上限）
// A2：工具结果回填的下限——预算裁剪时也不得低于此（低于则整条丢弃更有意义）
const TOOL_RESULT_MIN_CHARS = 200
// A2：上下文预算的尾差缓冲（工具定义 schema/系统提示的估算误差 + 回复预留）
const BUDGET_RESERVE_TOKENS = 384

// 会话记忆（U2）：按玩家名的多轮上下文，模块级 Map——agent 实例在重连/热重载时
// 被 feature-layer 重建，模块级存储保证记忆跨代际保留（会话是玩家维度的，不是 bot 维度的）。
// 上限 MAX_HISTORY_MESSAGES 条（含本轮），先出后入裁剪；只存 user/assistant 纯文本轮，
// 不存工具调用中间轮（长且不必要）。act 直调不污染会话。
// 会话数上限 MAX_SESSIONS（C7/T）：Map 迭代序 = 插入序，访问时 delete+set 刷新为
// 最新（LRU），超上限驱逐最久未访问的会话——此前每说过一句话的玩家永久驻留一条。
const MAX_HISTORY_MESSAGES = 10
const MAX_SESSIONS = 32
const SESSIONS = new Map()
// A5（第四轮）：summarize 全局冷却——模块级（agent 随重连/热重载重建，实例级会复位）。
// 覆盖死亡播报（feature-layer）与任务终态播报（manager）全部组合：低配 PC + Ollama
// 单请求队列下并发两条 LLM 请求会让 10s 超时静默触发或拖慢主对话（第四轮验证确认）
const SUMMARY_COOLDOWN_MS = 60000
let lastSummarizeAt = 0

/** 测试钩子：重置 summarize 全局冷却（生产不调用；tests 需要独立验证冷却语义）。 */
export function _resetSummarizeCooldown () {
  lastSummarizeAt = 0
}

/**
 * A2：token 估算（qwen3 BPE 近似，确定性可测，偏保守）——
 * CJK ×1.0 + ASCII ×0.25 + 其他 ×0.5。字符级截断 ≠ token 级截断的工程折中：
 * 超窗时宁可多裁一点（历史轮/工具结果），也不让 Ollama 静默截断（信息丢失不可控）。
 */
export function estimateTokens (text) {
  let t = 0
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0)
    if (c >= 0x4e00 && c <= 0x9fff) t += 1 // CJK 统一表意
    else if (c < 0x80) t += 0.25 // ASCII
    else t += 0.5
  }
  return Math.ceil(t)
}

/** 消息 token 估算（预算裁剪用；导出供测试验证工具参数计入）。 */
export function messageTokens (m) {
  if (m.toolResults?.length) {
    return m.toolResults.reduce((s, r) => s + estimateTokens(r.output), 0)
  }
  if (m.toolCalls?.length) {
    // P2-5（第五轮）：工具参数 JSON 计入估算——此前只计名字，参数大的调用
    //（run_task 的 options）真实用量被低估 → 预算裁剪误判不裁
    return estimateTokens(m.content ?? '') +
      estimateTokens(JSON.stringify(m.toolCalls.map(t => ({ name: t.name, arguments: t.arguments }))))
  }
  return estimateTokens(m.content ?? '')
}

/**
 * A2：上下文预算裁剪——消息序列（fixedTokens + Σ消息）超预算时按序裁剪：
 * ① 丢最旧的纯文本历史轮（工具轮必须保留配对）→ ② 工具结果统一截短（不低于
 * TOOL_RESULT_MIN_CHARS，由剩余预算分摊）→ ③ 当前用户消息截到剩余。
 * 原地修改传入数组（调用方持有副本）；返回是否发生裁剪。
 */
export function applyTokenBudget (messages, fixedTokens, budget) {
  let over = fixedTokens + messages.reduce((s, m) => s + messageTokens(m), 0) - budget
  if (over <= 0) return false
  // ① 丢最旧纯文本轮（保留最后一条——当前用户消息留给 ③ 按剩余预算截断）
  let i = 0
  while (over > 0 && i < messages.length - 1) {
    const m = messages[i]
    if (m.toolCalls || m.toolResults) { i++; continue } // 工具轮不动（配对语义）
    over -= messageTokens(m)
    messages.splice(i, 1)
  }
  // ② 工具结果统一截短（targetPer 由"除纯文本外"的预算分摊）
  if (over > 0) {
    const results = messages.flatMap(m => m.toolResults ?? [])
    if (results.length > 0) {
      const textBudget = Math.max(TOOL_RESULT_MIN_CHARS * results.length,
        budget - fixedTokens - messages.reduce((s, m) => s + (m.toolResults ? 0 : messageTokens(m)), 0))
      const targetPer = Math.max(TOOL_RESULT_MIN_CHARS, Math.floor(textBudget / results.length))
      for (const r of results) {
        if (r.output.length > targetPer) {
          over -= estimateTokens(r.output) - estimateTokens(r.output.slice(0, targetPer))
          r.output = r.output.slice(0, targetPer) + '…(截断)'
        }
      }
    }
  }
  // ③ 当前用户消息截到剩余（按比例近似，保守多裁）
  if (over > 0 && messages.length > 0) {
    const last = messages[messages.length - 1]
    if (last && !last.toolCalls && !last.toolResults && last.content) {
      const cur = estimateTokens(last.content)
      const keep = Math.max(TOOL_RESULT_MIN_CHARS, Math.floor(last.content.length * (1 - over / Math.max(1, cur))))
      last.content = last.content.slice(0, keep)
    }
  }
  return true
}

/** 读取会话并刷新 LRU 序（delete+set 移到迭代末尾）。 */
function getSession (user) {
  const v = SESSIONS.get(user)
  if (v !== undefined) {
    SESSIONS.delete(user)
    SESSIONS.set(user, v)
  }
  return v
}

/** 写入会话（LRU 上限驱逐最久未访问者）。 */
function setSession (user, history) {
  if (SESSIONS.has(user)) SESSIONS.delete(user)
  SESSIONS.set(user, history)
  if (SESSIONS.size > MAX_SESSIONS) {
    SESSIONS.delete(SESSIONS.keys().next().value)
  }
}

/** 有界 Map（按玩家冷却同款 LRU 上限）。 */
function putBounded (map, key, value) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  if (map.size > MAX_SESSIONS) map.delete(map.keys().next().value)
}

const SYSTEM_PROMPT = `你是运行在 Minecraft 服务器上的 Bot 助手（minecraft-bot）。
规则：
1. 回答保持简短（≤250 字符），用 reply 技能说话。
2. 涉及移动/创建任务/控制行为的操作必须用对应技能完成，不要编造能力。
3. 危险操作（move_to/run_task/stop_task/follow_player/find_block/explore）只有 op 玩家可用——当前调用者是否是 op 见"当前会话"（技能层会强制校验，无需再向调用者要求验证）。
4. 状态查询（status/task_status/inventory_summary）可自由使用，回答时引用真实数据。
5. 找东西用 find_block 技能（如"去找铁矿石"→ find_block(iron_ore)），不要用其他方式编造位置。
6. 不要角色扮演，不要输出 Markdown，不要虚构玩家或世界状态。环境感知以系统消息里的"环境:"行与 environment/nearby_entities 技能结果为准——没感知到的信息（如天气/生物群系/附近实体）如实说不知道，探索过的区域可查 query_map。`

/**
 * 每次对话注入调用者身份：LLM 必须知道"谁在说话、是否有 op 权限"，
 * 否则面对危险操作请求只会回复"需要验证 op 身份"（实测反馈——身份此前未进上下文）。
 * @param {string} user 消息来源玩家
 */
function buildSystem (user, cfg) {
  const auth = isOp(user, cfg)
    ? `${user} 是 op 白名单成员——危险操作可直接执行，无需再要求验证`
    : `${user} 是普通玩家——危险操作（move_to/run_task/stop_task/follow_player）必须拒绝并说明权限不足`
  return `${SYSTEM_PROMPT}\n\n当前会话：${auth}`
}

export class AgentInterface {
  /**
   * @param {{ bot, cfg, logger, tasks, conn, plugins }} ctx
   * @param {{ provider: object, skills: object, config: object }} deps
   */
  constructor (ctx, deps) {
    this.ctx = ctx
    this.provider = deps.provider
    this.skills = deps.skills
    this.cfg = deps.config ?? {}
    this.log = ctx.logger.child({ module: 'l2' })
    this.busy = false
    // 按玩家冷却（C7/T）：此前全局单值——一个 op 的请求冷却挡住所有玩家的 !agent chat
    this.cooldowns = new Map()
    this._abort = null
    // LLM 计量（U5）：本次对话累计 tokens + 最近一次请求耗时（/metrics 用）
    this.usage = { inputTokens: 0, outputTokens: 0, latencyMs: null }
  }

  static isAvailable () {
    return true
  }

  /**
   * 对话入口（LLM 工具循环）。
   * @param {string} user 消息来源玩家
   * @param {string} text 用户消息
   * @returns {Promise<{ reply: string }>}
   */
  async chat (user, text) {
    const now = Date.now()
    const cooldownMs = this.cfg.cooldownMs ?? 5000
    const until = this.cooldowns.get(user) ?? 0
    if (now < until) {
      return { reply: `请求冷却中（${Math.ceil((until - now) / 1000)}s 后重试）` }
    }
    if (this.busy) {
      // F1-b（第五轮）：busy 阻塞可长达 60-120s（move_to/find_block 工具执行）——
      // 附带已进行秒数让玩家知道不是卡死
      const elapsed = this._busySince ? Math.round((now - this._busySince) / 1000) : 0
      return { reply: `上一个请求仍在处理中（已进行 ${elapsed}s），请稍候` }
    }
    this.busy = true
    this._busySince = now
    putBounded(this.cooldowns, user, now + cooldownMs)
    const ac = new AbortController()
    this._abort = ac
    try {
      // 会话注入：历史（裁剪后）+ 本轮用户消息（history 是副本，工具循环内 push 不污染存储）
      const history = (getSession(user) ?? []).slice(-MAX_HISTORY_MESSAGES)
      const userMsg = String(text).slice(0, INPUT_MAX_CHARS)
      const messages = [...history, { role: 'user', content: userMsg }]
      const maxSteps = this.cfg.maxSteps ?? 5
      let finished = false
      let reply = '（无回复）'
      // auto provider 的粘滞回退按"本轮对话"重置（C7/V）：云端挂起时其余步骤直走 ollama
      this.provider.resetFallback?.()
      for (let step = 0; step < maxSteps && !finished; step++) {
        const tools = this.skills.listForTools()
        // A3：环境自动注入——每次工具轮重新生成（bot 移动后数据新鲜）；开关可关；
        // 缺失字段 environmentLine 内部兜底（返回空串）
        const system = buildSystem(user, this.ctx.cfg) + (this.cfg.envInjection === false ? '' : `\n${environmentLine(this.ctx.bot)}`)
        // A2：上下文预算裁剪（provider 有窗口时）——fixed = system + 工具定义；
        // 超预算按序裁剪历史/工具结果/用户消息。窗口 null（云端/测试）→ 不裁剪
        const window = this.provider.contextWindow?.()
        if (window) {
          const budget = window - (this.cfg.maxTokens ?? 1024) - BUDGET_RESERVE_TOKENS
          const fixedTokens = estimateTokens(system) + estimateTokens(JSON.stringify(tools))
          if (fixedTokens > budget && !this._budgetWarned) {
            this._budgetWarned = true
            // P2-5（第五轮）：warn 带具体数字——2048 窗口下 fixed > budget 是结构性
            // 不可收敛（裁剪三步后仍超窗，依赖 Ollama 静默截断）：提示调参方向
            this.log.warn({ fixedTokens, budget, window }, `L2 固定 prompt（system+技能定义）超出上下文预算（window ${window}）——历史/工具结果将被全部裁剪后仍可能超窗。建议 l2.ollamaNumCtx=4096 或减少 maxTokens/技能数`)
          }
          applyTokenBudget(messages, fixedTokens, budget)
        }
        const res = await this.provider.chat(messages, {
          tools,
          system,
          signal: ac.signal
        })
        // token/耗时计量（U5）：累计本轮全部 provider 调用
        if (res.usage) {
          this.usage.inputTokens += res.usage.inputTokens ?? 0
          this.usage.outputTokens += res.usage.outputTokens ?? 0
        }
        this.usage.latencyMs = res.latencyMs ?? null
        const calls = res.toolCalls?.slice(0, 4) ?? []
        if (calls.length === 0) {
          reply = res.text ?? '（无回复）'
          finished = true
          break
        }
        // 执行工具调用并把结果送回给 LLM
        const results = []
        for (const tc of calls) {
          const r = await this.skills.execute(tc.name, tc.arguments, user)
          // 工具结果截断：maxSteps×多技能的大 JSON（inventory_summary/task_status）
          // 会撑爆 4B 模型上下文或放大云端成本
          let output = r
          if (typeof output !== 'string') output = JSON.stringify(output)
          if (output.length > TOOL_RESULT_MAX_CHARS) output = output.slice(0, TOOL_RESULT_MAX_CHARS) + '…(截断)'
          results.push({ id: tc.id, name: tc.name, output })
        }
        messages.push({ role: 'assistant', content: res.text ?? '', toolCalls: calls })
        messages.push({ role: 'user', content: '', toolResults: results })
      }
      if (!finished) {
        // C7/U 修复：maxSteps 耗尽——此前返回"（无回复）"占位且写入会话污染下一轮；
        // 显式文案提示重试
        reply = `已达最大工具步数（${maxSteps}），请重试`
      }
      // 回写会话：本轮 user 轮 + 最终 assistant 轮（纯文本，裁剪到上限）
      history.push({ role: 'user', content: userMsg })
      history.push({ role: 'assistant', content: reply.slice(0, REPLY_MAX_CHARS) })
      setSession(user, history.slice(-MAX_HISTORY_MESSAGES))
      return { reply: reply.slice(0, REPLY_MAX_CHARS) }
    } catch (err) {
      if (err.name === 'AbortError') return { reply: '请求已中止' }
      this.log.error({ err: err.message }, 'agent chat failed')
      return { reply: `处理出错：${err.message}` }
    } finally {
      this.busy = false
      this._abort = null
    }
  }

  /**
   * 直调技能（!agent act，不经 LLM）。
   * @returns {Promise<{ ok: boolean, result: unknown }>}
   */
  async act (user, name, params) {
    // P2-3（第五轮）：act 直调技能不经 busy 门——!agent act move_to 可打进进行中
    // chat 工具循环（两个控制流并发改 pathfinder/装备状态）。busy 时拒绝
    if (this.busy) return { ok: false, result: '上一个请求仍在处理中，请稍候' }
    return this.skills.execute(name, params, user)
  }

  /**
   * 单次 LLM 一句话总结（U6/U7：死亡播报/任务终态播报）——无会话、无工具循环、
   * 不占用 busy/冷却状态。任何失败/超时返回 null（调用方回退固定模板），
   * 绝不阻塞调用方（10s 短超时）。
   * @param {string} prompt
   * @returns {Promise<string|null>}
   */
  async summarize (prompt) {
    if (!this.provider?.chat) return null
    // A5：全局冷却（60s）——死亡与任务终态并发时只发一条 LLM 请求
    const now = Date.now()
    if (now - lastSummarizeAt < SUMMARY_COOLDOWN_MS) return null
    lastSummarizeAt = now
    try {
      const res = await this.provider.chat(
        [{ role: 'user', content: String(prompt).slice(0, 500) }],
        {
          system: '你是 Minecraft 服务器上的 Bot 播报员。用一句话（≤100 字符）概括，不要 Markdown，不要角色扮演。',
          signal: AbortSignal.timeout(10000)
        }
      )
      const text = (res?.text ?? '').trim()
      return text ? text.slice(0, 120) : null
    } catch {
      return null
    }
  }

  /** 中止进行中的请求。 */
  stop () {
    this._abort?.abort()
  }

  /** U9：provider 连通性诊断（!agent doctor，只读）。 */
  async diagnose () {
    if (!this.provider?.diagnose) {
      return [{ ok: false, label: 'provider', error: 'provider 不支持诊断' }]
    }
    const r = await this.provider.diagnose()
    return Array.isArray(r) ? r : [r]
  }

  /** 清空指定玩家的会话记忆（!agent reset）。 */
  reset (user) {
    SESSIONS.delete(user)
  }

  /** 当前会话数（U3 /metrics 用）。 */
  sessionCount () {
    return SESSIONS.size
  }
}
