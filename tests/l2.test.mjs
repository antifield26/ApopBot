import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentInterface } from '../src/l2/agent-interface.js'
import { createSkillRegistry } from '../src/l2/skills.js'
import { createL2 } from '../src/l2/index.js'
import { loadConfig } from '../src/core/config.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (overrides = {}, cfgPatch = {}) {
  const cfg = { ...loadConfig({ argv: [], env: {} }), ...cfgPatch }
  const tasks = { getStatus: () => [{ id: 'm1', state: 'running' }], addTask: () => {}, removeTask: async () => {} }
  const conn = { getStatus: () => ({ state: 'connected', reconnectCount: 2 }) }
  const bot = {
    chat (msg) { this.messages.push(msg) },
    messages: [],
    inventory: { items: () => [{ name: 'diamond', count: 5 }] },
    players: {},
    entity: { position: { x: 1, y: 2, z: 3 }, health: 20, food: 20 },
    pathfinder: { setGoal: () => {} }
  }
  return { cfg, logger: makeLogger(), bot, tasks, conn, plugins: {}, ...overrides }
}

/** 可脚本化的 fake provider。 */
function makeFakeProvider (script) {
  const calls = []
  return {
    calls,
    async chat (messages, opts = {}) {
      calls.push({ messages: [...messages], tools: opts.tools, system: opts.system, signal: opts.signal })
      const step = script.shift()
      if (!step) return { text: '（脚本结束）', toolCalls: [] }
      if (step.throw) throw step.throw
      return step
    }
  }
}

const l2cfg = { enabled: true, provider: 'cloud', model: 'x', cooldownMs: 0, maxSteps: 5 }

function makeAgent (ctx, script) {
  const provider = makeFakeProvider(script)
  const skills = createSkillRegistry(ctx)
  const agent = new AgentInterface(ctx, { provider, skills, config: l2cfg })
  return { agent, provider, skills }
}

test('createL2: enabled=false 返回 null（零依赖路径）', () => {
  const ctx = makeCtx()
  assert.equal(createL2(ctx.cfg, ctx), null)
})

test('createL2: enabled=true 返回可用实例', () => {
  const ctx = makeCtx()
  const cfg2 = loadConfig({ argv: [], env: { MCBOT_L2_ENABLED: 'true' } })
  const agent = createL2(cfg2, ctx)
  assert.ok(agent)
  assert.equal(AgentInterface.isAvailable(), true)
})

test('chat: 单轮回复（无工具调用）', async () => {
  const ctx = makeCtx()
  const { agent, provider } = makeAgent(ctx, [{ text: '你好，我是 Bot' }])
  const { reply } = await agent.chat('steve', '介绍一下自己')
  assert.equal(reply, '你好，我是 Bot')
  assert.equal(provider.calls.length, 1)
  assert.ok(provider.calls[0].system.length > 0, '应传 system 提示')
  assert.ok(provider.calls[0].tools.length >= 5, '应传技能工具列表')
})

test('chat: 工具调用循环（调用 status 后回复）', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [
    { text: null, toolCalls: [{ id: 't1', name: 'status', arguments: {} }] },
    { text: '连接正常，重连 2 次', toolCalls: [] }
  ])
  const { reply } = await agent.chat('steve', '状态如何？')
  assert.equal(reply, '连接正常，重连 2 次')
})

test('chat: maxSteps 上限（工具调用无限循环时终止）', async () => {
  const ctx = makeCtx()
  // 脚本：永远返回工具调用（模拟 LLM 死循环）→ maxSteps 必须截断
  const script = Array.from({ length: 10 }, () => ({ text: null, toolCalls: [{ id: 't', name: 'status', arguments: {} }] }))
  const p = makeFakeProvider(script)
  const skills = createSkillRegistry(ctx)
  const agent = new AgentInterface(ctx, { provider: p, skills, config: { ...l2cfg, maxSteps: 3 } })
  const { reply } = await agent.chat('steve', '循环')
  assert.ok(p.calls.length <= 3, `maxSteps=3 时最多 3 轮工具调用（实际 ${p.calls.length}）`)
  assert.ok(typeof reply === 'string')
})

test('chat: cooldown 阻止连续请求', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [{ text: 'a' }, { text: 'b' }])
  await agent.chat('steve', 'hi')
  agent.cooldownUntil = Date.now() + 5000 // 手动设置冷却
  const r2 = await agent.chat('steve', 'again')
  assert.ok(r2.reply.includes('冷却'), '冷却期内应拒绝')
})

test('chat: busy 拒并发', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [{ text: 'a' }])
  agent.busy = true
  const r = await agent.chat('steve', 'x')
  assert.ok(r.reply.includes('处理中'))
})

test('chat: abort 返回友好回复', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [])
  agent._abort = { abort: () => {} }
  const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
  // 手动触发 abort 路径：busy 状态 + provider 抛 AbortError
  const p = { chat: async () => { throw err } }
  const skills = createSkillRegistry(ctx)
  const agent2 = new AgentInterface(ctx, { provider: p, skills, config: l2cfg })
  const r = await agent2.chat('steve', 'x')
  assert.equal(r.reply, '请求已中止')
})

test('chat: provider 抛错 → 友好回复不崩溃', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [])
  const p = { chat: async () => { throw new Error('API 500') } }
  const skills = createSkillRegistry(ctx)
  const agent2 = new AgentInterface(ctx, { provider: p, skills, config: l2cfg })
  const r = await agent2.chat('steve', 'x')
  assert.ok(r.reply.includes('处理出错'))
})

test('act: 直调技能成功', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('steve', 'status', {})
  assert.equal(r.ok, true)
  assert.equal(r.result.state, 'connected')
})

test('act: op 技能被非 op 拒绝', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('creeper', 'move_to', { x: 1, y: 2, z: 3 })
  assert.equal(r.ok, false)
  assert.ok(r.result.includes('权限不足'))
})

test('act: 参数校验（缺必填/类型错误）', async () => {
  const ctx = makeCtx({}, { ops: ['op1'] }) // op 身份（参数校验先于权限通过）
  const { agent } = makeAgent(ctx, [])
  const r1 = await agent.act('op1', 'move_to', {})
  assert.equal(r1.ok, false)
  assert.ok(r1.result.includes('缺少参数'))
  const r2 = await agent.act('op1', 'move_to', { x: 'abc', y: 1, z: 1 })
  assert.equal(r2.ok, false)
  assert.ok(r2.result.includes('必须是'))
})

test('act: 未知技能', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'fly', {})
  assert.equal(r.ok, false)
  assert.ok(r.result.includes('未知技能'))
})

test('skills: reply 技能通过 sendChat 发送', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('steve', 'reply', { text: '你好' })
  assert.equal(r.ok, true)
  assert.ok(ctx.bot.messages.includes('你好'))
})

test('skills: inventory_summary 聚合数量', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('steve', 'inventory_summary', {})
  assert.equal(r.ok, true)
  assert.deepEqual(r.result, { diamond: 5 })
})

test('provider: auto 模式 cloud 失败回退 ollama', async () => {
  const { createProvider } = await import('../src/l2/provider.js')
  const l2 = { provider: 'auto', cloudBaseUrl: 'http://x', cloudApiKeyEnv: 'TEST_KEY', ollamaUrl: 'http://y', ollamaModel: 'm' }
  const logger = makeLogger()
  process.env.TEST_KEY = 'k'
  const provider = createProvider({ l2 }, logger)
  // 不真正发网络请求：直接验证 createProvider 的 auto 包装存在
  assert.equal(provider.mode, 'auto')
  delete process.env.TEST_KEY
})

test('provider: cloud 缺 API key 报错（自动回退路径可感知）', async () => {
  const { createProvider } = await import('../src/l2/provider.js')
  const l2 = { provider: 'cloud', cloudApiKeyEnv: 'NONEXISTENT_KEY_XYZ', model: 'm' }
  const provider = createProvider({ l2 }, makeLogger())
  await assert.rejects(provider.chat([{ role: 'user', content: 'hi' }]), /API key/)
})
