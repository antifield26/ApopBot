import { BaseTask } from './base.js'

// 挖矿任务：collectblock + pathfinder 在限定区域内挖掘指定方块。
// 内部等待全部用 _internalWait（F3：不触碰用户暂停）；背包满（NoChests）单独识别
// 并暂停等待清空（F2）；stop 时取消进行中的 collect/pathfinder（F1）。
export class MineTask extends BaseTask {
  async init () {
    super.init()
    const o = this.options
    if (!Array.isArray(o.blockTypes) || o.blockTypes.length === 0) {
      throw new Error('mine 任务需要 options.blockTypes（方块名数组，无命名空间前缀）')
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
    this._radius = o.radius ?? 32
    this._chestLocations = Array.isArray(o.chestLocations) ? o.chestLocations : []
    this._stopWhenDone = o.stopWhenDone === true // F8：区域内挖空即完成
  }

  async run () {
    await super.run()
    const area = this.options.area

    while (!this._stopRequested) {
      await this._waitIfPaused()

      // 区域内查找目标方块（radius 只约束 findBlocks；collect 的 maxDistance 选项
      // 被 collectblock 忽略（F7），不再传）
      let targets = this.bot.findBlocks({
        matching: (block) => this._blockIds.has(block.type),
        maxDistance: this._radius,
        count: this._batchMax
      })
      if (area) {
        targets = targets.filter(({ x, y, z }) =>
          x >= area.x1 && x <= area.x2 && y >= area.y1 && y <= area.y2 && z >= area.z1 && z <= area.z2)
        targets = targets.slice(0, this._batchMax)
      }

      if (targets.length === 0) {
        if (this._stopWhenDone) {
          this.log.info('区域内无目标方块，任务完成')
          break // 自然完成 → completed
        }
        // F8：不再置 lastError（无目标不是失败）；F3：内部等待不置 paused
        this.log.warn('区域内没有找到目标方块，等待重试')
        await this._internalWait(5 * 60 * 1000, 'no-target')
        continue
      }

      this.log.info({ count: targets.length }, `mining ${this.options.blockTypes.join(',')}`)
      try {
        await this.bot.collectBlock.collect(targets, { chestLocations: this._chestLocations })
        this.incr('mined', targets.length)
      } catch (err) {
        if (err?.code === 'NoChests' || /no defined chest locations/i.test(String(err?.message))) {
          // F2：背包满且未配置箱子 → 暂停等待清空，而非 30s 死循环误报路径不可达
          this.log.warn('背包已满且未配置 chestLocations，暂停等待清空')
          await this._internalWait(5 * 60 * 1000, 'inventory-full')
        } else {
          this.log.warn({ err: err.message }, 'collect 中断，稍后重试')
          await this._internalWait(30 * 1000, 'collect-retry')
        }
      }
    }
  }

  /** F1：stop 时取消进行中的收集与寻路。 */
  async _cancel () {
    try { this.bot.collectBlock?.cancelTask() } catch { /* 插件可能已卸载 */ }
    try { this.bot.pathfinder?.stop() } catch { /* 同上 */ }
  }
}
