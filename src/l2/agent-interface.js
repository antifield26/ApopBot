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

// 文本长度上限（低配 4B 模型上下文与聊天消息长度双重约束；B6 从硬编码提为常量）
const INPUT_MAX_CHARS = 1000 // 用户消息截断
const REPLY_MAX_CHARS = 250 // 回复截断（与 chat.maxLength 默认一致）
const TOOL_RESULT_MAX_CHARS = 2000 // 工具结果回填截断（大 JSON 撑爆 4B 上下文）

// 会话记忆（U2）：按玩家名的多轮上下文，模块级 Map——agent 实例在重连/热重载时
// 被 feature-layer 重建，模块级存储保证记忆跨代际保留（会话是玩家维度的，不是 bot 维度的）。
// 上限 MAX_HISTORY_MESSAGES 条（含本轮），先出后入裁剪；只存 user/assistant 纯文本轮，
// 不存工具调用中间轮（长且不必要）。act 直调不污染会话。
// 会话数上限 MAX_SESSIONS（C7/T）：Map 迭代序 = 插入序，访问时 delete+set 刷新为
// 最新（LRU），超上限驱逐最久未访问的会话——此前每说过一句话的玩家永久驻留一条。
const MAX_HISTORY_MESSAGES = 10
const MAX_SESSIONS = 32
const SESSIONS = new Map()

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
3. 危险操作（move_to/run_task/stop_task/follow_player/find_block）只有 op 玩家可用——当前调用者是否是 op 见"当前会话"（技能层会强制校验，无需再向调用者要求验证）。
4. 状态查询（status/task_status/inventory_summary）可自由使用，回答时引用真实数据。
5. 找东西用 find_block 技能（如"去找铁矿石"→ find_block(iron_ore)），不要用其他方式编造位置。
6. 不要角色扮演，不要输出 Markdown，不要虚构玩家或世界状态。`

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
    if (this.busy) return { reply: '上一个请求仍在处理中，请稍候' }
    this.busy = true
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
        const res = await this.provider.chat(messages, {
          tools: this.skills.listForTools(),
          system: buildSystem(user, this.ctx.cfg),
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

  /** 清空指定玩家的会话记忆（!agent reset）。 */
  reset (user) {
    SESSIONS.delete(user)
  }

  /** 当前会话数（U3 /metrics 用）。 */
  sessionCount () {
    return SESSIONS.size
  }
}
