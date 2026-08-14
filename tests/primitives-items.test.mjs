// 改世界状态原语的注入式测试包（此前零覆盖：store_items/fetch_items/drop/use_item/
// harvest_animals/autoDeposit/ensureMiningTool——LLM act 可直接触达的生产路径，
// 唯一防线曾是真机验收）。fake container 驱动原语 handler，不依赖 mineflayer。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrimitiveRegistry } from '../src/core/primitives/index.js'
import { autoDeposit } from '../src/core/storage.js'
import { ensureMiningTool } from '../src/core/tool.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function getHandler (op) {
  return createPrimitiveRegistry({}).get(op).handler
}

/** fake 容器：deposit/withdraw 记录调用，可注入失败。 */
function makeContainer (opts = {}) {
  const calls = { deposit: [], withdraw: [], close: 0 }
  return {
    calls,
    items: () => opts.items ?? [{ name: 'cobblestone', type: 4, metadata: null, count: 32 }],
    deposit: async (type, metadata, count) => {
      calls.deposit.push({ type, metadata, count })
      return opts.depositOk !== false
    },
    withdraw: async (type, metadata, count) => {
      calls.withdraw.push({ type, metadata, count })
      return opts.withdrawOk !== false
    },
    close: () => { calls.close++ }
  }
}

/** fake bot 工厂：物品/容器/方块查询。 */
function makeBot (opts = {}) {
  const container = opts.container ?? makeContainer(opts)
  return {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => opts.items ?? [{ name: 'cobblestone', type: 4, metadata: null, count: 10 }] },
    heldItem: opts.heldItem ?? null,
    equip: opts.equip ?? (async () => {}),
    openContainer: opts.openContainer ?? (async () => container),
    blockAt: () => ({ name: 'chest', boundingBox: 'block' }),
    findBlocks: opts.findBlocks ?? (() => [{ x: 1, y: 64, z: 1 }]),
    registry: { itemsByName: { apple: { foodPoints: 4 } } },
    tossStack: opts.tossStack ?? (async () => {}),
    activateItem: opts.activateItem ?? (async () => {}),
    once: () => {},
    removeListener: () => {},
    _client: { write: () => {}, state: 'play' },
    pathfinder: { goto: async () => {}, stop: () => {}, setGoal: () => {} }
  }
}

// ---- store_items / fetch_items ----

test('store_items: 配置仓库优先存入，工具/食物豁免，关闭容器', async () => {
  const h = getHandler('store_items')
  const container = makeContainer({ items: [] })
  const bot = makeBot({
    container,
    items: [
      { name: 'cobblestone', type: 4, metadata: null, count: 10 },
      { name: 'iron_pickaxe', type: 5, metadata: null, count: 1 }, // 工具豁免
      { name: 'apple', type: 6, metadata: null, count: 2 } // 食物豁免（registry.foodPoints>0）
    ]
  })
  const cfg = { storage: { chests: [{ x: 1, y: 64, z: 1 }] } }
  const r = await h({ bot, cfg, logger: makeLogger() }, {})
  assert.equal(r.stored, 1, '只存非工具非食物')
  assert.equal(container.calls.deposit.length, 1)
  assert.equal(container.calls.deposit[0].type, 4)
  assert.ok(container.calls.close >= 1, '容器必须关闭')
})

test('store_items: 无配置仓库 → 附近 32 格搜索', async () => {
  const h = getHandler('store_items')
  const bot = makeBot({ cfg: null })
  // findBlocks 返回候选 → openContainer 成功 → deposit
  const r = await h({ bot, cfg: { storage: { chests: [] } }, logger: makeLogger() }, {})
  assert.ok(r.stored >= 1, `应存入（实际 ${JSON.stringify(r)}）`)
})

test('fetch_items: 取指定物品并按 count 截断', async () => {
  const h = getHandler('fetch_items')
  const container = makeContainer({ items: [{ name: 'cobblestone', type: 4, metadata: null, count: 32 }] })
  const bot = makeBot({ container })
  const r = await h({ bot, cfg: { storage: { chests: [{ x: 1, y: 64, z: 1 }] } }, logger: makeLogger() }, { itemName: 'cobblestone', count: 8 })
  assert.equal(r.fetched, 8, `取 8 个（实际 ${JSON.stringify(r)}）`)
  assert.equal(container.calls.withdraw[0].count, 8)
})

test('fetch_items: 仓库没有该物品 → 明确文案', async () => {
  const h = getHandler('fetch_items')
  const container = makeContainer({ items: [{ name: 'dirt', type: 3, metadata: null, count: 5 }] })
  const bot = makeBot({ container })
  const r = await h({ bot, cfg: { storage: { chests: [{ x: 1, y: 64, z: 1 }] } }, logger: makeLogger() }, { itemName: 'diamond' })
  assert.ok(String(r).includes('没有 diamond'), `应明确反馈: ${JSON.stringify(r)}`)
})

// ---- drop / use_item ----

test('drop: 指定物品按 count 丢弃；缺省手持物', async () => {
  const h = getHandler('drop')
  const tossed = []
  const bot = makeBot({ tossStack: async (item, count) => { tossed.push({ name: item.name, count }) } })
  await h({ bot }, { itemName: 'cobblestone', count: 3 })
  assert.deepEqual(tossed[0], { name: 'cobblestone', count: 3 })
  // 缺省 = 手持
  const bot2 = makeBot({ heldItem: { name: 'dirt', type: 3, count: 7 }, tossStack: async (item, count) => { tossed.push({ name: item.name, count }) } })
  await h({ bot: bot2 }, {})
  assert.deepEqual(tossed[1], { name: 'dirt', count: 7 })
})

test('use_item: 手持物品激活', async () => {
  const h = getHandler('use_item')
  const used = []
  const bot = makeBot({ heldItem: { name: 'ender_pearl' }, activateItem: async () => { used.push(true) } })
  const r = await h({ bot }, {})
  assert.equal(used.length, 1)
  assert.ok(String(r).includes('ender_pearl'))
})

// ---- autoDeposit ----

test('autoDeposit: 配置仓库优先 + 工具食物豁免 + 失败回退 stored:0', async () => {
  const container = makeContainer({ items: [] })
  const bot = makeBot({
    container,
    items: [
      { name: 'stone', type: 4, metadata: null, count: 10 },
      { name: 'diamond_sword', type: 5, metadata: null, count: 1 },
      { name: 'apple', type: 6, metadata: null, count: 2 }
    ]
  })
  const cfg = { storage: { chests: [{ x: 1, y: 64, z: 1 }] } }
  const r = await autoDeposit(bot, makeLogger(), cfg)
  assert.equal(r.stored, 1, '存非工具非食物')
  assert.ok(r.found.length >= 1)
  assert.equal(container.calls.deposit[0].type, 4)
  // 全部失败（deposit 恒 false）→ stored 0（回退 inventoryFull 语义）
  const failContainer = makeContainer({ depositOk: false, items: [] })
  const bot2 = makeBot({ container: failContainer, items: [{ name: 'stone', type: 4, metadata: null, count: 10 }] })
  const r2 = await autoDeposit(bot2, makeLogger(), cfg)
  assert.equal(r2.stored, 0)
})

test('autoDeposit: 无 openContainer/findBlocks → 静默 0（附加层不阻塞）', async () => {
  const r = await autoDeposit({}, makeLogger(), null)
  assert.deepEqual(r, { stored: 0, found: [] })
})

// ---- ensureMiningTool ----

function toolItem (name, durability = 100, used = 0) {
  return { name, durability, durabilityUsed: used, count: 1, type: 1, metadata: null }
}

test('ensureMiningTool: 空手 → 换该类最优工具；健康同类手持不换（只升不降）', async () => {
  const equipped = []
  const items = [toolItem('stone_pickaxe'), toolItem('iron_pickaxe')]
  const bot = makeBot({
    items,
    heldItem: null,
    equip: async (item) => { equipped.push(item.name) }
  })
  const r1 = await ensureMiningTool(bot, 'iron_ore', makeLogger())
  assert.equal(r1, 'iron_pickaxe', '空手应换最高材料')
  // 手持健康同类工具 → 不换（契约：手持空/非该类/将坏才换）
  const bot2 = makeBot({ items, heldItem: toolItem('stone_pickaxe'), equip: async (item) => { equipped.push(item.name) } })
  const r2 = await ensureMiningTool(bot2, 'iron_ore', makeLogger())
  assert.equal(r2, null, '健康同类手持不切换')
  // 手持将坏 stone + 背包 iron → 换更高材料（只升不降分支）
  const bot3 = makeBot({
    items,
    heldItem: toolItem('stone_pickaxe', 100, 90),
    equip: async (item) => { equipped.push(item.name) }
  })
  const r3 = await ensureMiningTool(bot3, 'iron_ore', makeLogger())
  assert.equal(r3, 'iron_pickaxe', '将坏低材料升更高材料')
})

test('ensureMiningTool: 手持将坏 diamond + 背包 iron → 只升不降（不降级）；无工具类 → 空手不换', async () => {
  const equipped = []
  const items = [toolItem('iron_pickaxe')]
  // 将坏 diamond（同类别更高材料）→ 背包最优 iron 材料更低 → 不换
  const bot = makeBot({
    items,
    heldItem: toolItem('diamond_pickaxe', 100, 90),
    equip: async (item) => { equipped.push(item.name) }
  })
  const r = await ensureMiningTool(bot, 'iron_ore', makeLogger())
  assert.equal(r, null, '只升不降——手持更高材料不降级')
  // 花等无工具类 → null 空手
  const bot2 = makeBot({ items, heldItem: null, equip: async () => { throw new Error('不应装备') } })
  const r2 = await ensureMiningTool(bot2, 'poppy', makeLogger())
  assert.equal(r2, null)
})

// ---- harvest_animals ----

test('harvest_animals: sheep 剪羊毛（equip shears → 接近 → useEntityOn）', async () => {
  const h = getHandler('harvest_animals')
  const used = []
  const sheep = { id: 9, name: 'sheep', type: 'animal', position: { x: 2, y: 64, z: 0, clone: () => ({ ...sheep.position }), distanceTo: (p) => Math.abs(p.x - sheep.position.x) + Math.abs(p.z - sheep.position.z) } }
  const bot = makeBot({
    items: [{ name: 'shears', type: 7, metadata: null, count: 1 }],
    equip: async (item) => { if (item.name === 'shears') bot.heldItem = item }
  })
  bot.entities = new Map([[9, sheep]])
  bot.entity.position = { x: 0, y: 64, z: 0, distanceTo: (p) => Math.abs(p.x) + Math.abs(p.z), clone: () => bot.entity.position }
  // useEntityOn 走 entity-actions 原始包（写 use_entity）——捕获写包
  const { useEntityOn } = await import('../src/core/entity-actions.js')
  const origWrite = bot._client.write
  bot._client.write = (name, params) => { if (name === 'use_entity') used.push(params); else origWrite(name, params) }
  const r = await h({ bot, logger: makeLogger() }, { filter: 'sheep', max: 1 })
  assert.ok(String(r.done).includes('剪毛 1 只'), `应剪 1 只（实际 ${JSON.stringify(r)}）`)
  assert.equal(used.length, 1, 'use_entity 原始包应发出')
  void useEntityOn
})

test('harvest_animals: 无剪刀 → 明确反馈', async () => {
  const h = getHandler('harvest_animals')
  const bot = makeBot({ items: [] })
  const r = await h({ bot, logger: makeLogger() }, { filter: 'sheep', max: 1 })
  assert.ok(String(r.reason ?? r.done ?? '').includes('没有剪刀'), JSON.stringify(r))
})
