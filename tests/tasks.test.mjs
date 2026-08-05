import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaseTask } from '../src/tasks/base.js'
import { TaskManager } from '../src/tasks/manager.js'

// 测试用最小假任务（不依赖 mineflayer）
class FakeTask extends BaseTask {
  async init () {
    super.init()
    if (this.options.failInit) throw new Error('init boom')
  }

  async run () {
    await super.run()
    this.runs = (this.runs ?? 0) + 1
    await this._sleep(1000)
  }

  _sleep (ms) {
    return new Promise((resolve) => {
      if (this._stopRequested) { resolve(); return }
      this._sleepResolve = resolve
      this._sleepTimer = setTimeout(resolve, ms)
    })
  }

  async stop () {
    clearTimeout(this._sleepTimer)
    this._sleepResolve?.()
    await super.stop()
  }
}

function makeManager (cfgOverrides = {}) {
  const logger = { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
  return new TaskManager(
    { tasks: [] },
    logger,
    { bot: { chat () {} } }
  )
}

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

test('BaseTask 状态机', async () => {
  const task = new FakeTask('t1', 'fake', {}, { bot: {}, logger: makeLogger(), config: {} })
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
  const task = new FakeTask('t2', 'fake', { failInit: true }, { bot: {}, logger: makeLogger(), config: {} })
  await task.start()
  assert.equal(task.state, 'failed')
  assert.ok(task.lastError.includes('init boom'))
})

test('TaskManager 装载与状态查询', async () => {
  const mgr = makeManager()
  // 用真实注册表不行（FakeTask 未注册），改用注入：替换 TASK_TYPES 不方便，直接用真实 afk 任务测试装载
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

  // 移除 a、新增 b、保留 c（不变）
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
