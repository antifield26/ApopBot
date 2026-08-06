import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cron } from 'croner'
import { BaseTask } from '../src/tasks/base.js'
import { TaskManager } from '../src/tasks/manager.js'

// 测试用最小假任务（不依赖 mineflayer）；内部等待用基类 _internalWait（可被 stop 打断）
class FakeTask extends BaseTask {
  async init () {
    super.init()
    if (this.options.failInit) throw new Error('init boom')
  }

  async run () {
    await super.run()
    this.incr('runs')
    await this._internalWait(1000, 'fake-sleep')
  }
}

function makeManager (cfgOverrides = {}) {
  return new TaskManager(
    { tasks: [], ...cfgOverrides },
    makeLogger(),
    { bot: { chat () {} } }
  )
}

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeTask (options = {}) {
  return new FakeTask('t1', 'fake', options, { bot: {}, logger: makeLogger(), config: {} })
}

test('BaseTask 状态机', async () => {
  const task = makeTask()
  assert.equal(task.state, 'created')
  const runPromise = task.start()
  assert.equal(task.state, 'init')
  await new Promise(r => setTimeout(r, 50))
  assert.equal(task.state, 'running')
  await task.stop()
  await runPromise
  assert.equal(task.state, 'stopped')
})

test('BaseTask init 抛错 → failed', async () => {
  const task = makeTask({ failInit: true })
  await task.start()
  assert.equal(task.state, 'failed')
  assert.ok(task.lastError.includes('init boom'))
})

test('F4 重启：stopped 后可再次 start（runCount 递增）', async () => {
  const task = makeTask()
  await task.start()
  await task.stop()
  assert.equal(task.state, 'stopped')
  assert.equal(task.runCount, 1)

  const p2 = task.start()
  assert.equal(task.state, 'init', '终态应自动重置后重启')
  await new Promise(r => setTimeout(r, 50))
  assert.equal(task.state, 'running')
  await task.stop()
  await p2
  assert.equal(task.runCount, 2, '第二次运行 runCount 递增')
})

test('F4 重启：failed 后可再次 start', async () => {
  const task = makeTask({ failInit: true })
  await task.start()
  assert.equal(task.state, 'failed')
  // 修复 failInit 后重启（模拟配置修复后的重试）
  task.options.failInit = false
  await task.start()
  await task.stop()
  assert.equal(task.state, 'stopped')
  assert.equal(task.runCount, 1)
})

test('paused → stop 不泄漏 run 协程（stop 唤醒暂停等待）', async () => {
  const task = makeTask()
  const p = task.start()
  await new Promise(r => setTimeout(r, 50))
  await task.pause()
  assert.equal(task.state, 'paused')
  const stopPromise = task.stop()
  await Promise.race([stopPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('stop 挂起')), 2000))])
  await p
  assert.equal(task.state, 'stopped')
})

test('TaskManager 装载与状态查询', async () => {
  const mgr = makeManager()
  await mgr.load({ tasks: [{ id: 'afk1', type: 'afk', options: { intervalMinutes: 1 } }] })
  const status = mgr.getStatus()
  assert.equal(status.length, 1)
  assert.equal(status[0].id, 'afk1')
  assert.ok(['running', 'init'].includes(status[0].state))
  await mgr.stopAll()
})

test('TaskManager 热重载：新增/移除/变更', async () => {
  const mgr = makeManager()
  await mgr.load({ tasks: [{ id: 'a', type: 'afk', options: { intervalMinutes: 1 } }] })
  assert.equal(mgr.getStatus().length, 1)

  await mgr.reload({ tasks: [
    { id: 'b', type: 'afk', options: { intervalMinutes: 2 } },
    { id: 'c', type: 'afk', options: { intervalMinutes: 3 } }
  ] })
  const ids = mgr.getStatus().map(t => t.id).sort()
  assert.deepEqual(ids, ['b', 'c'])
  await mgr.stopAll()
})

test('TaskManager 未知任务类型不崩溃', async () => {
  const mgr = makeManager()
  await mgr.load({ tasks: [{ id: 'x', type: 'unknown', options: {} }] })
  assert.equal(mgr.getStatus().length, 0)
})

test('F6 守卫：同配置重复任务 id 只装载第一个', async () => {
  const mgr = makeManager()
  await mgr.load({ tasks: [
    { id: 'a', type: 'afk', options: { intervalMinutes: 1 } },
    { id: 'a', type: 'afk', options: { intervalMinutes: 2 } }
  ] })
  assert.equal(mgr.getStatus().length, 1)
  await mgr.stopAll()
})

test('B2 回归：scheduled 触发后任务真正运行（而非 start/stop 同微任务空转）', async () => {
  const mgr = makeManager({ scheduleTimezone: 'UTC' })
  // 每秒触发一次；afk 无自然完成，运行时被 startTask 挂起 → 断言它确实进入了 running
  await mgr.load({ tasks: [
    { id: 's1', type: 'afk', schedule: '*/1 * * * * *', options: { intervalMinutes: 1 }, notifyChat: false }
  ] })
  assert.ok(mgr.tasks.get('s1').cron, '应创建 cron 调度')
  // 等两次触发窗口（~1.3s）：早期 bug 下任务会在同一微任务内 start+stop，从未进入 running
  await new Promise(r => setTimeout(r, 1300))
  const status = mgr.getStatus()[0]
  assert.equal(status.id, 's1')
  assert.ok(['running', 'init'].includes(status.state), `scheduled 任务应被真正启动（state=${status.state}）`)
  assert.ok(status.runCount >= 1, `runCount 应 >= 1（实际 ${status.runCount}）——任务从未运行则失败`)
  await mgr.stopAll()
})

test('B2 时长上限：runScheduled maxMinutes 到时强制停止', async () => {
  const mgr = makeManager({ scheduleTimezone: 'UTC' })
  await mgr.load({ tasks: [
    { id: 's1', type: 'afk', schedule: '0 3 * * *', options: { intervalMinutes: 1 }, durationMinutes: 0.01, notifyChat: false }
  ] })
  const rec = mgr.tasks.get('s1')
  assert.equal(rec.task.state, 'created', '未到触发时间不启动')
  await mgr.runScheduled('s1', 0.01) // 0.6s 后到时
  assert.equal(rec.task.state, 'stopped', '到时应强制停止')
  await mgr.stopAll()
})

test('F5 修复：reload 移除/变更任务时 cron 定时器停止', async () => {
  const origStop = Cron.prototype.stop
  let stopCalls = 0
  Cron.prototype.stop = function () { stopCalls++; return origStop.call(this) }
  try {
    const mgr = makeManager({ scheduleTimezone: 'UTC' })
    await mgr.load({ tasks: [
      { id: 's1', type: 'afk', schedule: '0 3 * * *', options: { intervalMinutes: 1 }, notifyChat: false },
      { id: 's2', type: 'afk', schedule: '0 4 * * *', options: { intervalMinutes: 1 }, notifyChat: false }
    ] })
    stopCalls = 0
    // 移除 s1、变更 s2
    await mgr.reload({ tasks: [
      { id: 's2', type: 'afk', schedule: '0 5 * * *', options: { intervalMinutes: 2 }, notifyChat: false }
    ] })
    assert.ok(stopCalls >= 2, `移除+变更应各 stop 一次 cron（实际 ${stopCalls}）`)
    await mgr.stopAll()
  } finally {
    Cron.prototype.stop = origStop
  }
})

test('addTask/removeTask 运行时增删', async () => {
  const mgr = makeManager()
  mgr.addTask({ id: 'ad1', type: 'afk', options: { intervalMinutes: 1 } })
  assert.equal(mgr.getStatus().length, 1)
  assert.ok(['running', 'init'].includes(mgr.getStatus()[0].state))
  await mgr.removeTask('ad1')
  assert.equal(mgr.getStatus().length, 0)
  // 重复添加报错
  mgr.addTask({ id: 'ad2', type: 'afk', options: { intervalMinutes: 1 } })
  assert.throws(() => mgr.addTask({ id: 'ad2', type: 'afk', options: { intervalMinutes: 1 } }))
  await mgr.removeTask('ad2')
})

// ---- P1-3 / P1-6：exclusive 互斥与排队清理（load/reload 路径）----

import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { CombatTask } from '../src/tasks/combat.js'

function makeCombatBot () {
  const bot = new EventEmitter()
  Object.assign(bot, {
    pathfinder: { setGoal: () => {}, stop () {} },
    entity: { position: new Vec3(0, 64, 0) },
    health: 20,
    nearestEntity: () => null
  })
  return bot
}

async function settle (n = 3) {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r))
}

test('P1-3 修复：load 两个常驻 exclusive 任务不并发（先入表后启动）', async () => {
  const bot = makeCombatBot()
  const manager = new TaskManager({}, makeLogger(), { bot })
  await manager.load({
    tasks: [
      { id: 'g1', type: 'combat', enabled: true, options: { stopWhenNoTargets: false } },
      { id: 'g2', type: 'combat', enabled: true, options: { stopWhenNoTargets: false } }
    ]
  })
  await settle(5) // 让 g1 进入循环（无目标 → 3s 内部等待挂起）
  const s1 = manager.getStatus().find(t => t.id === 'g1')
  const s2 = manager.getStatus().find(t => t.id === 'g2')
  assert.equal(s1.state, 'running')
  assert.equal(s2.state, 'created', '第二个 exclusive 应排队而非同时运行（互斥判定需看到已登记任务）')
  assert.equal(manager._pendingExclusive.length, 1)
  await manager.stopAll()
  assert.equal(manager._pendingExclusive.length, 0)
})

test('P1-6 修复：reload 移除排队的 exclusive 任务 → 队列不残留陈旧 rec', async () => {
  const bot = makeCombatBot()
  const manager = new TaskManager({}, makeLogger(), { bot })
  await manager.load({
    tasks: [
      { id: 'g1', type: 'combat', enabled: true, options: { stopWhenNoTargets: false } },
      { id: 'g2', type: 'combat', enabled: true, options: { stopWhenNoTargets: false } }
    ]
  })
  await settle(5)
  assert.equal(manager._pendingExclusive.length, 1, 'g2 应已排队')
  // reload 移除 g2：陈旧排队项必须被过滤（removeTask 有此清理，reload 此前漏了）
  await manager.reload({ tasks: [{ id: 'g1', type: 'combat', enabled: true, options: { stopWhenNoTargets: false } }] })
  assert.equal(manager._pendingExclusive.length, 0, 'reload 移除后排队队列应为空')
  assert.equal(manager.tasks.has('g2'), false)
  await manager.stopAll()
})

test('P1-6 修复：reload 后排队的 exclusive 任务重新入队并保持互斥', async () => {
  const bot = makeCombatBot()
  const manager = new TaskManager({}, makeLogger(), { bot })
  await manager.load({
    tasks: [
      { id: 'g1', type: 'combat', enabled: true, options: { stopWhenNoTargets: false } },
      { id: 'g2', type: 'combat', enabled: true, options: { stopWhenNoTargets: false } }
    ]
  })
  await settle(5)
  assert.equal(manager._pendingExclusive.length, 1)
  // reload 变更 g2 的 options（stopWhenNoTargets 打开 → 无目标自然完成）
  await manager.reload({
    tasks: [
      { id: 'g1', type: 'combat', enabled: true, options: { stopWhenNoTargets: false } },
      { id: 'g2', type: 'combat', enabled: true, options: { stopWhenNoTargets: true } }
    ]
  })
  await settle(5)
  assert.equal(manager._pendingExclusive.length, 1, '变更后的 g2 应重新排队（新 rec）')
  const s2 = manager.getStatus().find(t => t.id === 'g2')
  assert.equal(s2.state, 'created')
  await manager.stopAll()
})
