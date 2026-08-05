import { BaseTask } from './base.js'
import pathfinderPkg from 'mineflayer-pathfinder' // CJS 包：default 导入后解构（ESM named 互操作不可靠）
const { goals } = pathfinderPkg

// 战斗任务：区域内对敌对实体（entity.type === 'hostile'）进行巡逻战斗。
// 行为边界：区域限定（每轮重查 inArea）、低血自动进食/远离、攻击冷却、
// 击杀遥测（entityGone 监听）、maxTargets 上限。绝不追出区域。
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
    this._stopWhenNoTargets = o.stopWhenNoTargets !== false
    this._aggroRange = o.aggroRange ?? 12
    this._minHealth = o.minHealth ?? 8
    this._eatWhenLowHealth = o.eatWhenLowHealth !== false
    this._attackRange = o.attackRange ?? 3.5
    this._attackCooldownMs = o.attackCooldownMs ?? 400
    this._checkIntervalMs = (o.checkIntervalSeconds ?? 3) * 1000
    this._weaponName = typeof o.weapon === 'string' ? o.weapon : null // null = 自动找剑
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

  async run () {
    await super.run()
    this.bot.on('entityGone', this._onEntityGone)
    try {
      await this._loop()
    } finally {
      this.bot.removeListener('entityGone', this._onEntityGone)
    }
  }

  async _loop () {
    while (!this._stopRequested && (this._maxTargets === 0 || this.counters.kills < this._maxTargets)) {
      await this._waitIfPaused()

      // 低血优先处理：进食或撤离
      if (this.bot.entity.health < this._minHealth) {
        await this._handleLowHealth()
        continue
      }

      const target = this._findTarget()
      if (!target) {
        this._currentTarget = null
        try { this.bot.pathfinder.setGoal(null) } catch { /* 未在移动 */ }
        if (this._stopWhenNoTargets) {
          this.log.info('区域内没有敌对目标，任务完成')
          break
        }
        await this._internalWait(this._checkIntervalMs, 'no-target')
        continue
      }
      this._currentTarget = target

      // 距离内攻击，否则接近（每轮重查 inArea，绝不追出区域）
      const dist = this.bot.entity.position.distanceTo(target.position)
      if (dist > this._attackRange) {
        try {
          this.bot.pathfinder.setGoal(new goals.GoalNear(target.position, 2))
        } catch (err) {
          this.log.warn({ err: err.message }, '寻路失败')
          await this._internalWait(this._checkIntervalMs, 'path-retry')
        }
      } else {
        try { this.bot.pathfinder.setGoal(null) } catch { /* 已停 */ }
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
    return this.bot.nearestEntity((e) => {
      if (!e || e.type !== 'hostile') return false
      if (e === this.bot.entity) return false
      if (this.bot.entity.position.distanceTo(e.position) > this._aggroRange) return false
      if (this._area) {
        const { x, y, z } = e.position
        if (x < this._area.x1 || x > this._area.x2 || y < this._area.y1 || y > this._area.y2 || z < this._area.z1 || z > this._area.z2) return false
      }
      return true
    }, { kind: 'Hostile mobs' }) ?? null
  }

  /** 低血处理：autoEat 进食，失败则远离敌人。 */
  async _handleLowHealth () {
    try { this.bot.pathfinder.setGoal(null) } catch { /* 已停 */ }
    if (this._eatWhenLowHealth && this.bot.autoEat?.eat) {
      try {
        await this.bot.autoEat.eat()
        this.log.info('低血，自动进食')
        return
      } catch { /* 没有食物或正在进食 */ }
    }
    // 撤退：往远离最近敌人方向走 15 格
    const enemy = this.bot.nearestEntity((e) => e?.type === 'hostile' && e !== this.bot.entity)
    if (enemy) {
      const away = this.bot.entity.position.minus(enemy.position).normalize().scaled(15).plus(this.bot.entity.position)
      try {
        this.bot.pathfinder.setGoal(new goals.GoalBlock(away.x, away.y, away.z))
      } catch { /* 寻路失败忽略 */ }
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
    try { this.bot.pathfinder?.stop() } catch { /* 插件可能已卸载 */ }
  }
}
