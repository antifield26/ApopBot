// 任务 init 校验测试（v1.0.0 C10 迁移版）：脚本化后 init 校验在 scriptDef.init
//（ScriptTask.init 调用）——与原任务类的 init 校验逐条等价。
// 运行行为测试见 tests/runner.test.mjs（脚本 DSL 全链路）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScriptTask } from '../src/tasks/runner.js'
import mineScript from '../src/tasks/scripts/mine.js'
import fishScript from '../src/tasks/scripts/fish.js'
import afkScript from '../src/tasks/scripts/afk.js'
import farmScript from '../src/tasks/scripts/farm.js'
import chopScript from '../src/tasks/scripts/chop.js'
import combatScript from '../src/tasks/scripts/combat.js'
import breedScript from '../src/tasks/scripts/breed.js'
import exploreScript from '../src/tasks/scripts/explore.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (botOverrides = {}) {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { blocksByName: { iron_ore: { id: 44 }, wheat: { id: 59 }, oak_log: { id: 55 } }, entitiesArray: [] },
    inventory: { items: () => [] },
    pathfinder: { setGoal: () => {}, stop: () => {} },
    collectBlock: { collect: async () => {}, cancelTask: () => {} },
    ...botOverrides
  }
  return { bot, logger: makeLogger(), config: { ops: [], l2: {}, log: {} }, getConfig: () => ({ ops: [], l2: {}, log: {} }) }
}

const AREA = { x1: 0, y1: 0, z1: 0, x2: 20, y2: 100, z2: 20 }

async function expectFail (script, options, ctx, kw) {
  const task = new ScriptTask('t1', script.id, options, ctx, script)
  await task.start()
  assert.equal(task.state, 'failed', `${script.id} init 应失败`)
  assert.ok(task.lastError.includes(kw), `${script.id} 应报 ${kw}: ${task.lastError}`)
}

test('mine init: 缺 blockTypes 报错', async () => {
  await expectFail(mineScript, {}, makeCtx(), 'blockTypes')
})

test('mine init: 未知方块类型报错', async () => {
  await expectFail(mineScript, { blockTypes: ['not_a_block'] }, makeCtx(), '未知方块类型')
})

test('mine init: 合法配置通过', async () => {
  const task = new ScriptTask('t1', 'mine', { blockTypes: ['iron_ore'] }, makeCtx(), mineScript)
  task.start() // 不 await（mine 无目标会 5min no-target 等待）
  await new Promise(r => setImmediate(r))
  assert.ok(['running', 'init'].includes(task.state), `合法配置应启动（${task.state}）`)
  await task.stop()
})

test('mine init: 缺 collectBlock/pathfinder 插件报错', async () => {
  await expectFail(mineScript, { blockTypes: ['iron_ore'] }, makeCtx({ collectBlock: undefined }), 'collectBlock')
})

test('fish init: 缺 durationMinutes 不抛（task-schemas 入口拦截，脚本防御）', async () => {
  // task-schemas 在 manager 入口拦截 durationMinutes 必填；脚本层对缺省值防御
  // 第 11 轮：断言状态而非 assert.ok(true) 恒真——start() 吞错设计使 init 抛错
  // 转 failed 此前也不会被测试发现
  const task = new ScriptTask('t1', 'fish', {}, makeCtx(), fishScript)
  task.startedAt = Date.now()
  task.start()
  await new Promise(r => setImmediate(r))
  await task.stop()
  assert.equal(task.state, 'stopped', 'fish init 不应失败（stop 后应为 stopped）')
})

test('afk init: intervalMinutes 缺失/非法不抛（task-schemas 入口拦截，wait 钳制防御）', async () => {
  const task = new ScriptTask('t1', 'afk', { intervalMinutes: 0 }, makeCtx(), afkScript)
  task.startedAt = Date.now()
  task.start()
  await new Promise(r => setImmediate(r))
  await task.stop()
  assert.equal(task.state, 'stopped', 'afk init 不应失败（stop 后应为 stopped）')
})

test('farm init: 缺 area / 缺 cropTypes 报错', async () => {
  await expectFail(farmScript, { cropTypes: ['wheat'] }, makeCtx(), 'area')
  await expectFail(farmScript, { area: AREA }, makeCtx(), 'cropTypes')
})

test('farm init: 未知作物报错', async () => {
  await expectFail(farmScript, { area: AREA, cropTypes: ['dragon_fruit'] }, makeCtx(), '未知作物')
})

test('farm 合法配置通过且 exclusive', async () => {
  const task = new ScriptTask('t1', 'farm', { area: AREA, cropTypes: ['wheat'] }, makeCtx(), farmScript)
  assert.equal(task.exclusive, true)
  task.start()
  await new Promise(r => setImmediate(r))
  await task.stop()
})

test('chop 默认正则（/_log$|_wood$/）与显式 logTypes 校验', async () => {
  const task = new ScriptTask('t1', 'chop', {}, makeCtx(), chopScript)
  assert.equal(task.exclusive, true)
  const bad = new ScriptTask('t2', 'chop', { logTypes: ['not_a_log'] }, makeCtx(), chopScript)
  await bad.start()
  assert.equal(bad.state, 'failed')
  assert.ok(bad.lastError.includes('未知方块类型'), bad.lastError)
})

test('combat init: area 校验与必填 pathfinder + aggroRange 陷阱', async () => {
  await expectFail(combatScript, { area: { x1: 1 } }, makeCtx(), 'area')
  await expectFail(combatScript, {}, makeCtx({ pathfinder: undefined }), 'pathfinder')
  await expectFail(combatScript, { aggroRange: 2, attackRange: 5 }, makeCtx(), 'aggroRange')
})

test('breed init: area 校验、默认动物白名单、exclusive', async () => {
  const task = new ScriptTask('t1', 'breed', {}, makeCtx(), breedScript)
  assert.equal(task.exclusive, true)
  const bad = new ScriptTask('t2', 'breed', { area: { x1: 1 } }, makeCtx(), breedScript)
  await bad.start()
  assert.equal(bad.state, 'failed')
})

test('explore init: area 校验与必填 pathfinder', async () => {
  await expectFail(exploreScript, { area: { x1: 1 } }, makeCtx(), 'area')
  await expectFail(exploreScript, {}, makeCtx({ pathfinder: undefined }), 'pathfinder')
})
