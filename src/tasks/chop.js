import { BaseTask } from './base.js'
import { stopPathfinding } from '../core/movement.js'

// 伐木任务：区域内查找原木/木头方块并收集。
// 默认匹配所有名字匹配 /_log$|_wood$/ 的方块；可用 logTypes 指定。
export class ChopTask extends BaseTask {
  constructor (id, type, options, ctx) {
    super(id, type, options, ctx)
    this.exclusive = true
  }

  async init () {
    super.init()
    const o = this.options
    if (!this._isArea(o.area)) throw new Error('chop 任务需要 options.area（完整 x1..z2 六坐标）')
    this._batchMax = o.maxBlocks ?? 64
    this._radius = o.radius ?? 48
    // 默认巡逻：无树时等待（树会重新长）而非秒完成——与 combat 同款防"指令无效"误判；
    // 一次性伐光显式配 stopWhenDone: true
    this._stopWhenDone = o.stopWhenDone === true
    const registry = this.bot.registry
    if (!registry?.blocksByName) throw new Error('chop 任务需要 bot.registry（minecraft-data 数据）')

    this._logIds = new Set()
    if (Array.isArray(o.logTypes) && o.logTypes.length > 0) {
      for (const name of o.logTypes) {
        const block = registry.blocksByName[name]
        if (!block) throw new Error(`未知方块类型: ${name}`)
        this._logIds.add(block.id)
      }
    } else {
      // 默认：所有名字匹配 /_log$/ 或 /_wood$/ 的方块
      for (const [name, block] of Object.entries(registry.blocksByName)) {
        if (/_log$|_wood$/.test(name)) this._logIds.add(block.id)
      }
    }
  }

  _isArea (a) {
    return a && ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].every(k => Number.isInteger(a[k]))
  }

  async run (gen) {
    await super.run()
    const area = this.options.area

    while (this._alive(gen)) {
      await this._waitIfPaused()

      let targets = this.bot.findBlocks({
        matching: (block) => this._logIds.has(block.type),
        maxDistance: this._radius,
        count: this._batchMax
      })
      if (area) {
        // C8/R 同款：bot 距区域中心超过扫描半径时区域必然扫不到——告警而非静默 no-target
        if (this.bot.entity?.position) {
          const d = Math.hypot(
            this.bot.entity.position.x - (area.x1 + area.x2) / 2,
            this.bot.entity.position.z - (area.z1 + area.z2) / 2)
          if (d > this._radius) {
            this.log.warn({ dist: Math.round(d), radius: this._radius }, 'bot 距区域中心超出扫描半径——请靠近区域或调整 radius')
          }
        }
        targets = targets.filter(({ x, y, z }) =>
          x >= area.x1 && x <= area.x2 && y >= area.y1 && y <= area.y2 && z >= area.z1 && z <= area.z2)
        targets = targets.slice(0, this._batchMax)
      }

      if (targets.length === 0) {
        if (this._stopWhenDone) {
          this.log.info('区域内没有可伐的树，任务完成')
          break // 自然完成 → completed
        }
        this.log.warn('区域内没有找到可伐的树，等待重试')
        await this._internalWait(5 * 60 * 1000, 'no-target')
        continue
      }

      // collectblock 需要 Block/Entity（target.position），findBlocks 返回 Vec3[]——先转 Block
      const blocks = targets.map(p => this.bot.blockAt(p)).filter(Boolean)
      if (blocks.length === 0) {
        this.log.warn('区域内原木不在已加载区块，等待重试')
        await this._internalWait(30 * 1000, 'collect-retry')
        continue
      }

      this.log.info({ count: blocks.length }, 'chopping')
      try {
        // C4/J：分批 collect，批间响应 pause/stop（在途批次 ≤4 块，暂停延迟有界）
        for (let i = 0; i < blocks.length; i += 4) {
          if (this._stopRequested) break
          if (this._pauseRequested) await this._waitIfPaused()
          if (this._stopRequested) break
          const batch = blocks.slice(i, i + 4)
          await this.bot.collectBlock.collect(batch, {})
          this.incr('chopped', batch.length)
        }
      } catch (err) {
        if (err?.code === 'NoChests' || /no defined chest locations/i.test(String(err?.message))) {
          this.log.warn('背包已满（伐木），暂停等待清空')
          await this._internalWait(5 * 60 * 1000, 'inventory-full')
        } else {
          this.log.warn({ err: err.message }, 'collect 中断，稍后重试')
          await this._internalWait(30 * 1000, 'collect-retry')
        }
      }
    }
    this.log.info({ counters: this.counters }, 'chop task finished')
  }

  async _cancel () {
    try { this.bot.collectBlock?.cancelTask() } catch { /* 插件可能已卸载 */ }
    stopPathfinding(this.bot) // cancelTask 已含 stop，幂等兜底
  }
}
