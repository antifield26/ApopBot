// 探索记忆（L2 进化 B1）：DiscoveryMap 模块级单例——已访问锚点 + 资源发现缓存。
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

const state = {
  anchors: [], // [{x, y, z, ts}] 按插入序（旧在前），环形淘汰
  resources: {}, // blockName → [{x, y, z, ts}]（按插入序，新在后）
  store: null // stateStore（attachStore 注入）
}

function now () {
  return Date.now()
}

/** 快照（持久化用）。 */
export function snapshot () {
  return { version: 1, anchors: state.anchors.slice(0, MAX_ANCHORS), resources: JSON.parse(JSON.stringify(state.resources)) }
}

/** 从快照回灌（feature-layer 重建时；容量/形状防御与 record 路径一致）。 */
export function importSnapshot (memory) {
  if (!memory || typeof memory !== 'object') return
  if (Array.isArray(memory.anchors)) {
    state.anchors = memory.anchors
      .filter(a => a && Number.isInteger(a.x) && Number.isInteger(a.y) && Number.isInteger(a.z))
      .slice(-MAX_ANCHORS)
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
      (state.resources[e.name] ??= []).push({ x: e.x, y: e.y, z: e.z, ts: e.ts })
    }
  }
  persist()
}

/** 登记访问锚点（explore 任务每站调用）。 */
export function recordAnchor (pos) {
  if (!pos) return
  state.anchors.push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), ts: now() })
  if (state.anchors.length > MAX_ANCHORS) state.anchors.shift()
  persist()
}

/**
 * 登记资源发现（chunk 坐标去重：同 chunk 已记录只刷新 ts 不新增）。
 * @returns {boolean} 是否是新记录（首次发现该 chunk 的该资源）
 */
export function recordResource (name, pos) {
  if (!name || !pos) return false
  const list = state.resources[name] ?? (state.resources[name] = [])
  const chunkKey = (pos) => `${Math.floor(pos.x) >> 4},${Math.floor(pos.z) >> 4}`
  const key = chunkKey(pos)
  const existing = list.find(r => chunkKey(r) === key)
  if (existing) {
    existing.ts = now()
    return false
  }
  list.push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), ts: now() })
  if (list.length > MAX_RESOURCES_PER_NAME) list.shift()
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
    state.resources[oldestName].shift()
    if (state.resources[oldestName].length === 0) delete state.resources[oldestName]
    total--
  }
  persist()
  return true
}

/**
 * 查询已知资源（按与 pos 的欧氏距离升序；不重新扫描）。
 * @returns {Array<{x,y,z,ts}>}
 */
export function query (name, pos, maxCount = 5) {
  const list = state.resources[name] ?? []
  if (!pos || list.length === 0) return list.slice(0, maxCount)
  return [...list]
    .sort((a, b) => {
      const da = (a.x - pos.x) ** 2 + (a.y - pos.y) ** 2 + (a.z - pos.z) ** 2
      const db = (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2 + (b.z - pos.z) ** 2
      return da - db
    })
    .slice(0, maxCount)
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
  return {
    anchors: state.anchors.length,
    resources: total,
    covered,
    topResources: names
  }
}

/** 测试/隔离钩子：清空全部记忆（不持久化）。 */
export function _reset () {
  state.anchors = []
  state.resources = {}
}

function persist () {
  if (state.store) state.store.setMemory(snapshot())
}

/** 接入状态持久化（index.js 创建 stateStore 后调用）。 */
export function attachStore (store) {
  state.store = store ?? null
}
