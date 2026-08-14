// query_map 地形记忆验证测试（第 10 轮）：已加载区块逐条核对（失效自动删除）、
// 未加载区块标 verified:false——杜绝过期坐标误导 LLM/玩家（用户实测误判 find
// 失效的根因）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrimitiveRegistry } from '../src/core/primitives/index.ts'
import * as discovery from '../src/core/discovery.ts'

test.beforeEach(() => discovery._reset())

/** fake bot：blockAt 可注入（返回方块名或 null=未加载）。 */
function makeBot (blocks = {}) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: (v) => {
      const b = blocks[`${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`]
      return b === undefined ? null : { name: b }
    }
  }
}

const makeCtx = (bot) => ({
  cfg: { ops: [] },
  logger: { warn: () => {}, child: () => makeCtx(bot).logger },
  bot,
  conn: { getStatus: () => ({ state: 'connected' }) }
})

async function queryMap (bot, blockName) {
  const reg = createPrimitiveRegistry(makeCtx(bot))
  const def = reg.get('query_map')
  return def.handler(makeCtx(bot), { blockName }, {})
}

test('query_map: 已加载且仍是该方块 → verified:true 保留', async () => {
  discovery.recordResource('coal_ore', { x: 10, y: 60, z: 8 })
  const bot = makeBot({ '10,60,8': 'coal_ore' })
  const r = await queryMap(bot, 'coal_ore')
  assert.equal(r.length, 1)
  assert.equal(r[0].verified, true)
  assert.equal(discovery.query('coal_ore').length, 1, '验证通过不删除')
})

test('query_map: 已加载但不是该方块 → 自动删除（记忆自愈）', async () => {
  discovery.recordResource('coal_ore', { x: 10, y: 60, z: 8 })
  const bot = makeBot({ '10,60,8': 'stone' }) // 煤已被挖/替换
  const r = await queryMap(bot, 'coal_ore')
  assert.equal(r.length, 0, '失效记录被剔除')
  assert.equal(discovery.query('coal_ore').length, 0, '记忆已自愈删除')
})

test('query_map: 未加载区块 → verified:false 保留（无法核对）', async () => {
  discovery.recordResource('iron_ore', { x: 500, y: 20, z: 500 })
  const bot = makeBot({}) // 远处区块未加载 blockAt null
  const r = await queryMap(bot, 'iron_ore')
  assert.equal(r.length, 1)
  assert.equal(r[0].verified, false)
  assert.equal(discovery.query('iron_ore').length, 1, '未加载不删除')
})

test('query_map: 混合场景——失效剔除 + 有效保留 + 未加载标记', async () => {
  discovery.recordResource('coal_ore', { x: 10, y: 60, z: 8 }) // 已挖（stone）
  discovery.recordResource('coal_ore', { x: 20, y: 60, z: 8 }) // 仍在
  discovery.recordResource('coal_ore', { x: 500, y: 60, z: 8 }) // 未加载
  const bot = makeBot({ '10,60,8': 'stone', '20,60,8': 'coal_ore' })
  const r = await queryMap(bot, 'coal_ore')
  assert.equal(r.length, 2, '有效 + 未加载各 1')
  assert.ok(r.some(x => x.x === 20 && x.verified === true))
  assert.ok(r.some(x => x.x === 500 && x.verified === false))
  assert.ok(!r.some(x => x.x === 10), '失效记录已剔除')
  assert.equal(discovery.query('coal_ore').length, 2, '记忆已自愈（剩有效+未加载）')
})

// ---- danger 分支（World Model：附近危险区域记忆）----

test('P1: query_map danger 分支——返回附近危险区域（fresh 标记）', async () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 30, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  const reg = createPrimitiveRegistry(makeCtx(makeBot()))
  const r = await reg.get('query_map').handler(makeCtx(makeBot()), { danger: true }, {})
  assert.ok(r.danger, '应返回 danger 字段')
  assert.equal(r.danger.length, 1)
  assert.equal(r.danger[0].hostileNames[0], 'zombie')
  assert.equal(r.danger[0].fresh, true)
})

test('P1: query_map danger 分支——无记录 → 空数组（非错误）', async () => {
  discovery._reset()
  const reg = createPrimitiveRegistry(makeCtx(makeBot()))
  const r = await reg.get('query_map').handler(makeCtx(makeBot()), { danger: true }, {})
  assert.deepEqual(r.danger, [])
})

test('P1: query_map danger 与 blockName 同传 → 互斥报错', async () => {
  discovery._reset()
  const reg = createPrimitiveRegistry(makeCtx(makeBot()))
  await assert.rejects(
    reg.get('query_map').handler(makeCtx(makeBot()), { danger: true, blockName: 'iron_ore' }, {}),
    /互斥/
  )
})

// ---- 语义聚合（P2）：assess 分支 + minSafeDist + 互斥补全 ----

test('P2: blockName 与 place 同传 → 互斥报错（修复静默忽略漏洞）', async () => {
  discovery._reset()
  const reg = createPrimitiveRegistry(makeCtx(makeBot()))
  await assert.rejects(
    reg.get('query_map').handler(makeCtx(makeBot()), { blockName: 'iron_ore', place: 'home' }, {}),
    /互斥/
  )
})

test('P2: place 与 assess、danger 与 assess 同传 → 互斥报错', async () => {
  discovery._reset()
  const reg = createPrimitiveRegistry(makeCtx(makeBot()))
  await assert.rejects(reg.get('query_map').handler(makeCtx(makeBot()), { place: 'home', assess: '10,60,8' }, {}), /互斥/)
  await assert.rejects(reg.get('query_map').handler(makeCtx(makeBot()), { danger: true, assess: 'home' }, {}), /互斥/)
})

test('P2: assess 空串（缺省）→ 以 bot 当前位置评估', async () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 5, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  const reg = createPrimitiveRegistry(makeCtx(makeBot())) // bot 在 (0,64,0)
  const r = await reg.get('query_map').handler(makeCtx(makeBot()), { assess: '' }, {})
  assert.equal(r.assess, '当前位置')
  assert.equal(r.x, 0); assert.equal(r.z, 0)
  assert.equal(r.safe, false)
  assert.equal(r.dangerZones[0].dist, 5)
})

test('P2: assess 地点名 → 用地点坐标与地点维度评估', async () => {
  discovery._reset()
  discovery.setPlace('home', { x: 100, y: 64, z: -50 }, 'the_nether')
  const reg = createPrimitiveRegistry(makeCtx(makeBot()))
  const r = await reg.get('query_map').handler(makeCtx(makeBot()), { assess: 'home' }, {})
  assert.equal(r.assess, 'place:home')
  assert.equal(r.x, 100); assert.equal(r.z, -50)
  assert.equal(r.safe, true)
})

test('P2: assess x,y,z 坐标 → 解析评估', async () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 200, y: 64, z: 0 }, { hostileNames: ['zombie'] })
  const reg = createPrimitiveRegistry(makeCtx(makeBot()))
  const r = await reg.get('query_map').handler(makeCtx(makeBot()), { assess: '10, 60, -8' }, {})
  assert.equal(r.assess, 'pos:10,60,-8')
  assert.equal(r.x, 10); assert.equal(r.y, 60); assert.equal(r.z, -8)
  assert.equal(r.safe, true, '危险区在 190m 外（radius 64 内无）')
})

test('P2: assess 非法字符串 → 报错', async () => {
  discovery._reset()
  const reg = createPrimitiveRegistry(makeCtx(makeBot()))
  await assert.rejects(
    reg.get('query_map').handler(makeCtx(makeBot()), { assess: '不是地点也不是坐标' }, {}),
    /assess 需要命名地点名或 x,y,z 整数坐标/
  )
})

test('P2: minSafeDist——危险区 10m 内的资源被滤，幸存项含 nearestDanger', async () => {
  discovery._reset()
  discovery.recordResource('iron_ore', { x: 10, y: 60, z: 8 }) // 距危险区 10m
  discovery.recordResource('iron_ore', { x: 100, y: 60, z: 8 }) // 距危险区 100m
  discovery.recordDangerZone({ x: 0, y: 64, z: 8 }, { hostileNames: ['zombie'] })
  const bot = makeBot({ '10,60,8': 'iron_ore', '100,60,8': 'iron_ore' })
  const r = await queryMap(bot, 'iron_ore')
  assert.equal(r.length, 2, '无 minSafeDist 时两条都返回')
  const filtered = await regQueryMapWith(bot, { blockName: 'iron_ore', minSafeDist: 50 })
  assert.equal(filtered[0].x, 100, '危险 10m 内的被滤掉，幸存项在前')
  assert.equal(filtered[0].nearestDanger.dist, 100)
  assert.deepEqual(filtered[1], { filteredByDanger: 1 }, '被滤数量经尾项传达')
})

test('P2: minSafeDist 无 blockName → 报错', async () => {
  discovery._reset()
  const reg = createPrimitiveRegistry(makeCtx(makeBot()))
  await assert.rejects(
    reg.get('query_map').handler(makeCtx(makeBot()), { place: 'home', minSafeDist: 30 }, {}),
    /minSafeDist 只与 blockName 同用/
  )
})

test('P2: minSafeDist 全部被滤 → 返回 filteredByDanger 尾项（非空数组误导）', async () => {
  discovery._reset()
  discovery.recordResource('iron_ore', { x: 10, y: 60, z: 8 })
  discovery.recordDangerZone({ x: 0, y: 64, z: 8 }, { hostileNames: ['zombie'] })
  const bot = makeBot({ '10,60,8': 'iron_ore' })
  const r = await regQueryMapWith(bot, { blockName: 'iron_ore', minSafeDist: 50 })
  assert.deepEqual(r, [{ filteredByDanger: 1 }], '全部被安全过滤时明示而非空数组')
  assert.equal(discovery.query('iron_ore').length, 1, '记忆未删除（只是过滤）')
})

test('P2: blockName 无危险区 → 每条 nearestDanger=null', async () => {
  discovery._reset()
  discovery.recordResource('coal_ore', { x: 10, y: 60, z: 8 })
  const bot = makeBot({ '10,60,8': 'coal_ore' })
  const r = await queryMap(bot, 'coal_ore')
  assert.equal(r[0].nearestDanger, null)
})

/** 带任意参数的 query_map 调用助手。 */
async function regQueryMapWith (bot, args) {
  const reg = createPrimitiveRegistry(makeCtx(bot))
  return reg.get('query_map').handler(makeCtx(bot), args, {})
}
