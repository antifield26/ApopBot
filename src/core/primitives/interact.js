// @ts-check
// 动作原语注册表（按族拆分）：LLM act 动作数组与任务脚本共用的原子动作层。
// 每个原语 { schema, permission, exclusiveClass, guardText, timeoutMs, cooldownMs?, handler }。
// 约定（与 skills.execute 同源，由 executor 统一执行管线保证）：
// - handler(ctx, args, runtime) 返回 result（成功）；业务性"无事可做"（无目标/
//   无物品/冷却）也返回文案（ok:true——动作已有效执行）；真正的异常 throw
//   （executor 转 { ok:false, result: err.message }）
// - runtime = { signal: AbortSignal|null, user, taskId }——signal 贯通长时等待
//   （fish/eat/wait 的 race；movement 的 isInterrupted 组合谓词）
// - exclusive 守卫统一上提 executor（按 exclusiveClass），handler 不再自查
// 权限分级：观察/流程类 all；会改变世界状态（移动/构建/战斗/交互/物品/任务）op。
// 观察类返回结构化对象（LLM 收到 JSON、脚本读字段）；动作类返回简短中文文案。
// 交互（op / interact，exclusive 拒绝）
import { withTimeout } from '../../util/promise-timeout.js'
import { nearbyEntities } from '../entities.js'
import { createMovement, REASON_TEXT } from '../movement.js'
import { useEntityOn } from '../entity-actions.js'
import { SEED_BY_CROP } from '../crops.js'
import { interruptibleSleep } from './common.js'

// 喂食时间表（模块级）：minFeedIntervalMs 冷却判定用。按实体 id 记录最近喂食
// 时间——实体 id 由服务端复用，超过 1 小时未喂食的记录清除（防无限增长/陈旧
// id 误伤新实体）
const lastFedTs = new Map()
const FEED_TS_TTL_MS = 60 * 60 * 1000

/** 测试钩子：清空喂食冷却表（模块级状态跨测试文件累积——单进程模式防污染）。 */
export function _resetFeedTs () {
  lastFedTs.clear()
}

function pruneFeedTs (nowTs) {
  for (const [id, ts] of lastFedTs) {
    if (nowTs - ts > FEED_TS_TTL_MS) lastFedTs.delete(id)
  }
}

/**
 * 注册interact族原语。register = index.js 工厂注入的注册函数（含重复注册检查）；
 * _ctx 保留供族文件间约定签名（handler 经 c 首参取 ctx，不经此参数）。
 */
export function registerInteract (register, _ctx) {
  // ============ 交互（op / interact，exclusive 拒绝） ============
  register('interact_entity', {
    schema: {
      type: 'object',
      required: ['filter'],
      properties: {
        filter: { type: ['string', 'array'], description: '实体名子串或名称数组（如 cow/chicken——喂食繁殖用）' },
        foodName: { type: 'string', description: '食物物品名（如 wheat；缺省用背包自动匹配）' },
        count: { type: 'integer', min: 1, max: 10, description: '喂食次数（默认 2）' },
        useCooldownMs: { type: 'integer', min: 500, max: 30000, description: '喂食间隔（默认 3000）' },
        minFeedIntervalMs: { type: 'integer', min: 0, max: 3600000, description: '同一动物最小喂食间隔 ms（0=不限；breed 用 300000=MC 繁殖冷却）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'interact',
    guardText: '交互',
    timeoutMs: 30000,
    handler: async (c, { filter, foodName, count = 2, useCooldownMs = 3000, minFeedIntervalMs = 0 }, runtime) => {
      if (!c.bot?.entity?.position) throw new Error('位置不可用')
      const nowTs = Date.now()
      pruneFeedTs(nowTs)
      // filter 支持字符串（name 子串）与数组（任一匹配——breed 的 animalTypes）
      const filters = Array.isArray(filter) ? filter.map(f => String(f).toLowerCase()) : null
      const f = typeof filter === 'string' ? filter.toLowerCase() : null
      const matches = []
      for (const e of c.bot.entities instanceof Map ? c.bot.entities.values() : Object.values(c.bot.entities)) {
        if (!e || e === c.bot.entity || !e.position) continue
        const name = String(e.name ?? '').toLowerCase()
        if (filters ? !filters.some(x => name.includes(x)) : (f && !name.includes(f))) continue
        matches.push(e)
      }
      if (matches.length === 0) return { fed: 0, targetGone: false, reason: `附近没有匹配 ${JSON.stringify(filter)} 的实体` }
      matches.sort((a, b) => a.position.distanceTo(c.bot.entity.position) - b.position.distanceTo(c.bot.entity.position))
      // 喂食冷却：MC 繁殖冷却 5 分钟，同一动物冷却期内重复喂食不产生繁殖——
      // 连续数轮会导致 breed 计数虚报完成（实际零繁殖）。minFeedIntervalMs>0 时
      // 每喂一次重选下一只合格动物（同只连续喂 count 次浪费食物且不繁殖）
      const cooldownOf = (e) => {
        if (minFeedIntervalMs <= 0) return 0
        const last = lastFedTs.get(e.id)
        if (last === undefined) return 0
        return Math.max(0, minFeedIntervalMs - (nowTs - last))
      }
      // breed._feed 同款：找食物（参数优先，缺省按种子表自动匹配）→ equip → useEntityOn×count
      const food = foodName
        ? c.bot.inventory?.items()?.find(it => it.name === foodName)
        : c.bot.inventory?.items()?.find(it => Object.values(SEED_BY_CROP).includes(it.name))
      if (!food) return { fed: 0, targetGone: false, reason: `背包里没有可喂食的食物（${foodName ?? '种子类'}）` }
      await withTimeout(c.bot.equip(food, 'hand'), 10000, 'equip timeout')
      let fed = 0
      for (let i = 0; i < count; i++) {
        const target = matches.find(e => cooldownOf(e) === 0)
        if (!target) break // 全部处于冷却
        // 喂食前目标存在检查（写无效 entityId 的 use_entity 包按协议违规处理）
        const alive = c.bot.entities instanceof Map ? c.bot.entities.has(target.id) : !!c.bot.entities?.[target.id]
        if (!alive) return { fed, targetGone: true, targetName: target.name }
        // 距离门 + 接近：服务端 reach 校验对 ~>4 格交互静默拒绝——不接近则 fed++
        // 假成功（繁殖计数虚报、冷却表照记、实际零繁殖）；旧版 breed 的
        // approachEntity 在脚本化后回归，此处补回统一语义（坐标直算距离——
        // 不依赖 Vec3 方法，plain object 亦可用）
        const dp = target.position
        const dist = Math.hypot(dp.x - c.bot.entity.position.x, dp.y - c.bot.entity.position.y, dp.z - c.bot.entity.position.z)
        if (dist > 4) {
          const move = await createMovement(c.bot, c.logger).approachEntity(target, {
            range: 3,
            timeoutMs: 15000,
            isInterrupted: () => runtime?.signal?.aborted === true || !target?.position
          })
          if (!move.ok) {
            return { fed, targetGone: false, targetName: target.name, reason: `无法接近: ${REASON_TEXT[move.reason] ?? move.err?.message}` }
          }
        }
        useEntityOn(c.bot, target) // 走 entity-actions 原始包
        // 冷却表只在启用间隔时记录（默认 0 的 LLM act 调用不写表——无冷却语义
        // 且避免跨调用污染）
        if (minFeedIntervalMs > 0) lastFedTs.set(target.id, nowTs)
        fed++
        // 片间等待可中断（stop 后不再空等片间间隔——3s/次 × count 上限 10）
        if (i < count - 1) await interruptibleSleep(useCooldownMs, runtime?.signal)
      }
      if (fed === 0) {
        // 全冷却（脚本据此区分"冷却中"与"无食物"——冷却等待有明确残余时间）
        const maxRemain = matches.reduce((m, e) => Math.max(m, cooldownOf(e)), 0)
        if (maxRemain > 0) return { fed: 0, targetGone: false, cooldownMs: Math.round(maxRemain), reason: '匹配动物均处于喂食冷却' }
      }
      return { fed, targetGone: false, targetName: matches[0].name }
    }
  })
  register('harvest_animals', {
    schema: {
      type: 'object',
      required: ['filter'],
      properties: {
        filter: { type: 'string', description: '动物名/类型（sheep 剪羊毛；chicken 捡蛋）' },
        max: { type: 'integer', min: 1, max: 10, description: '最多处理数（默认 3）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'interact',
    guardText: '动物收获',
    timeoutMs: 30000,
    handler: async (c, { filter, max }) => {
      const lower = String(filter ?? '').toLowerCase()
      const count = max ?? 3
      const out = []
      if (lower.includes('sheep')) {
        // 剪羊毛：equip shears → 走近 → 右键（useEntityOn 原始包）
        const shears = c.bot.inventory?.items()?.find(it => it.name === 'shears')
        if (!shears) return { sheared: 0, reason: '没有剪刀（shears）' }
        const sheep = nearbyEntities(c.bot, { name: 'sheep', maxDistance: 24, limit: count })
        let sheared = 0
        for (const e of sheep) {
          if (!e?.position) continue
          const move = await createMovement(c.bot, c.logger).approachEntity(e, { range: 3, timeoutMs: 15000 })
          if (!move.ok) continue
          try {
            await withTimeout(c.bot.equip(shears, 'hand'), 10000, 'equip timeout')
            useEntityOn(c.bot, e)
            sheared++
          } catch { /* 剪毛失败跳过该只 */ }
        }
        out.push(`剪毛 ${sheared} 只`)
      }
      if (lower.includes('chicken')) {
        // 收鸡蛋：走近 item 实体（蛋/羽毛掉落物——实体碰撞自动拾取）
        const items = nearbyEntities(c.bot, { kind: 'item', maxDistance: 24, limit: count })
        let collected = 0
        for (const e of items) {
          if (!e?.position) continue
          const move = await createMovement(c.bot, c.logger).approachEntity(e, { range: 2, timeoutMs: 15000 })
          if (move.ok) collected++
        }
        out.push(`拾取掉落物 ${collected} 个`)
      }
      return out.length ? { done: out.join('；') } : { done: '没有匹配的动物/掉落物' }
    }
  })

}
