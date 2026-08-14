// 受击响应（guard）测试：怪物攻击 → 暂停任务 → combat 清理 → 范围清空后恢复。
// fake bot 用 EventEmitter（手动 emit entityHurt 触发）；fake tasks 记录调用时序，
// startTask 返回可控 promise（resolve = combat 完成）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { installGuardResponse } from '../src/core/fl-guard.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

/** fake tasks：pauseAll/addTask/startTask/removeTask/resumeTask 记录调用。 */
function makeTasks () {
  const calls = { pauseAll: 0, addTask: [], startTask: [], removeTask: [], resumeTask: [] }
  let combatDone
  const combatPromise = new Promise((resolve) => { combatDone = resolve })
  return {
    calls,
    combatDone,
    // 抢占语义（v1.5.1+）：非 exclusive pause、exclusive stop
    preemptForCombat: async () => { calls.preempt = (calls.preempt ?? 0) + 1; return { paused: ['m1'], stopped: ['e1'] } },
    addTask: (entry) => { calls.addTask.push(entry) },
    startTask: async (id, _rec, _maxMinutes, opts) => { calls.startTask.push({ id, opts }); return combatPromise },
    removeTask: async (id) => { calls.removeTask.push(id) },
    restartStopped: async (ids) => { calls.restartStopped = (calls.restartStopped ?? []).concat(ids) },
    resumeTask: async (id) => { calls.resumeTask.push(id) }
  }
}

function makeEnv (overrides = {}) {
  const bot = new EventEmitter()
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  const tasks = makeTasks()
  const ctx = { cfg: { guard: { enabled: true, radius: 32, cooldownMs: 30000 } }, tasks, logger: makeLogger(), ...overrides }
  installGuardResponse(ctx, bot, () => ctx.logger)
  return { bot, tasks, ctx }
}

const hostileSource = { name: 'zombie', type: 'zombie' }
const playerSource = { username: 'steve', name: 'steve' }

test('guard: 怪物攻击 → 暂停任务 + combat 清理 + 完成后恢复', async () => {
  const { bot, tasks } = makeEnv()
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((tasks.calls.preempt ?? 0), 1, '受击应暂停全部任务')
  assert.equal(tasks.calls.addTask.length, 1)
  assert.equal(tasks.calls.addTask[0].id, 'guard-response')
  assert.equal(tasks.calls.addTask[0].type, 'combat')
  assert.deepEqual(tasks.calls.addTask[0].options, { aggroRange: 32, stopWhenNoTargets: true, maxTargets: 0 })
  assert.equal(tasks.calls.addTask[0].notifyChat, false, 'guard 任务静默创建')
  assert.equal(tasks.calls.addTask[0].enabled, false, '禁用自动启动（防与显式 startTask 竞态——combat 未执行就被移除）')
  assert.deepEqual(tasks.calls.startTask, [{ id: 'guard-response', opts: { ignorePaused: true } }])
  // combat 完成（范围清空）→ 移除 guard 任务 → 重启被抢占的 exclusive → 恢复暂停的任务
  tasks.combatDone()
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(tasks.calls.removeTask, ['guard-response'])
  assert.deepEqual(tasks.calls.restartStopped, ['e1'], '被抢占的 exclusive 任务应重启')
  assert.deepEqual(tasks.calls.resumeTask, ['m1'], '恢复暂停的任务')
})

test('guard: 玩家/自伤源不触发', async () => {
  const { bot, tasks } = makeEnv()
  bot.emit('entityHurt', bot.entity, playerSource)
  bot.emit('entityHurt', bot.entity, bot.entity)
  bot.emit('entityHurt', bot.entity, null)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((tasks.calls.preempt ?? 0), 0, '玩家/PvP/环境自伤不触发守卫')
  assert.equal(tasks.calls.addTask.length, 0)
})

test('guard: 冷却内重复受击不触发；combat 运行中不重复', async () => {
  const { bot, tasks } = makeEnv()
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((tasks.calls.preempt ?? 0), 1)
  // combat 运行中（未 resolve）再受击 → 跳过
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((tasks.calls.preempt ?? 0), 1, '清理中不重复触发')
  // combat 完成后冷却内再受击 → 跳过
  tasks.combatDone()
  await new Promise((r) => setTimeout(r, 10))
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((tasks.calls.preempt ?? 0), 1, '冷却内不重复触发')
})

test('guard: 死亡重置冷却——重生后首次受击立即触发（怪物多时死亡循环场景）', async () => {
  const { bot, tasks } = makeEnv()
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((tasks.calls.preempt ?? 0), 1)
  tasks.combatDone()
  await new Promise((r) => setTimeout(r, 10))
  // 冷却内受击被挡
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((tasks.calls.preempt ?? 0), 1, '死亡前冷却内受击不触发')
  // 死亡 → 冷却重置 → 受击立即触发
  bot.emit('death')
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((tasks.calls.preempt ?? 0), 2, '死亡重置冷却——重生后首次受击立即触发战斗')
  tasks.combatDone()
  await new Promise((r) => setTimeout(r, 10))
})

test('guard: enabled=false 不响应', async () => {
  const { bot, tasks } = makeEnv({ cfg: { guard: { enabled: false, radius: 32, cooldownMs: 30000 } } })
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((tasks.calls.preempt ?? 0), 0)
  assert.equal(tasks.calls.addTask.length, 0)
})

test('guard: 无配置（cfg 无 guard 块）→ 默认启用', async () => {
  const { bot, tasks } = makeEnv({ cfg: {} })
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal((tasks.calls.preempt ?? 0), 1, '缺省配置按默认启用')
})

test('guard: addTask 冲突（残留）→ 本次跳过 + finally 清理残留（异常路径幂等）', async () => {
  const { bot, tasks, ctx } = makeEnv()
  // 残留：addTask 抛 id 冲突 → catch → finally removeTask 清残留 + 恢复任务
  const original = tasks.addTask
  tasks.addTask = (entry) => {
    if (entry.id === 'guard-response') throw new Error('任务 id 已存在: guard-response')
    original(entry)
  }
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(tasks.calls.removeTask, ['guard-response'], 'finally 清理残留')
  assert.deepEqual(tasks.calls.restartStopped, ['e1'], '异常路径仍重启被抢占 exclusive')
  assert.deepEqual(tasks.calls.resumeTask, ['m1'], '异常路径仍恢复任务')
  // 下次受击正常（残留已清；推进冷却）
  tasks.addTask = original
  ctx.cfg.guard.cooldownMs = 0
  bot.emit('entityHurt', bot.entity, hostileSource)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(tasks.calls.addTask.length, 1, '第二次受击正常建任务')
})
