// 动作原语注册表：LLM act 动作数组与任务脚本共用的原子动作层。
// 取代原 skills.js 的 20 个固定技能——原语可自由组合表达任意意图，不再有
// "提示词→固定技能"的映射瓶颈。每个原语：
//   { schema, permission, exclusiveClass, guardText, timeoutMs, cooldownMs?, handler }
//
// 约定（与 skills.execute 同源，由 executor 统一执行管线保证）：
// - handler(ctx, args, runtime) 返回 result（成功）；业务性"无事可做"（无目标/
//   无物品/冷却）也返回文案（ok:true——动作已有效执行）；真正的异常 throw
//   （executor 转 { ok:false, result: err.message }）
// - runtime = { signal: AbortSignal|null, user, taskId }——signal 贯通长时等待
//   （fish/eat/wait 的 race；movement 的 isInterrupted 组合谓词）
// - exclusive 守卫统一上提 executor（按 exclusiveClass），handler 不再自查
//
// 权限分级：观察/流程类 all；会改变世界状态（移动/构建/战斗/交互/物品/任务）op。
// 观察类返回结构化对象（LLM 收到 JSON、脚本读字段）；动作类返回简短中文文案。

import { Vec3 } from 'vec3'
import { withTimeout } from '../util/promise-timeout.js'
import { sendChat } from './chat.js'
import { nearbyEntities } from './entities.js'
import { environmentSnapshot } from './environment.js'
import { exploreStep, notifyValuableFound } from './explore.js'
import * as discovery from './discovery.js'
import { createMovement, REASON_TEXT, findSurfaceBlocks } from './movement.js'
import { isArea } from '../tasks/util.js' // 区域校验 5 份消重（farm/combat/breed/explore 同源）
import { attackEntity, useEntityOn } from './entity-actions.js'
import { hasExclusiveActive, getExclusiveOwner } from './arbiter.js'
import { validateTaskOptions } from './task-schemas.js'
import { TASK_TYPES } from '../tasks/types.js'
import { CROP_MATURITY, SEED_BY_CROP } from './crops.js'

// 动作冷却（dig/place/attack 防刷；equip/use_item 等不拦）。判定在 handler 内
// "只对实际执行生效"（业务性校验失败——距离/占用等——不占冷却，与原技能层一致）；
// cooldownMs 字段保留供 executor 层展示/扩展，冷却执行点在 handler。
const ACTION_COOLDOWN_MS = 500
const lastActionAt = new Map()
function checkActionCooldown (name) {
  const now = Date.now()
  const last = lastActionAt.get(name) ?? 0
  if (now - last < ACTION_COOLDOWN_MS) {
    throw new Error(`${name} 冷却中（${Math.ceil((ACTION_COOLDOWN_MS - (now - last)) / 1000)}s 后重试）`)
  }
  lastActionAt.set(name, now)
}

/**
 * 自动存储：背包满（NoChests）时附近找箱子/木桶存入物品——避免 mine/chop/farm
 * 脚本在背包满时干等。规则：
 * - 只搜 32 格内 chest/barrel（至多开 3 个，防 UI 卡死）
 * - 工具（*_sword/_pickaxe/_axe/_shovel/_hoe）与可食用物品不存（保持装备与食物）
 * - 单箱存 ≥1 项即返回（收集流程可继续）；全部失败返回 0（回退 inventoryFull 语义）
 * 失败任何一步静默（autonomy 的附加层——绝不阻塞/抛错）。
 * @returns {Promise<{ stored: number, found: Vec3[] }>}
 */
async function autoDeposit (bot, logger) {
  if (!bot?.openContainer || !bot?.findBlocks) return { stored: 0, found: [] }
  let found = []
  try {
    found = bot.findBlocks({ matching: (b) => b.name === 'chest' || b.name === 'barrel', maxDistance: 32, count: 8 })
  } catch { return { stored: 0, found: [] } }
  if (found.length === 0) return { stored: 0, found: [] }
  const isTool = (n) => /_sword$|_pickaxe$|_axe$|_shovel$|_hoe$/.test(n ?? '')
  let stored = 0
  for (const pos of found.slice(0, 3)) {
    let container = null
    try {
      const block = bot.blockAt(pos)
      if (!block) continue
      container = await withTimeout(bot.openContainer(block), 8000, 'open chest timeout')
      const items = bot.inventory?.items?.() ?? []
      for (const it of items) {
        const name = it?.name ?? ''
        if (isTool(name) || (bot.registry?.itemsByName?.[name]?.foodPoints ?? 0) > 0) continue
        try {
          const ok = await withTimeout(container.deposit(it.type, it.metadata ?? null, it.count), 8000, 'deposit timeout')
          if (ok) stored++
        } catch { /* 该物品存入失败跳过 */ }
        if (stored >= 1) break // 存入即可继续收集（背包留空位）
      }
      if (stored > 0) break
    } catch (err) {
      logger?.warn?.({ err: err.message }, '自动存储失败（回退 inventoryFull 语义）')
    } finally {
      try { container?.close() } catch { /* 容器可能已关闭 */ }
    }
  }
  return { stored, found }
}

/**
 * 创建原语注册表。ctx = { bot, cfg, logger, tasks, conn, plugins }（与 skills 同源）。
 * @returns {Map<string, object>} op → 原语定义
 */
export function createPrimitiveRegistry (ctx) {
  const reg = new Map()
  const register = (op, def) => {
    if (reg.has(op)) throw new Error(`原语重复注册: ${op}`)
    reg.set(op, def)
  }

  // ============ 观察族（all / readonly / 5s，不拦 exclusive） ============

  register('observe_status', {
    description: '获取 Bot 状态（连接/位置/血量/饥饿）',
    schema: { type: 'object', properties: {} },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c) => {
      // 精简输出（同 status 技能）：LLM 决策用不上的运维指标不进上下文
      const s = c.conn.getStatus()
      const e = c.bot?.entity
      return {
        state: s.state,
        position: e ? [Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)] : null,
        health: c.bot?.health ?? null, // update_health 包（26.1 实体元数据不解析 health）
        food: c.bot?.food ?? null
      }
    }
  })

  register('observe_inventory', {
    description: '获取背包物品摘要（名称与数量，按数量降序 Top-N）',
    schema: {
      type: 'object',
      properties: { maxItems: { type: 'integer', min: 1, max: 50, description: '最多返回条数，默认 10' } }
    },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { maxItems }) => {
      const allItems = c.bot?.inventory?.items() ?? []
      const counts = {}
      for (const it of allItems) {
        counts[it.name] = (counts[it.name] ?? 0) + (it.count ?? 1)
      }
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, maxItems ?? 10)
      // slotsUsed = 占用槽位数（items() 每槽一个实例——背包满判定用；
      // items 数组是去重后的物品种类，不能当槽位用）
      return { items: entries.map(([name, count]) => ({ name, count })), total: entries.length ? entries.reduce((s, [, n]) => s + n, 0) : 0, slotsUsed: allItems.length }
    }
  })

  register('observe_environment', {
    description: '获取当前环境快照（时间/昼夜/天气/维度/生物群系/朝向/附近玩家与实体）',
    schema: { type: 'object', properties: {} },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c) => environmentSnapshot(c.bot)
  })

  register('observe_entities', {
    description: '列出附近实体（按距离升序，可过滤名称/类型；结构化数组）',
    schema: {
      type: 'object',
      properties: {
        filter: { type: ['string', 'array'], description: '实体名子串或 kind（hostile/animal...），或名称数组（任一匹配）' },
        maxDistance: { type: 'number', min: 1, max: 256, description: '搜索半径 1-256，默认 32' },
        area: { type: 'object', description: '区域 {x1,y1,z1,x2,y2,z2}（只返回区域内实体）' }
      }
    },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { filter, maxDistance, area }) => {
      // filter 支持字符串（nearbyEntities 语义：name 子串 OR kind）与数组（任一匹配）
      let ents = []
      if (Array.isArray(filter)) {
        ents = nearbyEntities(c.bot, { maxDistance: maxDistance ?? 32, limit: 32 })
        // 大小写不敏感（与字符串路径 nearbyEntities 的 toLowerCase 语义一致）
        ents = ents.filter(e => filter.some(f => {
          const needle = String(f).toLowerCase()
          return String(e.name ?? '').toLowerCase().includes(needle) || String(e.type ?? '').toLowerCase() === needle
        }))
      } else {
        ents = nearbyEntities(c.bot, { name: filter, kind: filter, maxDistance: maxDistance ?? 32, limit: 32 })
      }
      if (area && isArea(area)) {
        ents = ents.filter(e => {
          const p = e.position
          if (!p) return false
          return p.x >= area.x1 && p.x <= area.x2 && p.y >= area.y1 && p.y <= area.y2 && p.z >= area.z1 && p.z <= area.z2
        })
      }
      return ents.slice(0, 10).map(e => {
        const p = e.position
        return { name: e.name, type: e.type, dist: e.dist, pos: p ? [p.x, p.y, p.z] : null }
      })
    }
  })

  register('observe_blocks', {
    description: '找指定方块的地表暴露位置（不移动；多名字/正则批量；结构化候选列表）',
    schema: {
      type: 'object',
      properties: {
        blockNames: { type: 'array', items: { type: 'string' }, description: '方块名列表（与 blockName/regex 三选一）' },
        blockName: { type: 'string', description: '单个方块名（如 iron_ore）' },
        regex: { type: 'string', description: '方块名正则（如 _log$）' },
        maxDistance: { type: 'number', min: 16, max: 256, description: '搜索半径 16-256，默认 64' },
        area: { type: 'object', description: '区域 {x1,y1,z1,x2,y2,z2}（只返回区域内候选）' }
      }
    },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { blockNames, blockName, regex, maxDistance, area }) => {
      // 与 !find/find_block 同款 findSurfaceBlocks（不移动、无副作用）——多名字批量
      const names = blockNames ?? (blockName ? [blockName] : null)
      const registry = c.bot?.registry
      let ids = null
      if (regex) {
        ids = new Set()
        for (const [name, block] of Object.entries(registry?.blocksByName ?? {})) {
          if (new RegExp(regex).test(name)) ids.add(block.id)
        }
      }
      const candidates = []
      const matchedNames = []
      // 区域过滤 + 中心距离告警（两条路径共用：regex 路径用 findBlocks 扫任意位置，
      // 含地下/洞穴，与 blockNames 的 findSurfaceBlocks 语义不同——统一走过滤 + 告警）
      const finish = () => {
        const me = c.bot.entity?.position
        const sorted = candidates
          .map(p => ({ p, d: me ? dist2(p, me) : 0 }))
          .sort((a, b) => a.d - b.d)
          .map(x => x.p)
        if (area && isArea(area)) {
          if (me) {
            const d = Math.hypot(me.x - (area.x1 + area.x2) / 2, me.z - (area.z1 + area.z2) / 2)
            if (d > (maxDistance ?? 64)) {
              c.logger.warn({ dist: Math.round(d), maxDistance: maxDistance ?? 64 }, 'bot 距区域中心超出扫描半径——请靠近区域或调整 area/maxDistance')
            }
          }
          return {
            blockNames: matchedNames,
            candidates: sorted
              .filter(([x, y, z]) => x >= area.x1 && x <= area.x2 && y >= area.y1 && y <= area.y2 && z >= area.z1 && z <= area.z2)
              .slice(0, 50)
          }
        }
        return { blockNames: matchedNames, candidates: sorted.slice(0, 50) }
      }
      if (ids) {
        // 正则路径：按 id 匹配 findBlocks
        const found = c.bot.findBlocks({ matching: (b) => ids.has(b.type), maxDistance: maxDistance ?? 64, count: 100 })
        const byName = {}
        for (const [n, b] of Object.entries(registry?.blocksByName ?? {})) if (ids.has(b.id)) byName[b.id] = n
        for (const p of found) {
          const n = byName[p.type] ?? 'unknown'
          if (!matchedNames.includes(n)) matchedNames.push(n)
          candidates.push([p.x, p.y, p.z])
          // 记忆被动积累——LLM 观察即探索（记录带维度；chunk 去重
          // + 全局上限天然防膨胀；被挖除后 blockUpdate 删记忆，再次观察自动重记）
          if (n !== 'unknown') discovery.recordResource(n, { x: p.x, y: p.y, z: p.z }, dim)
        }
        return finish()
      }
      if (!names || names.length === 0) throw new Error('observe_blocks 需要 blockNames/blockName/regex 之一')
      // 观察即记录（记录带维度；chunk 去重 + 全局上限天然防膨胀）
      const dim = c.bot?.game?.dimension?.replace(/^minecraft:/, '') ?? null
      for (const name of names) {
        let found
        try {
          found = findSurfaceBlocks(c.bot, name, { maxDistance: maxDistance ?? 64, maxCandidates: 32 })
        } catch {
          continue // 未知方块类型跳过该名（与 collect_blocks 一致——一个拼错不杀整批）
        }
        for (const p of found.candidates) {
          candidates.push([p.x, p.y, p.z])
          discovery.recordResource(name, p, dim)
        }
        matchedNames.push(name)
      }
      return finish()
    }
  })

  register('observe_block', {
    description: '获取单方块详情（名称/属性/是否空）',
    schema: {
      type: 'object',
      required: ['x', 'y', 'z'],
      properties: {
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }
      }
    },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { x, y, z }) => {
      const block = c.bot.blockAt(new Vec3(x, y, z))
      if (!block) return { name: null, empty: true, x, y, z }
      return { name: block.name, id: block.type, properties: block.getProperties?.() ?? null, empty: block.boundingBox === 'empty' }
    }
  })

  register('observe_crops', {
    description: '扫描区域作物成熟度（成熟/未成熟/耕地）',
    schema: {
      type: 'object',
      required: ['area'],
      properties: {
        area: { type: 'object', description: '区域 {x1,y1,z1,x2,y2,z2}' },
        cropTypes: { type: 'array', items: { type: 'string' }, description: '作物列表（默认全部已知作物）' }
      }
    },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { area, cropTypes }) => {
      if (!isArea(area)) throw new Error('observe_crops 需要完整 area（x1..z2 六坐标）')
      // farm._scanArea 同款：区域中心锚点 + 对角线 + 16 缓冲 + 256 钳制
      const anchor = new Vec3((area.x1 + area.x2) / 2, (area.y1 + area.y2) / 2, (area.z1 + area.z2) / 2)
      const diag = Math.hypot(area.x2 - area.x1, area.y2 - area.y1, area.z2 - area.z1)
      const maxDistance = Math.min(Math.ceil(diag) + 16, 256)
      const botPos = c.bot.entity?.position
      if (botPos) {
        const d = Math.hypot(botPos.x - anchor.x, botPos.z - anchor.z)
        if (d > maxDistance) c.logger.warn({ dist: Math.round(d), maxDistance }, 'bot 距区域中心超出扫描半径——请靠近区域或调整 area')
      }
      let found = []
      try {
        found = c.bot.findBlocks({ matching: (b) => b.type !== 0, maxDistance, count: 10000 })
      } catch { return { mature: [], immature: [], farmland: [] } }
      const crops = cropTypes?.length ? cropTypes : Object.keys(CROP_MATURITY)
      const mature = []
      const immature = []
      const farmland = []
      for (const p of found) {
        if (p.x < area.x1 || p.x > area.x2 || p.y < area.y1 || p.y > area.y2 || p.z < area.z1 || p.z > area.z2) continue
        const block = c.bot.blockAt(p)
        if (!block) continue
        if (block.name in CROP_MATURITY) {
          const age = block.getProperties?.()?.age
          const m = CROP_MATURITY[block.name]
          if (typeof age === 'number' && age >= m && crops.includes(block.name)) mature.push([p.x, p.y, p.z])
          else if (crops.includes(block.name)) immature.push([p.x, p.y, p.z])
        } else if (block.name === 'farmland') {
          farmland.push([p.x, p.y, p.z])
        }
      }
      return { mature, immature, farmland }
    }
  })

  register('query_map', {
    description: '查询探索记忆中已知的资源坐标（不重新扫描；已加载区块逐条验证，失效记录自动清除）',
    schema: {
      type: 'object',
      required: ['blockName'],
      properties: {
        blockName: { type: 'string', description: '方块名（如 iron_ore/diamond_ore/bamboo）' },
        maxCount: { type: 'integer', min: 1, max: 20, description: '最多返回条数，默认 5' }
      }
    },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { blockName, maxCount }) => {
      // 大小写归一——记忆 key 是 explore 记录的小写名（iron_ore），LLM 传 Iron_Ore
      // 会查空且无提示（误导 LLM 去重新探索）
      const name = String(blockName ?? '').toLowerCase()
      const me = c.bot?.entity?.position
      // 维度过滤——只返回当前维度的记录（下界/末地坐标 8:1 映射
      // 混存会误导；返回带 dimension 供 LLM 判断）
      const dim = c.bot?.game?.dimension?.replace(/^minecraft:/, '') ?? null
      const out = []
      for (const h of discovery.query(name, me, maxCount ?? 5, dim)) {
        // 地形记忆验证：已加载区块逐条核对是否仍是该方块——不是则
        // 自动删除（记忆自愈，杜绝过期坐标误导）；未加载区块无法验证标
        // verified:false（LLM 需 observe_block 确认后再行动）
        let verified = false
        const cur = c.bot?.blockAt?.(new Vec3(h.x, h.y, h.z))
        if (cur) {
          if (cur.name === name) {
            verified = true
          } else {
            discovery.removeResourceAt(h.x, h.y, h.z)
            continue // 失效记录：剔除
          }
        }
        out.push({ x: h.x, y: h.y, z: h.z, ts: h.ts, verified, dimension: h.dimension ?? 'overworld' })
      }
      return out
    }
  })

  register('map_status', {
    description: '探索记忆统计（已访问锚点/覆盖范围/资源记录）',
    schema: { type: 'object', properties: {} },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async () => discovery.stats()
  })

  // ============ 移动（op / movement / 60s，exclusive 拒绝） ============

  register('goto', {
    schema: {
      type: 'object',
      required: ['x', 'y', 'z'],
      properties: {
        // 世界边界 ±30000000——LLM 幻觉传超大值会进 GoalBlock 界外寻路异常
        x: { type: 'number', min: -30000000, max: 30000000 },
        y: { type: 'number', min: -30000000, max: 30000000 },
        z: { type: 'number', min: -30000000, max: 30000000 },
        range: { type: 'number', min: 0, max: 64, description: '到达判定距离（默认精确站格）' },
        timeoutMs: { type: 'number', min: 10000, max: 120000, description: '寻路超时 10-120s，默认 60s' }
      }
    },
    permission: 'op',
    exclusiveClass: 'movement',
    guardText: '移动',
    timeoutMs: 120000,
    handler: async (c, { x, y, z, range, timeoutMs }, runtime) => {
      // signal 贯通——goto 长时阻塞必须响应 stop()/断线中止，否则跑满 120s、
      // busy 全程占用（executor 超时拦不住原语内部的长等待）
      const r = await createMovement(c.bot, c.logger).gotoPoint(new Vec3(x, y, z), {
        range,
        timeoutMs: timeoutMs ?? 60000,
        isInterrupted: () => runtime?.signal?.aborted === true
      })
      if (r.ok) return { reached: [Math.floor(x), Math.floor(y), Math.floor(z)] }
      throw new Error(`移动失败: ${REASON_TEXT[r.reason] ?? r.err?.message}`)
    }
  })

  register('explore_step', {
    schema: {
      type: 'object',
      properties: {
        maxDistance: { type: 'number', min: 16, max: 256, description: '探索距离 16-256，默认 48' },
        direction: { type: 'string', description: 'n/s/e/w/ne/nw/se/sw/random，默认 random' }
      }
    },
    permission: 'op',
    exclusiveClass: 'movement',
    guardText: '探索',
    timeoutMs: 45000,
    handler: async (c, { maxDistance, direction }, runtime) => {
      // signal 贯通（同 goto——stop()/断线中止时探索步立即退出）
      const r = await exploreStep(c.bot, c.logger, { maxDistance, direction, signal: runtime?.signal ?? null })
      if (!r.ok) throw new Error(`探索失败: ${r.reason}`)
      notifyValuableFound(c.cfg, c.logger, r.found) // 重要资源 webhook 推送（节流，失败静默）
      return { from: [r.from.x, r.from.y, r.from.z], to: [r.to.x, r.to.y, r.to.z], found: r.found.map(f => ({ name: f.name, x: f.x, y: f.y, z: f.z })), hostile: r.entities.hostile ?? [] }
    }
  })

  // ============ 构建（op / build / 冷却 500ms，exclusive 拒绝） ============

  register('dig', {
    schema: {
      type: 'object',
      required: ['x', 'y', 'z'],
      properties: {
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }
      }
    },
    permission: 'op',
    exclusiveClass: 'build',
    guardText: '挖掘',
    timeoutMs: 30000,
    cooldownMs: ACTION_COOLDOWN_MS,
    handler: async (c, { x, y, z }) => {
      if (!c.bot?.dig || !c.bot.canDigBlock) throw new Error('dig 能力不可用（插件缺失）')
      const block = c.bot.blockAt(new Vec3(x, y, z))
      if (!block) return `坐标 (${x},${y},${z}) 没有方块（区块未加载？）`
      if (!c.bot.canDigBlock(block)) {
        return `方块 ${block.name} 不可挖掘（距离过远或不可挖掘）——先 goto 靠近到 5 格内`
      }
      checkActionCooldown('dig')
      await withTimeout(c.bot.dig(block), 30000, 'dig timeout') // 断线保护
      // 地形记忆失效：挖除的方块从探索记忆删除——记忆只增不减会让
      // query_map 长期返回过期坐标
      discovery.removeResourceAt(x, y, z)
      return `已挖掘 ${block.name} @ ${x},${y},${z}`
    }
  })

  register('place', {
    schema: {
      type: 'object',
      required: ['x', 'y', 'z'],
      properties: {
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
        face: { type: 'string', description: '放置方向：up/down/north/south/east/west（默认 up）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'build',
    guardText: '放置',
    timeoutMs: 30000,
    cooldownMs: ACTION_COOLDOWN_MS,
    handler: async (c, { x, y, z, face = 'up' }) => {
      if (!c.bot?.placeBlock) throw new Error('place 能力不可用（插件缺失）')
      const off = { up: [0, -1, 0], down: [0, 1, 0], north: [0, 0, 1], south: [0, 0, -1], east: [-1, 0, 0], west: [1, 0, 0] }[face]
      if (!off) return `无效的 face: ${face}（up/down/north/south/east/west）`
      const refBlock = c.bot.blockAt(new Vec3(x + off[0], y + off[1], z + off[2]))
      if (!refBlock || refBlock.boundingBox === 'empty') return '参考方块不存在（目标位置悬空？）'
      const dest = c.bot.blockAt(new Vec3(x, y, z))
      if (dest && dest.boundingBox !== 'empty') return `目标位置被 ${dest.name} 占用`
      if (!c.bot.heldItem) return '手里没有物品——先 equip <物品名>'
      checkActionCooldown('place')
      const itemName = c.bot.heldItem.name
      await withTimeout(c.bot.placeBlock(refBlock, face), 30000, 'place timeout')
      return `已放置 ${itemName} @ ${x},${y},${z}`
    }
  })

  register('collect_blocks', {
    schema: {
      type: 'object',
      properties: {
        positions: { type: 'array', items: { type: 'array' }, description: '指定坐标列表 [[x,y,z],...]（与 blockNames 二选一）' },
        blockNames: { type: 'array', items: { type: 'string' }, description: '按名称批量采集（区域/半径内）' },
        blockName: { type: 'string', description: '单名称版（等价 blockNames:[x]）' },
        area: { type: 'object', description: '区域 {x1,y1,z1,x2,y2,z2}（过滤候选）' },
        maxBlocks: { type: 'integer', min: 1, max: 64, description: '单次最多采集块数（默认 16）' },
        chestLocations: { type: 'array', description: '箱子坐标列表（背包满时存入）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'build',
    guardText: '采集',
    timeoutMs: 120000,
    cooldownMs: ACTION_COOLDOWN_MS,
    handler: async (c, { positions, blockNames, blockName, area, maxBlocks, chestLocations }, runtime) => {
      if (!c.bot?.collectBlock?.collect) throw new Error('collectBlock 插件不可用（配置 mineflayerPlugins.collectBlock=true）')
      // 解析候选：优先 positions；否则按名称扫描。
      // 契约：collectblock 的 Targets.getClosest() 访问 target.position（Block/Entity
      // 契约）——positions 必须经 blockAt 转 Block；blockAt 返回 null（跨会话坐标/
      // 区块卸载）或坐标非法（NaN）时**跳过该点**——裸 Vec3 会触发插件 collectAll
      // 的 UnknownType 崩溃（整批失败、已采数量不入账、脚本对同一批坐标无限重试）
      const toBlocks = (pts) => pts
        .map(p => {
          if (!Array.isArray(p) || p.length < 3 || !p.slice(0, 3).every(Number.isFinite)) return null
          return c.bot.blockAt?.(new Vec3(p[0], p[1], p[2])) ?? null
        })
        .filter(Boolean)
      let targets = []
      if (Array.isArray(positions) && positions.length) {
        targets = toBlocks(positions)
      } else {
        const names = blockNames ?? (blockName ? [blockName] : null)
        if (!names?.length) throw new Error('collect_blocks 需要 positions 或 blockNames')
        let found = []
        for (const name of names) {
          try {
            const r = findSurfaceBlocks(c.bot, name, { maxDistance: 64, maxCandidates: 32 })
            found.push(...r.candidates)
          } catch { /* 未知方块类型跳过该名 */ }
        }
        if (area && isArea(area)) {
          found = found.filter(p => p.x >= area.x1 && p.x <= area.x2 && p.y >= area.y1 && p.y <= area.y2 && p.z >= area.z1 && p.z <= area.z2)
        }
        targets = toBlocks(found)
      }
      if (targets.length === 0) return { collected: 0, inventoryFull: false }
      // chestLocations 转 Vec3（collectblock 的 getClosestChest 调 c.distanceTo——配置
      // 普通对象必须转）；坐标非法/缺维度（NaN）过滤——NaN chest 距离恒不可达
      const chests = Array.isArray(chestLocations)
        ? chestLocations
            .map(c => Array.isArray(c)
              ? (c.length >= 3 && c.slice(0, 3).every(Number.isFinite) ? new Vec3(c[0], c[1], c[2]) : null)
              : (c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z) ? new Vec3(c.x, c.y, c.z) : null))
            .filter(Boolean)
        : undefined
      // 分批 ≤4（批间 pause/stop 响应延迟有界——与 mine/chop 任务同款语义）
      let collected = 0
      const cap = Math.min(maxBlocks ?? 16, targets.length)
      for (let i = 0; i < cap; i += 4) {
        if (runtime?.signal?.aborted) return { collected, stopped: true }
        const batch = targets.slice(i, i + 4)
        try {
          await withTimeout(c.bot.collectBlock.collect(batch, { chestLocations: chests }), 120000, 'collect timeout')
          collected += batch.length
          // 地形记忆失效：收集成功的坐标从探索记忆删除（同 dig）
          for (const b of batch) {
            if (b?.position) discovery.removeResourceAt(b.position.x, b.position.y, b.position.z)
          }
        } catch (err) {
          if (err.code === 'NoChests') {
            // 自动存储——背包满时附近找箱子存物品再继续（避免 mine/chop/farm
            // 脚本背包满空转；存成功重试同一批，失败回退 inventoryFull 语义
            // 由脚本处理）
            if (runtime?.signal?.aborted) return { collected, stopped: true }
            const { stored, found } = await autoDeposit(c.bot, c.logger)
            if (stored > 0) {
              // 新箱子并入 chestLocations（后续批次优先使用）
              for (const p of found) {
                if (!chests) chests = []
                if (!chests.some(x => x.distanceTo(p) < 0.5)) chests.push(p)
              }
              i -= 4 // 重试同一批（已挖除的 collectblock 自动跳过）
              continue
            }
            return { collected, inventoryFull: true } // 背包满（无箱子可存）
          }
          // collect 中途失败（NoPath/目标变化）时批次整体不计——blockAt 复核已挖除
          // 的块补记计数（未加载按未挖保守 0），记忆统一清（已不准确的坐标）；
          // 失败块在下一轮扫描中重试
          for (const b of batch) {
            const now = c.bot.blockAt(b.position)
            if (now && now.type === 0) collected++
            if (b?.position) discovery.removeResourceAt(b.position.x, b.position.y, b.position.z)
          }
          throw err
        }
      }
      return { collected, inventoryFull: false }
    }
  })

  register('plant_crops', {
    schema: {
      type: 'object',
      required: ['area'],
      properties: {
        area: { type: 'object', description: '区域 {x1,y1,z1,x2,y2,z2}' },
        cropTypes: { type: 'array', items: { type: 'string' }, description: '作物列表（默认全部）' },
        seedOverrides: { type: 'object', description: '作物→种子物品名覆盖（farm 任务 seedOverrides 同款）' },
        max: { type: 'integer', min: 1, max: 32, description: '单次最多种植数（默认 8）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'build',
    guardText: '种植',
    timeoutMs: 60000,
    cooldownMs: ACTION_COOLDOWN_MS,
    handler: async (c, { area, cropTypes, seedOverrides, max }, runtime) => {
      if (!isArea(area)) throw new Error('plant_crops 需要完整 area（x1..z2 六坐标）')
      if (!c.bot?.placeBlock || !c.bot?.equip) throw new Error('plant 能力不可用（插件缺失）')
      // farm._seedByCrop 同款：SEED_BY_CROP + seedOverrides 合并（值 = 种子物品名）
      const seedByCrop = { ...SEED_BY_CROP, ...(seedOverrides ?? {}) }
      // 按 cropTypes 优先匹配种子（未指定 = 全部作物任意种子）——否则按背包
      // 第一颗种子乱种（farm 指定 cropTypes:['carrots'] 时若先有 wheat_seeds
      // 会种小麦进胡萝卜田）
      const wantedCrops = Array.isArray(cropTypes) && cropTypes.length > 0
        ? cropTypes
        : Object.keys(seedByCrop)
      const wantedSeeds = new Set(wantedCrops.map(c => seedByCrop[c]).filter(Boolean))
      // farm._scanArea 同款扫描（找区域内耕地）
      const anchor = new Vec3((area.x1 + area.x2) / 2, (area.y1 + area.y2) / 2, (area.z1 + area.z2) / 2)
      const diag = Math.hypot(area.x2 - area.x1, area.y2 - area.y1, area.z2 - area.z1)
      const maxDistance = Math.min(Math.ceil(diag) + 16, 256)
      let found = []
      try {
        found = c.bot.findBlocks({ matching: (b) => b.type !== 0, maxDistance, count: 10000 })
      } catch { return { planted: 0 } }
      const farmland = []
      for (const p of found) {
        if (p.x < area.x1 || p.x > area.x2 || p.y < area.y1 || p.y > area.y2 || p.z < area.z1 || p.z > area.z2) continue
        const block = c.bot.blockAt(p)
        if (block?.name === 'farmland') farmland.push(p)
      }
      let planted = 0
      const cap = Math.min(max ?? 8, farmland.length)
      for (let i = 0; i < cap; i++) {
        if (runtime?.signal?.aborted) break
        const soil = c.bot.blockAt(farmland[i])
        const above = soil ? c.bot.blockAt(soil.position.offset(0, 1, 0)) : null
        if (above && above.boundingBox !== 'empty') continue // 已占用
        // 只在 wantedSeeds（cropTypes 对应种子）内选取——不取背包第一颗任意种子
        const seeds = c.bot.inventory?.items()?.find(it => wantedSeeds.has(it.name))
        if (!seeds) return { planted, noSeeds: true }
        try {
          await withTimeout(c.bot.equip(seeds, 'hand'), 10000, 'equip timeout')
          await withTimeout(c.bot.placeBlock(soil, { x: 0, y: 1, z: 0 }), 30000, 'place timeout') // 种在耕地上方
          planted++
        } catch (err) {
          c.logger.warn({ err: err.message }, '种植失败（可能没有种子或位置不可用）')
          break
        }
      }
      return { planted }
    }
  })

  // ============ 战斗（op / combat / 冷却 500ms，exclusive 拒绝） ============

  register('attack', {
    schema: {
      type: 'object',
      required: ['filter'],
      properties: {
        filter: { type: 'string', description: '实体名子串或类型（hostile/zombie...）' },
        maxHits: { type: 'integer', min: 1, max: 20, description: '单次最多连击数（默认 5）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'combat',
    guardText: '攻击',
    timeoutMs: 60000,
    cooldownMs: ACTION_COOLDOWN_MS,
    handler: async (c, { filter, maxHits }, runtime) => {
      // 冷却在实体扫描前（与原技能层一致：无目标也占冷却——防止"打不到"刷调用）
      checkActionCooldown('attack')
      if (!c.bot?.entities || !c.bot.entity?.position) throw new Error('实体表/位置不可用')
      const me = c.bot.entity
      const f = filter?.toLowerCase()
      const matches = []
      for (const e of c.bot.entities instanceof Map ? c.bot.entities.values() : Object.values(c.bot.entities)) {
        if (!e || e === me || !e.position) continue
        if (f && !String(e.name ?? '').toLowerCase().includes(f) && e.type !== f) continue
        matches.push(e)
      }
      if (matches.length === 0) return { hits: 0, targetGone: false, targetName: null, reason: `附近没有匹配 ${filter} 的实体（observe_entities 查看）` }
      matches.sort((a, b) => a.position.distanceTo(me.position) - b.position.distanceTo(me.position))
      const target = matches[0]
      // 战斗循环（combat 任务同款：存在检查 + 接近 + 攻击）——攻击走
      // entity-actions 原始包；targetGone 供脚本数击杀（entityGone 监听等价语义）
      const move = createMovement(c.bot, c.logger)
      const ATTACK_RANGE = 3.5
      const alive = () => (c.bot.entities instanceof Map ? c.bot.entities.has(target.id) : !!c.bot.entities?.[target.id])
      let hits = 0
      let interruptedStreak = 0 // 连续被走位打断次数（目标持续移动时放弃追击，防无限重试）
      for (let i = 0; i < (maxHits ?? 5); i++) {
        // 取消/断线信号贯通——executor 超时拦不住 approach 循环，handler 必须
        // 自查 signal 才能在 stop/断线时停止追击
        if (runtime?.signal?.aborted) return { hits, targetGone: false, targetName: target.name, reason: '动作被中断' }
        if (!alive() || !target.position) return { hits, targetGone: true, targetName: target.name }
        const dist = me.position.distanceTo(target.position)
        if (dist > ATTACK_RANGE) {
          const r = await move.approachEntity(target, {
            range: 2,
            timeoutMs: 15000,
            isInterrupted: () => !target?.position || me.position.distanceTo(target.position) > 64
          })
          if (r.ok) continue
          if (r.reason === 'interrupted') {
            if (++interruptedStreak >= 2) {
              return { hits, targetGone: false, targetName: target.name, reason: '目标持续移动，追击中断（稍后可重试）' }
            }
            continue
          }
          return { hits, targetGone: false, targetName: target.name, reason: `无法接近: ${REASON_TEXT[r.reason] ?? r.err?.message}` }
        }
        try { c.bot.lookAt(target.position.offset(0, (target.height ?? 1.8) / 2, 0), true) } catch { /* 位置可能失效 */ }
        attackEntity(c.bot, target)
        hits++
        await new Promise(r => setTimeout(r, 600)) // 攻击冷却（1.9+ 攻击速度检测）
      }
      return { hits, targetGone: !alive(), targetName: target.name }
    }
  })

  // ============ 交互（op / interact，exclusive 拒绝） ============

  register('interact_entity', {
    schema: {
      type: 'object',
      required: ['filter'],
      properties: {
        filter: { type: ['string', 'array'], description: '实体名子串或名称数组（如 cow/chicken——喂食繁殖用）' },
        foodName: { type: 'string', description: '食物物品名（如 wheat；缺省用背包自动匹配）' },
        count: { type: 'integer', min: 1, max: 10, description: '喂食次数（默认 2）' },
        useCooldownMs: { type: 'integer', min: 500, max: 30000, description: '喂食间隔（默认 3000）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'interact',
    guardText: '交互',
    timeoutMs: 30000,
    handler: async (c, { filter, foodName, count = 2, useCooldownMs = 3000 }) => {
      if (!c.bot?.entity?.position) throw new Error('位置不可用')
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
      const target = matches[0]
      // breed._feed 同款：找食物（参数优先，缺省按种子表自动匹配）→ equip → useEntityOn×count
      const food = foodName
        ? c.bot.inventory?.items()?.find(it => it.name === foodName)
        : c.bot.inventory?.items()?.find(it => Object.values(SEED_BY_CROP).includes(it.name))
      if (!food) return { fed: 0, targetGone: false, reason: `背包里没有可喂食的食物（${foodName ?? '种子类'}）` }
      await withTimeout(c.bot.equip(food, 'hand'), 10000, 'equip timeout')
      let fed = 0
      for (let i = 0; i < count; i++) {
        // 喂食前目标存在检查（写无效 entityId 的 use_entity 包按协议违规处理）
        const alive = c.bot.entities instanceof Map ? c.bot.entities.has(target.id) : !!c.bot.entities?.[target.id]
        if (!alive) return { fed, targetGone: true, targetName: target.name }
        useEntityOn(c.bot, target) // 走 entity-actions 原始包
        fed++
        if (i < count - 1) await new Promise(r => setTimeout(r, useCooldownMs))
      }
      return { fed, targetGone: false, targetName: target.name }
    }
  })

  // ============ 物品（op / item，不拦 exclusive） ============

  register('equip', {
    schema: {
      type: 'object',
      required: ['itemName'],
      properties: { itemName: { type: 'string', description: '物品名（如 iron_pickaxe/diamond_sword/stone）' } }
    },
    permission: 'op',
    exclusiveClass: 'item',
    guardText: '',
    timeoutMs: 10000,
    handler: async (c, { itemName }) => {
      const item = c.bot.inventory?.items()?.find(it => it.name === itemName)
      if (!item) return `背包里没有 ${itemName}（observe_inventory 查看）`
      await withTimeout(c.bot.equip(item, 'hand'), 10000, 'equip timeout') // 断线保护
      return `已装备 ${itemName}`
    }
  })

  register('drop', {
    schema: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '物品名（缺省 = 手持物品）' },
        count: { type: 'integer', min: 1, max: 64, description: '丢弃数量（缺省 = 全部）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'item',
    guardText: '',
    timeoutMs: 10000,
    handler: async (c, { itemName, count }) => {
      if (!c.bot?.tossStack) throw new Error('drop 能力不可用（插件缺失）')
      let item = null
      if (itemName) {
        item = c.bot.inventory?.items()?.find(it => it.name === itemName)
        if (!item) return `背包里没有 ${itemName}`
      } else {
        const held = c.bot.heldItem
        if (!held) return '手里没有物品'
        item = held
      }
      await withTimeout(c.bot.tossStack(item, count ?? item.count), 10000, 'drop timeout')
      return `已丢弃 ${item.name} ${count ?? item.count} 个`
    }
  })

  register('use_item', {
    schema: { type: 'object', properties: {} },
    permission: 'op',
    exclusiveClass: 'item',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c) => {
      if (!c.bot?.activateItem) throw new Error('use_item 能力不可用（插件缺失）')
      const held = c.bot.heldItem?.name ?? '手持物品'
      await withTimeout(c.bot.activateItem(), 5000, 'use_item timeout')
      return `已使用 ${held}`
    }
  })

  register('eat', {
    schema: { type: 'object', properties: {} },
    permission: 'op',
    exclusiveClass: 'item',
    guardText: '',
    timeoutMs: 10000,
    handler: async (c) => {
      // combat 低血进食同款路径（autoEat 插件）
      if (!c.bot?.autoEat?.eat) return { ate: false, reason: 'autoEat 插件未启用（配置 mineflayerPlugins.autoEat=true）' }
      try {
        await withTimeout(c.bot.autoEat.eat(), 10000, 'eat timeout')
        return { ate: true }
      } catch (err) {
        return { ate: false, reason: err.message }
      }
    }
  })

  // ============ 流程（all / flow，不拦 exclusive） ============

  register('wait', {
    schema: {
      type: 'object',
      required: ['ms'],
      properties: { ms: { type: 'integer', min: 100, max: 300000, description: '等待毫秒数（10ms 步进，最大 5 分钟）' } }
    },
    permission: 'all',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 305000,
    handler: async (c, { ms }, runtime) => {
      // stop/pause/断线可打断（signal race——与任务 _internalWait 同语义）；
      // 监听器必须配对移除——同一 AbortSignal 跨长任务（farm 30s 等待循环数小时）
      // 累积 listener → 内存线性增长、abort 时触发数百次无意义回调
      let onAbort = null
      const wait = new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        if (!runtime?.signal) return
        onAbort = () => {
          clearTimeout(timer)
          reject(new Error('等待被中断'))
        }
        runtime.signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        await wait
      } finally {
        if (onAbort) runtime.signal.removeEventListener('abort', onAbort)
      }
      return { waited: ms }
    }
  })

  register('look', {
    schema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
        yaw: { type: 'number', description: '目标朝向（弧度；与坐标二选一）' },
        pitch: { type: 'number', description: '俯仰角（弧度，默认 0）' },
        relative: { type: 'boolean', description: 'yaw/pitch 为相对增量（afk 防踢用）' }
      }
    },
    permission: 'all',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { x, y, z, yaw, pitch, relative }) => {
      // relative 分支必须在 yaw 分支之前——否则 afk 传 {yaw:0.05, relative:true}
      // 会命中 yaw 绝对分支，每次转动都把视角 snap 回绝对 0.05（并非增量漂移）
      if (relative === true) {
        const e = c.bot.entity
        await withTimeout(c.bot.look(e.yaw + (yaw ?? 0.05), e.pitch + (pitch ?? 0), true), 5000, 'look timeout')
        return '已转向（相对增量）'
      }
      if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
        await withTimeout(c.bot.lookAt(new Vec3(x, y, z), true), 5000, 'look timeout')
        return `已转向 (${Math.floor(x)},${Math.floor(y)},${Math.floor(z)})`
      }
      if (typeof yaw === 'number') {
        await withTimeout(c.bot.look(yaw, pitch ?? 0, true), 5000, 'look timeout')
        return `已转向 yaw=${yaw}`
      }
      return 'look 需要 x,y,z 或 yaw（+可选 pitch）'
    }
  })

  register('reply', {
    description: '以 Bot 身份向当前对话的玩家发送一句话（聊天）。用于回答玩家或汇报状态。',
    schema: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string', description: '要发送的消息内容，不超过 250 字符' } }
    },
    permission: 'all',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { text }) => {
      await sendChat(c.bot, String(text).slice(0, 250), c.cfg.chat?.maxLength)
      return '已发送'
    }
  })

  register('fish', {
    schema: {
      type: 'object',
      properties: { timeoutMs: { type: 'integer', min: 5000, max: 300000, description: '单次钓鱼超时（默认 60s）' } }
    },
    permission: 'all',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 305000,
    handler: async (c, { timeoutMs }, runtime) => {
      if (!c.bot?.fish) return { caught: false, reason: 'fish 能力不可用（插件缺失）' }
      // FishTask 同款：bot.fish() 无超时——withTimeout + 取消信号 race 使任务
      // stop/断线能打断抛竿（60s 超时由调用方控制）
      // abort 监听器必须配对移除（wait 原语同款纪律）——fish 任务挂机数小时
      //（60s/次抛竿）会在同一 AbortSignal 上累积上百个监听器
      let onAbort = null
      let caught = false
      try {
        await Promise.race([
          withTimeout(c.bot.fish(), timeoutMs ?? 60000, 'fish timeout'),
          new Promise((_, reject) => {
            if (runtime?.signal?.aborted) return reject(new Error('等待被中断'))
            onAbort = () => reject(new Error('等待被中断'))
            runtime?.signal?.addEventListener('abort', onAbort, { once: true })
          })
        ])
        caught = true
      } catch (err) {
        if (err?.name === 'AbortError' || err?.message?.includes('中断')) throw err
        // 上钩失败/超时不算错误——返回 false 供脚本重试
        caught = false
      } finally {
        if (onAbort) runtime?.signal?.removeEventListener('abort', onAbort)
      }
      return { caught }
    }
  })

  // ============ 任务管理（op / flow——任务互斥由 manager 排队，不拦） ============

  register('start_task', {
    schema: {
      type: 'object',
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', description: Object.keys(TASK_TYPES).join('/') },
        id: { type: 'string', description: '任务唯一 id' },
        options: { type: 'object', description: '任务 options（如 area/blockTypes/durationMinutes）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 10000,
    handler: async (c, { type, id, options }) => {
      // LLM 生成的 ad-hoc options 过 schema（与 !task new 同款入口拦截）
      const v = validateTaskOptions(type, options)
      if (!v.ok) throw new Error(`参数校验失败: ${v.error}`)
      c.tasks.addTask({ id, type, options: options ?? {}, notifyChat: true })
      await new Promise(r => setImmediate(r)) // 等一个事件循环轮（init 抛错微任务内置 failed）
      const st = c.tasks.getStatus().find(t => t.id === id)
      if (!st) return `任务 ${id} 创建失败`
      if (st.state === 'failed') return `任务 ${id} (${type}) 启动失败: ${st.lastError ?? '未知原因'}`
      if (st.state === 'completed') return `任务 ${id} (${type}) 已自然完成（无事可做）`
      if (st.state === 'created' && c.tasks.isPendingExclusive?.(id)) {
        return `任务 ${id} (${type}) 已创建但排队中（exclusive 任务冲突，等待自动启动）`
      }
      return `任务 ${id} (${type}) 已启动`
    }
  })

  register('stop_task', {
    schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } }
    },
    permission: 'op',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 15000,
    handler: async (c, { id }) => {
      await c.tasks.removeTask(id)
      return `任务 ${id} 已移除`
    }
  })

  // ============ 跟随（op / movement，exclusive 拒绝） ============

  register('follow_player', {
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '玩家名（大小写不敏感），off 停止跟随；"跟随我"时可不填或填 me' }
      }
    },
    permission: 'op',
    // off（停止跟随）不冲突移动权——守卫放 handler 内（executor 统一守卫拦不到 off）
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 10000,
    handler: async (c, { name }) => {
      if (!c.plugins?.follow) throw new Error('follow 插件未启用（配置 mineflayerPlugins.follow=true 并重启）')
      if (name === 'off') {
        c.plugins.follow.stop()
        return '已停止跟随'
      }
      // 启动跟随与 exclusive 任务互斥（双控制器冲突防线）
      if (hasExclusiveActive()) {
        throw new Error(`exclusive 任务 ${getExclusiveOwner()} 运行中，无法跟随（任务结束后可试）`)
      }
      // "跟随我"指代消解（executor 注入 user）：空/me/self/我 → 当前对话玩家
      let targetName = name
      if (!name || ['me', 'self', '我', '自己'].includes(String(name).toLowerCase())) {
        targetName = c._caller ?? (c.execUser ?? null)
        if (!targetName) return '无法确定要跟随谁（对话上下文缺失）'
      }
      const lower = targetName.toLowerCase()
      const player = Object.values(c.bot.players ?? {}).find(p => p.username.toLowerCase() === lower)
      if (!player) return `找不到玩家 ${targetName}`
      // 目标防御：bot.players 含 Bot 自己——跟随自己 = 原地打转
      if (targetName.toLowerCase() === String(c.bot.username ?? '').toLowerCase()) {
        return `不能跟随 Bot 自己——请指定其他玩家（如"跟随我"）`
      }
      if (!player?.entity || player.entity === c.bot.entity) {
        return `玩家 ${targetName} 不可跟随（实体未加载或指向 Bot 自己）`
      }
      c.plugins.follow.setTarget(player.entity)
      return `开始跟随 ${targetName}`
    }
  })

  return reg
}

/** 平方距离（observe_blocks 排序用）。 */
function dist2 (p, me) {
  return (p[0] - me.x) ** 2 + (p[1] - me.y) ** 2 + (p[2] - me.z) ** 2
}
