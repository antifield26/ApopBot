import { BaseTask } from './base.js'
import { withTimeout } from '../util/promise-timeout.js'

// 钓鱼任务：bot.fish() 循环挂机钓鱼，按时长或背包满停止。
// 每次抛竿以 60s 超时兜底（mineflayer 的 fish() 无超时，可能永久挂起 —— F1）。
export class FishTask extends BaseTask {
  async init () {
    super.init()
    const o = this.options
    if (typeof o.durationMinutes !== 'number') throw new Error('fish 任务需要 options.durationMinutes')
    this._durationMs = o.durationMinutes * 60 * 1000
    this._stopWhenInventoryFull = o.stopWhenInventoryFull ?? false
  }

  async run (gen) {
    await super.run()
    const deadline = Date.now() + this._durationMs

    while (this._alive(gen) && Date.now() < deadline) {
      await this._waitIfPaused()

      if (this._stopWhenInventoryFull && this._inventoryFull()) {
        this.log.info('背包已满，停止钓鱼')
        break
      }

      // 抛竿与取消信号 race：stop() 时 _cancel 解析取消信号 → run 协程立即退出，
      // 不再等 10s stop 上限（mineflayer 的 fish() 无超时，会一直挂到收杆）。
      // 悬空 fish promise 的 rejection 挂 noop catch 防 unhandledRejection 误杀进程。
      try {
        const fishP = withTimeout(this.bot.fish(), 60 * 1000, 'fish attempt timeout')
        fishP.catch(() => { /* race 丢弃分支的 rejection 已有 handler（成功路径由 race 消费） */ })
        const cancel = new Promise((resolve) => { this._cancelFish = resolve })
        const winner = await Promise.race([fishP, cancel])
        if (winner === 'cancel') break
        this.incr('caught')
        this.log.debug({ total: this.counters.caught }, 'fish caught')
      } catch (err) {
        this.log.warn({ err: err.message }, 'fish attempt failed, retrying in 5s')
        await this._internalWait(5 * 1000, 'fish-retry')
      }
    }
    this.log.info({ caught: this.counters.caught ?? 0 }, 'fish task finished')
  }

  /** F1：stop 时解析取消信号打断挂起的 bot.fish()（底层鱼竿由 fishing 插件下次抛竿自愈）。 */
  async _cancel () {
    if (this._cancelFish) {
      const r = this._cancelFish
      this._cancelFish = null
      r('cancel')
    }
  }

  _inventoryFull () {
    const slots = this.bot.inventory?.slots?.filter(Boolean) ?? []
    // 粗略判断：可用槽位不足 2 个视为满（留出手持/盔甲位）
    return slots.length >= 34
  }
}
