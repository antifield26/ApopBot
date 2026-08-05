import { BaseTask } from './base.js'

// 挖矿任务：collectblock + pathfinder 在限定区域内挖掘指定方块。
export class MineTask extends BaseTask {
  async init () {
    super.init()
    const o = this.options
    if (!Array.isArray(o.blockTypes) || o.blockTypes.length === 0) {
      throw new Error('mine 任务需要 options.blockTypes（方块名数组）')
    }
    if (!this.bot.collectBlock || !this.bot.pathfinder) {
      throw new Error('mine 任务需要 collectBlock/pathfinder 插件')
    }
    // 解析方块 ID（26.1 用 stateId，minecraft-data 自动映射）
    this._blockIds = new Set()
    for (const name of o.blockTypes) {
      const block = this.bot.registry.blocksByName[name]
      if (!block) throw new Error(`未知方块类型: ${name}`)
      this._blockIds.add(block.id)
    }
    this._batchMax = o.maxBlocks ?? 64
  }

  async run () {
    await super.run()
    const o = this.options
    const radius = o.radius ?? 32
    const area = o.area

    while (!this._stopRequested) {
      await this._waitIfPaused()

      // 区域内查找目标方块
      let targets = this.bot.findBlocks({
        matching: (block) => this._blockIds.has(block.type),
        maxDistance: radius,
        count: this._batchMax
      })
      if (area) {
        targets = targets.filter(({ x, y, z }) =>
          x >= area.x1 && x <= area.x2 && y >= area.y1 && y <= area.y2 && z >= area.z1 && z <= area.z2)
        targets = targets.slice(0, this._batchMax)
      }

      if (targets.length === 0) {
        this.log.warn('区域内没有找到目标方块，暂停任务并稍后重试')
        this.lastError = 'no target blocks found in area'
        // 无可挖掘目标：进入 paused 并带重试定时器（5 分钟）
        this._setState('paused')
        await this._sleepUntilStoppedOrResumed(5 * 60 * 1000)
        if (!this._stopRequested && this._state === 'paused') this.resume()
        continue
      }

      this.log.info({ count: targets.length }, `mining ${o.blockTypes.join(',')}`)
      try {
        await this.bot.collectBlock.collect(targets, { maxDistance: radius })
      } catch (err) {
        this.log.warn({ err: err.message }, 'collect 中断（可能路径不可达）')
        // 等待后重试下一批
        await this._sleepUntilStoppedOrResumed(30 * 1000)
      }
    }
  }

  _sleepUntilStoppedOrResumed (ms) {
    return new Promise((resolve) => {
      if (this._stopRequested) { resolve(); return }
      const timer = setTimeout(() => {
        this._resumeNotify = null
        resolve()
      }, ms)
      this._resumeNotify = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  async stop () {
    await super.stop()
    this._resumeNotify?.()
  }

  async pause () {
    await super.pause()
    this._resumeNotify?.()
  }
}
