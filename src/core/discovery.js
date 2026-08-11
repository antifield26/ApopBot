// 探索记忆：DiscoveryMap 模块级单例——已访问锚点 + 资源发现缓存。
// 目的：LLM 探索过的区域与资源坐标跨对话/跨重启保留（会话记忆是玩家聊天维度，
// 无空间记忆）；query_map 技能按需查询，不重复扫描（省算力省 token）。
//
// 容量边界（防 state.json 无限增长）：
//   - resources：按 chunk 坐标 (x>>4, z>>4) 去重（同 chunk 命中只刷新 ts），
//     每块名最多 16 条，全局 512 条，超限按 ts 淘汰最旧
//   - anchors：已访问锚点 256 条环形缓冲（淘汰最旧）
// 持久化：attachStore(stateStore) 后每次修改 setMemory(snapshot())——复用 state.js
// 的 5s 防抖 + exit 同步落盘；feature-layer 重建时 importSnapshot 回灌。
// 无 explore 任务且 l2 关闭时不产生记录 → memory 保持空 → state.json 不膨胀。

const MAX_RESOURCES_PER_NAME = 16
const MAX_RESOURCES_TOTAL = 512
const MAX_ANCHORS = 256
const MAX_PLACES = 32 // 命名地点上限（!home set / set_place）

const state = {
  anchors: [], // [{x, y, z, ts}] 按插入序（旧在前），环形淘汰
  resources: {}, // blockName → [{x, y, z, ts}]（按插入序，新在后）
  places: [], // [{name, x, y, z, dimension, ts}] 命名地点（家/矿场/基地——LRU 淘汰最旧）
  store: null // stateStore（attachStore 注入）
}

// 坐标反查索引（'fx,fy,fz' → Set<blockName>）——blockUpdate 监听每事件调用
// removeResourceAt，全表扫描（≤512 条 × Object.entries）在大挖掘/森林大火时
// 每格一次主线程压力。索引使未命中路径 O(1)（绝大多数事件坐标不在记忆里）。
// 与 resources 双写同步：recordResource/removeResourceAt/importSnapshot/_reset 均维护。
const byCoord = new Map()

function coordKey (x, y, z) {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
}

/** 重建 byCoord 索引（importSnapshot/_reset 后同步）。 */
function rebuildIndex () {
  byCoord.clear()
  for (const [name, list] of Object.entries(state.resources)) {
    for (const r of list) {
      const k = coordKey(r.x, r.y, r.z)
      const s = byCoord.get(k)
      if (s) s.add(name)
      else byCoord.set(k, new Set([name]))
    }
  }
}

function now () {
  return Date.now()
}

/** 快照（持久化用）。 */
export function snapshot () {
  return {
    version: 2, // v2：+places（命名地点）
    anchors: state.anchors.slice(0, MAX_ANCHORS),
    resources: JSON.parse(JSON.stringify(state.resources)),
    places: state.places.slice(0, MAX_PLACES)
  }
}

/** 从快照回灌（feature-layer 重建时；容量/形状防御与 record 路径一致）。 */
export function importSnapshot (memory) {
  if (!memory || typeof memory !== 'object') return
  if (Array.isArray(memory.anchors)) {
    state.anchors = memory.anchors
      .filter(a => a && Number.isInteger(a.x) && Number.isInteger(a.y) && Number.isInteger(a.z))
      .slice(-MAX_ANCHORS)
  }
  // v2：命名地点回灌（旧快照无 places 按空；形状防御）
  if (Array.isArray(memory.places)) {
    state.places = memory.places
      .filter(p => p && typeof p.name === 'string' && p.name && Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z))
      .slice(-MAX_PLACES)
  } else {
    state.places = []
  }
  if (memory.resources && typeof memory.resources === 'object' && !Array.isArray(memory.resources)) {
    const res = {}
    let count = 0
    for (const [name, list] of Object.entries(memory.resources)) {
      if (!Array.isArray(list)) continue
      const clean = list
        .filter(r => r && Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.z))
        .slice(-MAX_RESOURCES_PER_NAME)
      if (clean.length) {
        res[name] = clean
        count += clean.length
      }
    }
    // 全局上限：超限从最旧记录开始淘汰
    let entries = []
    for (const [name, list] of Object.entries(res)) {
      for (const r of list) entries.push({ name, ...r })
    }
    entries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    while (entries.length > MAX_RESOURCES_TOTAL) entries.shift()
    state.resources = {}
    for (const e of entries) {
      // 快照往返保留维度——否则下界记录回灌后丢失 dimension 字段，
      // query 按维度过滤查不到
      (state.resources[e.name] ??= []).push({
        x: e.x, y: e.y, z: e.z, ts: e.ts,
        ...(e.dimension ? { dimension: e.dimension } : {})
      })
    }
  }
  rebuildIndex() // 索引与回灌同步
  persist()
}

/** 登记访问锚点（explore 任务每站调用）。带维度（下界/末地坐标独立）。 */
export function recordAnchor (pos, dimension = null) {
  if (!pos) return
  state.anchors.push({
    x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), ts: now(),
    ...(dimension ? { dimension } : {})
  })
  if (state.anchors.length > MAX_ANCHORS) state.anchors.shift()
  persist()
}

/**
 * 登记资源发现（chunk 坐标去重：同 chunk 已记录只刷新 ts 不新增）。
 * @returns {boolean} 是否是新记录（首次发现该 chunk 的该资源）
 */
export function recordResource (name, pos, dimension = null) {
  if (!name || !pos) return false
  const list = state.resources[name] ?? (state.resources[name] = [])
  const chunkKey = (pos) => `${Math.floor(pos.x) >> 4},${Math.floor(pos.z) >> 4}`
  const key = chunkKey(pos)
  const existing = list.find(r => chunkKey(r) === key)
  if (existing) {
    existing.ts = now()
    // 旧记录补维度（同 chunk 跨维度记录已不可能——chunkKey 按 x/z 去重，
    // 维度不同则记录冲突；此处仅补旧数据缺失的维度）
    if (!existing.dimension && dimension) existing.dimension = dimension
    return false
  }
  // 维度字段——下界/末地坐标与主世界混存会误导查询（8:1 映射），
  // query 按维度过滤；旧数据（无维度）仅匹配主世界查询
  list.push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), ts: now(), ...(dimension ? { dimension } : {}) })
  // 索引维护（与 resources 双写）
  const ck = coordKey(pos.x, pos.y, pos.z)
  const s = byCoord.get(ck)
  if (s) s.add(name)
  else byCoord.set(ck, new Set([name]))
  if (list.length > MAX_RESOURCES_PER_NAME) {
    const dropped = list.shift()
    if (dropped) {
      const ds = byCoord.get(coordKey(dropped.x, dropped.y, dropped.z))
      ds?.delete(name)
      if (ds && ds.size === 0) byCoord.delete(coordKey(dropped.x, dropped.y, dropped.z))
    }
  }
  // 全局上限：从全局最旧开始淘汰
  let total = 0
  for (const l of Object.values(state.resources)) total += l.length
  while (total > MAX_RESOURCES_TOTAL) {
    let oldestName = null
    let oldestTs = Infinity
    for (const [name, l] of Object.entries(state.resources)) {
      if (l[0]?.ts < oldestTs) { oldestTs = l[0].ts; oldestName = name }
    }
    if (!oldestName) break
    const dropped = state.resources[oldestName].shift()
    if (dropped) {
      const ds = byCoord.get(coordKey(dropped.x, dropped.y, dropped.z))
      ds?.delete(oldestName)
      if (ds && ds.size === 0) byCoord.delete(coordKey(dropped.x, dropped.y, dropped.z))
    }
    if (state.resources[oldestName].length === 0) delete state.resources[oldestName]
    total--
  }
  persist()
  return true
}

/**
 * 删除指定坐标的全部资源记录（地形记忆失效）。
 * 调用点：dig/collect_blocks 挖除后、blockUpdate 方块变化时、query_map 验证失败自愈。
 * 按坐标精确删除（一个坐标只可能是一种方块——无需 name 参数；同坐标下多个
 * name 的记录一并清除，防御未来同坐标多记录场景）。
 * @returns {number} 删除条数
 */
export function removeResourceAt (x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 0
  const fx = Math.floor(x); const fy = Math.floor(y); const fz = Math.floor(z)
  // byCoord 索引 O(1) 判空——blockUpdate 高频事件（挖掘/火烧/水流）的
  // 绝大多数坐标不在记忆里
  const names = byCoord.get(coordKey(fx, fy, fz))
  if (!names) return 0
  let removed = 0
  for (const name of [...names]) {
    const list = state.resources[name]
    if (!list) { names.delete(name); continue }
    const kept = list.filter(r => !(Math.floor(r.x) === fx && Math.floor(r.y) === fy && Math.floor(r.z) === fz))
    removed += list.length - kept.length
    if (kept.length) state.resources[name] = kept
    else delete state.resources[name]
  }
  byCoord.delete(coordKey(fx, fy, fz)) // 该坐标已无任何记录
  if (removed > 0) persist()
  return removed
}

/**
 * 查询已知资源（按与 pos 的欧氏距离升序；不重新扫描）。
 * dimension 提供时按维度过滤——旧记录（无维度字段）只对主世界查询匹配；
 * 下界/末地查询只返回带对应维度的记录（8:1 坐标映射下跨维度坐标会误导 LLM/玩家）。
 * @returns {Array<{x,y,z,ts,dimension?}>}
 */
export function query (name, pos, maxCount = 5, dimension = null) {
  const list = (state.resources[name] ?? [])
    .filter(r => !dimension || r.dimension === dimension || (!r.dimension && dimension === 'overworld'))
  if (!pos || list.length === 0) return list.slice(0, maxCount)
  return [...list]
    .sort((a, b) => {
      const da = (a.x - pos.x) ** 2 + (a.y - pos.y) ** 2 + (a.z - pos.z) ** 2
      const db = (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2 + (b.z - pos.z) ** 2
      return da - db
    })
    .slice(0, maxCount)
}

/**
 * 登记命名地点（!home set / set_place）。同名覆盖（带维度——下界/主世界基地不混淆）；
 * 超上限淘汰最旧。名字规范化：trim + 小写（query_map 匹配同口径）。
 * @returns {boolean} 是否新登记（覆盖旧名 = true）
 */
export function setPlace (name, pos, dimension = null) {
  const key = String(name ?? '').trim().toLowerCase()
  if (!key || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return false
  const idx = state.places.findIndex(p => p.name === key)
  if (idx !== -1) {
    state.places[idx] = { name: key, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimension: dimension ?? null, ts: now() }
  } else {
    state.places.push({ name: key, x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimension: dimension ?? null, ts: now() })
    if (state.places.length > MAX_PLACES) state.places.shift()
  }
  persist()
  return true
}

/** 删除命名地点。@returns {boolean} 是否存在并删除 */
export function removePlace (name) {
  const key = String(name ?? '').trim().toLowerCase()
  const before = state.places.length
  state.places = state.places.filter(p => p.name !== key)
  if (state.places.length !== before) { persist(); return true }
  return false
}

/** 查询命名地点（query_map place 分支用；大小写不敏感）。 */
export function getPlace (name) {
  const key = String(name ?? '').trim().toLowerCase()
  return state.places.find(p => p.name === key) ?? null
}

/** 全部命名地点（!home list / map_status）。 */
export function listPlaces () {
  return state.places.map(p => ({ ...p }))
}

/** 地图统计（map_status 技能与 /metrics 用）。 */
export function stats () {
  const total = Object.values(state.resources).reduce((s, l) => s + l.length, 0)
  const names = Object.entries(state.resources)
    .map(([name, list]) => ({ name, count: list.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity
  for (const a of state.anchors) {
    if (a.x < minX) minX = a.x
    if (a.x > maxX) maxX = a.x
    if (a.z < minZ) minZ = a.z
    if (a.z > maxZ) maxZ = a.z
  }
  const covered = state.anchors.length > 1
    ? `X ${minX}..${maxX} Z ${minZ}..${maxZ}`
    : state.anchors.length === 1
      ? `单点 (${state.anchors[0].x},${state.anchors[0].z})`
      : '无'
  // 维度分布（运维看"探索到哪个维度"）
  const dimCounts = {}
  for (const r of Object.values(state.resources).flat()) {
    const d = r.dimension ?? 'overworld'
    dimCounts[d] = (dimCounts[d] ?? 0) + 1
  }
  return {
    anchors: state.anchors.length,
    resources: total,
    places: state.places.length, // 命名地点数
    covered,
    topResources: names,
    dimensions: dimCounts
  }
}

/** 测试/隔离钩子：清空全部记忆（不持久化）。 */
export function _reset () {
  state.anchors = []
  state.resources = {}
  state.places = []
  byCoord.clear()
}

function persist () {
  if (state.store) state.store.setMemory(snapshot())
}

/** 接入状态持久化（index.js 创建 stateStore 后调用）。 */
export function attachStore (store) {
  state.store = store ?? null
}
