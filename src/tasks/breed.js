import { BaseTask } from './base.js'
import pathfinderPkg from 'mineflayer-pathfinder' // CJS 包：default 导入后解构（ESM named 互操作不可靠）
const { goals } = pathfinderPkg

// 养殖任务：区域内对白名单动物喂食繁殖（useOn 两次触发繁殖，等待幼崽生成）。
// 行为边界：区域限定、maxBreedings 上限（默认 4，退化安全）、useCooldown 防刷。
// 繁殖成功判定：目标动物 entityGone（成年个体被幼崽替换）计一次。
export class BreedTask extends BaseTask {
  constructor (id, type, options, ctx) {
    super(id, type, options, ctx)
    this.exclusive = true
  }

  async init () {
    super.init()
    const o = this.options
    if (o.area !== undefined && !this._isArea(o.area)) {
      throw new Error('breed 任务 options.area 不完整（可省略或给全 x1..z2）')
    }
    if (!this.bot.pathfinder) throw new Error('breed 任务需要 pathfinder 插件')
    this._area = o.area ?? null
    this._animalTypes = Array.isArray(o.animalTypes) && o.animalTypes.length > 0
      ? o.animalTypes
      : ['cow', 'sheep', 'pig', 'chicken']
    this._foodItem = typeof o.foodItem === 'string' ? o.foodItem : 'wheat'
    this._maxBreedings = o.maxBreedings ?? 4
    this._useCooldownMs = o.useCooldownMs ?? 3000
    this._currentAnimal = null
    this._onEntityGone = (entity) => {
      if (entity === this._currentAnimal) {
        // 成年个体消失（生成幼崽或死亡）：计一次繁殖
        this._currentAnimal = null
        this.incr('breedings')
        this.log.debug({ breedings: this.counters.breedings }, 'breeding success')
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
    while (this._alive(gen) && this.counters.breedings < this._maxBreedings) {
      await this._waitIfPaused()

      const animal = this._findAnimal()
      if (!animal) {
        this._currentAnimal = null
        try { this.bot.pathfinder.setGoal(null) } catch { /* 未在移动 */ }
        this.log.info('区域内没有可繁殖的动物，任务完成')
        break
      }
      this._currentAnimal = animal

      // 接近动物（3s 超时保护：寻路失败也不卡死）
      await this._approach(animal)
      if (this._stopRequested) break

      // 喂食（两次，间隔冷却）；失败（无食物/装备失败）等待重试而非忙等——
      // 修复审计发现：白名单动物在场但背包无食物时每轮微任务空转 + 日志刷屏
      if (!await this._feed(animal)) {
        await this._internalWait(30 * 1000, 'no-food')
        continue
      }

      // 等待幼崽生成/替换（最多 5s）
      await this._internalWait(5 * 1000, 'waiting-baby')
    }
    this.log.info({ counters: this.counters }, 'breed task finished')
  }

  _findAnimal () {
    return this.bot.nearestEntity((e) => {
      if (!e || e === this.bot.entity) return false
      if (!this._animalTypes.includes(e.name)) return false
      if (this._area) {
        const { x, y, z } = e.position
        if (x < this._area.x1 || x > this._area.x2 || y < this._area.y1 || y > this._area.y2 || z < this._area.z1 || z > this._area.z2) return false
      }
      return true
    }) ?? null
  }

  async _approach (animal) {
    try {
      this.bot.pathfinder.setGoal(new goals.GoalNear(animal.position, 2))
    } catch (err) {
      this.log.warn({ err: err.message }, '寻路失败')
      await this._internalWait(3 * 1000, 'path-retry')
      return
    }
    // 等待到达（轮询，上限 30s）
    const deadline = Date.now() + 30 * 1000
    while (!this._stopRequested && Date.now() < deadline) {
      if (this.bot.entity.position.distanceTo(animal.position) <= 3) break
      await new Promise(r => setTimeout(r, 500))
    }
    try { this.bot.pathfinder.setGoal(null) } catch { /* 已停 */ }
  }

  /** 装备食物并喂食两次。成功返回 true。 */
  async _feed (animal) {
    const food = this.bot.inventory?.items()?.find(it => it.name === this._foodItem)
    if (!food) {
      this.log.warn(`背包里没有食物 ${this._foodItem}，任务完成`)
      this._currentAnimal = null
      return false
    }
    try {
      await this.bot.equip(food, 'hand')
      for (let i = 0; i < 2; i++) {
        if (this._stopRequested) return false
        try {
          this.bot.useOn(animal)
          this.incr('fed')
        } catch (err) {
          this.log.warn({ err: err.message }, 'useOn 失败')
        }
        if (i === 0) await new Promise(r => setTimeout(r, this._useCooldownMs))
      }
      return true
    } catch (err) {
      this.log.warn({ err: err.message }, '喂食失败')
      return false
    }
  }

  async _cancel () {
    try { this.bot.pathfinder?.stop() } catch { /* 插件可能已卸载 */ }
  }
}
