// L2 Agent 接口：进程内 LLM 工具循环（不引入子进程/IPC——单 bot、maxSteps 有界，
// Node 22 全局 fetch 零新依赖；mindcraft 的 AgentProcess 模式在此规模无收益，见 docs/l2.md）。
//
// chat(user, text)：cooldown 门 + busy 拒并发 → 循环 ≤maxSteps：provider.chat →
//   执行 toolCalls（≤4/轮，权限与参数校验在 skills.execute）→ 续；无工具调用即回复。
// act(user, name, params)：直调技能（!agent act，不经 LLM）。
// stop()：AbortController 中止进行中的请求。
//
// 错误永不向上抛——以友好回复返回（配合 logger.error 留痕）。

const SYSTEM_PROMPT = `你是运行在 Minecraft 服务器上的 Bot 助手（minecraft-bot）。
规则：
1. 回答保持简短（≤250 字符），用 reply 技能说话。
2. 涉及移动/创建任务/控制行为的操作必须用对应技能完成，不要编造能力。
3. 危险操作（move_to/run_task/stop_task/follow_player）只有 op 玩家可用，非 op 请求直接说明权限不足。
4. 状态查询（status/task_status/inventory_summary）可自由使用，回答时引用真实数据。
5. 不要角色扮演，不要输出 Markdown，不要虚构玩家或世界状态。`

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
    this.cooldownUntil = 0
    this._abort = null
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
    if (now < this.cooldownUntil) {
      return { reply: `请求冷却中（${Math.ceil((this.cooldownUntil - now) / 1000)}s 后重试）` }
    }
    if (this.busy) return { reply: '上一个请求仍在处理中，请稍候' }
    this.busy = true
    this.cooldownUntil = now + cooldownMs
    const ac = new AbortController()
    this._abort = ac
    try {
      const messages = [{ role: 'user', content: String(text).slice(0, 1000) }]
      const maxSteps = this.cfg.maxSteps ?? 5
      let reply = '（无回复）'
      for (let step = 0; step < maxSteps; step++) {
        const res = await this.provider.chat(messages, {
          tools: this.skills.listForTools(),
          system: SYSTEM_PROMPT,
          signal: ac.signal
        })
        const calls = res.toolCalls?.slice(0, 4) ?? []
        if (calls.length === 0) {
          reply = res.text ?? '（无回复）'
          break
        }
        // 执行工具调用并把结果送回给 LLM
        const results = []
        for (const tc of calls) {
          const r = await this.skills.execute(tc.name, tc.arguments, user)
          results.push({ id: tc.id, name: tc.name, output: r })
        }
        messages.push({ role: 'assistant', content: res.text ?? '', toolCalls: calls })
        messages.push({ role: 'user', content: '', toolResults: results })
      }
      return { reply: reply.slice(0, 250) }
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

  /** 中止进行中的请求。 */
  stop () {
    this._abort?.abort()
  }
}
