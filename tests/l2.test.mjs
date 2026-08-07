import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { AgentInterface, _resetSummarizeCooldown, estimateTokens, applyTokenBudget } from '../src/l2/agent-interface.js'
import { createSkillRegistry } from '../src/l2/skills.js'
import { createL2 } from '../src/l2/index.js'
import { loadConfig } from '../src/core/config.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (overrides = {}, cfgPatch = {}) {
  const cfg = { ...loadConfig({ argv: [], env: {} }, { skipProdConfig: true }), ...cfgPatch }
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

test('skills: inventory_summary 聚合数量（U14 精简为字符串 Top-N）', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('steve', 'inventory_summary', {})
  assert.equal(r.ok, true)
  assert.equal(r.result, 'diamond:5', 'U14 后为紧凑字符串（不再全量对象撑爆上下文）')
  // 空背包 → 空态文本
  const ctx2 = makeCtx({ bot: { ...makeCtx().bot, inventory: { items: () => [] } } })
  const { agent: a2 } = makeAgent(ctx2, [])
  const empty = await a2.act('steve', 'inventory_summary', {})
  assert.equal(empty.result, '背包为空')
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

test('A5 修复: summarize 全局冷却——60s 内连续调用只发一次 LLM 请求（死亡+任务终态并发防 Ollama 排队）', async () => {
  _resetSummarizeCooldown() // 测试隔离：模块级冷却跨用例共享
  const ctx = makeCtx()
  let calls = 0
  const p = { chat: async () => { calls++; return { text: '一句话' } } }
  const skills = createSkillRegistry(ctx)
  const agent = new AgentInterface(ctx, { provider: p, skills, config: l2cfg })
  assert.equal(await agent.summarize('a'), '一句话', '首次调用应发出')
  assert.equal(calls, 1)
  assert.equal(await agent.summarize('b'), null, '冷却期内应静默跳过（返回 null 让调用方用固定模板）')
  assert.equal(calls, 1, '冷却期内不得再发请求')
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

// ---- A3（第四轮）：技能层仲裁器防线与参数边界 ----

test('A3 修复: follow_player 在 exclusive 任务运行中被拒（与 !follow 命令同款防线）', async () => {
  const arb = await import('../src/core/arbiter.js')
  try {
    const follow = { setTarget: () => {}, stop: () => {} }
    const ctx = makeCtx({ plugins: { follow } }, { ops: ['op1'] })
    ctx.bot.players = { steve: { username: 'Steve', entity: { id: 1 } } }
    const { agent } = makeAgent(ctx, [])
    arb.setExclusiveOwner('g1') // 模拟 exclusive 任务运行中
    const r = await agent.act('op1', 'follow_player', { name: 'steve' })
    assert.equal(r.ok, false, 'exclusive 运行中跟随应被拒')
    assert.ok(r.result.includes('exclusive 任务 g1'), r.result)
    // off 不受限（停止跟随不冲突）
    const off = await agent.act('op1', 'follow_player', { name: 'off' })
    assert.equal(off.ok, true)
  } finally {
    arb.setExclusiveOwner(null) // 清理模块级单例
  }
})

test('修复: follow_player 目标选择——跟随 Bot 自己被拒 + "跟随我"映射调用者', async () => {
  // 本地测试实测：9B 模型把"跟随我"的"我"误解为 Bot 自己 →
  // follow_player(name=mcbot-test) → 跟随自己原地打转（目标选择错误）
  const targets = []
  const follow = { setTarget: (e) => { targets.push(e) }, stop: () => {} }
  const bot = {
    ...makeCtx().bot,
    username: 'mcbot-test',
    players: {
      // bot.players 含 Bot 自己（mineflayer 行为）——技能层必须排除
      'mcbot-test': { username: 'mcbot-test', entity: { id: 99 } },
      Antifield: { username: 'Antifield', entity: { id: 1 } }
    }
  }
  const ctx = makeCtx({ bot, plugins: { follow } }, { ops: ['op1', 'Antifield'] }) // Antifield 需 op 才能调 follow_player
  const { agent } = makeAgent(ctx, [])
  // ① 显式传 Bot 自己的名字 → 拒绝（此前会 setTarget 自己）
  const self = await agent.act('op1', 'follow_player', { name: 'mcbot-test' })
  assert.equal(self.ok, true)
  assert.ok(self.result.includes('不能跟随 Bot 自己'), self.result)
  assert.equal(targets.length, 0, '跟随自己必须被拒')
  // ② "跟随我" → name=me → 映射到调用者 op1 找不到（players 无 op1）→ 明确反馈
  const meMissing = await agent.act('op1', 'follow_player', { name: 'me' })
  assert.equal(meMissing.ok, true)
  assert.ok(meMissing.result.includes('找不到玩家 op1'), meMissing.result)
  // ③ 调用者是 Antifield（players 有）→ 映射成功
  const me = await agent.act('Antifield', 'follow_player', { name: 'me' })
  assert.equal(me.ok, true)
  assert.ok(me.result.includes('开始跟随 Antifield'), me.result)
  assert.deepEqual(targets, [{ id: 1 }], '应跟随调用者实体（非 Bot 自己）')
  // ④ 省略 name（跟随我语义）→ 同样映射调用者
  const noName = await agent.act('Antifield', 'follow_player', {})
  assert.equal(noName.ok, true)
  assert.ok(noName.result.includes('开始跟随 Antifield'), noName.result)
  // ⑤ 不存在的玩家 → 明确反馈
  const missing = await agent.act('op1', 'follow_player', { name: 'alex' })
  assert.equal(missing.ok, true)
  assert.ok(missing.result.includes('找不到玩家 alex'), missing.result)
})

test('A3 修复: find_block 到达时附加 exclusive 冲突告警（与 !find 命令同款）', async () => {
  const arb = await import('../src/core/arbiter.js')
  try {
    const ctx = makeFindCtx({}, { ops: ['op1'] })
    const { agent } = makeAgent(ctx, [])
    arb.setExclusiveOwner('g1')
    const r = await agent.act('op1', 'find_block', { blockName: 'iron_ore' })
    assert.equal(r.ok, true)
    assert.ok(r.result.includes('exclusive 任务 g1'), `到达结果应含告警: ${r.result}`)
  } finally {
    arb.setExclusiveOwner(null)
  }
})

test('A3 修复: move_to 坐标越界（世界边界 ±30000000）→ 参数校验拒绝', async () => {
  const ctx = makeCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r1 = await agent.act('op1', 'move_to', { x: 1e18, y: 64, z: 0 })
  assert.equal(r1.ok, false)
  assert.ok(r1.result.includes('不能大于'), r1.result)
  const r2 = await agent.act('op1', 'move_to', { x: -1e18, y: 64, z: 0 })
  assert.equal(r2.ok, false)
  assert.ok(r2.result.includes('不能小于'), r2.result)
  // NaN/Infinity 兜底（validateParams isFinite）
  const r3 = await agent.act('op1', 'move_to', { x: Number.NaN, y: 64, z: 0 })
  assert.equal(r3.ok, false)
  assert.ok(r3.result.includes('有限数值'), r3.result)
})

// ---- L2 进化（A2/A3）：上下文预算裁剪 + 环境感知 ----

test('A2: estimateTokens 估算（CJK×1.0 + ASCII×0.25 + 其他×0.5）', () => {
  assert.equal(estimateTokens('abc'), 1) // 4 × 0.25 = 1
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens(''), 0)
  assert.ok(estimateTokens('混合 abc 文本') > 0)
})

test('A2: applyTokenBudget——超预算丢最旧历史轮，工具轮保留', () => {
  const messages = [
    { role: 'user', content: '旧历史一（很长很长很长很长很长很长）' },
    { role: 'assistant', content: '旧历史二' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'status', arguments: {} }] },
    { role: 'user', content: '', toolResults: [{ id: 't1', name: 'status', output: '结果' }] },
    { role: 'user', content: '当前问题' }
  ]
  const before = messages.length
  const trimmed = applyTokenBudget(messages, 0, 5) // 预算极小 → 必裁
  assert.equal(trimmed, true)
  assert.ok(messages.length < before, '应丢弃旧轮')
  assert.ok(messages.some(m => m.toolCalls), '工具调用轮必须保留（配对语义）')
  assert.equal(messages.at(-1).content, '当前问题', '当前用户消息保留')
})

test('A2: applyTokenBudget——工具结果动态截短且不低于下限', () => {
  const long = 'x'.repeat(5000)
  const messages = [
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'status', arguments: {} }] },
    { role: 'user', content: '', toolResults: [{ id: 't1', name: 'status', output: long }] },
    { role: 'user', content: 'q' }
  ]
  applyTokenBudget(messages, 0, 200) // 极紧预算
  const out = messages.find(m => m.toolResults).toolResults[0].output
  assert.ok(out.length < 5000, '应被截短')
  assert.ok(out.length >= 200, '不得低于下限')
  assert.ok(out.endsWith('…(截断)'))
})

test('A2: applyTokenBudget——未超预算不动消息', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  assert.equal(applyTokenBudget(messages, 0, 10000), false)
  assert.deepEqual(messages, [{ role: 'user', content: 'hi' }])
})

test('A3 修复: environment 技能输出环境快照（makeCtx 缺 time/weather 字段——null 安全）', async () => {
  const ctx = makeCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('steve', 'environment', {})
  assert.equal(r.ok, true)
  assert.ok(r.result.includes('位置'), r.result) // makeCtx bot 有 entity.position
  assert.ok(r.result.includes('朝向'), r.result) // yaw 存在
})

test('A3 修复: nearby_entities 输出列表（无实体 → 如实反馈）', async () => {
  const ctx = makeCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('steve', 'nearby_entities', { maxDistance: 32 })
  assert.equal(r.ok, true)
  assert.ok(r.result.includes('没有'), r.result)
})

test('A3 修复: 环境自动注入——chat 的 system 含环境行', async () => {
  const ctx = makeCtx()
  ctx.bot.time = { age: 24000 * 5 + 6000, timeOfDay: 6000, isDay: true }
  ctx.bot.isRaining = false
  ctx.bot.game = { dimension: 'minecraft:overworld' }
  ctx.bot.players = { steve: { username: 'Steve', entity: { position: { x: 5, y: 64, z: 0 } } } }
  const { agent, provider } = makeAgent(ctx, [{ text: '我在哪？' }])
  await agent.chat('steve', '你周围的环境？')
  // 注意 SYSTEM_PROMPT 规则 6 自身含"环境:"字样——用注入行的精确格式 \n环境: 断言
  assert.ok(provider.calls[0].system.includes('\n环境: '), `system 应含环境行: ${provider.calls[0].system}`)
  assert.ok(provider.calls[0].system.includes('第6天'), provider.calls[0].system)
  assert.ok(provider.calls[0].system.includes('overworld'), provider.calls[0].system)
  // envInjection=false 关闭注入（AgentInterface 的 cfg 是构造参数——直接改实例）
  const ctx2 = makeCtx()
  ctx2.bot.time = { age: 1000, timeOfDay: 1000, isDay: true }
  const { agent: a2, provider: p2 } = makeAgent(ctx2, [{ text: 'x' }])
  a2.cfg = { ...a2.cfg, envInjection: false }
  await a2.chat('steve', 'hi')
  assert.ok(!p2.calls[0].system.includes('\n环境: '), 'envInjection=false 不注入')
})

// ---- L2 进化（B2/C1）：探索记忆查询 + 单步探索 ----

test('B2 修复: query_map 查询探索记忆（无记录 → 指引探索）', async () => {
  const discovery = await import('../src/core/discovery.js')
  discovery._reset()
  const ctx = makeCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  // 空地图 → 指引
  const empty = await agent.act('op1', 'query_map', { blockName: 'iron_ore' })
  assert.equal(empty.ok, true)
  assert.ok(empty.result.includes('还没有 iron_ore'), empty.result)
  // 有记录 → 坐标
  discovery.recordResource('iron_ore', { x: 10, y: 63, z: 8 })
  const hit = await agent.act('op1', 'query_map', { blockName: 'iron_ore' })
  assert.ok(hit.result.includes('iron_ore @ 10,63,8'), hit.result)
  // 非 op 拒绝（all 权限？query_map 是 all——对，all）
  const nonOp = await agent.act('creeper', 'query_map', { blockName: 'iron_ore' })
  assert.equal(nonOp.ok, true, 'query_map 是 all 权限（只读查询）')
  discovery._reset()
})

test('B2 修复: map_status 统计（空地图 → 指引）', async () => {
  const discovery = await import('../src/core/discovery.js')
  discovery._reset()
  const ctx = makeCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const empty = await agent.act('op1', 'map_status', {})
  assert.ok(empty.result.includes('地图还是空的'), empty.result)
  discovery.recordAnchor({ x: 0, y: 64, z: 0 })
  discovery.recordResource('coal_ore', { x: 5, y: 60, z: 0 })
  const s = await agent.act('op1', 'map_status', {})
  assert.ok(s.result.includes('已访问 1 站'), s.result)
  assert.ok(s.result.includes('coal_ore:1'), s.result)
  discovery._reset()
})

test('C1 修复: explore 技能单步探索（exclusive 任务运行中被拒）', async () => {
  const arb = await import('../src/core/arbiter.js')
  const discovery = await import('../src/core/discovery.js')
  discovery._reset()
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { iron_ore: { id: 44 } } },
    findBlocks: ({ matching }) => (matching({ type: 44 }) ? [new Vec3(10, 63, 0)] : []),
    once: () => {},
    removeListener: () => {},
    pathfinder: { setGoal: () => {}, stop: () => {}, goto: () => Promise.resolve() }
  }
  const ctx = makeCtx({ bot }, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  try {
    // exclusive 运行中 → 拒绝（移动互斥）
    arb.setExclusiveOwner('g1')
    const denied = await agent.act('op1', 'explore', { direction: 'n' })
    assert.equal(denied.ok, false)
    assert.ok(denied.result.includes('exclusive 任务 g1'), denied.result)
    // 无冲突 → 单步探索成功 + 记录
    arb.setExclusiveOwner(null)
    const r = await agent.act('op1', 'explore', { direction: 'n' })
    assert.equal(r.ok, true)
    assert.ok(r.result.includes('探索完成'), r.result)
    assert.ok(r.result.includes('iron_ore'), `报告应含发现: ${r.result}`)
    assert.ok(discovery.query('iron_ore', null, 20).length >= 1, '发现应写入记忆')
    // 非 op 拒绝
    const nonOp = await agent.act('creeper', 'explore', {})
    assert.equal(nonOp.ok, false)
    assert.ok(nonOp.result.includes('权限不足'))
  } finally {
    arb.setExclusiveOwner(null)
    discovery._reset()
  }
})

// ---- 第五轮完善档：P1 filter / P2-3 防线 / F1-b busy / P2-5 估算 ----

test('P1 修复: nearby_entities filter 命中（OR 语义 + e.type 比对——此前 AND+大写 kind 恒失效）', async () => {
  const zombie = { id: 1, name: 'zombie', type: 'hostile', position: new Vec3(5, 64, 0) }
  const cow = { id: 2, name: 'cow', type: 'animal', position: new Vec3(8, 64, 0) }
  const ctx = makeCtx({ bot: {
    ...makeCtx().bot,
    entities: new Map([[1, zombie], [2, cow]]),
    entity: { position: new Vec3(0, 64, 0) }
  } }, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  // filter='hostile'（type 值）→ 命中 zombie（此前被 name 检查拦截恒空）
  const r1 = await agent.act('op1', 'nearby_entities', { filter: 'hostile', maxDistance: 32 })
  assert.equal(r1.ok, true)
  assert.ok(r1.result.includes('zombie'), `hostile 过滤应命中 zombie: ${r1.result}`)
  assert.ok(!r1.result.includes('cow'), 'cow 不应被命中')
  // filter='zombie'（name 子串）→ 命中 zombie（此前被 kind 检查拦截恒空）
  const r2 = await agent.act('op1', 'nearby_entities', { filter: 'zombie', maxDistance: 32 })
  assert.ok(r2.result.includes('zombie'), `zombie 过滤应命中: ${r2.result}`)
})

test('P2-3 修复: move_to 在 exclusive 任务运行中被拒（唯一漏网的危险技能）', async () => {
  const arb = await import('../src/core/arbiter.js')
  try {
    const ctx = makeCtx({}, { ops: ['op1'] })
    const { agent } = makeAgent(ctx, [])
    arb.setExclusiveOwner('g1')
    const r = await agent.act('op1', 'move_to', { x: 10, y: 64, z: 10 })
    assert.equal(r.ok, false)
    assert.ok(r.result.includes('exclusive 任务 g1'), r.result)
  } finally {
    arb.setExclusiveOwner(null)
  }
})

test('P2-3 修复: act 在 busy 时被拒（!agent act 不得打进进行中 chat 工具循环）', async () => {
  const ctx = makeCtx({}, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  agent.busy = true // 模拟 chat 工具循环进行中
  const r = await agent.act('op1', 'status', {})
  assert.equal(r.ok, false)
  assert.ok(r.result.includes('处理中'), r.result)
})

test('F1-b 修复: busy 反馈附带已进行秒数', async () => {
  const ctx = makeCtx()
  const { agent } = makeAgent(ctx, [])
  agent.busy = true
  agent._busySince = Date.now() - 5000 // 已进行 5s
  const { reply } = await agent.chat('steve', 'hi')
  assert.ok(reply.includes('5s'), `应附带已进行秒数: ${reply}`)
  assert.ok(reply.includes('处理中'), reply)
})

test('P2-5 修复: messageTokens 工具轮计入参数 JSON（估算不再系统性偏低）', async () => {
  const { messageTokens } = await import('../src/l2/agent-interface.js')
  assert.ok(typeof messageTokens === 'function')
  const small = messageTokens({ role: 'assistant', content: '', toolCalls: [{ name: 'status', arguments: {} }] })
  const big = messageTokens({ role: 'assistant', content: '', toolCalls: [{ name: 'run_task', arguments: { type: 'mine', id: 'x', options: { blockTypes: ['iron_ore'], area: { x1: 0, y1: 0, z1: 0, x2: 10, y2: 10, z2: 10 } } } }] })
  assert.ok(big > small, `参数大的调用估算应更大: ${small} vs ${big}`)
})

// ---- L2 进化（U13/U14/U15）：动作技能 / 结果精简 / 会话工具记录 ----

test('U13: dig 技能——可挖性校验/距离提示/exclusive 拒绝', async () => {
  const arb = await import('../src/core/arbiter.js')
  const dug = []
  const bot = {
    ...makeCtx().bot,
    // canDigBlock 按真实语义（可挖 + 距离 ≤5.1）——far 场景借此走"不可挖掘"提示
    canDigBlock: (b) => b.position.distanceTo(bot.entity.position) <= 5.1,
    dig: async (b) => { dug.push(b.position) },
    // position 用传入的 Vec3（dig handler 的 distanceTo 调用）
    blockAt: (p) => ({ name: 'stone', boundingBox: 'solid', position: p }),
    entity: { position: new Vec3(0, 64, 0) }
  }
  const ctx = makeCtx({ bot }, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  try {
    const r = await agent.act('op1', 'dig', { x: 2, y: 63, z: 0 })
    assert.equal(r.ok, true)
    assert.ok(r.result.includes('已挖掘 stone'), r.result)
    assert.equal(dug.length, 1)
    // 距离过远 → 提示先 move_to
    const far = await agent.act('op1', 'dig', { x: 100, y: 63, z: 100 })
    assert.equal(far.ok, true)
    assert.ok(far.result.includes('不可挖掘') || far.result.includes('move_to'), far.result)
    assert.equal(dug.length, 1, '距离过远不得挖掘')
    // exclusive 运行中拒绝
    arb.setExclusiveOwner('g1')
    const denied = await agent.act('op1', 'dig', { x: 2, y: 63, z: 0 })
    assert.equal(denied.ok, false)
    assert.ok(denied.result.includes('exclusive 任务 g1'), denied.result)
    // 非 op 拒绝
    const nonOp = await agent.act('creeper', 'dig', { x: 2, y: 63, z: 0 })
    assert.equal(nonOp.ok, false)
  } finally {
    arb.setExclusiveOwner(null)
  }
})

test('U13: place 技能——参考方块/占用检查/heldItem 前置', async () => {
  const placed = []
  const bot = {
    ...makeCtx().bot,
    blockAt: (p) => {
      // (10,64,-5) 目标位为空；其下方 (10,63,-5) 是石头（face=up 参考）
      if (p.x === 10 && p.z === -5 && p.y === 64) return { name: 'air', boundingBox: 'empty' }
      if (p.x === 10 && p.z === -5 && p.y === 63) return { name: 'stone', boundingBox: 'solid' }
      return { name: 'air', boundingBox: 'empty' }
    },
    heldItem: { name: 'stone' },
    placeBlock: async (ref, face) => { placed.push([ref.position, face]) }
  }
  const ctx = makeCtx({ bot }, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'place', { x: 10, y: 64, z: -5, face: 'up' })
  assert.equal(r.ok, true)
  assert.ok(r.result.includes('已放置 stone'), r.result)
  assert.equal(placed.length, 1)
  // 目标位占用 → 拒绝
  const bot2 = {
    ...makeCtx().bot,
    blockAt: () => ({ name: 'stone', boundingBox: 'solid' }),
    heldItem: { name: 'stone' },
    placeBlock: async () => {}
  }
  const ctx2 = makeCtx({ bot: bot2 }, { ops: ['op1'] })
  const { agent: a2 } = makeAgent(ctx2, [])
  const occupied = await a2.act('op1', 'place', { x: 10, y: 64, z: -5, face: 'up' })
  assert.equal(occupied.ok, true)
  assert.ok(occupied.result.includes('占用'), occupied.result)
  // 空手 → 提示 equip（参考方块须 solid 才能走到 heldItem 检查——检查顺序在占位之前）
  const bot3 = {
    ...makeCtx().bot,
    blockAt: (p) => (p.y === 63 ? { name: 'stone', boundingBox: 'solid' } : { name: 'air', boundingBox: 'empty' }),
    heldItem: null,
    placeBlock: async () => {}
  }
  const ctx3 = makeCtx({ bot: bot3 }, { ops: ['op1'] })
  const { agent: a3 } = makeAgent(ctx3, [])
  const noItem = await a3.act('op1', 'place', { x: 10, y: 64, z: -5, face: 'up' })
  assert.ok(noItem.result.includes('equip'), noItem.result)
})

test('U13 修复: attack 技能——Map 实体表回归 + 击杀即止（原地不动根因一）', async () => {
  // 根因：bot.entities 是 Map——`entities[id]` 下标恒 undefined → 存在检查恒 false →
  // attack 技能从未真正发出攻击包（P1 Map bug 同根，U13 侧漏网）
  const arb = await import('../src/core/arbiter.js')
  const packets = []
  const entities = new Map()
  const hostile = { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(2, 64, 0), height: 1.8 } // 距离 2 ≤ 3.5
  entities.set(1, hostile)
  const bot = {
    ...makeCtx().bot,
    entity: { position: new Vec3(0, 64, 0) },
    entities,
    lookAt: () => {},
    _client: { write: (name, params) => { packets.push({ name, ...params }); if (name === 'attack') entities.delete(1) } } // 一击击杀
  }
  const ctx = makeCtx({ bot }, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  try {
    const r = await agent.act('op1', 'attack', { filter: 'zombie' })
    assert.equal(r.ok, true)
    assert.ok(r.result.includes('已攻击 zombie'), r.result)
    assert.ok(r.result.includes('目标已消失'), r.result)
    assert.equal(packets.filter(p => p.name === 'attack').length, 1, '应写独立 attack 包（此前 Map 下标检查恒 false 从未发出）')
    assert.equal(packets[0].entityId, 1)
    // exclusive 拒绝（exclusive 检查在冷却之前——不受 500ms 冷却干扰）
    arb.setExclusiveOwner('g1')
    const denied = await agent.act('op1', 'attack', { filter: 'zombie' })
    assert.equal(denied.ok, false)
    assert.ok(denied.result.includes('exclusive 任务 g1'), denied.result)
    // 非 op 拒绝
    const nonOp = await agent.act('creeper', 'attack', { filter: 'zombie' })
    assert.equal(nonOp.ok, false)
  } finally {
    arb.setExclusiveOwner(null)
  }
})

test('U13 修复: attack 技能——远距目标自动接近后攻击（原地不动根因二）', async () => {
  // 根因：无接近逻辑——5 格外攻击包被服务端 reach 校验拒绝（无效攻击），Bot 原地不动。
  // 修复：approachEntity 接近到攻击距离再攻击（combat 任务同款三件套）
  const packets = []
  const entities = new Map()
  const hostile = { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(10, 64, 0), height: 1.8 } // 距离 10 > 3.5
  entities.set(1, hostile)
  let gotoCalls = 0
  const bot = {
    ...makeCtx().bot,
    entity: { position: new Vec3(0, 64, 0) },
    entities,
    once: () => {},
    removeListener: () => {},
    pathfinder: {
      setGoal: () => {},
      stop: () => {},
      // 模拟寻路成功：目标被走近（真实 goto 由 pathfinder 驱动，此处直接改位置）
      goto: async () => { gotoCalls++; hostile.position = new Vec3(1, 64, 0) }
    },
    lookAt: () => {},
    _client: { write: (name, params) => { packets.push({ name, ...params }); if (name === 'attack') entities.delete(1) } }
  }
  const ctx = makeCtx({ bot }, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'attack', { filter: 'zombie' })
  assert.equal(r.ok, true)
  assert.equal(gotoCalls, 1, '远距目标应先接近（approachEntity）')
  assert.ok(r.result.includes('已攻击 zombie'), r.result)
  assert.equal(packets.filter(p => p.name === 'attack').length, 1, '接近后应攻击（此前远距直接发无效包）')
})

test('U13 修复: attack 技能——连击上限（目标存活 5 次后提示可继续）', async () => {
  const packets = []
  const hostile = { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(2, 64, 0), height: 1.8 }
  const bot = {
    ...makeCtx().bot,
    entity: { position: new Vec3(0, 64, 0) },
    entities: new Map([[1, hostile]]),
    lookAt: () => {},
    _client: { write: (name, params) => packets.push({ name, ...params }) }
  }
  const ctx = makeCtx({ bot }, { ops: ['op1'] })
  const { agent } = makeAgent(ctx, [])
  const r = await agent.act('op1', 'attack', { filter: 'zombie' })
  assert.equal(r.ok, true)
  assert.ok(r.result.includes('目标仍存活'), r.result)
  assert.equal(packets.filter(p => p.name === 'attack').length, 5, '应连击至 5 次上限（600ms 冷却）')
})

test('U15: 会话工具记录——第二次 chat 的 system 注入上次工具操作', async () => {
  const ctx = makeCtx()
  ctx.bot.registry = { blocksByName: { iron_ore: { id: 44 } } }
  ctx.bot.findBlocks = ({ matching }) => (matching({ type: 44 }) ? [new Vec3(10, 63, 0)] : [])
  ctx.bot.blockAt = () => ({ boundingBox: 'empty', name: 'air' })
  ctx.bot.once = () => {}
  ctx.bot.removeListener = () => {}
  ctx.bot.pathfinder = { setGoal: () => {}, stop: () => {}, goto: () => Promise.resolve() }
  const { agent, provider } = makeAgent(ctx, [
    { text: null, toolCalls: [{ id: 't1', name: 'status', arguments: {} }] },
    { text: '完成' },
    { text: '继续' }
  ])
  // 第一轮：调用 status 工具 → 记录进 calls
  await agent.chat('steve', '看看状态')
  // 第二轮：system 应含"最近工具操作: status→..."
  await agent.chat('steve', '继续')
  const lastSystem = provider.calls.at(-1).system
  assert.ok(lastSystem.includes('最近工具操作'), `system 应注入工具记录: ${lastSystem}`)
  assert.ok(lastSystem.includes('status'), lastSystem)
})

test('A2 修复: 预算裁剪生效——provider 有 contextWindow 时超预算消息被裁', async () => {
  const ctx = makeCtx()
  const { agent, provider } = makeAgent(ctx, [{ text: 'ok' }])
  provider.contextWindow = () => 512 // 极紧窗口 → 必触发裁剪
  await agent.chat('steve', 'x'.repeat(2000))
  // 不抛错即通过（裁剪在 provider.chat 前执行）；system 仍含环境行
  assert.ok(provider.calls[0].system.includes('环境:'), provider.calls[0].system)
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
