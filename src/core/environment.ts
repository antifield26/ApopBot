// 环境快照构建器：environment 技能与自动注入共用。
// 数据源 26.1 已核实：
//   - bot.time（timeOfDay/isDay/age/moonPhase，服务端 time 包驱动）
//   - bot.isRaining + bot.thunderState（**无 bot.weather 字段**，game_state_change 包）
//   - bot.game.dimension（剥 minecraft: 前缀）
//   - bot.blockAt(脚).biome.name（prismarine-chunk 1.41.0 已支持；blockAt 未加载返回
//     null → unknown；biome id 未知 → biome_id 兜底，不虚构）
//   - yaw → 8 向罗盘（原版约定 yaw=0 南，顺时针增大）
// 安全：全字段 null 安全——缺失/异常逐项跳过，任何调用不抛（测试 makeCtx 缺字段不崩）。
// nearbyEntities/资源白名单在 src/core/{entities,resources}.js
//（core/explore.js 的 scanEntities 依赖它们——放本模块会造成 core→l2 上向引用）。

import { distance, fmtPos, nearbyEntities } from './entities.ts'
import * as discovery from './discovery.ts'

/** yaw → 8 向罗盘（原版：yaw=0 朝南 +Z，顺时针增大）。 */
export function directionFromYaw (yaw) {
  if (!Number.isFinite(yaw)) return '?'
  const deg = (((yaw * 180) / Math.PI) % 360 + 360) % 360
  const names = ['南', '西南', '西', '西北', '北', '东北', '东', '东南']
  return names[Math.round(deg / 45) % 8]
}

/**
 * 时间 hh:mm（timeOfDay 0-24000 ticks）。
 * Minecraft 语义：timeOfDay 0 = 日出（游戏钟 6:00）——必须加 6000 ticks（6 小时）
 * 偏移，否则 0 → 00:00，输出恒比游戏钟早 6 小时。
 */
export function formatTime (timeOfDay) {
  if (!Number.isFinite(timeOfDay)) return '?'
  const totalMin = Math.floor(((timeOfDay % 24000) + 6000) % 24000 / 1000 * 60)
  const h = String(Math.floor(totalMin / 60)).padStart(2, '0')
  const m = String(totalMin % 60).padStart(2, '0')
  return `${h}:${m}`
}

/** 附近玩家（按距离升序，entity 可 null 的跳过）。 */
export function nearbyPlayers (bot, limit = 5) {
  try {
    const me = bot?.entity
    return Object.values((bot?.players ?? {}) as Record<string, any>)
      .map(p => ({
        name: p.username,
        entity: p.entity,
        dist: distance(me, p.entity)
      }))
      .filter(x => x.entity && x.dist !== null)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, limit)
  } catch {
    return []
  }
}

/** 生物群系名（blockAt 未加载/未知 id 兜底，不虚构）。 */
function biomeName (bot) {
  try {
    const b = bot?.blockAt?.(bot?.entity?.position)
    const name = b?.biome?.name
    if (name) return name
    const id = b?.biome?.id
    return id !== undefined ? `biome_${id}` : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 完整环境快照（environment 技能；≤600 字符）。
 * 位置[第N天 hh:mm 昼夜]，天气，维度，生物群系，朝向，附近玩家≤5，附近实体≤5。
 */
export function environmentSnapshot (bot) {
  const parts = []
  const p = bot?.entity?.position
  if (p) {
    const t = bot?.time
    // 同 environmentLine：dayTime 来自 /time query 取模（26.1 无 dayTime 字段）；
    // 取模对昼夜可靠、精确时钟不准（/time set 偏移）——只输出昼/夜
    const dayTime = t?.dayTime
    const when = t?.age !== undefined && Number.isInteger(dayTime) && dayTime >= 0 && dayTime < 24000
      ? `第${Math.floor(t.age / 24000) + 1}天${dayTime < 13000 ? '昼' : '夜'}`
      : '时间未知'
    parts.push(`位置[${fmtPos(p)} ${when}]`)
  }
  if (bot?.isRaining !== undefined) parts.push(bot.isRaining ? (bot.thunderState ? '雷雨' : '雨') : '晴')
  const dim = bot?.game?.dimension
  if (dim) parts.push(`维度:${dim.replace(/^minecraft:/, '')}`)
  parts.push(`生物群系:${biomeName(bot)}`)
  parts.push(`朝向:${directionFromYaw(bot?.entity?.yaw)}`)
  const players = nearbyPlayers(bot, 5)
  if (players.length) parts.push(`附近玩家:${players.map(x => `${x.name}(${x.dist}m)`).join(' ')}`)
  const ents = nearbyEntities(bot, { limit: 5 })
  if (ents.length) parts.push(`附近实体:${ents.map(x => `${x.name}(${x.dist}m)`).join(' ')}`)
  return parts.length ? parts.join('，') : '（无环境数据）'
}

/**
 * 环境摘要行（自动注入用；≤150 字符，压缩格式）。
 * 坐标 第N天 hh:mm 昼/夜 晴/雨 维度 朝向 玩家Top3（带坐标——LLM 需知道玩家位置
 * 才能执行 follow/goto 类指令；相对坐标=玩家与 Bot 的偏移，绝对值=世界坐标）
 * @param {Record<string, any>} bot
 * @param {number} [playerLimit]
 * @param {{ info?: (msg: object, txt?: string) => void }|null} [logger] 可选——time 原始数据日志
 *        （时间刻排查：mineflayer 26.1 time 包经 patch 多路 fallback 解析，
 *         timeOfDay 来源错误时输出与实际游戏钟偏差不定）
 */
export function environmentLine (bot, playerLimit = 3, logger = null) {
  const parts = []
  const p = bot?.entity?.position
  if (p) parts.push(`坐标${fmtPos(p)}`)
  const t = bot?.time
  if (t?.age !== undefined) {
    // 时间来源：/minecraft:time query time（26.1 协议无 dayTime 字段，命令返回维度
    // 时钟总刻）——取模 24000 得 dayTime。用户实测：取模对昼夜判断可靠，但
    // /time set 的偏移使精确时钟不准——实际游玩不需要 Bot 返回时间，故只输出
    // 第N天 + 昼/夜（不输出 hh:mm——不准的时间会误导 LLM）。
    const dayTime = t.dayTime
    if (dayTime !== undefined && Number.isInteger(dayTime) && dayTime >= 0 && dayTime < 24000) {
      logger?.info?.({ dayTime, age: t.age }, 'env-time')
      parts.push(`第${Math.floor(t.age / 24000) + 1}天${dayTime < 13000 ? '昼' : '夜'}`)
    } else {
      logger?.info?.({ dayTime: t.dayTime ?? null, age: t.age }, 'env-time-pending')
      parts.push(`第${Math.floor(t.age / 24000) + 1}天?时间未知`)
    }
  }
  if (bot?.isRaining !== undefined) parts.push(bot.isRaining ? '雨' : '晴')
  const dim = bot?.game?.dimension
  if (dim) parts.push(dim.replace(/^minecraft:/, ''))
  parts.push(`朝${directionFromYaw(bot?.entity?.yaw)}`)
  const players = nearbyPlayers(bot, playerLimit)
  if (players.length) {
    parts.push(`玩家:${players.map(x => {
      const pp = x.entity?.position
      return pp ? `${x.name}(${fmtPos(pp)})` : x.name
    }).join(',')}`)
  }
  return parts.length ? `环境: ${parts.join(' ')}` : ''
}

/**
 * 退化状态行（L2 每工具轮自动注入；正常时返回空串——零成本）。
 * 数据源 26.1：bot.health/bot.food（update_health 包）、背包占用行数、
 * 手持物品 durability（nbt 耐久）。让 LLM 零工具调用成本感知生存危机。
 */
export function degenerateLine (bot) {
  const parts = []
  try {
    const hp = bot?.health
    if (typeof hp === 'number' && hp > 0 && hp < 10) parts.push(`血${Math.round(hp)}`) // 满血 20，<10 低
    const food = bot?.food
    if (typeof food === 'number' && food > 0 && food < 6) parts.push(`饥${Math.round(food)}`)
    const slots = bot?.inventory?.items?.()?.length ?? 0
    if (slots >= 34) parts.push('背包满') // 与任务 slotsUsed ≥34 判满同口径
    const held = bot?.heldItem
    const maxDura = held?.durability
    if (held && typeof maxDura === 'number' && maxDura > 0 && held.durabilityUsed / maxDura > 0.8) {
      parts.push(`${held.name ?? '工具'}将坏`)
    }
  } catch { /* 数据源异常——跳过退化行 */ }
  return parts.length ? `状态: ${parts.join(' ')}` : ''
}

/**
 * 附近危险行（L2 每工具轮自动注入；无新鲜危险记录时返回空串——零成本常态）。
 * 数据源：discovery 危险区域记忆（explore 站/entityHurt 记录）——只认新鲜窗口内
 * （DANGER_FRESH_MS）的记录，实体是瞬态的，过期记录不注入避免误导。
 */
export function dangerLine (bot) {
  try {
    const me = bot?.entity?.position
    if (!me) return ''
    const zones = discovery.queryDangerZones(me, { radius: 128, maxCount: 3 })
      .filter(z => z.fresh)
    if (zones.length === 0) return ''
    const parts = zones.map(z => `${z.hostileNames.join('/') || 'hostile'}(${z.dist}m,${z.ageMinutes}分钟前)`)
    const line = `危险: ${parts.join(' ')}`
    return line.length > 150 ? line.slice(0, 150) + '…' : line
  } catch { /* 记忆数据异常——跳过危险行 */ }
  return ''
}
