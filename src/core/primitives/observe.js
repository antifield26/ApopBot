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
// 观察族（all / readonly / 5s，不拦 exclusive）
import { Vec3 } from 'vec3'
import { nearbyEntities } from '../entities.js'
import { environmentSnapshot } from '../environment.js'
import * as discovery from '../discovery.js'
import { isArea } from '../../tasks/util.js'
import { findSurfaceBlocks } from '../movement.js'
import { CROP_MATURITY, CROP_BY_BLOCK } from '../crops.js'

/**
 * 注册observe族原语。register = index.js 工厂注入的注册函数（含重复注册检查）；
 * _ctx 保留供族文件间约定签名（handler 经 c 首参取 ctx，不经此参数）。
 */
export function registerObserve (register, _ctx) {
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
      let ents
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
      // 与 !find/find_block 同款 findSurfaceBlocks（不移动、无副作用）——多名字批量。
      // 三选一互斥：同传时 regex 静默优先会与直觉不符（LLM 双传难归因）——显式报错
      if (regex && (blockNames || blockName)) {
        throw new Error('observe_blocks 的 regex 与 blockNames/blockName 互斥，只能给一种')
      }
      const names = blockNames ?? (blockName ? [blockName] : null)
      const registry = c.bot?.registry
      let ids = null
      if (regex) {
        ids = new Set()
        for (const [name, block] of Object.entries(registry?.blocksByName ?? {})) {
          if (new RegExp(regex).test(name)) ids.add(block.id)
        }
      }
      // 观察即记录（记录带维度；chunk 去重 + 全局上限天然防膨胀）——声明在
      // handler 开头：regex 路径与 names 路径共用（TDZ 防护）
      const dim = c.bot?.game?.dimension?.replace(/^minecraft:/, '') ?? null
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
      let found
      try {
        found = c.bot.findBlocks({ matching: (b) => b.type !== 0, maxDistance, count: 10000 })
      } catch { return { mature: [], immature: [], farmland: [] } }
      // 作物白名单：age 型 + 高度/果实型（crops.js 单一来源）
      const allCrops = [...Object.keys(CROP_MATURITY), ...Object.values(CROP_BY_BLOCK)]
      const crops = cropTypes?.length ? cropTypes : allCrops
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
        } else if (block.name in CROP_BY_BLOCK) {
          const crop = CROP_BY_BLOCK[block.name]
          if (!crops.includes(crop)) continue
          if (block.name === 'sugar_cane') {
            // 高度型：只判根部（下方无甘蔗）——≥2 格高收集顶部块（dig 顶部保留
            // 根部继续长）；单根 immature
            const below = c.bot.blockAt(new Vec3(p.x, p.y - 1, p.z))
            if (below?.name === 'sugar_cane') continue // 非根部跳过
            let topY = p.y
            for (let y = p.y + 1; y <= p.y + 2; y++) {
              const b = c.bot.blockAt(new Vec3(p.x, y, p.z))
              if (b?.name === 'sugar_cane') topY = y
              else break
            }
            if (topY > p.y) mature.push([p.x, topY, p.z])
            else immature.push([p.x, p.y, p.z])
          } else {
            mature.push([p.x, p.y, p.z]) // 南瓜/西瓜：果实块存在即成熟
          }
        } else if (block.name === 'farmland') {
          farmland.push([p.x, p.y, p.z])
        }
      }
      return { mature, immature, farmland }
    }
  })
  register('query_map', {
    description: '查询探索记忆中已知的资源坐标/命名地点/附近危险区域（不重新扫描；已加载区块逐条验证，失效记录自动清除）',
    schema: {
      type: 'object',
      properties: {
        blockName: { type: 'string', description: '方块名（如 iron_ore/diamond_ore/bamboo；与 place/danger 三选一）' },
        place: { type: 'string', description: '命名地点名（如 home/矿场——!home set 登记的语义坐标；与 blockName/danger 三选一）' },
        danger: { type: 'boolean', description: '查询附近危险区域记忆（hostile 出没坐标；fresh/stale 由返回标记判断；与 blockName/place 三选一）' },
        maxCount: { type: 'integer', min: 1, max: 20, description: '最多返回条数，默认 5' }
      }
    },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { blockName, place, danger, maxCount }) => {
      // 三选一互斥（同 observe_blocks 语义——双传难归因，显式报错）
      if (danger && (blockName || place)) {
        throw new Error('query_map 的 danger 与 blockName/place 互斥，只能给一种')
      }
      // 危险区域分支（hostile 出没记忆——实体瞬态，fresh/ageMinutes 供判断）
      if (danger) {
        return { danger: discovery.queryDangerZones(c.bot?.entity?.position, { maxCount: maxCount ?? 5 }) }
      }
      // 命名地点分支（!home set / set_place 登记的语义坐标——家/矿场/基地）
      if (place) {
        const p = discovery.getPlace(place)
        if (!p) return { place: String(place), found: false, hint: '地点不存在（!home set <name> 或 set_place 登记）' }
        return { place: p.name, found: true, x: p.x, y: p.y, z: p.z, dimension: p.dimension ?? 'overworld' }
      }
      if (!blockName) throw new Error('query_map 需要 blockName、place 或 danger')
      // 大小写归一——记忆 key 是 explore 记录的小写名（iron_ore），LLM 传 Iron_Ore
      // 会查空且无提示（误导 LLM 去重新探索）
      const name = String(blockName).toLowerCase()
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
  register('observe_tasks', {
    description: '查看当前任务列表（状态/等待原因/排队/剩余时长/计数——readonly）',
    schema: { type: 'object', properties: {} },
    permission: 'all',
    exclusiveClass: 'readonly',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c) => {
      // 行式渲染与 !task list 同款（readonly 观察族——注册即进工具集）
      const status = c.tasks?.getStatus?.() ?? []
      if (status.length === 0) return { tasks: [] }
      const list = status.slice(0, 10).map(t => {
        const parts = [`${t.id}:${t.state}`]
        if (t.waitingReason) parts.push(`(${t.waitingReason})`)
        if (t.lastError) parts.push(`(err:${String(t.lastError).slice(0, 40)})`)
        if (t.queuePosition) parts.push(`[排队#${t.queuePosition}]`)
        if (t.remainingMinutes !== undefined) parts.push(`[余${t.remainingMinutes}m]`)
        if (Object.keys(t.counters).length) parts.push(`[${JSON.stringify(t.counters).slice(0, 80)}]`)
        return parts.join('')
      })
      return { tasks: list, total: status.length, truncated: status.length > 10 }
    }
  })

}

/** 平方距离（observe_blocks 排序用）。 */
function dist2 (p, me) {
  return (p[0] - me.x) ** 2 + (p[1] - me.y) ** 2 + (p[2] - me.z) ** 2
}

