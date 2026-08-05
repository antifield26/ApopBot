import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MineTask } from '../src/tasks/mine.js'
import { FishTask } from '../src/tasks/fish.js'
import { AfkTask } from '../src/tasks/afk.js'
import { FarmTask } from '../src/tasks/farm.js'
import { ChopTask } from '../src/tasks/chop.js'
import { CombatTask } from '../src/tasks/combat.js'
import { BreedTask } from '../src/tasks/breed.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (bot) {
  return { bot, logger: makeLogger(), config: {} }
}

const AREA = { x1: 0, y1: 0, z1: 0, x2: 10, y2: 10, z2: 10 }

function makeMineBot (blocksByName = {}) {
  return {
    registry: { blocksByName },
    collectBlock: {},
    pathfinder: {}
  }
}

test('MineTask init: 缺 blockTypes 报错', async () => {
  const task = new MineTask('m1', 'mine', {}, makeCtx(makeMineBot()))
  await assert.rejects(task.init(), /blockTypes/)
})

test('MineTask init: 未知方块类型报错', async () => {
  const task = new MineTask('m1', 'mine', { blockTypes: ['not_a_block'] }, makeCtx(makeMineBot({ iron_ore: { id: 44 } })))
  await assert.rejects(task.init(), /未知方块类型/)
})

test('MineTask init: 合法配置通过（并解析 block id）', async () => {
  const task = new MineTask('m1', 'mine', { blockTypes: ['iron_ore'], radius: 16 }, makeCtx(makeMineBot({ iron_ore: { id: 44 } })))
  await task.init()
  assert.deepEqual([...task._blockIds], [44])
  assert.equal(task._chestLocations.length, 0)
})

test('MineTask init: chestLocations 透传', async () => {
  const task = new MineTask('m1', 'mine', { blockTypes: ['iron_ore'], chestLocations: [{ x: 1, y: 2, z: 3 }] }, makeCtx(makeMineBot({ iron_ore: { id: 44 } })))
  await task.init()
  assert.deepEqual(task._chestLocations, [{ x: 1, y: 2, z: 3 }])
})

test('MineTask init: 缺 collectBlock/pathfinder 插件报错', async () => {
  const task = new MineTask('m1', 'mine', { blockTypes: ['iron_ore'] }, makeCtx({ registry: { blocksByName: { iron_ore: { id: 44 } } } }))
  await assert.rejects(task.init(), /collectBlock\/pathfinder/)
})

test('FishTask init: 缺 durationMinutes 报错', async () => {
  const task = new FishTask('f1', 'fish', {}, makeCtx({}))
  await assert.rejects(task.init(), /durationMinutes/)
})

test('FishTask init: 合法配置通过', async () => {
  const task = new FishTask('f1', 'fish', { durationMinutes: 2 }, makeCtx({}))
  await task.init()
  assert.equal(task._durationMs, 120000)
})

test('AfkTask init: 缺 intervalMinutes 报错', async () => {
  const task = new AfkTask('a1', 'afk', {}, makeCtx({}))
  await assert.rejects(task.init(), /intervalMinutes/)
})

test('AfkTask init: 合法配置通过', async () => {
  const task = new AfkTask('a1', 'afk', { intervalMinutes: 5 }, makeCtx({}))
  await task.init()
  assert.equal(task._intervalMs, 300000)
})

test('任务完成态: run 自然退出 → completed（stopWhenDone 语义回归）', async () => {
  // 用 FishTask 模拟"自然完成"：durationMinutes 极小 + 假 bot.fish 立即 resolve
  let fishCalls = 0
  const bot = { fish: async () => { fishCalls++; } }
  const task = new FishTask('f1', 'fish', { durationMinutes: 0.01 }, makeCtx(bot))
  await task.start()
  assert.equal(task.state, 'completed', 'fish 到时自然退出应置 completed')
  assert.ok(fishCalls >= 1)
})

// ---- M2 新任务类型：init 校验 ----

function makeFarmBot () {
  return { registry: { blocksByName: { wheat: { id: 1 }, carrots: { id: 2 }, farmland: { id: 3 } } }, collectBlock: {}, pathfinder: {} }
}

test('FarmTask init: 缺 area / 缺 cropTypes 报错', async () => {
  await assert.rejects(new FarmTask('f', 'farm', { cropTypes: ['wheat'] }, makeCtx(makeFarmBot())).init(), /area/)
  await assert.rejects(new FarmTask('f', 'farm', { area: AREA }, makeCtx(makeFarmBot())).init(), /cropTypes/)
})

test('FarmTask init: 未知作物报错', async () => {
  const task = new FarmTask('f', 'farm', { area: AREA, cropTypes: ['dragonfruit'] }, makeCtx(makeFarmBot()))
  await assert.rejects(task.init(), /未知作物/)
})

test('FarmTask init: 合法配置通过且 exclusive', async () => {
  const task = new FarmTask('f', 'farm', { area: AREA, cropTypes: ['wheat', 'carrots'] }, makeCtx(makeFarmBot()))
  await task.init()
  assert.equal(task.exclusive, true)
  assert.equal(task._seedByCrop.wheat, 'wheat_seeds', '种子映射默认值')
  assert.equal(task._seedByCrop.carrots, 'carrot')

  // seedOverrides 可自定义种子映射
  const task2 = new FarmTask('f', 'farm', { area: AREA, cropTypes: ['wheat'], seedOverrides: { wheat: 'wheat_seeds_custom' } }, makeCtx(makeFarmBot()))
  await task2.init()
  assert.equal(task2._seedByCrop.wheat, 'wheat_seeds_custom')
})

test('ChopTask init: 缺 area 报错 / 默认 log 匹配 / 显式 logTypes', async () => {
  const bot = { registry: { blocksByName: { oak_log: { id: 10 }, oak_wood: { id: 11 }, stone: { id: 12 } } }, collectBlock: {}, pathfinder: {} }
  await assert.rejects(new ChopTask('c', 'chop', {}, makeCtx(bot)).init(), /area/)

  const def = new ChopTask('c', 'chop', { area: AREA }, makeCtx(bot))
  await def.init()
  assert.deepEqual([...def._logIds].sort(), [10, 11], '默认应匹配 oak_log/oak_wood')

  const explicit = new ChopTask('c', 'chop', { area: AREA, logTypes: ['oak_log'] }, makeCtx(bot))
  await explicit.init()
  assert.deepEqual([...explicit._logIds], [10])

  await assert.rejects(new ChopTask('c', 'chop', { area: AREA, logTypes: ['nope'] }, makeCtx(bot)).init(), /未知方块类型/)
})

test('ChopTask exclusive', () => {
  const bot = { registry: { blocksByName: {} }, collectBlock: {}, pathfinder: {} }
  const task = new ChopTask('c', 'chop', { area: AREA }, makeCtx(bot))
  assert.equal(task.exclusive, true)
})

test('CombatTask init: area 校验与必填 pathfinder', async () => {
  await assert.rejects(new CombatTask('b', 'combat', { area: { x1: 1 } }, makeCtx({ pathfinder: {} })).init(), /area/)
  await assert.rejects(new CombatTask('b', 'combat', {}, makeCtx({})).init(), /pathfinder/)
  const task = new CombatTask('b', 'combat', { area: AREA, maxTargets: 2 }, makeCtx({ pathfinder: {} }))
  await task.init()
  assert.equal(task.exclusive, true)
  assert.equal(task._maxTargets, 2)
})

test('BreedTask init: area 校验、默认动物白名单、exclusive', async () => {
  await assert.rejects(new BreedTask('b', 'breed', { area: { z2: 5 } }, makeCtx({ pathfinder: {} })).init(), /area/)
  await assert.rejects(new BreedTask('b', 'breed', {}, makeCtx({})).init(), /pathfinder/)
  const task = new BreedTask('b', 'breed', { area: AREA, maxBreedings: 2 }, makeCtx({ pathfinder: {} }))
  await task.init()
  assert.equal(task.exclusive, true)
  assert.deepEqual(task._animalTypes, ['cow', 'sheep', 'pig', 'chicken'])
  assert.equal(task._maxBreedings, 2)
})
