// 环境快照构建器（L2 进化 A3）：environment/nearby_entities 技能与自动注入共用。
// 数据源 26.1 已核实：
//   - bot.time（timeOfDay/isDay/age/moonPhase，服务端 time 包驱动）
//   - bot.isRaining + bot.thunderState（**无 bot.weather 字段**，game_state_change 包）
//   - bot.game.dimension（剥 minecraft: 前缀）
//   - bot.blockAt(脚).biome.name（prismarine-chunk 1.41.0 已支持；blockAt 未加载返回
//     null → unknown；biome id 未知 → biome_id 兜底，不虚构）
//   - yaw → 8 向罗盘（原版约定 yaw=0 南，顺时针增大）
//   - bot.players（玩家 entity 可能 null，守卫）；Object.values(bot.entities) 过滤自身
//     （name/type/position；**绝不读实体 health**——26.1 实体元数据不解析，恒 undefined；
//     player 的 kind/category 是 UNKNOWN 不可用，玩家走 bot.players）
// 安全：全字段 null 安全——缺失/异常逐项跳过，任何调用不抛（测试 makeCtx 缺字段不崩）。

/** 资源白名单（explore 技能/任务采样用；26.1.2 已核实存在，注意 sugar_cane 非 sugarcane）。 */
export const RESOURCE_WHITELIST = [
  'iron_ore', 'deepslate_iron_ore', 'coal_ore', 'deepslate_coal_ore',
  'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore',
  'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
  'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
  'nether_gold_ore', 'nether_quartz_ore', 'ancient_debris',
  'bamboo', 'sugar_cane', 'cactus', 'sweet_berry_bush'
]

/** 重要资源（webhook 推送用）：钻石/绿宝石/远古残骸。 */
export const VALUABLE_RESOURCES = ['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'ancient_debris']

/** yaw → 8 向罗盘（原版：yaw=0 朝南 +Z，顺时针增大）。 */
export function directionFromYaw (yaw) {
  if (!Number.isFinite(yaw)) return '?'
  const deg = (((yaw * 180) / Math.PI) % 360 + 360) % 360
  const names = ['南', '西南', '西', '西北', '北', '东北', '东', '东南']
  return names[Math.round(deg / 45) % 8]
}

function fmtPos (p) {
  return p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?'
}

function distance (a, b) {
  if (!a || !b || !a.position || !b.position) return null
  return Math.round(Math.hypot(
    b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z))
}

/** 时间 hh:mm（timeOfDay 0-24000 ticks）。 */
function formatTime (timeOfDay) {
  if (!Number.isFinite(timeOfDay)) return '?'
  const totalMin = Math.floor((timeOfDay % 24000) / 1000 * 60)
  const h = String(Math.floor(totalMin / 60)).padStart(2, '0')
  const m = String(totalMin % 60).padStart(2, '0')
  return `${h}:${m}`
}

/** 附近玩家（按距离升序，entity 可 null 的跳过）。 */
export function nearbyPlayers (bot, limit = 5) {
  try {
    const me = bot?.entity
    return Object.values(bot?.players ?? {})
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

/**
 * 附近实体列表（过滤 bot 自身；按距离升序；kind 作标签——player 的 kind 不可靠，
 * 玩家由 nearbyPlayers 覆盖）。
 * @param {{ name?: string, kind?: string, maxDistance?: number }} opts
 */
export function nearbyEntities (bot, { name, kind, maxDistance = 64, limit = 10 } = {}) {
  try {
    const me = bot?.entity
    const nameFilter = name?.toLowerCase()
    const list = []
    for (const e of Object.values(bot?.entities ?? {})) {
      if (!e || e === me || !e.position) continue
      if (maxDistance && me?.position && distance(me, e) > maxDistance) continue
      if (nameFilter && !String(e.name ?? '').toLowerCase().includes(nameFilter)) continue
      if (kind && e.kind !== kind && !(kind === 'player' && e.type === 'player')) continue
      list.push(e)
    }
    return list
      .map(e => ({
        name: e.name ?? 'unknown',
        kind: e.kind ?? e.type ?? '?',
        type: e.type ?? '?',
        dist: distance(me, e),
        pos: fmtPos(e.position)
      }))
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
    const when = t?.age !== undefined
      ? `第${Math.floor(t.age / 24000) + 1}天 ${formatTime(t.timeOfDay)} ${t.isDay ? '昼' : '夜'}`
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
 * 坐标 第N天 hh:mm 昼/夜 晴/雨 维度 朝向 玩家Top3
 */
export function environmentLine (bot, playerLimit = 3) {
  const parts = []
  const p = bot?.entity?.position
  if (p) parts.push(`坐标${fmtPos(p)}`)
  const t = bot?.time
  if (t?.age !== undefined) parts.push(`第${Math.floor(t.age / 24000) + 1}天${formatTime(t.timeOfDay)}${t.isDay ? '昼' : '夜'}`)
  if (bot?.isRaining !== undefined) parts.push(bot.isRaining ? '雨' : '晴')
  const dim = bot?.game?.dimension
  if (dim) parts.push(dim.replace(/^minecraft:/, ''))
  parts.push(`朝${directionFromYaw(bot?.entity?.yaw)}`)
  const players = nearbyPlayers(bot, playerLimit)
  if (players.length) parts.push(`玩家:${players.map(x => x.name).join(',')}`)
  return parts.length ? `环境: ${parts.join(' ')}` : ''
}
