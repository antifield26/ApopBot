import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _idleTick, _resetIdleWatcher, bindIdleWatcher } from '../src/core/idle-watcher.ts'

// 任务长 idle LLM 播报测试（此前零覆盖——10 分钟阈值 + 1 小时冷却 + 跨重建）。
// _idleTick 单次检查由测试直接驱动（60s 周期不便于测试）。

test('idle 播报：waitingReason 超阈值 → LLM 播报；1 小时冷却内同任务同原因去重', async () => {
  _resetIdleWatcher()
  const messages = []
  const bot = { chat: (m) => { messages.push(m) } }
  const summaries = []
  const now0 = Date.now()
  const ctx = {
    tasks: {
      getStatus: () => [{
        id: 't1',
        type: 'afk',
        state: 'running',
        waitingReason: 'no-food',
        waitingSince: now0 - 11 * 60000 // 已等待 11 分钟 > 10 分钟阈值
      }]
    },
    agent: { summarize: async (p) => { summaries.push(p); return '任务卡在没食物' } }
  }
  bindIdleWatcher(ctx, bot)
  _idleTick(now0)
  await new Promise(r => setImmediate(r))
  assert.equal(summaries.length, 1, '超阈值应触发 LLM 播报')
  assert.ok(messages.some(m => m.includes('任务卡在没食物')), `播报内容: ${messages}`)
  // 冷却内（同 now）不重复
  _idleTick(now0 + 30 * 60000)
  await new Promise(r => setImmediate(r))
  assert.equal(summaries.length, 1, '1 小时内同任务同原因不重复播报')
  // 1 小时后可再播报
  _idleTick(now0 + 61 * 60000)
  await new Promise(r => setImmediate(r))
  assert.equal(summaries.length, 2, '冷却过后可再播报')
  _resetIdleWatcher()
})

test('idle 播报：未超阈值/无等待原因/非 running 不播报', async () => {
  _resetIdleWatcher()
  const bot = { chat: () => {} }
  const summaries = []
  const now0 = Date.now()
  const ctx = {
    tasks: {
      getStatus: () => [
        { id: 't1', type: 'afk', state: 'running', waitingReason: 'fresh', waitingSince: now0 - 5000 },
        { id: 't2', type: 'afk', state: 'running', waitingReason: null, waitingSince: now0 - 20 * 60000 },
        { id: 't3', type: 'afk', state: 'paused', waitingReason: 'old', waitingSince: now0 - 20 * 60000 }
      ]
    },
    agent: { summarize: async (p) => { summaries.push(p); return 'x' } }
  }
  bindIdleWatcher(ctx, bot)
  _idleTick(now0)
  await new Promise(r => setImmediate(r))
  assert.equal(summaries.length, 0, '未超阈值/无原因/非 running 均不播报')
  _resetIdleWatcher()
})

test('idle 播报：无 agent/无 tasks → 静默跳过（零依赖路径）', () => {
  _resetIdleWatcher()
  bindIdleWatcher({ tasks: null, agent: null }, { chat: () => {} })
  _idleTick() // 不抛即可
  bindIdleWatcher({ tasks: { getStatus: () => [] }, agent: null }, { chat: () => {} })
  _idleTick() // 无 summarize 静默
  _resetIdleWatcher()
})

test('idle 播报：跨重建引用更新（bindIdleWatcher 换 bot/ctx 后播报走新引用）', async () => {
  _resetIdleWatcher()
  const messages1 = []
  const messages2 = []
  const summaries = []
  const now0 = Date.now()
  const mkCtx = () => ({
    tasks: {
      getStatus: () => [{ id: 't1', type: 'afk', state: 'running', waitingReason: 'stuck', waitingSince: now0 - 11 * 60000 }]
    },
    agent: { summarize: async (p) => { summaries.push(p); return '卡住了' } }
  })
  // 重建前绑定 bot1（模拟 feature-layer 重建换引用）
  bindIdleWatcher(mkCtx(), { chat: (m) => { messages1.push(m) } })
  bindIdleWatcher(mkCtx(), { chat: (m) => { messages2.push(m) } })
  _idleTick(now0)
  await new Promise(r => setImmediate(r))
  assert.equal(messages1.length, 0, '旧 bot 不应再收播报')
  assert.ok(messages2.some(m => m.includes('卡住了')), '新 bot 应收到播报')
  _resetIdleWatcher()
})
