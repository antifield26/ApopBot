// 任务基类：状态机 created → init → running ⇄ paused → stopped/completed/failed。
//
// run-completion 语义：
//   start() 返回 run 完成的 Promise；run() 正常返回 → completed（自然完成），
//   stop() 触发 → stopped，init/run 抛错 → failed。终态（stopped/completed/failed）
//   可再次 start()（重启语义）。
//
// 暂停语义：pause()/resume() 是"用户暂停"；任务内部等待（无目标/重试/
// 背包满等）用 _internalWait(ms, reason)，不触碰 paused 状态、不置 lastError，
// 以 waitingReason 呈现于 getStatus。用户 pause 与 stop 都会打断内部等待。
//
// 取消语义：stop() 调用子类 _cancel() 钩子取消进行中的 mineflayer 动作
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
    // 浅复制：loadConfig 对整棵 cfg deepFreeze——config 路径装载的任务 options 是
    // 冻结对象，脚本 init 若写回（combat 的 weaponName）会在 ESM strict 模式下抛
    // TypeError。复制后写 task.options 不影响 config 条目（manager reload 的 diff
    // 基于 config 条目对象）。嵌套对象（area 等）共享引用——当前脚本只读嵌套对象，
    // 可接受。
    this.options = { ...(options ?? {}) }
    this.ctx = ctx
    this.bot = ctx.bot
    this.log = ctx.logger.child({ task: id })
    this._state = 'created'
    this.startedAt = null
    this.lastError = null
    this.counters = {} // 任务遥测计数（mined/caught/wiggles/…）
    this.waitingReason = null // 内部等待原因（getStatus 展示，非错误）
    this.waitingSince = null // waitingReason 开始时间（idle 播报判定）
    this.runCount = 0
    this.exclusive = false // true = 运行期间拒绝启动其他 exclusive 任务
    this._stopRequested = false
    this._pauseRequested = false
    this._runPromise = null
    this._runGen = 0 // run 代际：start 换代后仍存活的旧 run 协程自弃（防 stop 超时后双 run 并发）
    this._resumeNotify = null
    this._pauseWaiters = [] // _waitIfPaused 的挂起 resolve（stop/pause 唤醒）
    // _internalWait 的 per-wait token 集合：每次等待自建 token 登记于此，唤醒只
    // 作用于当前代的等待（旧代残留等待醒来后由代际守卫直接退出，不串扰新代）
    this._internalWaits = new Set()
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
   * 防御：pause 落在 init 微任务窗口时 state 已置 paused——这里不得覆盖回 running，
   * 否则 resume() 因 state!=='paused' 直接返回、_pauseRequested 永不清除 → 任务
   * 永久卡在 _waitIfPaused（伪死锁）。
   * @returns {Promise<void>}
   */
  async run () {
    if (!this._pauseRequested) this._setState('running')
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
   * 任务内部等待（不触碰 paused 状态）。stop/pause 时提前返回。
   * 竞态守卫：stop() 先于 run 循环到达此处时（fire-and-forget 启动后立即 stop），
   * 立即返回而非挂起——否则 stop() 会空等 STOP_WAIT_TIMEOUT_MS。
   * per-wait token：唤醒只作用于当前代的等待；旧代协程残留的等待醒来后由代际
   * 守卫直接退出，其 finally 也只清自己代际的 waitingReason（不串扰新代）。
   * @param {number} ms
   * @param {string} reason 展示原因（如 no-target / inventory-full）
   */
  async _internalWait (ms, reason = 'wait') {
    if (this._stopRequested) return
    this.waitingReason = reason
    this.waitingSince = this.waitingSince ?? Date.now() // 首次进入等待时记录
    const gen = this._runGen
    try {
      await new Promise((resolve) => {
        const token = {
          resolve,
          timer: setTimeout(() => {
            this._internalWaits.delete(token)
            resolve()
          }, ms)
        }
        this._internalWaits.add(token)
      })
      if (gen !== this._runGen) return // 代际守卫：旧代残留等待醒来后直接退出
    } finally {
      // 只清当前代代的 waitingReason——旧代 finally 不得清掉新代设置的 reason
      if (gen === this._runGen) { this.waitingReason = null; this.waitingSince = null }
    }
  }

  /** 打断所有进行中的内部等待（stop/pause 调用）。 */
  _wakeInternalWait () {
    for (const t of this._internalWaits) {
      clearTimeout(t.timer)
      t.resolve()
    }
    this._internalWaits.clear()
  }

  /** 终态重置为 created（重启语义）。 */
  _reset () {
    this._state = 'created'
    this._stopRequested = false
    this._pauseRequested = false
    this.lastError = null
    this.startedAt = null
    this.waitingReason = null
    this.waitingSince = null
    this._runPromise = null
    this._pauseWaiters = []
    // 残留 token 一并清（防旧代等待占用槽位）；必须 clearTimeout 各 token 的
    // timer——只 clear Set 会让孤儿定时器存活到原等待时长（no-target 最长 5 分钟），
    // 维持事件循环引用并事后空转 resolve；_wakeInternalWait 本就 clearTimeout+resolve
    //（resolve 后旧代协程由代际守卫退出，无害）
    this._wakeInternalWait()
  }

  /**
   * 完整启动流程（由 TaskManager 调用）：init → run，返回 run 完成 Promise。
   * 已在 init/running/paused 时返回当前 run promise；终态自动重置后重启。
   */
  async start () {
    if (['init', 'running', 'paused'].includes(this._state)) return this._runPromise ?? null
    this._reset()
    this._runGen++ // 新代际：stop() 超时强制结束后旧 run 协程在下次循环检查时自弃
    const gen = this._runGen
    let runPromise = null
    try {
      await this.init()
      if (this._stopRequested) { this._setState('stopped'); return null }
      this.runCount++
      // run promise 绑定局部引用：_runPromise 是单槽字段，同 id 重启后会被新一代
      // 覆盖；start() 若返回/await 字段当前值，旧代调用方（startTask/runScheduled）
      // 会挂到新一代的 run 上（p 永不 settle / 误到时）
      runPromise = this.run(gen)
      this._runPromise = runPromise
      await runPromise
      // 自然完成判定限本代（gen 匹配）：stop 超时强制结束 + 同 id 重启后旧代协程
      // 醒来时 _stopRequested 已被新代 _reset 清空、state 是新代的 running，不加
      // 代际检查会把新代任务误置 completed
      if (gen === this._runGen && !this._stopRequested && this._state === 'running') this._setState('completed') // 自然完成
    } catch (err) {
      if (gen !== this._runGen) return null // 旧代际的失败不影响新 run 的状态
      this.lastError = err.message
      this._setState('failed')
      this.log.error({ err: err.message }, 'task failed')
      // 失败路径返回 null 而非已 reject 的 _runPromise：startTask/runScheduled 的
      // await p 不再收到 rejection（croner 漂浮 rejection → unhandledRejection →
      // fatalExit 停服，链在此断）
      return null
    }
    return runPromise
  }

  /** 当前 run 代际仍有效（start 换代后旧协程循环退出）。 */
  _alive (gen) {
    return gen === this._runGen && !this._stopRequested
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
      waitingSince: this.waitingSince,
      runCount: this.runCount
    }
  }
}
