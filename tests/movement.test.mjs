// 统一移动层测试：goto 四拒绝名分类/墙钟超时/谓词中断/gotoNearest 结构/
// approachEntity 四路径/findSurfaceBlocks 六场景。fake bot 的 goto stub 先 setGoal
// 再 settle（镜像真实 goto 语义）；stop() 在 setImmediate 里 emit path_stop
// （模拟真实"下一 tick 触发"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { createMovement, createMovements, stopPathfinding, findSurfaceBlocks } from '../src/core/movement.js'
import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

/** fake bot：pathfinder.goto 由测试注入手动 settle 的 promise。
 * 镜像真实语义：stop() → path_stop 事件 → goto 拒绝 PathStopped。 */
function makePathBot (gotoImpl) {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.setGoalCalls = []
  bot.stopCalls = 0
  bot.pathfinder = {
    setGoal: (g) => { bot.setGoalCalls.push(g) },
    stop: () => {
      bot.stopCalls++
      setImmediate(() => bot.emit('path_stop'))
    },
    goto: (goal) => {
      bot.setGoalCalls.push(goal) // 镜像真实：goto 内部先 setGoal
      const inner = gotoImpl(goal)
      return new Promise((resolve, reject) => {
        const onStop = () => {
          bot.removeListener('path_stop', onStop)
          reject(Object.assign(new Error('PathStopped'), { name: 'PathStopped' }))
        }
        bot.on('path_stop', onStop)
        inner.then(
          (v) => { bot.removeListener('path_stop', onStop); resolve(v) },
          (e) => { bot.removeListener('path_stop', onStop); reject(e) }
        )
      })
    }
  }
  return bot
}

/** 可控 settle 的 goto 实现：返回 { promise, resolve, reject }。 */
function deferredGoto (name) {
  let resolveFn, rejectFn
  const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject })
  const impl = () => promise
  return { impl, resolve: resolveFn, reject: rejectFn, name }
}

// ---- goto ----

test('goto: 到达 resolve → ok:true（不调 stop）', async () => {
  const d = deferredGoto()
  const bot = makePathBot(d.impl)
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  const p = move.goto(new goals.GoalBlock(5, 64, 5), { timeoutMs: 1000 })
  d.resolve()
  const r = await p
  assert.deepEqual(r, { ok: true })
  assert.equal(bot.stopCalls, 0, '成功路径不清理（goal_reached 已自清）')
})

test('goto: 四拒绝名分类 + 失败路径调 stop', async () => {
  for (const [name, reason] of [['NoPath', 'no-path'], ['Timeout', 'timeout'], ['GoalChanged', 'goal-changed'], ['PathStopped', 'interrupted']]) {
    const d = deferredGoto(name)
    const bot = makePathBot(d.impl)
    const move = createMovement(bot, makeLogger(), { pollMs: 10 })
    const p = move.goto(new goals.GoalBlock(5, 64, 5), { timeoutMs: 1000 })
    d.reject(Object.assign(new Error(name), { name }))
    const r = await p
    assert.equal(r.ok, false, `${name} 应失败`)
    assert.equal(r.reason, reason, `${name} → ${reason}`)
    assert.equal(bot.setGoalCalls.at(-1), null, '失败路径应 setGoal(null) 清理残留 stateGoal（否则会重新 A*）')
  }
})

test('goto: 墙钟超时（goto 永不 settle）→ timeout + stop', async () => {
  const d = deferredGoto('Hang')
  const bot = makePathBot(d.impl)
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  const r = await move.goto(new goals.GoalBlock(5, 64, 5), { timeoutMs: 50 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'timeout', '墙钟超时优先于 PathStopped 分类')
  assert.ok(bot.stopCalls >= 1)
})

test('C2 修复：断线（bot end 事件）→ goto 立即返回 interrupted（goto promise 永不 settle 不再挂死）', async () => {
  const d = deferredGoto('Disconnect') // goto 永不 settle（断线后 physics tick 停止 → path_stop 永不到达）
  const bot = makePathBot(d.impl)
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  const p = move.goto(new goals.GoalBlock(5, 64, 5), { timeoutMs: 60000 })
  bot.emit('end') // 模拟断线
  const r = await p
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'interrupted')
  assert.equal(bot.stopCalls, 0, '断线无需主动 stop（bot 已死）')
  assert.equal(bot.listenerCount('end'), 0, 'end 监听应清理（防每次断线泄漏）')
})

test('goto: 谓词中断 → interrupted', async () => {
  const d = deferredGoto('Hang2')
  const bot = makePathBot(d.impl)
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  let interrupted = false
  const p = move.goto(new goals.GoalBlock(5, 64, 5), { timeoutMs: 5000, isInterrupted: () => interrupted })
  setTimeout(() => { interrupted = true }, 20)
  const r = await p
  assert.equal(r.reason, 'interrupted')
  assert.ok(bot.stopCalls >= 1)
})

test('goto: A* Timeout 自动重试一次（第二次成功）', async () => {
  let calls = 0
  const bot = makePathBot((goal) => {
    calls++
    if (calls === 1) return Promise.reject(Object.assign(new Error('Timeout'), { name: 'Timeout' }))
    return Promise.resolve()
  })
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  const r = await move.goto(new goals.GoalBlock(5, 64, 5), { timeoutMs: 5000 })
  assert.equal(r.ok, true, 'Timeout 应重试一次后成功')
  assert.equal(calls, 2)
})

test('C8/X 修复：gotoNearest 空数组 → no-path（不等 A* 跑满超时重试）', async () => {
  const bot = makePathBot(() => Promise.resolve())
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  const r = await move.gotoNearest([], 3, { timeoutMs: 1000 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-path')
  assert.equal(bot.setGoalCalls.length, 0, '空候选不应触发 setGoal')
})

// ---- gotoPoint / gotoNearest ----

test('gotoPoint: 无 range → GoalBlock；有 range → GoalNear', async () => {
  const bot = makePathBot(() => Promise.resolve())
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  await move.gotoPoint(new Vec3(5.5, 64.4, -3.2), { timeoutMs: 1000 })
  assert.ok(bot.setGoalCalls.at(-1) instanceof goals.GoalBlock, '缺省应 GoalBlock')
  await move.gotoPoint(new Vec3(5, 64, 5), { range: 3, timeoutMs: 1000 })
  const last = bot.setGoalCalls.at(-1)
  assert.ok(last instanceof goals.GoalNear, '提供 range 应 GoalNear')
  assert.equal(last.rangeSq, 9, 'range 3 → rangeSq 9')
})

test('gotoNearest: GoalCompositeAny 含全部候选（range 与坐标正确）', async () => {
  const bot = makePathBot(() => Promise.resolve())
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  await move.gotoNearest([new Vec3(1, 64, 1), new Vec3(10, 65, 10)], 3, { timeoutMs: 1000 })
  const goal = bot.setGoalCalls.at(-1)
  assert.ok(goal instanceof goals.GoalCompositeAny, '多候选应包成 CompositeAny')
  assert.equal(goal.goals.length, 2)
  assert.ok(goal.goals.every(g => g instanceof goals.GoalNear))
  assert.equal(goal.goals[0].rangeSq, 9)
  // 防回归：Vec3 单参构造会 NaN（Math.floor(Vec3)）
  assert.ok(goal.goals.every(g => Number.isInteger(g.x) && Number.isInteger(g.y) && Number.isInteger(g.z)),
    '子 goal 坐标必须有效')
  assert.equal(goal.goals[1].x, 10)
  assert.equal(goal.goals[1].y, 65)
})

// ---- approachEntity ----

test('approachEntity: 已到位 → 立即 ok（仅清残留 goal，不设新目标）', async () => {
  const bot = makePathBot(() => Promise.resolve())
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  const r = await move.approachEntity({ position: new Vec3(1, 64, 0) }, { range: 2, timeoutMs: 1000 })
  assert.deepEqual(r, { ok: true })
  assert.equal(bot.setGoalCalls.at(-1), null, '到位仅 setGoal(null) 清残留')
  assert.ok(!bot.setGoalCalls.some(g => g instanceof goals.GoalNear), '不应设置接近目标')
})

test('approachEntity: 范围外 → goto 到达（setGoal 仅一次，A* 不被打断）', async () => {
  const d = deferredGoto()
  const bot = makePathBot(d.impl)
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  const p = move.approachEntity({ position: new Vec3(5, 64, 0) }, { range: 2, timeoutMs: 2000 })
  await new Promise(r => setTimeout(r, 40)) // 多个 pollMs 周期（A* 挂起中）
  const nearCalls = bot.setGoalCalls.filter(g => g instanceof goals.GoalNear)
  assert.equal(nearCalls.length, 1, '回归核心：goto 期间不得重复 setGoal（每 500ms 重建会重置 A* → 原地不动）')
  const g = nearCalls[0]
  assert.ok(Number.isInteger(g.x) && Number.isInteger(g.y) && Number.isInteger(g.z),
    `GoalNear 坐标必须有效（传 Vec3 单参会 NaN）: x=${g.x} y=${g.y} z=${g.z}`)
  assert.equal(g.x, 5, '目标坐标应正确传入')
  d.resolve()
  const r = await p
  assert.equal(r.ok, true)
})

test('approachEntity: 谓词中断 → interrupted + stop', async () => {
  const d = deferredGoto()
  const bot = makePathBot(d.impl) // goto 挂起（否则立即成功，谓词来不及触发）
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  let interrupted = false
  const p = move.approachEntity(
    { position: new Vec3(10, 64, 0) },
    { range: 2, timeoutMs: 5000, isInterrupted: () => interrupted }
  )
  setTimeout(() => { interrupted = true }, 20)
  const r = await p
  assert.equal(r.reason, 'interrupted')
  assert.ok(bot.stopCalls >= 1)
})

test('approachEntity: 目标位移超阈值 → interrupted（调用方重扫换目标）', async () => {
  const d = deferredGoto()
  const bot = makePathBot(d.impl)
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  const entity = { position: new Vec3(10, 64, 0) }
  const p = move.approachEntity(entity, { range: 2, timeoutMs: 5000 })
  setTimeout(() => { entity.position = new Vec3(20, 64, 0) }, 20) // 移动 10 格 > RECALC_DIST 2
  const r = await p
  assert.equal(r.reason, 'interrupted', '目标大幅移动应中断让调用方重扫')
})

test('approachEntity: goto NoPath → no-path（立即，非轮询等待）', async () => {
  const d = deferredGoto()
  const bot = makePathBot(d.impl)
  const move = createMovement(bot, makeLogger(), { pollMs: 1000 })
  const t0 = Date.now()
  const p = move.approachEntity({ position: new Vec3(10, 64, 0) }, { range: 2, timeoutMs: 5000 })
  setTimeout(() => d.reject(Object.assign(new Error('NoPath'), { name: 'NoPath' })), 20)
  const r = await p
  assert.ok(Date.now() - t0 < 500, 'NoPath 应立即返回而非等下一轮询')
  assert.equal(r.reason, 'no-path')
})

test('approachEntity: 超时 → timeout + stop', async () => {
  const d = deferredGoto()
  const bot = makePathBot(d.impl)
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  const r = await move.approachEntity({ position: new Vec3(50, 64, 0) }, { range: 2, timeoutMs: 50 })
  assert.equal(r.reason, 'timeout')
  assert.ok(bot.stopCalls >= 1)
})

test('approachEntity: 实体消失（无 position）→ error', async () => {
  const bot = makePathBot(() => Promise.resolve())
  const move = createMovement(bot, makeLogger(), { pollMs: 10 })
  const r = await move.approachEntity({}, { range: 2, timeoutMs: 1000 })
  assert.equal(r.reason, 'error')
})

// ---- stopPathfinding / createMovements ----

test('stopPathfinding: 插件缺失容错', () => {
  stopPathfinding({}) // 不抛
  stopPathfinding({ pathfinder: { stop: () => { throw new Error('gone') } } }) // 不抛
})

test('createMovements: 构造 Movements 实例', () => {
  class FakeMovements { constructor (b) { this.bot = b } }
  const m = createMovements({}, FakeMovements)
  assert.ok(m instanceof FakeMovements)
})

// ---- findSurfaceBlocks ----

function makeFindBot ({ blocksByName, findBlocks, blockAt }) {
  return {
    registry: { blocksByName },
    findBlocks,
    blockAt
  }
}

test('findSurfaceBlocks: 上方 2 格空 → 地表候选', () => {
  const bot = makeFindBot({
    blocksByName: { iron_ore: { id: 44 } },
    findBlocks: () => [new Vec3(5, 64, 5)],
    blockAt: () => ({ boundingBox: 'empty', name: 'air' })
  })
  const { block, candidates } = findSurfaceBlocks(bot, 'iron_ore')
  assert.equal(block.id, 44)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].x, 5)
})

test('findSurfaceBlocks: 上方有实体方块 → 排除（埋地下/洞顶）', () => {
  const bot = makeFindBot({
    blocksByName: { iron_ore: { id: 44 } },
    findBlocks: () => [new Vec3(5, 64, 5)],
    blockAt: (p, extra) => (p.y === 65 ? { boundingBox: 'block', name: 'stone' } : { boundingBox: 'empty', name: 'air' })
  })
  const { candidates } = findSurfaceBlocks(bot, 'iron_ore')
  assert.equal(candidates.length, 0)
})

test('findSurfaceBlocks: 区块未加载（blockAt null）→ 排除', () => {
  const bot = makeFindBot({
    blocksByName: { iron_ore: { id: 44 } },
    findBlocks: () => [new Vec3(5, 64, 5)],
    blockAt: () => null
  })
  assert.equal(findSurfaceBlocks(bot, 'iron_ore').candidates.length, 0)
})

test('findSurfaceBlocks: 上方液体 → 排除（防走入岩浆/水）', () => {
  const bot = makeFindBot({
    blocksByName: { iron_ore: { id: 44 } },
    findBlocks: () => [new Vec3(5, 64, 5)],
    blockAt: () => ({ boundingBox: 'empty', name: 'lava' })
  })
  assert.equal(findSurfaceBlocks(bot, 'iron_ore').candidates.length, 0)
})

test('findSurfaceBlocks: 未知方块名 → throw', () => {
  const bot = makeFindBot({
    blocksByName: {},
    findBlocks: () => [],
    blockAt: () => null
  })
  assert.throws(() => findSurfaceBlocks(bot, 'not_a_block'), /未知方块类型/)
})

// ---- 第 9 轮：卡住自愈（26.1 区块时序 → A* 路径穿墙 → 位置停滞 → 重试） ----

test('第 9 轮：位置停滞 → stuck 重试——第二次 goto 成功', async () => {
  const d1 = deferredGoto()
  const d2 = deferredGoto()
  let call = 0
  const bot = makePathBot(() => {
    call++
    if (call === 1) return d1.impl()
    bot.entity.position = new Vec3(10, 64, 10) // 第二次"走到"目标（停滞检测不触发）
    return d2.impl()
  })
  const mv = createMovement(bot, makeLogger(), { stuckGraceMs: 30, stuckDetectMs: 30 })
  const p = mv.goto(new goals.GoalBlock(10, 64, 10), { timeoutMs: 5000, pollMs: 10 })
  // 第一次 goto 位置不动（fake bot position 恒 0,64,0）→ 停滞检测 → stop → PathStopped
  // → runOnce 返回 stuck → goto 自动重试（第二次）→ d2 稍后 resolve
  setTimeout(() => d2.resolve('ok'), 200)
  const r = await p
  assert.equal(r.ok, true, `重试后应到达: ${JSON.stringify(r)}`)
  assert.ok(bot.setGoalCalls.length >= 2, `应重试（setGoal ≥2 次，实际 ${bot.setGoalCalls.length}）`)
})

test('第 9 轮：卡住重试 3 次仍失败 → 返回 stuck（不无限重试）', async () => {
  const bot = makePathBot(() => new Promise(() => {})) // 永不 settle + 位置不动
  const mv = createMovement(bot, makeLogger(), { stuckGraceMs: 20, stuckDetectMs: 20, sidestepTimeoutMs: 30 })
  const r = await mv.goto(new goals.GoalBlock(10, 64, 10), { timeoutMs: 5000, pollMs: 10 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'stuck', `reason 应为 stuck（实际 ${r.reason}）`)
  assert.ok(r.stuck === true, '应带 stuck 标记')
  assert.ok(bot.stopCalls >= 4, '初始 1 次 + 3 次重试各 1 次 + sidestep 超时 stop（stuck 上限 3）')
})

test('第 9 轮：谓词中断优先于停滞检测（stop 请求不被卡住重试吞掉）', async () => {
  const d = deferredGoto()
  const bot = makePathBot(() => d.impl())
  const mv = createMovement(bot, makeLogger(), { stuckGraceMs: 20, stuckDetectMs: 20 })
  let interrupted = false
  const p = mv.goto(new goals.GoalBlock(10, 64, 10), { timeoutMs: 5000, pollMs: 10, isInterrupted: () => interrupted })
  // 中断在停滞检测触发后转真（100ms > 40ms）——第二次 runOnce 检测到中断 →
  // reason=interrupted → goto 不继续 stuck 重试（while 条件 !isInterrupted）
  setTimeout(() => { interrupted = true }, 100)
  const r = await p
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'interrupted', '中断转真后不应再返回 stuck（重试被中断语义接管）')
})
