import { BaseTask } from './base.js'

// AFK 任务：周期性微小视角转动，防 Paper afk-kick-timeout 踢出。
// 注意：更可靠的做法是服务端 server.properties 调大/关闭 afk-kick-timeout。
export class AfkTask extends BaseTask {
  async init () {
    super.init()
    const o = this.options
    if (typeof o.intervalMinutes !== 'number') throw new Error('afk 任务需要 options.intervalMinutes')
    this._intervalMs = o.intervalMinutes * 60 * 1000
  }

  async run () {
    await super.run()

    while (!this._stopRequested) {
      await this._waitIfPaused()
      await this._sleep(this._intervalMs)
      if (this._stopRequested) break

      // 微小的视角转动即可重置 afk 计时
      const yaw = this.bot.entity.yaw + 0.05
      this.bot.look(yaw, this.bot.entity.pitch, true)
      this.log.debug('afk wiggle')
    }
  }

  _sleep (ms) {
    return new Promise((resolve) => {
      // 竞态守卫：stop() 可能在 run() 到达 _sleep 之前已执行
      if (this._stopRequested) { resolve(); return }
      this._sleepResolve = resolve
      this._sleepTimer = setTimeout(resolve, ms)
    })
  }

  async stop () {
    clearTimeout(this._sleepTimer)
    this._sleepResolve?.()
    await super.stop()
  }
}
