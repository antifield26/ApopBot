// 探索记忆（L2 进化 B1）测试：容量边界/去重/淘汰/快照往返。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as discovery from '../src/core/discovery.ts'
import { DANGER_FRESH_MS } from '../src/core/discovery.ts'

test.beforeEach(() => discovery._reset())

test('B1: recordResource 去重——同 chunk 只刷新 ts 不新增', () => {
  const r1 = discovery.recordResource('iron_ore', { x: 10, y: 63, z: 8 })
  const r2 = discovery.recordResource('iron_ore', { x: 11, y: 64, z: 9 }) // 同 chunk (0,0)
  assert.equal(r1, true, '首次发现应为新记录')
  assert.equal(r2, false, '同 chunk 再发现不是新记录')
  assert.equal(discovery.query('iron_ore', { x: 0, y: 0, z: 0 }).length, 1)
  // 不同 chunk 是新记录
  assert.equal(discovery.recordResource('iron_ore', { x: 30, y: 63, z: 8 }), true) // chunk (1,0)
  assert.equal(discovery.query('iron_ore').length, 2)
})

test('B1: 每块名上限 16 条，超限淘汰最旧', () => {
  for (let i = 0; i < 20; i++) discovery.recordResource('coal_ore', { x: i * 20, y: 60, z: 0 })
  const list = discovery.query('coal_ore', null, 20) // 传 maxCount 看全量
  assert.equal(list.length, 16, '每块名最多 16 条')
  assert.ok(!list.some(r => r.x === 0), '最早的记录应被淘汰')
  assert.ok(list.some(r => r.x === 19 * 20), '最新的保留')
})

test('B1: 全局 512 条上限——超限淘汰全局最旧', () => {
  // 每名 16 上限先生效（33 × 16 = 528 > 512）→ 全局淘汰再触发
  for (let n = 0; n < 33; n++) {
    for (let i = 0; i < 16; i++) discovery.recordResource(`ore_${n}`, { x: i * 20, y: 60, z: n * 20 })
  }
  const s = discovery.stats()
  assert.equal(s.resources, 512, '全局最多 512 条')
  // 全局淘汰按 ts 最旧——第一个名字的最早记录应被淘汰
  const first = discovery.query('ore_0', null, 20)
  assert.equal(first.length, 16 - 16, '最旧名字的记录被全局淘汰')
  assert.equal(discovery.query('ore_32', null, 20).length, 16, '最后的名字保留全量')
})

test('B1: anchors 上限 256 环形淘汰', () => {
  for (let i = 0; i < 300; i++) discovery.recordAnchor({ x: i, y: 64, z: 0 })
  assert.equal(discovery.stats().anchors, 256)
  const s = discovery.snapshot()
  assert.ok(!s.anchors.some(a => a.x === 0), '最旧锚点应被淘汰')
})

test('B1: 快照往返——attachStore 后 setMemory 持久化 + importSnapshot 回灌', () => {
  const saved = []
  discovery.attachStore({ setMemory: (m) => { saved.push(m) } })
  discovery.recordResource('diamond_ore', { x: 100, y: 12, z: -50 })
  discovery.recordAnchor({ x: 0, y: 64, z: 0 })
  assert.ok(saved.length >= 1, '修改应触发 setMemory')
  const snap = saved.at(-1)
  assert.equal(snap.version, 3, 'v3 快照（含 places/dangerZones）')
  assert.equal(snap.resources.diamond_ore.length, 1)
  assert.equal(snap.anchors.length, 1)
  assert.ok(Array.isArray(snap.places), 'v2 快照含 places 数组')
  // 清空后回灌
  discovery._reset()
  discovery.importSnapshot(snap)
  assert.equal(discovery.query('diamond_ore').length, 1)
  assert.equal(discovery.stats().anchors, 1)
  discovery.attachStore(null)
})

test('B1: importSnapshot 形状防御——坏数据按空处理', () => {
  discovery.importSnapshot(null)
  discovery.importSnapshot({ resources: { iron_ore: 'bad' }, anchors: 'bad' })
  assert.equal(discovery.stats().resources, 0)
  assert.equal(discovery.stats().anchors, 0)
})

test('B1: query 按当前位置距离升序', () => {
  discovery.recordResource('gold_ore', { x: 100, y: 30, z: 0 })
  discovery.recordResource('gold_ore', { x: 10, y: 30, z: 0 })
  const r = discovery.query('gold_ore', { x: 0, y: 64, z: 0 }, 5)
  assert.equal(r[0].x, 10, '近的在前')
  assert.equal(r[1].x, 100)
})

// ===== 第 10 轮：地形记忆失效 =====

test('B1: removeResourceAt 删除精确坐标（含跨 name）', () => {
  discovery.recordResource('coal_ore', { x: 10, y: 60, z: 8 })
  discovery.recordResource('iron_ore', { x: 10, y: 60, z: 8 }) // 同坐标（防御场景）
  discovery.recordResource('coal_ore', { x: 30, y: 60, z: 8 })
  const removed = discovery.removeResourceAt(10, 60, 8)
  assert.equal(removed, 2, '同坐标两条记录都删')
  assert.equal(discovery.query('coal_ore').length, 1, '其他坐标保留')
  assert.equal(discovery.query('iron_ore').length, 0, '同坐标其他 name 也删')
  // 不存在的坐标：0 删除且不报错
  assert.equal(discovery.removeResourceAt(999, 999, 999), 0)
})

test('B1: removeResourceAt 浮点坐标按 floor 匹配（blockAt 返回浮点）', () => {
  discovery.recordResource('coal_ore', { x: 10, y: 60, z: 8 })
  // blockUpdate/dig 传的浮点位置（实体坐标）应匹配整数记录
  assert.equal(discovery.removeResourceAt(10.42, 60.1, 8.9), 1, '浮点按 floor 匹配')
  assert.equal(discovery.query('coal_ore').length, 0)
})

test('B1: removeResourceAt 触发持久化', () => {
  const saved = []
  discovery.attachStore({ setMemory: (m) => { saved.push(m) } })
  discovery.recordResource('coal_ore', { x: 10, y: 60, z: 8 })
  saved.length = 0
  discovery.removeResourceAt(10, 60, 8)
  assert.ok(saved.length >= 1, '删除应触发持久化')
  assert.equal(saved.at(-1).resources.coal_ore, undefined, '快照中该记录已删')
  discovery.attachStore(null)
})

// 第 11 轮 G1：维度感知——下界/末地记录独立存储，跨维度查询过滤。
// 注意 chunk 去重（x>>4,z>>4）——测试坐标必须跨 chunk（x 相差 ≥16）
test('G1: 维度感知——recordResource 带维度，query 按维度过滤', () => {
  // 主世界（含旧数据无维度字段——兼容主世界查询）
  discovery.recordResource('iron_ore', { x: 10, y: 60, z: 8 }, 'overworld')
  discovery.recordResource('iron_ore', { x: 40, y: 60, z: 8 }) // 旧数据形态（跨 chunk）
  // 下界记录（同名字不同维度）
  discovery.recordResource('iron_ore', { x: 100, y: 30, z: 100 }, 'nether')
  // 主世界查询：命中 2 条（overworld + 旧数据）
  assert.equal(discovery.query('iron_ore', null, 5, 'overworld').length, 2)
  // 下界查询：只命中 nether 记录（主世界/旧数据被过滤）
  const nether = discovery.query('iron_ore', null, 5, 'nether')
  assert.equal(nether.length, 1)
  assert.equal(nether[0].dimension, 'nether')
  // 不提供维度：不过滤（兼容旧调用方）
  assert.equal(discovery.query('iron_ore', null, 5).length, 3)
})

test('M2 修复：同 chunk 跨维度记录独立去重——下界不被主世界吞并', () => {
  // 主世界 chunk (10>>4, 8>>4) 记录钻石
  assert.equal(discovery.recordResource('diamond_ore', { x: 10, y: 12, z: 8 }, 'overworld'), true)
  // 下界相同 x/z chunk 记录石英——修复前 chunkKey 不含维度 → 命中主世界
  // 记录只刷 ts 不新增 → 下界查询永远查不到石英
  assert.equal(discovery.recordResource('nether_quartz_ore', { x: 10, y: 60, z: 8 }, 'nether'), true)
  assert.equal(discovery.query('nether_quartz_ore', null, 5, 'nether').length, 1, '下界记录不应被吞并')
  // 同名资源跨维度同 chunk 各自独立
  assert.equal(discovery.recordResource('iron_ore', { x: 10, y: 60, z: 8 }, 'overworld'), true)
  assert.equal(discovery.recordResource('iron_ore', { x: 10, y: 30, z: 8 }, 'nether'), true, '同 chunk 跨维度应新增而非刷 ts')
  assert.equal(discovery.query('iron_ore', null, 5, 'overworld').length, 1)
  assert.equal(discovery.query('iron_ore', null, 5, 'nether').length, 1)
  // 同 chunk 同维度仍去重
  assert.equal(discovery.recordResource('iron_ore', { x: 11, y: 31, z: 9 }, 'nether'), false, '同 chunk 同维度仍只刷 ts')
  assert.equal(discovery.query('iron_ore', null, 5, 'nether').length, 1)
  // 快照往返后两条独立记录保留
  const snap = discovery.snapshot()
  discovery._reset()
  discovery.importSnapshot(snap)
  assert.equal(discovery.query('iron_ore', null, 5, 'overworld').length, 1)
  assert.equal(discovery.query('iron_ore', null, 5, 'nether').length, 1)
})

test('G1: 维度感知——快照往返保留维度，stats 统计维度分布', () => {
  discovery.recordResource('nether_gold_ore', { x: 5, y: 40, z: 5 }, 'nether')
  discovery.recordResource('coal_ore', { x: 5, y: 61, z: 5 }, 'overworld')
  const snap = discovery.snapshot()
  assert.equal(snap.resources.nether_gold_ore[0].dimension, 'nether')
  discovery._reset()
  discovery.importSnapshot(snap)
  assert.equal(discovery.query('nether_gold_ore', null, 5, 'nether').length, 1, '快照往返后维度保留')
  assert.equal(discovery.stats().dimensions.nether, 1, '维度分布统计')
})

// 命名地点（A7）：!home set / set_place 登记的语义坐标
test('A7: setPlace/removePlace/getPlace——同名覆盖 + 名字规范化 + 容量上限', () => {
  discovery.setPlace('Home', { x: 10, y: 64, z: 20 }, 'overworld')
  assert.equal(discovery.getPlace('home').x, 10, '名字小写化匹配')
  discovery.setPlace('home', { x: 11, y: 64, z: 20 }, 'overworld') // 同名覆盖
  assert.equal(discovery.getPlace('home').x, 11, '同名覆盖更新坐标')
  discovery.setPlace('mine', { x: 100, y: 30, z: 100 }, 'nether')
  assert.equal(discovery.getPlace('MINE').dimension, 'nether', '维度保留（下界基地独立）')
  assert.equal(discovery.removePlace('HOME'), true, '删除命中')
  assert.equal(discovery.getPlace('home'), null, '删除后查空')
  assert.equal(discovery.removePlace('home'), false, '重复删除 false')
})

test('A7: 快照往返保留 places（version 3）', () => {
  discovery.setPlace('base', { x: 1, y: 2, z: 3 }, 'overworld')
  const snap = discovery.snapshot()
  assert.equal(snap.version, 3)
  assert.equal(snap.places[0].name, 'base')
  discovery._reset()
  discovery.importSnapshot(snap)
  assert.equal(discovery.getPlace('base').z, 3, '回灌后地点保留')
})

// ---- dangerZones 危险区域记忆（World Model）----

test('P1: recordDangerZone——同 chunk 刷新 ts/名字并集不新增', () => {
  discovery._reset()
  const p1 = { x: 100, y: 64, z: 100 }
  const p2 = { x: 108, y: 64, z: 100 } // 同 chunk（>>4 相同）
  assert.equal(discovery.recordDangerZone(p1, { hostileNames: ['zombie'] }, 'overworld'), true)
  assert.equal(discovery.recordDangerZone(p2, { hostileNames: ['creeper'] }, 'overworld'), false, '同 chunk 应刷新不新增')
  const zones = discovery.listDangerZones()
  assert.equal(zones.length, 1, '同 chunk 只保留 1 条')
  assert.deepEqual(zones[0].hostileNames, ['zombie', 'creeper'], '名字应为并集')
  assert.equal(zones[0].x, 108, '位置应更新为最近目击')
})

test('P1: recordDangerZone——容量上限淘汰最旧（MAX_DANGER_ZONES）', () => {
  discovery._reset()
  for (let i = 0; i < 70; i++) {
    discovery.recordDangerZone({ x: i * 64, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  }
  assert.equal(discovery.listDangerZones().length, 64, '应封顶 64 条')
  assert.equal(discovery.listDangerZones()[0].x, 6 * 64, '最旧（x=0）应被淘汰')
})

test('P1: queryDangerZones——距离升序 + fresh/ageMinutes 标记', () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 100, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  discovery.recordDangerZone({ x: 50, y: 64, z: 0 }, { hostileNames: ['creeper'] })
  const zones = discovery.queryDangerZones({ x: 0, y: 64, z: 0 }, { radius: 200 })
  assert.equal(zones.length, 2)
  assert.equal(zones[0].x, 50, '近者优先')
  assert.equal(zones[0].fresh, true, '刚记录应新鲜')
  assert.equal(zones[0].ageMinutes, 0)
})

test('P1: queryDangerZones——维度过滤 + 半径外排除', () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 10, y: 64, z: 0 }, { hostileNames: ['zombie'] }, 'the_nether')
  discovery.recordDangerZone({ x: 10, y: 64, z: 0 }, { hostileNames: ['zombie'] }, 'overworld')
  const ow = discovery.queryDangerZones({ x: 0, y: 64, z: 0 }, { dimension: 'overworld' })
  assert.equal(ow.length, 1, '主世界查询只返回主世界记录')
  assert.equal(discovery.queryDangerZones({ x: 0, y: 64, z: 0 }, { radius: 5 }).length, 0, '半径外排除')
})

test('P1: 快照往返——version 3 含 dangerZones；importSnapshot 旧快照按空', () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 10, y: 64, z: 0 }, { hostileNames: ['zombie'] }, 'overworld')
  const snap = discovery.snapshot()
  assert.equal(snap.version, 3)
  assert.equal(snap.dangerZones.length, 1)
  // 旧快照（无 dangerZones 键）→ 按空
  discovery._reset()
  discovery.importSnapshot({ version: 2, anchors: [], resources: {}, places: [] })
  assert.equal(discovery.listDangerZones().length, 0, '旧快照按空')
  // 往返恢复
  discovery._reset()
  discovery.importSnapshot(snap)
  assert.equal(discovery.listDangerZones().length, 1)
  assert.deepEqual(discovery.listDangerZones()[0].hostileNames, ['zombie'])
})

test('P1: importSnapshot 形状防御——坏 dangerZones 按空', () => {
  discovery._reset()
  discovery.importSnapshot({ version: 3, dangerZones: [{ x: 'bad', y: 1, z: 1, threatLevel: 'x', hostileNames: 'not-array', ts: 'x' }] })
  assert.equal(discovery.listDangerZones().length, 0, '坏记录按空')
})

test('P1: stats 含 dangerZones 计数；_reset 清空', () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 10, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  assert.equal(discovery.stats().dangerZones, 1)
  discovery._reset()
  assert.equal(discovery.stats().dangerZones, 0)
})

// ---- 语义聚合（P2）：资源×危险区关联 ----

test('P2: queryResourcesWithRisk——无危险区时 nearestDanger=null', () => {
  discovery._reset()
  discovery.recordResource('iron_ore', { x: 100, y: 64, z: 0 })
  const hits = discovery.queryResourcesWithRisk('iron_ore', { x: 0, y: 64, z: 0 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].nearestDanger, null)
})

test('P2: queryResourcesWithRisk——危险区 dist/names 正确', () => {
  discovery._reset()
  discovery.recordResource('iron_ore', { x: 100, y: 64, z: 0 })
  discovery.recordDangerZone({ x: 110, y: 64, z: 0 }, { hostileNames: ['zombie', 'creeper'] })
  const hits = discovery.queryResourcesWithRisk('iron_ore', { x: 0, y: 64, z: 0 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].nearestDanger.dist, 10)
  assert.deepEqual(hits[0].nearestDanger.names, ['zombie', 'creeper'])
})

test('P2: queryResourcesWithRisk——radius 过滤（危险区在搜索半径外→null）', () => {
  discovery._reset()
  discovery.recordResource('iron_ore', { x: 100, y: 64, z: 0 })
  discovery.recordDangerZone({ x: 200, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  assert.equal(discovery.queryResourcesWithRisk('iron_ore', { x: 0, y: 64, z: 0 }, { radius: 50 })[0].nearestDanger, null)
  assert.notEqual(discovery.queryResourcesWithRisk('iron_ore', { x: 0, y: 64, z: 0 }, { radius: 128 })[0].nearestDanger, null)
})

test('P2: queryResourcesWithRisk——维度过滤（下界危险区不附主世界资源）', () => {
  discovery._reset()
  discovery.recordResource('iron_ore', { x: 100, y: 64, z: 0 }, 'overworld')
  discovery.recordDangerZone({ x: 110, y: 64, z: 0 }, { hostileNames: ['zombie'] }, 'the_nether')
  const hits = discovery.queryResourcesWithRisk('iron_ore', { x: 0, y: 64, z: 0 }, { dimension: 'overworld' })
  assert.equal(hits[0].nearestDanger, null, '下界危险区不应附到主世界资源')
})

test('P2: queryResourcesWithRisk——maxCount 截断复用 query 语义', () => {
  discovery._reset()
  discovery.recordResource('coal_ore', { x: 100, y: 64, z: 0 })
  discovery.recordResource('coal_ore', { x: 100, y: 64, z: 80 }) // 不同 chunk
  discovery.recordDangerZone({ x: 100, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  const hits = discovery.queryResourcesWithRisk('coal_ore', { x: 0, y: 64, z: 0 }, { maxCount: 1 })
  assert.equal(hits.length, 1, 'maxCount=1 只返回最近 1 条')
  assert.equal(hits[0].nearestDanger.dist, 0)
})

test('P2: assessLocation——无记录 → safe:true 空数组', () => {
  discovery._reset()
  const a = discovery.assessLocation({ x: 0, y: 64, z: 0 })
  assert.equal(a.safe, true)
  assert.deepEqual(a.dangerZones, [])
})

test('P2: assessLocation——fresh 记录 → safe:false 且含 dist/fresh/ageMinutes', () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 10, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  const a = discovery.assessLocation({ x: 0, y: 64, z: 0 })
  assert.equal(a.safe, false)
  assert.equal(a.dangerZones.length, 1)
  assert.equal(a.dangerZones[0].dist, 10)
  assert.equal(a.dangerZones[0].fresh, true)
  assert.equal(a.dangerZones[0].ageMinutes, 0)
})

test('P2: assessLocation——stale 记录（1h 外）→ safe:true（过期不算威胁）', () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 10, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  const stale = discovery.listDangerZones().map(z => ({ ...z, ts: Date.now() - DANGER_FRESH_MS - 60000 }))
  discovery._reset()
  discovery.importSnapshot({ version: 3, anchors: [], resources: {}, places: [], dangerZones: stale })
  const a = discovery.assessLocation({ x: 0, y: 64, z: 0 })
  assert.equal(a.safe, true, '过期记录不算威胁')
  assert.equal(a.dangerZones.length, 1, '过期记录仍返回（fresh=false 供判断）')
})

test('P2: assessLocation——radius 外不报（radius 缩小→safe）', () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 100, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  assert.equal(discovery.assessLocation({ x: 0, y: 64, z: 0 }, { radius: 50 }).safe, true)
  assert.equal(discovery.assessLocation({ x: 0, y: 64, z: 0 }, { radius: 128 }).safe, false)
})
