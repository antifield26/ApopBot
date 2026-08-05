// 任务基类：状态机 created → init → running ⇄ paused → stopped/completed/failed。
//
// run-completion 语义（B2 修复基础）：
//   start() 返回 run 完成的 Promise；run() 正常返回 → completed（自然完成），
//   stop() 触发 → stopped，init/run 抛错 → failed。终态（stopped/completed/failed）
//   可再次 start()（F4 重启语义）。
//
// 暂停语义（F3 修复）：pause()/resume() 是"用户暂停"；任务内部等待（无目标/重试/
// 背包满等）用 _internalWait(ms, reason)，不再触碰 paused 状态、不置 lastError，
// 以 waitingReason 呈现于 getStatus。用户 pause 与 stop 都会打断内部等待。
//
// 取消语义（F1 修复）：stop() 调用子类 _cancel() 钩子取消进行中的 mineflayer 动作
// （collectBlock.cancelTask / pathfinder.stop / fish 超时等），并以 10s 上限等待
// run 协程退出，stop 永不挂起。

import { withTimeout } from '../util/promise-timeout.js'

export const TASK_STATES = Object.freeze(['created', 'init', 'running', 'paused', 'stopped', 'completed', 'failed'])

// stop() 等待 run 协程退出的上限（防子类 _cancel 失效导致挂起）
const STOP_WAIT_TIMEOUT_MS = 10000

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
    this.counters = {} // 任务遥测计数（mined/caught/wiggles/…）
    this.waitingReason = null // 内部等待原因（getStatus 展示，非错误）
    this.runCount = 0
    this.exclusive = false // true = 运行期间拒绝启动其他 exclusive 任务（M2 的新任务类型）
    this._stopRequested = false
    this._pauseRequested = false
    this._runPromise = null
    this._resumeNotify = null
    this._pauseWaiters = [] // _waitIfPaused 的挂起 resolve（stop/pause 唤醒）
    this._internalWaitNotify = null
    this._internalWaitTimer = null
  }

  get state () {
    return this._state
  }

  _setState (state) {
    this._state = state
    this.log.debug({ state }, 'task state changed')
  }

  /** 遥测计数递增。 */
  incr (name, n = 1) {
    this.counters[name] = (this.counters[name] ?? 0) + n
    return this.counters[name]
  }

  /**
   * 校验 options 并准备资源。
   * @returns {Promise<void>}
   */
  async init () {
    this._setState('init')
  }

  /**
   * 主循环。返回的 Promise 在任务结束时 resolve（自然完成/stop/pause 均会退出）。
   * @returns {Promise<void>}
   */
  async run () {
    this._setState('running')
    this.startedAt = Date.now()
  }

  /**
   * 子类实现：取消进行中的 mineflayer 动作（stop 时由基类调用）。
   * @returns {Promise<void>}
   */
  async _cancel () {}

  /**
   * 停止并清理。幂等；等待 run 协程退出（上限 10s）。
   * @returns {Promise<void>}
   */
  async stop () {
    if (this._state === 'stopped') return
    this._stopRequested = true
    this._setState('stopped')
    this._wakeInternalWait()
    this._wakePauseWaiters()
    try {
      await this._cancel()
    } catch (err) {
      this.log.warn({ err: err.message }, 'cancel 失败')
    }
    if (this._runPromise) {
      try {
        await withTimeout(this._runPromise, STOP_WAIT_TIMEOUT_MS, 'task stop timeout')
      } catch {
        this.log.warn('任务未在停止超时内退出，强制结束')
      }
    }
  }

  /**
   * 挂起（仅对可暂停任务有意义；用户暂停）。
   * @returns {Promise<void>}
   */
  async pause () {
    if (!['init', 'running'].includes(this._state)) return
    this._pauseRequested = true
    this._setState('paused')
    this._wakeInternalWait() // 打断内部等待，让循环立即进入暂停
  }

  /**
   * 恢复运行。
   * @returns {Promise<void>}
   */
  async resume () {
    if (this._state !== 'paused') return
    this._pauseRequested = false
    this._setState('running')
    this._wakePauseWaiters()
  }

  /**
   * 供 run 循环检查用户暂停请求，await 直到 resume/stop。
   */
  async _waitIfPaused () {
    while (this._pauseRequested && !this._stopRequested) {
      await new Promise((resolve) => { this._pauseWaiters.push(resolve) })
    }
  }

  /** 唤醒所有 _waitIfPaused 的挂起。 */
  _wakePauseWaiters () {
    const ws = this._pauseWaiters
    this._pauseWaiters = []
    for (const w of ws) w()
  }

  /**
   * 任务内部等待（F3：不触碰 paused 状态）。stop/pause 时提前返回。
   * 竞态守卫：stop() 先于 run 循环到达此处时（fire-and-forget 启动后立即 stop），
   * 立即返回而非挂起——否则 stop() 会空等 STOP_WAIT_TIMEOUT_MS。
   * @param {number} ms
   * @param {string} reason 展示原因（如 no-target / inventory-full）
   */
  async _internalWait (ms, reason = 'wait') {
    if (this._stopRequested) return
    this.waitingReason = reason
    try {
      await new Promise((resolve) => {
        this._internalWaitNotify = () => {
          clearTimeout(this._internalWaitTimer)
          resolve()
        }
        this._internalWaitTimer = setTimeout(() => {
          this._internalWaitNotify = null
          resolve()
        }, ms)
      })
    } finally {
      this.waitingReason = null
      this._internalWaitNotify = null
    }
  }

  /** 打断当前内部等待（stop/pause 调用）。 */
  _wakeInternalWait () {
    if (this._internalWaitNotify) {
      const n = this._internalWaitNotify
      this._internalWaitNotify = null
      clearTimeout(this._internalWaitTimer)
      n()
    }
  }

  /** 终态重置为 created（F4 重启语义）。 */
  _reset () {
    this._state = 'created'
    this._stopRequested = false
    this._pauseRequested = false
    this.lastError = null
    this.startedAt = null
    this.waitingReason = null
    this._runPromise = null
    this._pauseWaiters = []
  }

  /**
   * 完整启动流程（由 TaskManager 调用）：init → run，返回 run 完成 Promise（B2）。
   * 已在 init/running/paused 时返回当前 run promise；终态自动重置后重启（F4）。
   */
  async start () {
    if (['init', 'running', 'paused'].includes(this._state)) return this._runPromise ?? null
    this._reset()
    try {
      await this.init()
      if (this._stopRequested) { this._setState('stopped'); return null }
      this.runCount++
      this._runPromise = this.run()
      await this._runPromise
      if (!this._stopRequested) this._setState('completed') // 自然完成
    } catch (err) {
      this.lastError = err.message
      this._setState('failed')
      this.log.error({ err: err.message }, 'task failed')
    }
    return this._runPromise
  }

  getStatus () {
    return {
      id: this.id,
      type: this.type,
      state: this._state,
      startedAt: this.startedAt,
      lastError: this.lastError,
      counters: { ...this.counters },
      waitingReason: this.waitingReason,
      runCount: this.runCount
    }
  }
}
