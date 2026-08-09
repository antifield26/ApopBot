// 实体/玩家遍历工具（第六轮 C2 从 l2/environment.js 归位 core——core/explore.js 的
// scanEntities 依赖 nearbyEntities，放 l2 造成 core→l2 上向引用）。纯实体遍历，
// 不涉及 LLM 环境快照语义。
//
// 数据源 26.1 已核实：
//   - bot.players（玩家 entity 可能 null，守卫）；Object.values(bot.entities) 过滤自身
//     （name/type/position；**绝不读实体 health**——26.1 实体元数据不解析，恒 undefined；
//     player 的 kind/category 是 UNKNOWN 不可用，玩家走 bot.players）
// 安全：全字段 null 安全——缺失/异常逐项跳过，任何调用不抛（测试 makeCtx 缺字段不崩）。

export function fmtPos (p) {
  return p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '?'
}

export function distance (a, b) {
  if (!a || !b || !a.position || !b.position) return null
  return Math.round(Math.hypot(
    b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z))
}

/**
 * 附近实体列表（过滤 bot 自身；按距离升序）。
 * 过滤语义（第五轮 P1 修复）：name 与 kind/type 是 **OR**——filter 字符串可以是
 * 实体名子串（zombie）或 26.1 的 type（hostile/passive/animal/projectile/player/mob）。
 * 此前 AND 语义 + e.kind 大写分类（'Hostile mobs'）导致过滤恒失效（P1-1 实测）。
 * 玩家由 nearbyPlayers 覆盖（entity.kind 对 player 不可靠）；绝不读实体 health。
 * @param {{ name?: string, kind?: string, maxDistance?: number }} opts
 */
export function nearbyEntities (bot, { name, kind, maxDistance = 64, limit = 10 } = {}) {
  try {
    const me = bot?.entity
    const nameFilter = name?.toLowerCase()
    const typeFilter = kind?.toLowerCase()
    // bot.entities 是 Map（combat.js 用 .values 判定）——Object.values(Map) 恒空，
    // 必须双形态遍历（第五轮 P1 实测：此前整个 nearby_entities 技能恒空）
    const entities = bot?.entities
    const all = entities instanceof Map ? [...entities.values()] : Object.values(entities ?? {})
    const list = []
    for (const e of all) {
      if (!e || e === me || !e.position) continue
      if (maxDistance && me?.position && distance(me, e) > maxDistance) continue
      const nameHit = nameFilter && String(e.name ?? '').toLowerCase().includes(nameFilter)
      const typeHit = typeFilter && (e.type === typeFilter || (typeFilter === 'player' && e.type === 'player'))
      if (nameFilter || typeFilter) {
        if (!nameHit && !typeHit) continue // OR：任一命中即通过
      }
      list.push(e)
    }
    return list
      .map(e => ({
        name: e.name ?? 'unknown',
        // 输出 type 而非 kind：kind 是数据表 category（大写分类，26.1 实测 'Hostile mobs'），
        // 对 LLM 决策无意义且与 filter 语义不一致
        kind: e.type ?? '?',
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
