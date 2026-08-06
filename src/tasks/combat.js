import { BaseTask } from './base.js'
import { createMovement, stopPathfinding, clearGoal } from '../core/movement.js'

// 战斗任务：区域内对敌对实体（entity.type === 'hostile'）进行巡逻战斗。
// 行为边界：区域限定（每轮重查 inArea）、低血自动进食/远离、攻击冷却、
// 击杀遥测（entityGone 监听）、maxTargets 上限。绝不追出区域。
// 移动统一走 movement.js（approachEntity 接近/gotoPoint 撤退）——含到达判定、
// pause/stop 响应、超时兜底、统一清理（C2 迁移）。
export class CombatTask extends BaseTask {
  constructor (id, type, options, ctx) {
    super(id, type, options, ctx)
    this.exclusive = true
  }

  async init () {
    super.init()
    const o = this.options
    if (o.area !== undefined && !this._isArea(o.area)) {
      throw new Error('combat 任务 options.area 不完整（可省略或给全 x1..z2）')
    }
    if (!this.bot.pathfinder) throw new Error('combat 任务需要 pathfinder 插件')
    this._area = o.area ?? null
    this._maxTargets = o.maxTargets ?? 0 // 0 = 不限
    // 默认巡逻：无怪时持续等待而非立即"完成"（守卫语义——秒完成会被误认为指令无效）；
    // 一次性清理可显式配 stopWhenNoTargets: true
    this._stopWhenNoTargets = o.stopWhenNoTargets === true
    this._aggroRange = o.aggroRange ?? 12
    this._minHealth = o.minHealth ?? 8
    this._eatWhenLowHealth = o.eatWhenLowHealth !== false
    this._attackRange = o.attackRange ?? 3.5
    this._attackCooldownMs = o.attackCooldownMs ?? 400
    this._checkIntervalMs = (o.checkIntervalSeconds ?? 3) * 1000
    this._weaponName = typeof o.weapon === 'string' ? o.weapon : null // null = 自动找剑
    // 敌对实体判定防御：entity.type 依赖实体数据表 internalId 映射（协议 775 为 PR pin，
    // 发包值与表不一致时 type 退化为 'other'）——按 entityType（数据表 id，26.1 下 == internalId）
    // 二次匹配 hostile 集合，保证"找不到怪"不是数据映射问题
    this._hostileIds = new Set(
      (this.bot.registry?.entitiesArray ?? [])
        .filter(e => e.type === 'hostile')
        .map(e => e.id)
    )
    this._move = createMovement(this.bot, this.log) // 统一移动层（C2）
    this._currentTarget = null
    this._onEntityGone = (entity) => {
      if (entity === this._currentTarget) {
        this._currentTarget = null
        this.incr('kills')
        this.log.debug({ kills: this.counters.kills }, 'target eliminated')
      }
    }
  }

  _isArea (a) {
    return a && ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].every(k => Number.isInteger(a[k]))
  }

  async run (gen) {
    await super.run()
    this.bot.on('entityGone', this._onEntityGone)
    try {
      await this._loop(gen)
    } finally {
      this.bot.removeListener('entityGone', this._onEntityGone)
    }
  }

  async _loop (gen) {
    // 注意：counters.kills 在首次 entityGone 前是 undefined——用 ?? 0 比较，
    // 否则 `undefined < maxTargets` 为 false → 配置 maxTargets 的任务第一轮即"完成"（测试安全网实测）
    while (this._alive(gen) && (this._maxTargets === 0 || (this.counters.kills ?? 0) < this._maxTargets)) {
      await this._waitIfPaused()

      // 低血优先处理：进食或撤离。注意 bot.entity.health 在协议 775 下恒 undefined
      // （实测），改走 update_health 通道的 bot.health；未更新前按满血 20 处理
      if ((this.bot.health ?? 20) < this._minHealth) {
        await this._handleLowHealth()
        continue
      }

      const target = this._findTarget()
      if (!target) {
        this._currentTarget = null
        clearGoal(this.bot)
        if (this._stopWhenNoTargets) {
          this.log.info('区域内没有敌对目标，任务完成')
          break
        }
        await this._internalWait(this._checkIntervalMs, 'no-target')
        continue
      }
      this._currentTarget = target

      // 距离内攻击，否则移动层接近（approachEntity：到达判定/pause 响应/超时兜底）。
      // 行为变化：approach 期间不换目标（原每轮重扫）——由 30s 超时 + 循环顶部重扫兜底；
      // isInterrupted 含 aggroRange 检查保住"绝不追出区域/范围"语义
      const dist = this.bot.entity.position.distanceTo(target.position)
      if (dist > this._attackRange) {
        const r = await this._move.approachEntity(target, {
          range: Math.min(2, this._attackRange - 0.5), // 停点保证能攻击到（attackRange 3.5）
          timeoutMs: 30000,
          isInterrupted: () => this._stopRequested || this._pauseRequested ||
            !target?.position ||
            this.bot.entity.position.distanceTo(target.position) > this._aggroRange
        })
        if (!r.ok && r.reason !== 'interrupted') {
          this.log.warn({ reason: r.reason, err: r.err?.message }, '接近目标失败')
          await this._internalWait(this._checkIntervalMs, 'path-retry')
        }
      } else {
        clearGoal(this.bot) // 攻击前清残留 goal（防 pathfinder 继续走旧目标）
        await this._equipWeapon()
        try {
          this.bot.attack(target)
          this.incr('attacks')
          await new Promise(r => setTimeout(r, this._attackCooldownMs))
        } catch (err) {
          this.log.warn({ err: err.message }, 'attack 失败')
          await this._internalWait(this._checkIntervalMs, 'attack-fail')
        }
      }

      await this._internalWait(Math.min(this._checkIntervalMs, 500), 'combat-scan')
    }
  }

  _findTarget () {
    const myPos = this.bot.entity.position
    // 无目标时 debug 记录实体类型分布——线上确认"找不到怪"是环境还是数据映射问题
    const target = this.bot.nearestEntity((e) => {
      if (!e || !this._isHostile(e)) return false
      if (e === this.bot.entity) return false
      if (this.bot.entity.position.distanceTo(e.position) > this._aggroRange) return false
      if (this._area) {
        const { x, y, z } = e.position
        if (x < this._area.x1 || x > this._area.x2 || y < this._area.y1 || y > this._area.y2 || z < this._area.z1 || z > this._area.z2) return false
      }
      return true
    }, { kind: 'Hostile mobs' }) ?? null
    if (!target) {
      const list = this.bot.entities?.values ? [...this.bot.entities.values()] : null
      const nearby = list ? list.slice(0, 12)
        .map(e => `${e.name ?? '?'}:${e.type ?? '?'}:${e.entityType ?? '?'}`).join(', ') : '(无实体表)'
      this.log.debug({ nearby }, 'combat 未找到目标（实体类型分布）')
    }
    return target
  }

  /** 敌对判定：type === 'hostile'（数据表映射正常）或 entityType 命中 hostile 集合（防御）。 */
  _isHostile (e) {
    if (e.type === 'hostile') return true
    return this._hostileIds.has(e.entityType)
  }

  /** 低血处理：autoEat 进食，失败则远离敌人。 */
  async _handleLowHealth () {
    clearGoal(this.bot)
    if (this._eatWhenLowHealth && this.bot.autoEat?.eat) {
      try {
        await this.bot.autoEat.eat()
        this.log.info('低血，自动进食')
        return
      } catch { /* 没有食物或正在进食 */ }
    }
    // 撤退：往远离最近敌人方向走 15 格（移动层 gotoPoint——到达即返回，
    // 优于原 fire-and-forget + 固定 10s 睡眠）
    const enemy = this.bot.nearestEntity((e) => e && this._isHostile(e) && e !== this.bot.entity)
    if (enemy) {
      const away = this.bot.entity.position.minus(enemy.position).normalize().scaled(15).plus(this.bot.entity.position)
      const r = await this._move.gotoPoint(away, { timeoutMs: 10000 })
      if (!r.ok) this.log.warn({ reason: r.reason }, '撤退寻路失败，原地等待')
    }
    await this._internalWait(10 * 1000, 'retreat-low-health')
  }

  /** 装备武器：显式 weapon 或背包第一个剑；无则空手。 */
  async _equipWeapon () {
    try {
      const item = this._weaponName
        ? this.bot.inventory.items().find(it => it.name === this._weaponName)
        : this.bot.inventory.items().find(it => /sword$/.test(it.name))
      if (item) await this.bot.equip(item, 'hand')
    } catch (err) {
      this.log.warn({ err: err.message }, '武器装备失败（空手继续）')
    }
  }

  async _cancel () {
    stopPathfinding(this.bot)
  }
}
