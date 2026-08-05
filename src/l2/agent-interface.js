// L2 LLM 层契约与桩实现。l2.enabled=false 时零额外依赖、不加载任何 SDK。

/**
 * AgentInterface 契约：L2 启用时提供 chat/act 能力。
 * 后续 mindcraft 子进程接入点见 docs/l2.md 与 src/l2/mindcraft-adapter.js。
 */
export class AgentInterface {
  /**
   * @param {{ bot, config, logger, tasks, commands }} ctx
   */
  constructor (ctx) {
    this.ctx = ctx
  }

  /** 骨架阶段恒为 false；集成真实 agent 后返回 true。 */
  static isAvailable () {
    return false
  }

  /**
   * 用户与 agent 对话。
   * @returns {Promise<{ reply: string }>}
   */
  async chat (_user, _text) {
    return { reply: 'L2 骨架阶段：agent 尚未接入（参见 docs/l2.md）' }
  }

  /**
   * 调用 L1 技能/任务（未来由 mindcraft 子进程调用）。
   * @returns {Promise<{ ok: boolean, result: unknown }>}
   */
  async act (_name, _params) {
    return { ok: false, result: 'L2 骨架阶段：act 未实现' }
  }

  /** 优雅终止 agent 会话。 */
  async stop () {}
}
