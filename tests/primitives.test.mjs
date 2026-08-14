import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { getEventListeners } from 'node:events'
import { createPrimitiveRegistry } from '../src/core/primitives/index.js'

// 动作原语层直测（不经 executor 管线）：registry 由工厂创建，handler 直接调用。

/** interact_entity 用最小 fake bot：位置/实体表/背包/equip/写包通道。
 *  含最小寻路桩（H8 修复后 >4 格需 approachEntity——movement 的 runOnce 要求
 *  pathfinder.goto + once/removeListener 事件通道）。 */
function makeInteractBot (entities) {
  const pos = { x: 0, y: 64, z: 0, distanceTo: (p) => Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z) }
  const bot = {
    entity: { position: pos },
    entities: new Map(entities.map(e => [e.id, e])),
    inventory: { items: () => [{ name: 'wheat_seeds', count: 10 }] },
    equip: async () => {},
    pathfinder: { goto: async () => {}, stop: () => {}, setGoal: () => {} },
    once: () => {},
    removeListener: () => {},
    _client: { write: () => {}, state: 'play' }
  }
  return bot
}

function animal (id, name, x, z) {
  const pos = {
    x, y: 64, z,
    distanceTo: (p) => Math.abs(x - p.x) + Math.abs(z - p.z),
    clone: () => ({ x: pos.x, y: pos.y, z: pos.z, distanceTo: pos.distanceTo, clone: pos.clone })
  }
  return { id, name, position: pos }
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

// ---- M9：多角色共享 executor 的 user 指代消解 ----

test('M9: 多角色共享 executor——follow_player 无 name 解析各自 runtime.user（不被残留 _caller 串扰）', async () => {
  const { createActionExecutor } = await import('../src/core/executor.js')
  const targets = []
  const bot = {
    username: 'bot1',
    players: {
      alice: { username: 'alice', entity: { id: 1 } },
      bob: { username: 'bob', entity: { id: 2 } }
    }
  }
  const ctx = {
    bot,
    cfg: { l2: { maxActionsPerCall: 8 }, ops: ['alice', 'bob'], log: { dir: null } },
    logger: makeLogger(),
    plugins: { follow: { setTarget: (e) => targets.push(e), stop: () => {} } },
    tasks: null,
    conn: null,
    _caller: null
  }
  const reg = new Map(createPrimitiveRegistry(ctx))
  const executor = createActionExecutor(ctx, { primitives: reg, audit: null })
  // 动作串行化（M4）后角色并发被拒——此处验证顺序场景：B 先执行使 ctx._caller
  // 残留 'bob'，A 的 follow_player 无 name 必须读 per-action runtime.user='alice'
  //（修复前读共享 ctx._caller → 解析到 bob）
  const rB = await executor.executeBatch([{ op: 'follow_player', args: { name: 'me' } }], { user: 'bob', source: 'llm' })
  assert.ok(rB.results[0].result.includes('开始跟随 bob'), `B 应解析到自己: ${JSON.stringify(rB.results[0])}`)
  const rA = await executor.executeBatch([{ op: 'follow_player', args: {} }], { user: 'alice', source: 'llm' })
  assert.ok(rA.results[0].result.includes('开始跟随 alice'), `A 应解析到自己（修复前串到 bob）: ${JSON.stringify(rA.results[0])}`)
  assert.deepEqual(targets, [{ id: 2 }, { id: 1 }], '目标顺序：B 先、A 后，各随各的调用者')
})

test('M4: 动作互斥——非 readonly 动作执行期间其它角色动作被拒；readonly 观察放行', async () => {
  const { createActionExecutor } = await import('../src/core/executor.js')
  const ctx = {
    bot: { entity: { position: { x: 0, y: 64, z: 0 } }, chat: () => {} },
    cfg: { l2: { maxActionsPerCall: 8 }, ops: ['alice', 'bob'], log: { dir: null } },
    logger: makeLogger(),
    tasks: { getStatus: () => [] },
    conn: { getStatus: () => ({ state: 'connected' }) },
    plugins: null,
    _caller: null
  }
  const reg = new Map(createPrimitiveRegistry(ctx))
  let releaseSlow
  const slowGate = new Promise(r => { releaseSlow = r })
  reg.set('slow_op', {
    schema: {},
    permission: 'op',
    exclusiveClass: 'movement',
    guardText: '慢动作',
    timeoutMs: 60000,
    handler: async () => { await slowGate; return 'slow done' }
  })
  const executor = createActionExecutor(ctx, { primitives: reg, audit: null })
  const pA = executor.executeBatch([{ op: 'slow_op', args: {} }], { user: 'alice', source: 'llm' })
  await new Promise(r => setImmediate(r)) // A 的 slow_op 挂起（占锁）
  // B 的非 readonly 动作被拒（此前实例级 busy 无法跨角色——双 goto 互覆盖）
  const rB = await executor.executeBatch([{ op: 'goto', args: { x: 10, y: 64, z: 10 } }], { user: 'bob', source: 'llm' })
  assert.equal(rB.results[0].ok, false, '非 readonly 动作在锁内应被拒')
  assert.ok(rB.results[0].result.includes('另一个会话'), JSON.stringify(rB.results[0]))
  // readonly 观察不占锁也不被锁拦（观察并发是无害的）
  const rObs = await executor.executeBatch([{ op: 'observe_status', args: {} }], { user: 'bob', source: 'llm' })
  assert.equal(rObs.results[0].ok, true, 'readonly 观察应放行')
  releaseSlow()
  const rA = await pA
  assert.equal(rA.results[0].ok, true, 'A 的慢动作应正常完成')
})

// ---- M4：sleep 原语 abort 监听器配对移除 ----

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

/** sleep 原语 fake bot：pathfinder.goto 立即成功 + wake 事件手动触发。 */
function makeSleepBot () {
  const bot = new EventEmitter()
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  bot.time = { isDay: false }
  bot.sleep = async () => {}
  bot.findBlocks = () => [{ x: 1, y: 64, z: 1 }]
  bot.blockAt = () => ({ name: 'red_bed' })
  bot.pathfinder = {
    setGoal: () => {},
    stop: () => { setImmediate(() => bot.emit('path_stop')) },
    goto: () => Promise.resolve()
  }
  return bot
}

// ---- M6：幽灵动作（竞速取消/事后校验） ----

test('M6: raceAbort——abort 后立即拒绝且监听器清理（底层 promise 不被吞）', async () => {
  const { raceAbort } = await import('../src/core/primitives/common.js')
  const controller = new AbortController()
  let resolveUnderlying
  const underlying = new Promise(r => { resolveUnderlying = r })
  const p = raceAbort(underlying, controller.signal, '动作被中断')
  controller.abort()
  await assert.rejects(p, { name: 'AbortError' })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'abort 后监听器清理')
  // 底层继续执行不受影响（幽灵动作残余——调用方已返回，底层自然收敛）
  let settled = false
  underlying.then(() => { settled = true })
  resolveUnderlying()
  await new Promise(r => setImmediate(r))
  assert.equal(settled, true, '底层 promise 仍会 settle（不被吞）')
})

test('M6: dig 原语 stop 后立即中断（不再等挖掘完成）', async () => {
  const controller = new AbortController()
  let resolveDig
  const bot = {
    dig: () => new Promise(r => { resolveDig = r }),
    canDigBlock: () => true,
    blockAt: () => ({ name: 'stone', type: 1 })
  }
  const h = createPrimitiveRegistry({}).get('dig').handler
  const p = h({ bot, cfg: {}, logger: makeLogger() }, { x: 1, y: 64, z: 1 }, { signal: controller.signal })
  await new Promise(r => setImmediate(r)) // handler 进入 dig 等待
  controller.abort()
  await assert.rejects(p, { name: 'AbortError' })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'abort 后监听器清理')
  resolveDig() // 底层残余 settle（幽灵挖掘——服务端自然收敛）
})

test('M6: equip 超时后按手持校验——已装备视为成功（不误报失败引发重试双重副作用）', async () => {
  const held = { name: 'iron_pickaxe' }
  const bot = {
    inventory: { items: () => [{ name: 'iron_pickaxe' }] },
    equip: async () => { throw new Error('equip timeout') },
    get heldItem () { return held }
  }
  const h = createPrimitiveRegistry({}).get('equip').handler
  const r = await h({ bot }, { itemName: 'iron_pickaxe' })
  assert.equal(r, '已装备 iron_pickaxe', '超时但手持已就位 → 视为成功')
  // 手持未就位 → 原错误上抛
  const bot2 = { ...bot, heldItem: null }
  await assert.rejects(h({ bot: bot2 }, { itemName: 'iron_pickaxe' }), /equip timeout/)
})

test('M4: sleep 原语正常 wake/abort 路径均移除 abort 监听器（不泄漏）', async () => {
  const controller = new AbortController()
  const h = createPrimitiveRegistry({}).get('sleep').handler
  // 正常 wake 路径：wake 事件触发后 abort 监听器必须归零（修复前残留——任务级
  // signal 生命周期数天，farm 每晚睡觉每晚泄漏 1 个）
  const bot = makeSleepBot()
  const p1 = h({ bot, cfg: {}, logger: makeLogger() }, { timeoutMs: 30000 }, { signal: controller.signal })
  await new Promise(r => setImmediate(r)) // handler 进入 wake 等待（goto 已同步成功）
  bot.emit('wake')
  const r1 = await p1
  assert.deepEqual(r1, { slept: true })
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, '正常 wake 后 abort 监听器应移除')
  // abort 路径：中止后监听器同样归零（once 自清 + finally 幂等）
  const p2 = h({ bot, cfg: {}, logger: makeLogger() }, { timeoutMs: 30000 }, { signal: controller.signal })
  await new Promise(r => setImmediate(r))
  controller.abort()
  await assert.rejects(p2, /中断/)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'abort 后监听器也应清理')
})
