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
    if (this.options.failRun) throw new Error('run boom')
    await this._internalWait(1000, 'fake-sleep')
  }
}

/** 异步 init（拉宽 pause-init 微任务窗口，C4/O 测试用）。 */
class SlowInitTask extends BaseTask {
  async init () {
    super.init()
    await new Promise(r => setTimeout(r, 30))
  }

  async run (gen) {
    await super.run()
    while (this._alive(gen)) {
      await this._waitIfPaused()
      await this._internalWait(1000, 'slow-sleep')
    }
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

// ---- C4：状态机显式化（per-wait token / pause-init 窗口 / 采纳窗口）----

test('C4/O 修复：pause 落在 init 窗口 → 保持 paused，resume 正常恢复（不再伪死锁）', async () => {
  const task = new SlowInitTask('t1', 'fake', {}, { bot: {}, logger: makeLogger(), config: {} })
  const p = task.start() // init 挂起 30ms
  await new Promise(r => setTimeout(r, 10)) // init 窗口内 pause
  await task.pause()
  await new Promise(r => setTimeout(r, 60)) // init 完成、run 启动
  assert.equal(task.state, 'paused', 'run() 不得覆盖 paused（否则 resume 永远 no-op）')
  await task.resume()
  await new Promise(r => setTimeout(r, 10))
  assert.equal(task.state, 'running', 'resume 应恢复正常运行')
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

test('C4/P 修复：per-wait token——并发等待互不干扰，唤醒全部生效', async () => {
  const task = makeTask()
  const w1 = task._internalWait(5000, 'w1')
  const w2 = task._internalWait(5000, 'w2')
  assert.equal(task._internalWaits.size, 2, '两次等待应各自持有 token（单槽会被覆盖）')
  task._wakeInternalWait()
  await Promise.all([w1, w2])
  assert.equal(task._internalWaits.size, 0, '唤醒后 token 应清理')
})

test('C4/P 修复：旧代际等待到点不清新代 waitingReason', async () => {
  const task = makeTask()
  task._runGen = 1
  const old = task._internalWait(5, 'old-gen') // 5ms 后自己到点
  task._runGen = 2 // 模拟 stop 超时强制结束 + 立即重启
  const nw = task._internalWait(5000, 'new-gen')
  assert.equal(task.waitingReason, 'new-gen')
  await old // 旧代到点醒来 → finally 应跳过清理（gen 不匹配）
  assert.equal(task.waitingReason, 'new-gen', '旧代 finally 不得清掉新代 reason')
  task._wakeInternalWait()
  await nw
})

test('C4/F 修复：run 抛错 → start() 返回 null（采纳窗口关闭，不再返回已 reject 的 promise）', async () => {
  const task = makeTask({ failRun: true })
  const p = await task.start()
  assert.equal(p, null, '失败路径应返回 null（runScheduled 的 await p 不再收到 rejection）')
  assert.equal(task.state, 'failed')
  assert.ok(task.lastError.includes('run boom'))
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

test('E 修复：scheduled exclusive 排队启动后仍到时停止（时长上限不丢）', async () => {
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
  // 模拟 scheduled 触发：排队时挂时长上限（runScheduled 的 withTimeout 随函数栈丢弃）
  await manager.runScheduled('g2', 0.01)
  const rec = manager.tasks.get('g2')
  assert.equal(rec.pendingMaxMinutes, 0.01, '排队记录应保存时长上限')
  // 停止 g1 → drain 启动 g2（带上限）→ 0.6s 后到时停止
  await manager.stopTask('g1')
  await settle(2)
  const s2 = manager.getStatus().find(t => t.id === 'g2')
  assert.ok(['running', 'init'].includes(s2.state), 'g2 应在 g1 停止后启动')
  await new Promise(r => setTimeout(r, 800))
  assert.equal(manager.tasks.get('g2').task.state, 'stopped', '排队启动的 scheduled 任务应到时停止')
  await manager.stopAll()
})

test('F 修复：scheduled 任务 run 抛错 → 通知失败而非上抛（croner 漂浮 rejection → fatal exit）', async () => {
  const bot = makeCombatBot()
  const manager = new TaskManager({}, makeLogger(), { bot })
  const notices = []
  manager._notify = (rec, state) => { notices.push(state) }
  await manager.load({
    tasks: [{ id: 's1', type: 'combat', schedule: '0 3 * * *', options: { stopWhenNoTargets: false }, notifyChat: false }]
  })
  bot.entity = null // 触发 combat 循环 TypeError（F 触发源同类）
  let rejected = false
  try {
    await manager.runScheduled('s1')
  } catch {
    rejected = true
  }
  assert.equal(rejected, false, 'runScheduled 不得上抛')
  const s1 = manager.getStatus().find(t => t.id === 's1')
  assert.equal(s1.state, 'failed')
  assert.ok(notices.some(n => n.includes('failed')), `应通知失败: ${notices}`)
  await manager.stopAll()
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

test('C6/N 修复：removeTask 清理快照计数器 + restoreCounters 回灌', async () => {
  const stateStore = {
    counters: {},
    setCounter (id, c) { this.counters[id] = { ...c } },
    deleteCounter (id) { delete this.counters[id] },
    setTasks () {}, flush () {}
  }
  const mgr = new TaskManager({ tasks: [] }, makeLogger(), { bot: { chat () {} } }, stateStore)
  mgr.addTask({ id: 'ad1', type: 'afk', options: { intervalMinutes: 1 }, notifyChat: false })
  await settle(3)
  mgr._snapshotCounters()
  assert.ok(stateStore.counters.ad1, '快照应写入计数器')
  await mgr.removeTask('ad1')
  assert.equal(stateStore.counters.ad1, undefined, 'removeTask 应清理计数器（不残留）')
  // 重建回灌路径（feature-layer doRebuild 调用）
  mgr.addTask({ id: 'ad1', type: 'afk', options: { intervalMinutes: 1 }, notifyChat: false })
  mgr.restoreCounters('ad1', { wiggles: 3 })
  assert.equal(mgr.getStatus().find(t => t.id === 'ad1').counters.wiggles, 3, '回灌后遥测应保留')
  await mgr.stopAll()
})

test('U8 修复：getStatus 附加调度字段（排队位置/时长剩余/下次 cron 触发）', async () => {
  const bot = makeCombatBot()
  const manager = new TaskManager({ scheduleTimezone: 'UTC' }, makeLogger(), { bot })
  await manager.load({
    tasks: [
      { id: 'g1', type: 'combat', enabled: true, options: { stopWhenNoTargets: false }, durationMinutes: 0.01 },
      { id: 'g2', type: 'combat', enabled: true, options: { stopWhenNoTargets: false } }
    ]
  })
  await settle(5)
  const s1 = manager.getStatus().find(t => t.id === 'g1')
  const s2 = manager.getStatus().find(t => t.id === 'g2')
  assert.equal(s1.queuePosition, null, '运行中的任务不排队')
  assert.equal(s2.queuePosition, 1, '排队的 g2 应显示位置 1')
  assert.ok(s1.remainingMinutes !== undefined, '带 durationMinutes 的运行任务应显示剩余时长')
  await manager.stopAll()
  // cron 下次触发
  const bot2 = makeCombatBot()
  const mgr2 = new TaskManager({ scheduleTimezone: 'UTC' }, makeLogger(), { bot: bot2 })
  await mgr2.load({ tasks: [{ id: 's1', type: 'afk', schedule: '0 3 * * *', options: { intervalMinutes: 1 } }] })
  const st = mgr2.getStatus()[0]
  assert.ok(st.nextRunAt instanceof Date, 'cron 任务应显示下次触发时间')
  await mgr2.stopAll()
})

test('U7 修复：任务终态经 LLM 一句话总结（附加层）+ 冷却防刷屏', async () => {
  const summaries = []
  const agent = { summarize: async (p) => { summaries.push(p); return '挖了 5 个铁' } }
  const bot = { chat: (m) => { bot.messages.push(m) }, messages: [] }
  const mgr = new TaskManager({ tasks: [], chat: { maxLength: 250 } }, makeLogger(), { bot }, null, () => agent)
  mgr.addTask({ id: 'a1', type: 'afk', options: { intervalMinutes: 1 } })
  await settle(3)
  const rec = mgr.tasks.get('a1')
  rec.task.counters = { wiggles: 5 }
  mgr._notify(rec, 'completed')
  await settle(3)
  assert.ok(summaries.length >= 1, '终态应触发 LLM 总结')
  assert.ok(bot.messages.some(m => m.includes('挖了 5 个铁')), `总结应广播: ${bot.messages}`)
  // 冷却期内不重复总结；非终态（stopped）不总结
  mgr._notify(rec, 'failed: boom')
  await settle(3)
  assert.equal(summaries.length, 1, '冷却期内不应重复总结')
  await mgr.stopAll()
})

test('U7 修复：无 agent 时总结静默跳过（任务流程不受影响）', async () => {
  const bot = { chat: (m) => { bot.messages.push(m) }, messages: [] }
  const mgr = new TaskManager({ tasks: [], chat: { maxLength: 250 } }, makeLogger(), { bot })
  mgr.addTask({ id: 'a1', type: 'afk', options: { intervalMinutes: 1 } })
  await settle(3)
  const rec = mgr.tasks.get('a1')
  mgr._notify(rec, 'completed') // getAgent null → 直接跳过
  await settle(3)
  assert.ok(bot.messages.some(m => m.includes('[任务 a1] completed')), '模板通知仍应发送')
  await mgr.stopAll()
})

test('C8/S 修复：exclusive 任务运行期间仲裁器登记，终态清除', async () => {
  const arb = await import('../src/core/arbiter.js')
  const bot = makeCombatBot()
  const manager = new TaskManager({}, makeLogger(), { bot })
  await manager.load({
    tasks: [{ id: 'g1', type: 'combat', enabled: true, options: { stopWhenNoTargets: false } }]
  })
  await settle(5)
  assert.equal(arb.getExclusiveOwner(), 'g1', '运行中的 exclusive 任务应登记移动仲裁器')
  await manager.stopAll()
  assert.equal(arb.getExclusiveOwner(), null, '终态应清除登记')
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

// ---- U1：状态快照挂钩（ad-hoc 条目 + 计数器）----

test('U1: addTask 标记 adHoc 并同步快照（配置任务不写快照）', async () => {
  const bot = makeCombatBot()
  const synced = []
  const store = { setTasks: (tasks) => { synced.push(tasks) }, setCounter: () => {} }
  const manager = new TaskManager({}, makeLogger(), { bot }, store)
  await manager.load({
    tasks: [{ id: 'cfg1', type: 'combat', enabled: true, options: { stopWhenNoTargets: true } }]
  })
  assert.equal(synced.length, 0, '配置任务不触发快照同步')
  manager.addTask({ id: 'adhoc1', type: 'combat', options: { stopWhenNoTargets: true } })
  assert.equal(synced.length, 1)
  assert.deepEqual(synced.at(-1).map(e => e.id), ['adhoc1'], '快照只含 ad-hoc 条目')
  assert.equal(synced.at(-1)[0].adHoc, true)
  await manager.removeTask('adhoc1')
  assert.deepEqual(synced.at(-1), [], '移除后快照清空')
  await manager.stopAll()
})

test('U1: 任务终态快照计数器', async () => {
  const bot = makeCombatBot()
  const counters = []
  const store = { setTasks: () => {}, setCounter: (id, c) => { counters.push([id, c]) } }
  const manager = new TaskManager({}, makeLogger(), { bot }, store)
  // 无目标 + stopWhenNoTargets → 立即自然完成 → startTask 终态钩子快照计数器
  await manager.load({ tasks: [{ id: 'c1', type: 'combat', enabled: true, options: { stopWhenNoTargets: true } }] })
  await new Promise(r => setTimeout(r, 50))
  assert.ok(counters.length >= 1, '任务终态应快照计数器')
  assert.equal(counters.at(-1)[0], 'c1')
  assert.deepEqual(counters.at(-1)[1], {}, 'combat 无目标完成 counters 为空对象')
  await manager.stopAll()
})
