import { BaseTask } from './base.js'
import { Vec3 } from 'vec3' // blockAt 必须传 Vec3 实例（普通对象触发 pos.floored 崩溃）
import { stopPathfinding } from '../core/movement.js'

// 农场任务：区域内 种植 → 等待成熟 → 收割 → 补种 的循环。
// 成熟度按方块 state 的 age 属性对照成熟表；收割用 collectBlock（掉落物自动收集）。
// 仅使用已验证 API：blockAt/getProperties/placeBlock/equip/collectBlock。
export class FarmTask extends BaseTask {
  constructor (id, type, options, ctx) {
    super(id, type, options, ctx)
    this.exclusive = true // 与 chop/combat/breed 互斥（都在动 pathfinder/collectBlock）
  }

  async init () {
    super.init()
    const o = this.options
    if (!this._isArea(o.area)) throw new Error('farm 任务需要 options.area（完整 x1..z2 六坐标）')
    if (!Array.isArray(o.cropTypes) || o.cropTypes.length === 0) {
      throw new Error('farm 任务需要 options.cropTypes（如 ["wheat"]）')
    }
    this._seedByCrop = { ...FarmTask.SEED_BY_CROP, ...(o.seedOverrides ?? {}) }
    for (const crop of o.cropTypes) {
      if (!(crop in FarmTask.CROP_MATURITY)) {
        throw new Error(`未知作物: ${crop}（已知: ${Object.keys(FarmTask.CROP_MATURITY).join(', ')}）`)
      }
      const block = this.bot.registry?.blocksByName?.[crop]
      if (!block) throw new Error(`未知方块类型: ${crop}`)
    }
    this._replant = o.replant !== false
    this._maxCycles = o.maxCycles ?? 1
    this._growthCheckMs = (o.growthCheckSeconds ?? 30) * 1000
    // 默认巡逻：区域空闲（无作物/无种子/无耕地）时等待而非秒完成——同款防误判；
    // 一次性配 stopWhenIdle: true
    this._stopWhenIdle = o.stopWhenIdle === true
  }

  _isArea (a) {
    return a && ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].every(k => Number.isInteger(a[k]))
  }

  async run (gen) {
    await super.run()
    const area = this.options.area
    let cycles = 0

    while (this._alive(gen) && (this._maxCycles === 0 || cycles < this._maxCycles)) {
      await this._waitIfPaused()

      const blocks = this._scanArea(area)
      const mature = blocks.filter(b => this._isMature(b))
      const immature = blocks.filter(b => this._isCrop(b) && !this._isMature(b))
      const farmland = blocks.filter(b => b.name === 'farmland')

      if (mature.length > 0) {
        this.log.info({ count: mature.length }, 'harvesting mature crops')
        try {
          await this.bot.collectBlock.collect(mature, {})
          this.incr('harvested', mature.length)
        } catch (err) {
          if (err?.code === 'NoChests' || /no defined chest locations/i.test(String(err?.message))) {
            this.log.warn('背包已满（收割），暂停等待清空')
            await this._internalWait(5 * 60 * 1000, 'inventory-full')
          } else {
            this.log.warn({ err: err.message }, 'harvest 中断，稍后重试')
            await this._internalWait(30 * 1000, 'harvest-retry')
          }
          continue
        }
        cycles++
        continue
      }

      if (this._replant && farmland.length > 0 && this._hasSeed()) {
        const planted = await this._plant(farmland)
        if (planted > 0) {
          this.incr('planted', planted)
          cycles++
          continue
        }
      }

      if (immature.length > 0) {
        // 有未成熟作物：等待生长（内部等待，可被 stop/pause 打断）
        await this._internalWait(this._growthCheckMs, 'growing')
        continue
      }

      if (this._stopWhenIdle) {
        this.log.info('区域内没有可做的工作，任务完成')
        break // 自然完成 → completed
      }
      // 巡逻等待：玩家放种子/种下作物/成熟后下一轮继续
      await this._internalWait(this._growthCheckMs, 'idle')
      continue
    }
    this.log.info({ counters: this.counters }, 'farm task finished')
  }

  _scanArea (area) {
    // 逐格 blockAt（20×20×4 ≈ 1600 次/cycle）在低配机是纯 CPU 空转——
    // 改 findBlocks（客户端区块内扫描）后按区域过滤，与 mine/chop 同模式（B4）
    const anchor = this.bot.entity?.position ?? new Vec3(
      (area.x1 + area.x2) / 2, (area.y1 + area.y2) / 2, (area.z1 + area.z2) / 2)
    const diag = Math.hypot(area.x2 - area.x1, area.y2 - area.y1, area.z2 - area.z1)
    let found
    try {
      found = this.bot.findBlocks({
        matching: (b) => b.type !== 0,
        maxDistance: Math.ceil(diag) + 16, // 区域对角线 + 缓冲（锚点未必在区域中心）
        count: 10000
      })
    } catch { return [] } // 区块未加载/API 缺失
    return found
      .filter(({ x, y, z }) =>
        x >= area.x1 && x <= area.x2 && y >= area.y1 && y <= area.y2 && z >= area.z1 && z <= area.z2)
      .map(p => this.bot.blockAt(p))
      .filter(Boolean)
  }

  _isCrop (block) {
    return block.name in FarmTask.CROP_MATURITY
  }

  _isMature (block) {
    if (!this._isCrop(block)) return false
    const age = block.getProperties?.()?.age
    return typeof age === 'number' && age >= FarmTask.CROP_MATURITY[block.name]
  }

  _hasSeed () {
    // 注意：映射表 key 是作物名（wheat），库存物品名是种子名（wheat_seeds）——
    // 必须查 values。`it.name in map` 永远 false，导致 farm 永不种植（测试安全网实测）
    return this.bot.inventory?.items()?.some(it => Object.values(this._seedByCrop).includes(it.name)) ?? false
  }

  /** 在空耕地上种植（逐块：找种子 → 装备 → placeBlock）。返回成功种植数。 */
  async _plant (farmland) {
    let planted = 0
    for (const soil of farmland) {
      if (this._stopRequested || planted >= 8) break
      const seeds = this.bot.inventory?.items()?.find(it => Object.values(this._seedByCrop).includes(it.name))
      if (!seeds) break
      try {
        await this.bot.equip(seeds, 'hand')
        await this.bot.placeBlock(soil, { x: 0, y: 1, z: 0 }) // 种在耕地上方
        planted++
      } catch (err) {
        this.log.warn({ err: err.message }, '种植失败（可能没有种子或位置不可用）')
        break
      }
    }
    return planted
  }

  /** 收割/种植的进行中动作取消。 */
  async _cancel () {
    try { this.bot.collectBlock?.cancelTask() } catch { /* 插件可能已卸载 */ }
    stopPathfinding(this.bot) // cancelTask 已含 stop，幂等兜底
  }
}

FarmTask.CROP_MATURITY = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3 }
FarmTask.SEED_BY_CROP = {
  wheat: 'wheat_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
  nether_wart: 'nether_wart'
}
