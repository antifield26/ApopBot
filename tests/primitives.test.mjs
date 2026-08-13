import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrimitiveRegistry } from '../src/core/primitives/index.js'

// 动作原语层直测（不经 executor 管线）：registry 由工厂创建，handler 直接调用。

/** interact_entity 用最小 fake bot：位置/实体表/背包/equip/写包通道。 */
function makeInteractBot (entities) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: new Map(entities.map(e => [e.id, e])),
    inventory: { items: () => [{ name: 'wheat_seeds', count: 10 }] },
    equip: async () => {},
    _client: { write: () => {} }
  }
}

function animal (id, name, x, z) {
  return {
    id,
    name,
    position: {
      x, y: 64, z,
      distanceTo: (p) => Math.abs(x - p.x) + Math.abs(z - p.z)
    }
  }
}

function interactHandler () {
  return createPrimitiveRegistry({}).get('interact_entity').handler
}

test('M3: interact_entity 繁殖冷却——冷却期动物跳过并换喂下一只', async () => {
  const h = interactHandler()
  // 两只 cow：cow1 更近（先喂）
  const bot = makeInteractBot([animal(1, 'cow', 1, 1), animal(2, 'cow', 3, 3)])
  const r1 = await h({ bot }, { filter: ['cow'], count: 1, minFeedIntervalMs: 300000 })
  assert.equal(r1.fed, 1, '首轮喂最近一只')
  // 立即再喂：cow1 冷却中 → 换喂 cow2
  const r2 = await h({ bot }, { filter: ['cow'], count: 1, minFeedIntervalMs: 300000 })
  assert.equal(r2.fed, 1, '冷却期跳过 cow1 换喂 cow2')
  // 两只都冷却 → fed:0 + 残余冷却
  const r3 = await h({ bot }, { filter: ['cow'], count: 1, minFeedIntervalMs: 300000 })
  assert.equal(r3.fed, 0, '全冷却不再喂食')
  assert.ok(r3.cooldownMs > 0, '全冷却应返回残余冷却时间（脚本区分冷却/无食物）')
  // count=2 时每喂一次重选——两只不同动物各喂一次（此前同只连续喂 2 次）
  const bot2 = makeInteractBot([animal(11, 'cow', 1, 1), animal(12, 'cow', 3, 3)])
  const r4 = await h({ bot: bot2 }, { filter: ['cow'], count: 2, minFeedIntervalMs: 300000 })
  assert.equal(r4.fed, 2, 'count=2 应喂两只不同动物')
})

test('M3: interact_entity 默认不限冷却（LLM act 行为不变）', async () => {
  const h = interactHandler()
  const bot = makeInteractBot([animal(21, 'cow', 1, 1)])
  const r1 = await h({ bot }, { filter: ['cow'], count: 1 })
  assert.equal(r1.fed, 1)
  const r2 = await h({ bot }, { filter: ['cow'], count: 1 })
  assert.equal(r2.fed, 1, 'minFeedIntervalMs=0 时同只动物可重复喂')
  assert.equal(r2.cooldownMs, undefined, '默认路径不产生 cooldownMs 字段')
})
