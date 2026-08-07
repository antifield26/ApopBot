import { BaseTask } from './base.js'
import { createMovement, stopPathfinding, clearGoal } from '../core/movement.js'
import { useEntityOn } from '../core/entity-actions.js'
import { withTimeout } from '../util/promise-timeout.js'

// 养殖任务：区域内对白名单动物喂食繁殖（useOn 两次触发繁殖，等待幼崽生成）。
// 行为边界：区域限定、maxBreedings 上限（默认 4，退化安全）、useCooldown 防刷。
// 繁殖成功判定：目标动物 entityGone（成年个体被幼崽替换）计一次。
// 移动统一走 movement.js（approachEntity 接近——含 pause 响应，修手写轮询不响应 pause 的缺陷）。
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
    // 默认巡逻：无动物时等待（动物可能未加载/未刷新）而非秒完成——同款防误判；
    // 一次性配 stopWhenNoAnimals: true
    this._stopWhenNoAnimals = o.stopWhenNoAnimals === true
    this._move = createMovement(this.bot, this.log) // 统一移动层（C2）
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
    // 同 combat：breedings 首次 entityGone 前是 undefined，?? 0 保证 maxBreedings 配置有效
    while (this._alive(gen) && (this.counters.breedings ?? 0) < this._maxBreedings) {
      await this._waitIfPaused()

      const animal = this._findAnimal()
      if (!animal) {
        this._currentAnimal = null
        clearGoal(this.bot)
        if (this._stopWhenNoAnimals) {
          this.log.info('区域内没有可繁殖的动物，任务完成')
          break
        }
        await this._internalWait(30 * 1000, 'no-animal')
        continue
      }
      this._currentAnimal = animal

      // 移动层接近（approachEntity：到达判定/pause 响应/超时兜底；30s 超时保护）
      const r = await this._move.approachEntity(animal, {
        range: 2,
        timeoutMs: 30000,
        isInterrupted: () => this._stopRequested || this._pauseRequested
      })
      if (!r.ok && r.reason !== 'interrupted') {
        this.log.warn({ reason: r.reason }, '接近动物失败')
        await this._internalWait(3 * 1000, 'path-retry')
      }
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

  /** 装备食物并喂食两次。成功返回 true。 */
  async _feed (animal) {
    const food = this.bot.inventory?.items()?.find(it => it.name === this._foodItem)
    if (!food) {
      // 文案修正：任务保持运行（外层 30s no-food 等待），不是"完成"——误导排障
      this.log.warn(`背包里没有食物 ${this._foodItem}，等待补货（任务保持运行）`)
      this._currentAnimal = null
      return false
    }
    try {
      // A4（第四轮）：equip 是事件驱动等待（PR 分支 simple_inventory 等包触发，
      // 断线后永不 settle）——10s 超时保护（同 combat 低血进食路径）
      await withTimeout(this.bot.equip(food, 'hand'), 10000, 'equip timeout')
      for (let i = 0; i < 2; i++) {
        if (this._stopRequested) return false
        // A4（第四轮）：喂食前目标存在检查（与 combat.js:128 攻击前同款）——
        // approach/equip 期间动物可死亡或被其他玩家繁殖掉，写无效 entityId 的
        // use_entity 包在部分服务端按协议违规处理（combat 断线排查同类）
        if (!this.bot.entities?.[animal.id]) {
          this._currentAnimal = null
          return false // 外层走 30s no-animal 重扫
        }
        try {
          // 项目层写包：bot.useOn 在 26.1 门控 bug 下回退损坏的旧式 use_entity
          //（缺 location）→ 序列化错误断线（与 combat 攻击同源）——见 entity-actions.js
          useEntityOn(this.bot, animal)
          this.incr('fed')
        } catch (err) {
          this.log.warn({ err: err.message }, 'useOn 失败')
        }
        if (i === 0) {
          // A4：裸 setTimeout 换 _internalWait——stop/pause 期间也能提前退出
          //（原实现只查 _stopRequested，pause 不响应）
          await this._internalWait(this._useCooldownMs, 'use-cooldown')
        }
      }
      return true
    } catch (err) {
      this.log.warn({ err: err.message }, '喂食失败')
      return false
    }
  }

  async _cancel () {
    stopPathfinding(this.bot)
  }
}
