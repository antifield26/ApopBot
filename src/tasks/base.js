// 任务基类：状态机 created → init → running ⇄ paused → stopped/failed。
// 子类实现 init/run/stop（run 返回的 Promise 在 stop/pause 时 resolve）。

export const TASK_STATES = Object.freeze(['created', 'init', 'running', 'paused', 'stopped', 'failed'])

export class BaseTask {
  /**
   * @param {string} id
   * @param {string} type
   * @param {object} options
   * @param {{ bot, logger, config }} ctx 运行上下文注入
   */
  constructor (id, type, options, ctx) {
    this.id = id
    this.type = type
    this.options = options ?? {}
    this.ctx = ctx
    this.bot = ctx.bot
    this.log = ctx.logger.child({ task: id })
    this._state = 'created'
    this.startedAt = null
    this.lastError = null
    this._stopRequested = false
    this._pauseRequested = false
    this._runPromise = null
    this._resumeNotify = null
  }

  get state () {
    return this._state
  }

  _setState (state) {
    this._state = state
    this.log.debug({ state }, 'task state changed')
  }

  /**
   * 校验 options 并准备资源。
   * @returns {Promise<void>}
   */
  async init () {
    this._setState('init')
  }

  /**
   * 主循环。返回的 Promise 在 stop/pause 时被 resolve。
   * @returns {Promise<void>}
   */
  async run () {
    this._setState('running')
    this.startedAt = Date.now()
  }

  /**
   * 停止并清理。幂等。
   * @returns {Promise<void>}
   */
  async stop () {
    this._stopRequested = true
    this._setState('stopped')
  }

  /**
   * 挂起（仅对可暂停任务有意义）。
   * @returns {Promise<void>}
   */
  async pause () {
    if (this._state !== 'running') return
    this._pauseRequested = true
    this._setState('paused')
  }

  /**
   * 恢复运行。
   * @returns {Promise<void>}
   */
  async resume () {
    if (this._state !== 'paused') return
    this._pauseRequested = false
    this._setState('running')
    if (this._resumeNotify) {
      const n = this._resumeNotify
      this._resumeNotify = null
      n()
    }
  }

  /** 供 run 循环内部检查挂起请求，await 直到 resume。 */
  async _waitIfPaused () {
    if (!this._pauseRequested) return
    await new Promise((resolve) => { this._resumeNotify = resolve })
  }

  /**
   * 完整启动流程（由 TaskManager 调用）：init → run。
   */
  async start () {
    if (this._state !== 'created') return
    try {
      await this.init()
      if (this._stopRequested) return // init 期间被 stop
      this._runPromise = this.run()
      await this._runPromise
    } catch (err) {
      this.lastError = err.message
      this._setState('failed')
      this.log.error({ err: err.message }, 'task failed')
    }
  }

  getStatus () {
    return {
      id: this.id,
      type: this.type,
      state: this._state,
      startedAt: this.startedAt,
      lastError: this.lastError
    }
  }
}
