import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { installDeathHandling } from '../src/core/fl-death.js'

// 死亡/重生处理链路测试（此前零覆盖——生命周期核心路径：死亡→pauseAll→
// follow 停止→agent 中止→respawn 请求；重生→恢复暂停任务）。

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (tasks, plugins = null, agent = null) {
  return {
    tasks,
    plugins,
    agent,
    lastDamageSource: null
  }
}

function makeBot () {
  const bot = new EventEmitter()
  bot.messages = []
  bot.chat = (m) => { bot.messages.push(m) }
  bot.entity = { position: { x: 1, y: 64, z: 2 } }
  bot.respawn = () => { bot.respawnCalls = (bot.respawnCalls ?? 0) + 1 }
  return bot
}

function makeNotifier (sends) {
  return { send: (kind) => { sends.push(kind) } }
}

test('fl-death：死亡 → 暂停任务 + 停跟随 + 中止 agent + 请求重生 + 通知', async () => {
  const paused = []
  const resumed = []
  let followStopped = false
  let agentStopped = false
  const ctx = makeCtx(
    {
      pauseAll: async () => { paused.push(1); return ['t1'] },
      resumeTask: async (id) => { resumed.push(id) }
    },
    { follow: { stop: () => { followStopped = true } } },
    { stop: () => { agentStopped = true }, summarize: async () => null } // 无 LLM → 回退模板
  )
  const bot = makeBot()
  const sends = []
  installDeathHandling(ctx, bot, () => makeLogger(), () => makeNotifier(sends))
  bot.emit('death')
  await new Promise(r => setImmediate(r))
  assert.equal(paused.length, 1, '死亡应暂停全部任务')
  assert.equal(followStopped, true, '死亡应停止跟随')
  assert.equal(agentStopped, true, '死亡应中止进行中的 LLM 工具循环')
  assert.equal(bot.respawnCalls, 1, '死亡应请求重生')
  assert.ok(sends.includes('death'), 'webhook 应推送死亡')
  assert.ok(bot.messages.some(m => m.includes('已死亡')), `模板播报: ${bot.messages}`)
  // 重生：恢复死亡时暂停的任务
  bot.emit('respawn')
  await new Promise(r => setImmediate(r))
  assert.deepEqual(resumed, ['t1'], '重生应恢复本次死亡暂停的任务')
  assert.ok(sends.includes('respawn'), 'webhook 应推送重生')
  assert.ok(bot.messages.some(m => m.includes('任务已恢复')), '有暂停任务时播报恢复')
})

test('fl-death：快速重生服竞态——respawn 先于 pauseAll 完成也正确恢复', async () => {
  let releasePause
  const gate = new Promise(r => { releasePause = r })
  const resumed = []
  const ctx = makeCtx({
    pauseAll: async () => { await gate; return ['t2'] },
    resumeTask: async (id) => { resumed.push(id) }
  })
  const bot = makeBot()
  const sends = []
  installDeathHandling(ctx, bot, () => makeLogger(), () => makeNotifier(sends))
  bot.emit('death')
  bot.emit('respawn') // 快速重生服：respawn 先于 pauseAll 完成到达
  releasePause()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(resumed, ['t2'], 'respawn 应 await deathPaused 再恢复（同步读取会漏掉暂停名单）')
})

test('fl-death：无运行任务死亡 → 重生不播"任务已恢复"（如实播报防误导）', async () => {
  const ctx = makeCtx({
    pauseAll: async () => [], // 死亡时无运行任务
    resumeTask: async () => {}
  })
  const bot = makeBot()
  const sends = []
  installDeathHandling(ctx, bot, () => makeLogger(), () => makeNotifier(sends))
  bot.emit('death')
  await new Promise(r => setImmediate(r))
  bot.emit('respawn')
  await new Promise(r => setImmediate(r))
  assert.ok(!bot.messages.some(m => m.includes('任务已恢复')), '无暂停任务不得播"任务已恢复"')
  assert.ok(bot.messages.some(m => m.includes('已重生')), `重生播报: ${bot.messages}`)
})

test('fl-death：死亡播报带真实伤害来源（60s 新鲜窗口内）', async () => {
  const ctx = makeCtx({ pauseAll: async () => [], resumeTask: async () => {} })
  ctx.lastDamageSource = { who: 'zombie', ts: Date.now() }
  const bot = makeBot()
  const sends = []
  installDeathHandling(ctx, bot, () => makeLogger(), () => makeNotifier(sends))
  bot.emit('death')
  await new Promise(r => setImmediate(r))
  assert.ok(bot.messages.some(m => m.includes('zombie')), `播报应含真实伤害来源: ${bot.messages}`)
  // 过期来源 → 环境伤害兜底
  ctx.lastDamageSource = { who: 'skeleton', ts: Date.now() - 5 * 60000 }
  const bot2 = makeBot()
  installDeathHandling(ctx, bot2, () => makeLogger(), () => makeNotifier(sends))
  bot2.emit('death')
  await new Promise(r => setImmediate(r))
  assert.ok(bot2.messages.some(m => m.includes('环境伤害')), `过期来源应回退环境伤害: ${bot2.messages}`)
})
