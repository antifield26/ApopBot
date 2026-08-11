// query_map 地形记忆验证测试（第 10 轮）：已加载区块逐条核对（失效自动删除）、
// 未加载区块标 verified:false——杜绝过期坐标误导 LLM/玩家（用户实测误判 find
// 失效的根因）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrimitiveRegistry } from '../src/core/primitives/index.js'
import * as discovery from '../src/core/discovery.js'

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
