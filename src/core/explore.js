// @ts-check
// 探索核心：explore 技能（单步）与 ExploreTask（螺旋）共享——
// 资源采样、实体扫描、螺旋 waypoint 生成。
//
// 同步枚举防线：所有 findBlocks 一律 maxDistance ≤ 64、count ≤ 2（采样是周期性
// 低频动作，64 半径 ≈ 231 section 单次 2-5ms，23 资源 ≈ 100ms/站——不触碰
// movement.js:228 的 16-256 通道，那是给用户输入限幅的；此处是内部常量）。

import * as discovery from './discovery.js'
// 资源白名单/实体遍历在 core——从 l2/environment.js 导入会造成 core→l2 上向引用
import { RESOURCE_WHITELIST, VALUABLE_RESOURCES } from './resources.js'
import { nearbyEntities } from './entities.js'
import { createNotifier } from './notify.js'

export const SAMPLE_RADIUS = 64 // 采样半径（主控旋钮）
export const SAMPLE_COUNT = 2 // 每资源最多记录条数
export const EXPLORE_STEP = 48 // 单步探索默认距离（技能）
export const SPIRAL_STEP = 32 // 螺旋站点间距（2 个区块）
// 重要资源 webhook 推送节流——1 条/10 分钟/类型（防刷屏）
const VALUABLE_COOLDOWN_MS = 10 * 60 * 1000
const lastValuableNotify = new Map()

/**
 * 重要资源发现推送：钻石/绿宝石/远古残骸 → webhook（notify.webhook 配置时）。
 * 失败静默（notify.js 内部兜底）；节流按资源类型。调用方：explore 技能与 ExploreTask。
 */
export function notifyValuableFound (cfg, logger, found) {
  if (!found?.length || !cfg?.notify?.webhook) return
  const notifier = createNotifier(cfg, logger)
  const now = Date.now()
  for (const f of found) {
    if (!VALUABLE_RESOURCES.includes(f.name)) continue
    if (now - (lastValuableNotify.get(f.name) ?? 0) < VALUABLE_COOLDOWN_MS) continue
    lastValuableNotify.set(f.name, now)
    notifier.send('explore', `发现重要资源 ${f.name}`, `坐标 ${f.x},${f.y},${f.z}`)
  }
}

/**
 * 采样记录资源（findBlocks 64 半径 × count 2；chunk 去重由 discovery 负责）。
 * @returns {Array<{name, x, y, z}>} 新发现的资源（首次记录的 chunk）
 */
export function sampleResources (bot) {
  const found = []
  if (!bot?.findBlocks || !bot.registry?.blocksByName) return found
  // 维度（剥 minecraft: 前缀；旧记录仅主世界查询匹配）
  const dim = bot?.game?.dimension?.replace(/^minecraft:/, '') ?? null
  const byName = bot.registry.blocksByName
  for (const name of RESOURCE_WHITELIST) {
    const def = byName[name]
    if (!def) continue // 维度内不存在的资源（如主世界无 nether_gold_ore）——跳过
    let blocks = []
    try {
      blocks = bot.findBlocks({ matching: (b) => b.type === def.id, maxDistance: SAMPLE_RADIUS, count: SAMPLE_COUNT })
    } catch { /* 区块未加载/API 异常——跳过该资源 */ }
    for (const p of blocks) {
      if (discovery.recordResource(name, p, dim)) found.push({ name, x: p.x, y: p.y, z: p.z, dimension: dim })
    }
  }
  return found
}

/** 实体扫描（半径 64；返回分类计数与敌对名单——26.1 entity.type 是唯一可靠分类，
 * e.kind 是数据表大写 category（'Hostile mobs'），不可用于分类）。
 * hostile 是显示串（`zombie(12m)`）；hostileNames 是纯名字（落危险区域记忆用——
 * 双字段同一次遍历生成，消费方按需取用）。 */
export function scanEntities (bot) {
  const hostile = []
  const hostileNames = []
  const counts = { hostile: 0, passive: 0, neutral: 0, player: 0, other: 0 }
  for (const e of nearbyEntities(bot, { maxDistance: 64, limit: 50 })) {
    const type = e.type
    if (type === 'hostile') {
      counts.hostile++
      hostile.push(`${e.name}(${e.dist}m)`)
      if (e.name && !hostileNames.includes(e.name)) hostileNames.push(e.name)
    } else if (counts[type] !== undefined) counts[type]++
    else counts.other++
  }
  return { counts, hostile: hostile.slice(0, 8), hostileNames: hostileNames.slice(0, 8) }
}

/** 方向解析（8 向 + random；返回 {dx, dz} 单位向量）。 */
export function resolveDirection (direction) {
  const dirs = {
    n: { dx: 0, dz: -1 }, s: { dx: 0, dz: 1 }, e: { dx: 1, dz: 0 }, w: { dx: -1, dz: 0 },
    ne: { dx: 1, dz: -1 }, nw: { dx: -1, dz: -1 }, se: { dx: 1, dz: 1 }, sw: { dx: -1, dz: 1 }
  }
  if (direction && dirs[direction]) return dirs[direction]
  // random：4/8 向等概率（Math.random 不可注入——测试直接传具体方向）
  const names = Object.keys(dirs)
  return dirs[names[Math.floor(Math.random() * names.length)]]
}

/**
 * 方形螺旋 waypoint 生成（纯函数，可测）。
 * 第 r 环（Chebyshev 半径 r·step）周长上均匀取 max(4, round(8r)) 站；
 * 环半径超过 maxDistance 停止。
 * @returns {Array<{x: number, z: number, ring: number}>} 按访问顺序
 */
export function spiralWaypoints (centerX, centerZ, maxDistance, step = SPIRAL_STEP) {
  const points = []
  const maxRing = Math.max(1, Math.floor(maxDistance / step))
  for (let r = 1; r <= maxRing; r++) {
    const n = Math.max(4, Math.round(8 * r))
    for (let i = 0; i < n; i++) {
      const per = ((i + 0.5) / n) * 8 * r // 方形周长参数 0..8r（单位 step）
      let x, z
      if (per < 2 * r) { x = (per - r) * step; z = -r * step } // 顶边左→右
      else if (per < 4 * r) { x = r * step; z = (per - 3 * r) * step } // 右边上→下
      else if (per < 6 * r) { x = (5 * r - per) * step; z = r * step } // 底边右→左
      else { x = -r * step; z = (7 * r - per) * step } // 左边下→上
      points.push({ x: centerX + Math.round(x), z: centerZ + Math.round(z), ring: r })
    }
  }
  return points
}

/**
 * 单步探索（explore 技能）：向 direction 游走 min(maxDistance, 48) 格，
 * 到达后采样记录 + 实体扫描。移动走 movement.js（end-race/墙钟超时免费获得）。
 * @returns {Promise<{ok: boolean, reason?: string, from: {x: number, y: number, z: number}|null, to: {x: number, y: number, z: number}|null, found: Array<{name: string, x: number, y: number, z: number}>, entities: { hostile?: Array<string>, counts?: object } }>}
 */
export async function exploreStep (bot, log, { maxDistance = EXPLORE_STEP, direction = 'random', signal = null } = {}) {
  const me = bot?.entity
  if (!me?.position) return { ok: false, reason: 'no-position', from: null, to: null, found: [], entities: {} }
  const { Vec3 } = await import('vec3')
  const { createMovement, REASON_TEXT } = await import('./movement.js')
  const start = { x: Math.floor(me.position.x), y: Math.floor(me.position.y), z: Math.floor(me.position.z) }
  const dir = resolveDirection(direction)
  const dist = Math.min(maxDistance, EXPLORE_STEP)
  const target = new Vec3(
    Math.floor(me.position.x + dir.dx * dist),
    Math.floor(me.position.y),
    Math.floor(me.position.z + dir.dz * dist))
  const move = createMovement(bot, log)
  // signal 贯通（goto 谓词中断）——stop()/断线中止时探索步立即退出
  const r = await move.gotoPoint(target, {
    range: 3,
    timeoutMs: 45000,
    isInterrupted: () => signal?.aborted === true
  })
  const found = sampleResources(bot)
  const entities = scanEntities(bot)
  const end = bot.entity?.position
  // 锚点带维度（下界探索不污染主世界覆盖统计）
  if (end) discovery.recordAnchor(end, bot?.game?.dimension?.replace(/^minecraft:/, '') ?? null)
  // 危险区域落记忆：站点有 hostile → 记录目击位置（chunk 去重 + 新鲜窗口限增长）
  if (entities.hostileNames.length && end) {
    discovery.recordDangerZone(end, { hostileNames: entities.hostileNames }, bot?.game?.dimension?.replace(/^minecraft:/, '') ?? null)
  }
  return {
    ok: r.ok,
    reason: r.ok ? undefined : (REASON_TEXT[r.reason] ?? r.err?.message ?? '移动失败'),
    from: start,
    to: end ? { x: Math.floor(end.x), y: Math.floor(end.y), z: Math.floor(end.z) } : null,
    found,
    entities
  }
}
