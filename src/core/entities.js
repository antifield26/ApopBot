// @ts-check
// 实体/玩家遍历工具（core/explore.js 的 scanEntities 依赖 nearbyEntities——
// 放 l2 会造成 core→l2 上向引用）。纯实体遍历，不涉及 LLM 环境快照语义。
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
 * 过滤语义：name 与 kind/type 是 **OR**——filter 字符串可以是实体名子串
 * （zombie）或 26.1 的 type（hostile/passive/animal/projectile/player/mob）；
 * 必须用 OR（AND + e.kind 大写分类 'Hostile mobs' 会使过滤恒失效）。
 * 玩家由 nearbyPlayers 覆盖（entity.kind 对 player 不可靠）；绝不读实体 health。
 * @param {{ name?: string, kind?: string, maxDistance?: number, limit?: number }} opts
 * @returns {Array<{ id?: number, name?: string, kind?: string, type?: string, position?: import('vec3').Vec3, dist?: number, height?: number }>}
 */
export function nearbyEntities (bot, opts = {}) {
  const { name, kind, maxDistance = 64, limit = 10 } = opts ?? {}
  try {
    const me = bot?.entity
    const nameFilter = name?.toLowerCase()
    const typeFilter = kind?.toLowerCase()
    // bot.entities 是 Map（combat.js 用 .values 判定）——Object.values(Map) 恒空，
    // 必须双形态遍历
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
        // 输出 type 而非 kind：kind 是数据表 category（大写分类，26.1 下为 'Hostile mobs'），
        // 对 LLM 决策无意义且与 filter 语义不一致
        kind: e.type ?? '?',
        type: e.type ?? '?',
        dist: distance(me, e),
        pos: fmtPos(e.position),
        // 原始位置（observe_entities 的结构化坐标用——pos 是格式化字符串）
        position: e.position
      }))
      // 位置未就绪（login 中/实体瞬态）的 dist 为 null——保留会参与 NaN 比较
      // 使排序顺序不定
      .filter(x => x.dist !== null)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, limit)
  } catch {
    return []
  }
}
