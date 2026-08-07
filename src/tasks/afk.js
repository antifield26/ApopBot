import { BaseTask } from './base.js'

// AFK 任务：周期性微小视角转动，防 Paper afk-kick-timeout 踢出。
// 注意：更可靠的做法是服务端 server.properties 调大/关闭 afk-kick-timeout。
export class AfkTask extends BaseTask {
  async init () {
    super.init()
    const o = this.options
    // C5/I 修复：intervalMinutes ≤ 0 → _internalWait(≤0) 被 setTimeout 钳制为 ~1ms
    // → 无限近忙循环刷 look 包（可触发服务端包速率踢出 + 高 CPU）
    if (typeof o.intervalMinutes !== 'number' || !Number.isFinite(o.intervalMinutes) || o.intervalMinutes < 1) {
      throw new Error('afk 任务需要 options.intervalMinutes（≥1 分钟）')
    }
    this._intervalMs = o.intervalMinutes * 60 * 1000
  }

  async run (gen) {
    await super.run()

    while (this._alive(gen)) {
      await this._waitIfPaused()
      // 内部等待（stop/pause 可打断），不再需要自定义 _sleep/stop
      await this._internalWait(this._intervalMs, 'afk-sleep')
      if (this._stopRequested) break

      // 微小的视角转动即可重置 afk 计时
      try {
        const yaw = this.bot.entity.yaw + 0.05
        this.bot.look(yaw, this.bot.entity.pitch, true)
        this.incr('wiggles')
        this.log.debug({ wiggles: this.counters.wiggles }, 'afk wiggle')
      } catch (err) {
        this.log.warn({ err: err.message }, 'afk 视角转动失败')
      }
    }
  }
}
