import { BaseTask } from './base.js'
import { Vec3 } from 'vec3'
import { createMovement, stopPathfinding } from '../core/movement.js'
import { spiralWaypoints, sampleResources, scanEntities, SPIRAL_STEP, notifyValuableFound } from '../core/explore.js'
import * as discovery from '../core/discovery.js'

// 探索任务（L2 进化 C2）：后台持续探索——从中心方形螺旋向外游荡，每站采样记录
// 资源与实体（发现写入 DiscoveryMap，LLM 经 query_map 查询）。exclusive 互斥
//（与 combat/breed 同：动 pathfinder，与 follow/其他移动任务互斥）。
//
// 行为边界：
//   - maxDistance 站点半径上限（默认 256；螺旋环半径超过后 stopWhenDone 自然完成，
//     否则以当前位置为新中心重启螺旋——有界漫游，永不"走丢"）
//   - area 可选：站点裁剪到盒内，连续 16 站被裁视为覆盖完成
//   - 不战斗：低血靠 autoEat（死亡由 feature-layer 现成管道：暂停→重生→恢复；
//     waypoint 是绝对坐标，重生后继续有效）
//   - 移动全走 movement.js（end-race/墙钟超时/断线兜底免费获得）
export class ExploreTask extends BaseTask {
  constructor (id, type, options, ctx) {
    super(id, type, options, ctx)
    this.exclusive = true
  }

  async init () {
    super.init()
    const o = this.options
    if (o.area !== undefined && !this._isArea(o.area)) {
      throw new Error('explore 任务 options.area 不完整（可省略或给全 x1..z2）')
    }
    if (!this.bot.pathfinder) throw new Error('explore 任务需要 pathfinder 插件')
    this._area = o.area ?? null
    this._maxDistance = Math.min(256, o.maxDistance ?? 256) // 纵深钳制（同步枚举防线）
    this._stopWhenDone = o.stopWhenDone === true
    this._checkIntervalMs = (o.checkIntervalSeconds ?? 3) * 1000
    this._move = createMovement(this.bot, this.log)
    this._consecutiveTrimmed = 0 // 连续被 area 裁剪的站点数（覆盖完成判定）
    this._center = this.bot.entity?.position
      ? { x: Math.floor(this.bot.entity.position.x), z: Math.floor(this.bot.entity.position.z) }
      : { x: 0, z: 0 }
  }

  _isArea (a) {
    return a && ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].every(k => Number.isInteger(a[k]))
  }

  async run (gen) {
    await super.run()
    // 环到 maxDistance 后以当前位置为新中心重启螺旋（有界漫游）
    while (this._alive(gen)) {
      await this._waitIfPaused()
      const waypoints = spiralWaypoints(this._center.x, this._center.z, this._maxDistance, SPIRAL_STEP)
      let finished = false
      this.incr('rings') // 本环开始（螺旋代际计数）
      for (const wp of waypoints) {
        if (!this._alive(gen)) return
        await this._waitIfPaused()
        // area 裁剪：站点在盒外 → 跳过（连续 16 站被裁 = 覆盖完成）
        if (this._area && !this._inArea(wp)) {
          this._consecutiveTrimmed++
          if (this._consecutiveTrimmed >= 16 && this._stopWhenDone) {
            this.log.info('区域已覆盖（连续 16 站在区域外），任务完成')
            finished = true
            break
          }
          continue
        }
        this._consecutiveTrimmed = 0
        await this._visitStation(gen, wp)
      }
      if (finished || !this._alive(gen)) break
      if (this._stopWhenDone) {
        this.log.info({ rings: this.counters.rings ?? 0 }, '螺旋完成（stopWhenDone），任务结束')
        break
      }
      // 无 stopWhenDone：以当前位置为新中心重启（计数器累积）
      const p = this.bot.entity?.position
      if (p) this._center = { x: Math.floor(p.x), z: Math.floor(p.z) }
    }
    this.log.info({ counters: this.counters }, 'explore task finished')
  }

  /**
   * 站点地面 y 采样（P2-4，第五轮）：从 bot 当前 y 向下找第一个非空方块——
   * 此前用 bot 当前 y 作站点高度，悬崖/山顶/峡谷壁站点高差 >3 → 大量 NoPath
   * 计入 unreachable 跳过（探索效率损失）。每站 1-2 次 blockAt，代价极小。
   */
  _groundY (x, z) {
    try {
      const start = Math.floor(this.bot.entity?.position?.y ?? 64)
      for (let y = start; y > start - 48; y--) {
        const b = this.bot.blockAt(new Vec3(x, y, z)) // 26.1 blockAt 必须 Vec3 实例
        if (b && b.boundingBox !== 'empty') return y + 1 // 站在方块上面
      }
    } catch { /* 区块未加载——回落当前 y */ }
    return Math.floor(this.bot.entity?.position?.y ?? 64)
  }

  /** 一站：寻路到达 → 采样记录资源 → 实体扫描 → 锚点登记 → 节奏等待。 */
  async _visitStation (gen, wp) {
    const r = await this._move.gotoPoint({ x: wp.x, y: this._groundY(wp.x, wp.z), z: wp.z }, {
      range: 3,
      timeoutMs: 45000,
      isInterrupted: () => this._stopRequested || this._pauseRequested
    })
    if (!r.ok && r.reason !== 'interrupted') {
      this.log.warn({ reason: r.reason, wp }, '站点不可达，跳过')
      this.incr('unreachable')
    } else if (r.ok) {
      this.incr('waypoints')
      const found = sampleResources(this.bot)
      if (found.length) {
        this.incr('discovered', found.length)
        for (const f of found) this.incr(`res:${f.name}`)
        // D：重要资源 webhook 推送（节流 10 分钟/类型；失败静默）。
        // P2-2：实时配置（reload 后构造时冻结的 ctx.config 是旧引用）
        notifyValuableFound(this.ctx.getConfig?.() ?? this.ctx.config, this.log, found)
      }
      const ents = scanEntities(this.bot)
      if (ents.counts.hostile > 0) this.log.info({ hostile: ents.hostile }, '站点附近有敌对实体（只记录不接触）')
      discovery.recordAnchor(this.bot.entity?.position)
    }
    await this._internalWait(Math.min(this._checkIntervalMs, 500), 'explore-station')
  }

  _inArea (wp) {
    const a = this._area
    return wp.x >= a.x1 && wp.x <= a.x2 && wp.z >= a.z1 && wp.z <= a.z2
  }

  async _cancel () {
    stopPathfinding(this.bot)
  }
}
