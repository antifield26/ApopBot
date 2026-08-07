import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
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
  agent.cooldowns.set('steve', Date.now() + 5000) // 手动设置冷却
  const r2 = await agent.chat('steve', 'again')
  assert.ok(r2.reply.includes('冷却'), '冷却期内应拒绝')
})

test('C7/T 修复：冷却按玩家——一个玩家的冷却不挡其他玩家', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [{ text: 'a' }, { text: 'b' }])
  await agent.chat('steve', 'hi')
  agent.cooldowns.set('steve', Date.now() + 5000)
  const r1 = await agent.chat('steve', 'again')
  assert.ok(r1.reply.includes('冷却'), '同玩家冷却期内应拒绝')
  const r2 = await agent.chat('alex', 'hi2')
  assert.ok(!r2.reply.includes('冷却'), '其他玩家不受全局冷却影响')
  assert.equal(r2.reply, 'b')
})

test('C7/U 修复：maxSteps 耗尽 → 显式文案（不再返回无回复占位污染会话）', async () => {
  const ctx = makeCtx()
  const script = Array.from({ length: 10 }, () => ({ text: null, toolCalls: [{ id: 't', name: 'status', arguments: {} }] }))
  const p = makeFakeProvider(script)
  const skills = createSkillRegistry(ctx)
  const agent = new AgentInterface(ctx, { provider: p, skills, config: { ...l2cfg, maxSteps: 3 } })
  const { reply } = await agent.chat('steve', '循环')
  assert.ok(reply.includes('最大工具步数'), reply)
})

test('C7/T 修复：会话 LRU 上限——超过 32 个玩家驱逐最久未访问（不无限增长）', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, Array.from({ length: 40 }, () => ({ text: 'r', toolCalls: [] })))
  for (let i = 0; i < 35; i++) await agent.chat(`user${i}`, 'hi')
  assert.ok(agent.sessionCount() <= 32, `会话数应封顶 32（实际 ${agent.sessionCount()}）`)
  for (let i = 0; i < 35; i++) agent.reset(`user${i}`) // 清理模块级 Map
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

test('chat: system prompt 注入调用者身份（op 判定——修复"需要验证 op 身份"）', async () => {
  const ctx = makeCtx({}, { ops: ['steve'] })
  const { agent, provider } = makeAgent(ctx, [])
  await agent.chat('steve', 'hi')
  assert.ok(provider.calls[0].system.includes('steve'), 'system 应包含调用者名')
  assert.ok(provider.calls[0].system.includes('op 白名单成员'), 'op 玩家应标注可执行危险操作')
})

test('chat: 非 op 调用者身份注入（标注受限）', async () => {
  const ctx = makeCtx({}, { ops: ['steve'] })
  const { agent, provider } = makeAgent(ctx, [])
  await agent.chat('alex', 'hi')
  assert.ok(provider.calls[0].system.includes('alex'))
  assert.ok(provider.calls[0].system.includes('普通玩家'), '非 op 应标注危险操作受限')
  assert.ok(!provider.calls[0].system.includes('op 白名单成员'))
})

test('P1-7 修复：follow_player 插件未启用 → ok:false（不再假成功误导 LLM）', async () => {
  const ctx = makeCtx({}, { ops: ['op1'] }) // makeCtx 默认 plugins: {}（follow 未启用）
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'follow_player', { name: 'steve' })
  assert.equal(r.ok, false)
  assert.ok(r.result.includes('插件未启用'), `应明确报插件未启用: ${r.result}`)
})

// ---- U2：会话记忆（模块级 Map，跨 agent 实例保留；!agent reset 清空）----

test('U2: 会话记忆——第二轮 chat 携带历史（user+assistant）', async () => {
  const ctx = makeCtx()
  const { agent, provider } = makeAgent(ctx, [
    { text: '第一次回复', toolCalls: [] },
    { text: '第二次回复', toolCalls: [] }
  ])
  agent.reset('mem1')
  await agent.chat('mem1', '你好')
  await agent.chat('mem1', '继续')
  const second = provider.calls[1].messages
  assert.ok(second.length >= 3, `第二轮应含历史+本轮（实际 ${second.length} 条）`)
  assert.ok(second.some(m => m.content === '你好'), '历史 user 轮应携带')
  assert.ok(second.some(m => m.content === '第一次回复'), '历史 assistant 轮应携带')
  assert.equal(second.at(-1).content, '继续')
  agent.reset('mem1')
})

test('U2: 会话裁剪——超过上限只保留最近条数', async () => {
  const script = Array.from({ length: 7 }, (_, i) => ({ text: `r${i}`, toolCalls: [] }))
  const ctx = makeCtx()
  const { agent, provider } = makeAgent(ctx, script)
  agent.reset('mem2')
  for (let i = 0; i < 7; i++) await agent.chat('mem2', `q${i}`)
  const last = provider.calls[6].messages
  assert.ok(last.length <= 11, `历史上限 10 + 本轮 1（实际 ${last.length}）`)
  assert.ok(!last.some(m => m.content === 'q0'), '最早一轮应被裁剪')
  agent.reset('mem2')
})

test('U2: reset 清空会话；act 直调不污染会话', async () => {
  const ctx = makeCtx()
  const { agent, provider } = makeAgent(ctx, [
    { text: 'a', toolCalls: [] },
    { text: 'b', toolCalls: [] }
  ])
  agent.reset('mem3')
  await agent.chat('mem3', 'hi')
  await agent.act('mem3', 'status', {})
  agent.reset('mem3')
  await agent.chat('mem3', 'again')
  assert.equal(provider.calls[1].messages.length, 1, 'reset 后第二轮应只有本轮（act 不写入会话）')
  agent.reset('mem3')
})

test('U2: 会话跨 agent 实例保留（重连/热重载重建后记忆不丢）', async () => {
  const ctx = makeCtx()
  const a1 = makeAgent(ctx, [{ text: 'reply', toolCalls: [] }])
  a1.agent.reset('mem4')
  await a1.agent.chat('mem4', '记得这个')
  const a2 = makeAgent(ctx, [{ text: 'reply2', toolCalls: [] }]) // 模拟 rebuild：新实例
  await a2.agent.chat('mem4', '还记得吗')
  assert.ok(a2.provider.calls[0].messages.some(m => m.content === '记得这个'), '新实例应继承模块级会话')
  a2.agent.reset('mem4')
})

test('skills: run_task exclusive 排队时返回排队信息（不假成功）', async () => {
  const ctx = makeCtx({}, { ops: ['op1'] })
  ctx.tasks.getStatus = () => [{ id: 'g', state: 'created' }]
  ctx.tasks.isPendingExclusive = () => true
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'run_task', { type: 'combat', id: 'g' })
  assert.equal(r.ok, true)
  assert.ok(r.result.includes('排队中'), `排队时应如实告知 LLM: ${r.result}`)
})

// ---- U6：summarize（死亡/任务终态的一句话播报，无会话无工具循环）----

test('U6: summarize 单次 LLM 调用，不污染会话', async () => {
  const ctx = makeCtx()
  const { agent, provider } = makeAgent(ctx, [{ text: '被僵尸击杀', toolCalls: [] }])
  agent.reset('memx')
  const s = await agent.summarize('死亡播报')
  assert.equal(s, '被僵尸击杀')
  assert.equal(provider.calls.length, 1, '应为单次调用')
  // 不污染会话记忆
  await agent.chat('memx', 'hi')
  assert.equal(provider.calls[1].messages.length, 1, 'summarize 不应写入会话')
  agent.reset('memx')
})

test('U6: summarize 失败 → null（调用方回退固定模板，不抛错）', async () => {
  const ctx = makeCtx()
  const p = { chat: async () => { throw new Error('API down') } }
  const skills = createSkillRegistry(ctx)
  const agent = new AgentInterface(ctx, { provider: p, skills, config: l2cfg })
  assert.equal(await agent.summarize('x'), null)
})

test('U6: summarize 无 provider → null（零依赖路径）', async () => {
  const ctx = makeCtx()
  const skills = createSkillRegistry(ctx)
  const agent = new AgentInterface(ctx, { provider: null, skills, config: l2cfg })
  assert.equal(await agent.summarize('x'), null)
})

// ---- find_block 技能（L2 层 find 能力，与 !find 命令共享移动层）----

function makeFindCtx (overrides = {}, cfgPatch = {}) {
  const bot = {
    chat: () => {},
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    players: {},
    registry: { blocksByName: { iron_ore: { id: 44 }, bamboo: { id: 99 } } },
    // findSurfaceBlocks 的 isSurfaceAt 调 p.offset——必须返回 Vec3（findBlocks 真实语义）
    findBlocks: ({ matching }) => (matching({ type: 44 }) ? [new Vec3(10, 64, 0)] : []),
    blockAt: () => ({ boundingBox: 'empty', name: 'air' }),
    // C2 end-race 需要事件 API（本组测试不模拟断线，no-op 即可）
    once: () => {},
    removeListener: () => {},
    pathfinder: { setGoal: () => {}, stop: () => {}, goto: () => Promise.resolve() },
    ...(overrides.bot ?? {})
  }
  const ctx = makeCtx(overrides, cfgPatch)
  ctx.bot = bot
  return ctx
}

test('C8/W 修复：find_block 找到并到达 → 报告实际到达坐标（非欧氏最近候选）', async () => {
  const ctx = makeFindCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'find_block', { blockName: 'iron_ore' })
  assert.equal(r.ok, true)
  assert.ok(r.result.includes('已到达 iron_ore'), r.result)
  assert.ok(r.result.includes('0,64,0'), `应报实际到达点（bot 位置）: ${r.result}`)
})

test('skills: find_block 无候选 → 如实反馈', async () => {
  const ctx = makeFindCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'find_block', { blockName: 'bamboo' })
  assert.equal(r.ok, true)
  assert.ok(r.result.includes('没有暴露在地表的 bamboo'), r.result)
})

test('skills: find_block 未知方块 → ok:false', async () => {
  const ctx = makeFindCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'find_block', { blockName: 'not_a_block' })
  assert.equal(r.ok, false)
  assert.ok(r.result.includes('未知方块类型'))
})

test('skills: find_block 无法到达（NoPath）→ 如实反馈最近候选', async () => {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { iron_ore: { id: 44 } } },
    findBlocks: () => [new Vec3(10, 64, 0)],
    blockAt: () => ({ boundingBox: 'empty', name: 'air' }),
    once: () => {},
    removeListener: () => {},
    pathfinder: {
      setGoal: () => {}, stop: () => {},
      goto: () => Promise.reject(Object.assign(new Error('NoPath'), { name: 'NoPath' }))
    }
  }
  const ctx = makeCtx({ bot }, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'find_block', { blockName: 'iron_ore' })
  assert.equal(r.ok, true) // 技能 handler 返回文本（含失败信息），非抛错
  assert.ok(r.result.includes('无法到达'), r.result)
  assert.ok(r.result.includes('10,64,0'), r.result)
})

test('skills: find_block 非 op → 权限不足', async () => {
  const ctx = makeFindCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('creeper', 'find_block', { blockName: 'iron_ore' })
  assert.equal(r.ok, false)
  assert.ok(r.result.includes('权限不足'))
})

test('C5/G 修复：find_block maxDistance 越界（16-256 外）→ 参数校验拒绝（防主线程冻结）', async () => {
  const ctx = makeFindCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'find_block', { blockName: 'iron_ore', maxDistance: 100000 })
  assert.equal(r.ok, false)
  assert.ok(r.result.includes('不能大于'), r.result)
  const r2 = await agent.act('op1', 'find_block', { blockName: 'iron_ore', maxDistance: 5 })
  assert.equal(r2.ok, false)
  assert.ok(r2.result.includes('不能小于'), r2.result)
})
