// 会话落盘测试（v1.0.0 C5）：tmp+rename 原子写 / 2s 防抖 / exit flush / LRU 裁剪 /
// 形状防御 / 未来版本拒绝 / agent-interface 回填接入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSessionStore, loadSessions } from '../src/l2/sessions.ts'
import { AgentInterface } from '../src/l2/agent-interface.ts'

function makeTmp () {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sess-'))
  return { dir, file: path.join(dir, 'sessions.json') }
}

test('set→flush 原子落盘（无 .tmp 残留）+ 内容完整', () => {
  const { dir, file } = makeTmp()
  try {
    const s = createSessionStore({ file, debounceMs: 100000, maxSessions: 4 })
    s.set('steve', { history: [{ role: 'user', content: 'hi' }], calls: [{ name: 'act', result: 'ok' }] })
    s.flush()
    assert.ok(existsSync(file), '落盘存在')
    assert.ok(!existsSync(file + '.tmp'), '无 tmp 残留')
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(disk.schemaVersion, 2)
    assert.equal(disk.sessions.steve.history[0].content, 'hi')
    assert.equal(disk.sessions.steve.calls[0].result, 'ok')
    assert.equal(disk.sessions.steve.goal, null, 'v2 会话含 goal 字段')
    assert.equal(disk.sessions.steve.summary, null, 'v2 会话含 summary 字段')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('防抖：多次 set 只落一次盘（flush 前不写）', () => {
  const { dir, file } = makeTmp()
  try {
    const s = createSessionStore({ file, debounceMs: 100000 })
    s.set('a', { history: [{ role: 'user', content: '1' }], calls: [] })
    s.set('b', { history: [{ role: 'user', content: '2' }], calls: [] })
    assert.ok(!existsSync(file), '防抖窗口内不落盘')
    s.flush()
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(disk.sessions).sort(), ['a', 'b'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LRU 裁剪：超过 maxSessions 只落最近 N 个', () => {
  const { dir, file } = makeTmp()
  try {
    const s = createSessionStore({ file, debounceMs: 100000, maxSessions: 3 })
    for (let i = 0; i < 5; i++) s.set(`u${i}`, { history: [], calls: [] })
    s.flush()
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(Object.keys(disk.sessions).length, 3, '超限裁剪到 3')
    assert.ok(!('u0' in disk.sessions), '最旧被驱逐')
    assert.ok('u4' in disk.sessions, '最新保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('get 刷新 LRU 序（访问过的会话保留）', () => {
  const { dir, file } = makeTmp()
  try {
    const s = createSessionStore({ file, debounceMs: 100000, maxSessions: 2 })
    s.set('a', { history: [], calls: [] })
    s.set('b', { history: [], calls: [] })
    s.get('a') // 刷新 a → 最新
    s.set('c', { history: [], calls: [] })
    s.flush()
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok('a' in disk.sessions, '访问过的 a 保留')
    assert.ok(!('b' in disk.sessions), '未访问的 b 被驱逐')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('形状防御：history/calls 非数组按空；reset 删除', () => {
  const { dir, file } = makeTmp()
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessions: { bad: { history: 'x', calls: null }, good: { history: [{ role: 'user', content: 'ok' }], calls: [] } } }))
    const s = createSessionStore({ file, debounceMs: 100000 })
    const bad = s.get('bad')
    assert.deepEqual(bad, { history: [], calls: [], goal: null, summary: null }, '坏形状按空')
    assert.equal(s.get('good').history[0].content, 'ok')
    s.reset('good')
    s.flush()
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(!('good' in disk.sessions), 'reset 同步清磁盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未来版本拒绝加载（明确报错）', () => {
  const { dir, file } = makeTmp()
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, sessions: {} }))
    assert.throws(() => loadSessions(file), /schemaVersion=99/, '未来版本应报错')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agent-interface 接入：重启后从磁盘回填会话（多轮上下文不丢）', async () => {
  const { dir, file } = makeTmp()
  try {
    const store = createSessionStore({ file, debounceMs: 100000 })
    const ctx = { cfg: { ops: [] }, logger: { child: () => ctx.logger, info () {}, warn () {}, error () {}, debug () {} }, bot: {}, tasks: {}, conn: { getStatus: () => ({ state: 'x' }) }, plugins: {} }
    const executor = { primitives: new Map(), executeOne: async () => ({ ok: true, result: 'x' }), executeBatch: async () => ({ ok: true, results: [] }) }
    // 第一代 agent：写入会话
    const agent1 = new AgentInterface(ctx, { provider: { chat: async () => ({ text: '第一条回复', toolCalls: [] }) }, executor, sessionStore: store, config: { enabled: true, cooldownMs: 0, maxSteps: 3 } })
    await agent1.chat('steve', '你好')
    store.flush()
    // 模拟重启：新 agent + 新 store（从磁盘加载）
    const store2 = createSessionStore({ file, debounceMs: 100000 })
    const agent2 = new AgentInterface(ctx, { provider: { chat: async () => ({ text: '第二条回复', toolCalls: [] }) }, executor, sessionStore: store2, config: { enabled: true, cooldownMs: 0, maxSteps: 3 } })
    await agent2.chat('steve', '还记得吗')
    // 第二轮 provider 收到的 messages 应含第一轮的 user/assistant（历史回填）
    // 用带记录的 provider 验证：
    const seen = []
    const provider3 = { chat: async (messages) => { seen.push(messages); return { text: 'ok', toolCalls: [] } } }
    const agent3 = new AgentInterface(ctx, { provider: provider3, executor, sessionStore: store2, config: { enabled: true, cooldownMs: 0, maxSteps: 3 } })
    await agent3.chat('steve', '三')
    const texts = seen[0].map(m => m.content ?? '')
    assert.ok(texts.includes('你好'), `历史应回填: ${JSON.stringify(texts)}`)
    assert.ok(texts.includes('第一条回复'), `assistant 轮应回填: ${JSON.stringify(texts)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('第 8 轮：reset 立即落盘（防抖窗口内崩溃不复活）', () => {
  const { dir, file } = makeTmp()
  try {
    const s = createSessionStore({ file, debounceMs: 100000 })
    s.set('steve', { history: [{ role: 'user', content: 'secret' }], calls: [] })
    s.flush()
    s.reset('steve')
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal('steve' in disk.sessions, false, 'reset 后磁盘立即无该会话（防抖窗口内崩溃也不复活）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('第 8 轮：set 刷新 LRU 插入序（活跃会话不被裁尾误裁）', () => {
  const { dir, file } = makeTmp()
  try {
    const s = createSessionStore({ file, debounceMs: 100000, maxSessions: 2 })
    s.set('a', { history: [], calls: [] })
    s.set('b', { history: [], calls: [] })
    s.set('a', { history: [], calls: [] }) // a 再次写入——刷新到末尾
    s.set('c', { history: [], calls: [] }) // 超限 → 裁最旧（修复前误裁 a）
    s.flush()
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok('a' in disk.sessions && 'c' in disk.sessions, '活跃 a 保留')
    assert.ok(!('b' in disk.sessions), '被裁的是最久未刷新的 b（修复前 a 会被误裁）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
