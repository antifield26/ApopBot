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

  async run () {
    await super.run()
    const deadline = Date.now() + this._durationMs

    while (!this._stopRequested && Date.now() < deadline) {
      await this._waitIfPaused()

      if (this._stopWhenInventoryFull && this._inventoryFull()) {
        this.log.info('背包已满，停止钓鱼')
        break
      }

      try {
        await withTimeout(this.bot.fish(), 60 * 1000, 'fish attempt timeout')
        this.incr('caught')
        this.log.debug({ total: this.counters.caught }, 'fish caught')
      } catch (err) {
        this.log.warn({ err: err.message }, 'fish attempt failed, retrying in 5s')
        await this._internalWait(5 * 1000, 'fish-retry')
      }
    }
    this.log.info({ caught: this.counters.caught ?? 0 }, 'fish task finished')
  }

  _inventoryFull () {
    const slots = this.bot.inventory?.slots?.filter(Boolean) ?? []
    // 粗略判断：可用槽位不足 2 个视为满（留出手持/盔甲位）
    return slots.length >= 34
  }
}
