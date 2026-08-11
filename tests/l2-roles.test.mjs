// 多Agent（单 bot 多角色）测试：createL2 角色注册表——缺省两角色/委托路由/
// 会话隔离/前缀剥离/旧 key 迁移/白名单/冷却/统计。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as discovery from '../src/core/discovery.js'
import { _resetSummarizeCooldown, _resetSessions } from '../src/l2/agent-interface.js'
import { createL2 } from '../src/l2/index.js'
import { createActionExecutor } from '../src/core/executor.js'
import { loadConfig } from '../src/core/config.js'

test.beforeEach(() => {
  discovery._reset()
  _resetSessions() // 模块级 SESSIONS 跨测试共享——残留历史会触发滚动摘要污染调用计数
})

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (overrides = {}, cfgPatch = {}) {
  const cfg = { ...loadConfig({ argv: [], env: {} }, { skipProdConfig: true }), ...cfgPatch }
  const tasks = { getStatus: () => [{ id: 'm1', state: 'running' }], addTask: () => {}, removeTask: async () => {} }
  const conn = { getStatus: () => ({ state: 'connected', reconnectCount: 2 }) }
  const bot = {
    chat () {},
    messages: [],
    inventory: { items: () => [{ name: 'diamond', count: 5 }] },
    players: {},
    entity: { position: { x: 1, y: 2, z: 3 }, health: 20, food: 20 },
    pathfinder: { setGoal: () => {} }
  }
  return { cfg, logger: makeLogger(), bot, tasks, conn, plugins: {}, ...overrides }
}

/** 可脚本化的 fake provider（共享实例——注册表角色共用同一 provider）。 */
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

/** 启用 l2 的 ctx + 注册表构造（注入 fake provider/executor）。 */
function makeRegistry (ctx, script, l2Patch = {}, extra = {}) {
  const provider = makeFakeProvider(script)
  const executor = createActionExecutor(ctx, { audit: null })
  const l2 = { enabled: true, provider: 'cloud', model: 'x', cooldownMs: 0, maxSteps: 5, ...l2Patch }
  const cfg = { ...ctx.cfg, l2 }
  const registry = createL2(cfg, ctx, { provider, executor, sessionStore: null, experience: null, ...extra })
  return { registry, provider, executor }
}

test('roles: 缺省配置 → primary + planner 两角色；enabled=false → null', () => {
  const ctx = makeCtx()
  const { registry } = makeRegistry(ctx, [])
  assert.ok(registry.primary, '应有 primary 角色')
  assert.ok(registry.planner, '应有 planner 角色（恒创建）')
  assert.equal(registry.get('primary'), registry.primary)
  assert.equal(registry.get('planner'), registry.planner)
  assert.equal(registry.get('不存在'), null)
  assert.equal(registry.all().length, 2)
  // enabled=false → null（零依赖路径不受 roles 影响）
  const ctx2 = makeCtx()
  assert.equal(createL2(ctx2.cfg, ctx2), null)
  // 自定义角色配置
  const ctx3 = makeCtx()
  const { registry: r3 } = makeRegistry(ctx3, [], { roles: [{ name: 'farmer', systemPrompt: '你是农场主' }] })
  assert.equal(r3.get('farmer').systemPrompt, '你是农场主')
  assert.equal(r3.all().length, 3)
})

test('roles: 注册表委托 primary——chat 走 primary 会话/人设', async () => {
  const ctx = makeCtx()
  const { registry, provider } = makeRegistry(ctx, [{ text: '你好，我是 Bot' }])
  const r = await registry.chat('steve', '介绍自己')
  assert.equal(r.reply, '你好，我是 Bot')
  assert.ok(provider.calls[0].system.includes('Bot 助手'), '委托 chat 用 primary 人设')
  // getGoal/setGoal/clearGoal 委托 primary
  registry.setGoal('steve', '建基地', ['砍树'])
  assert.equal(registry.getGoal('steve').text, '建基地')
  assert.ok(registry.clearGoal('steve'))
})

test('roles: onTaskCompleted 路由 planner——规划器人设+受限工具集，primary 会话不受影响', async () => {
  const ctx = makeCtx({}, { ops: ['steve'] })
  const { registry, provider } = makeRegistry(ctx, [
    // planner 脚本：先工具调用 start_task，然后收尾
    { text: '', toolCalls: [{ id: 't1', name: 'start_task', arguments: { type: 'chop', id: 'c1' } }] },
    { text: '下一步已启动', toolCalls: [] }
  ])
  registry.setGoal('steve', '砍树攒木头')
  // planner 角色冷却独立——primary 的 lastPlanAt 不影响 planner
  registry.planner._resetPlanCooldown()
  const ok = await registry.onTaskCompleted({ id: 'm1' })
  assert.equal(ok, true)
  const sys = provider.calls[0].system
  assert.ok(sys.includes('无人值守规划器'), '规划调用应带规划器人设（primary 的 chat 人设不同）')
  assert.ok(sys.includes('砍树攒木头'), '规划调用应含目标')
  const tools = provider.calls[0].tools.map(t => t.name)
  assert.ok(tools.includes('start_task'), '规划工具集含 start_task')
  assert.ok(!tools.includes('act'), '规划工具集不含 act')
  // 工具执行成功（权限按裸 user 'steve' 判定——前缀剥离生效）
  const execResult = registry.executor.lastResult ?? null
  assert.ok(execResult === null || execResult.ok !== false, 'start_task 未被前缀身份误拒')
})

test('roles: 会话隔离——primary:steve 与 planner:steve 独立', async () => {
  const ctx = makeCtx()
  const { registry, provider } = makeRegistry(ctx, [
    { text: '主角色回复', toolCalls: [] },
    { text: '规划器回复', toolCalls: [] },
    { text: '规划器回复2', toolCalls: [] }
  ])
  await registry.chat('steve', '你好')
  await registry.planner.chat('steve', '你是什么角色？')
  await registry.planner.chat('steve', '再说一次')
  assert.equal(provider.calls.length, 3)
  // planner 第二次调用的历史 = 上次 user+assistant 轮（含 '规划器回复'）
  const plannerMsgs = provider.calls[2].messages
  assert.ok(plannerMsgs.some(m => m.content === '规划器回复'), 'planner 会话保留自己的历史')
  // 且不含 primary 的消息（隔离——primary 的历史不泄漏进 planner 会话）
  assert.ok(!plannerMsgs.some(m => m.content === '你好'), 'planner 会话无 primary 历史')
})

test('roles: 会话跨实例继承——role 前缀 key 在新实例可见（模拟 rebuild）', async () => {
  const ctx = makeCtx()
  const { registry } = makeRegistry(ctx, [{ text: 'ok', toolCalls: [] }])
  await registry.chat('steve', '记住我要砍树')
  // 模拟 feature-layer 重建：新注册表（同一模块级 SESSIONS）
  const { registry: r2, provider: p2 } = makeRegistry(ctx, [{ text: 'ok2', toolCalls: [] }])
  await r2.chat('steve', '继续')
  assert.equal(p2.calls[0].messages.length >= 2, true, '新实例应继承 primary:steve 会话历史')
})

test('roles: 旧裸 key 迁移——磁盘裸 key 首读回填前缀 key（v1.3.0 sessions.json）', async () => {
  const ctx = makeCtx()
  const disk = new Map()
  disk.set('steve', {
    history: [{ role: 'user', content: '旧会话消息' }, { role: 'assistant', content: '旧回复' }],
    calls: [], goal: null, summary: null
  })
  const sessionStore = {
    get: (k) => disk.get(k) ?? null,
    set: (k, v) => disk.set(k, v),
    reset: (k) => disk.delete(k)
  }
  const provider = makeFakeProvider([{ text: '迁移成功', toolCalls: [] }])
  const executor = createActionExecutor(ctx, { audit: null })
  const l2 = { enabled: true, provider: 'cloud', model: 'x', cooldownMs: 0, maxSteps: 5 }
  const registry = createL2({ ...ctx.cfg, l2 }, ctx, { provider, executor, sessionStore, experience: null })
  await registry.chat('steve', '继续')
  assert.ok(provider.calls[0].messages.some(m => m.content === '旧会话消息'), '旧裸 key 会话应被读到')
  assert.ok(disk.get('primary:steve'), '会话应迁到角色前缀 key')
  assert.equal(disk.has('steve'), false, '旧裸 key 应删除')
})

test('roles: tools 白名单——farmer 角色只含白名单工具，无 act 则无动作通道', async () => {
  const ctx = makeCtx()
  const { registry, provider } = makeRegistry(ctx, [
    { text: '农活报告', toolCalls: [] },
    { text: '', toolCalls: [] }
  ], {
    roles: [{ name: 'farmer', systemPrompt: '你是农场主', tools: ['observe_crops'] }]
  })
  const farmer = registry.get('farmer')
  await farmer.chat('steve', '看看作物')
  const names = provider.calls[0].tools.map(t => t.name)
  assert.ok(names.includes('observe_crops'), '白名单工具应存在')
  assert.ok(!names.includes('act'), '白名单无 act → 无动作通道')
  assert.ok(!names.includes('observe_status'), '白名单外 readonly 工具不暴露')
  // 未知 op warn 跳过不炸
  const ctx2 = makeCtx()
  const { registry: r2 } = makeRegistry(ctx2, [], {
    roles: [{ name: 'ghost', tools: ['不存在的原语'] }]
  })
  assert.ok(r2.get('ghost'), '未知白名单 op 不炸实例')
})

test('roles: planEnabled 角色级覆盖 + summarize 冷却跨角色共享', async () => {
  _resetSummarizeCooldown()
  const ctx = makeCtx()
  const { registry, provider } = makeRegistry(ctx, [
    { text: '摘要内容', toolCalls: [] },
    { text: '第二条', toolCalls: [] }
  ], { roles: [{ name: 'planner', planEnabled: false }] })
  registry.setGoal('steve', '目标')
  // planner planEnabled=false → 不自主推进
  assert.equal(await registry.onTaskCompleted({ id: 'm1' }), false)
  assert.equal(provider.calls.length, 0)
  // summarize 共享 60s 冷却：primary 后 planner 被门挡
  const s1 = await registry.summarize('压缩', 100)
  assert.ok(s1, 'primary summarize 成功')
  const s2 = await registry.planner.summarize('再压缩', 100)
  assert.equal(s2, null, '60s 冷却内跨角色共享门')
})

test('roles: sessionCount 按角色统计；roleStats 形状', async () => {
  const ctx = makeCtx()
  const { registry } = makeRegistry(ctx, [
    { text: 'a', toolCalls: [] }, { text: 'b', toolCalls: [] }, { text: 'c', toolCalls: [] }
  ])
  await registry.chat('steve', 'x')
  await registry.chat('alex', 'y')
  await registry.planner.chat('steve', 'z')
  assert.equal(registry.primary.sessionCount(), 2, 'primary 两个玩家会话')
  assert.equal(registry.planner.sessionCount(), 1, 'planner 一个玩家会话')
  assert.equal(registry.sessionCount(), 3, '注册表求和')
  const stats = registry.roleStats()
  assert.equal(stats.length, 2)
  assert.deepEqual(stats.map(s => s.name), ['primary', 'planner'])
  assert.ok(stats.every(s => typeof s.busy === 'boolean' && typeof s.sessions === 'number'))
})

// ---- 技能学习（v1.5.0：注册表并行触发 + 跨角色共享）----

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSkillsStore } from '../src/l2/skills.js'

function makeTmp () {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skills-'))
  return { dir, file: path.join(dir, 'skills.json') }
}

test('v1.5.0: 注册表 onTaskCompleted 并行触发学习——规划 + 学习互不阻塞', async () => {
  const ctx = makeCtx({}, { ops: ['steve'] })
  const { registry, provider } = makeRegistry(ctx, [
    { text: '', toolCalls: [{ id: 't1', name: 'start_task', arguments: { type: 'chop', id: 'c1' } }] },
    { text: '下一步已启动', toolCalls: [] }
  ])
  // 学习通道用 spy 验证挂接（fire-and-forget 与共享 provider script 竞争不可测时序）
  let learned = false
  registry.planner.learnFromTask = async () => { learned = true; return true }
  registry.setGoal('steve', '砍树攒木头')
  registry.planner._resetPlanCooldown()
  const ok = await registry.onTaskCompleted({ entry: { id: 'm1', type: 'mine' }, task: { state: 'completed', counters: {} } })
  assert.equal(ok, true, '规划通道正常返回')
  assert.equal(learned, true, 'onTaskCompleted 并行触发学习')
  assert.ok(provider.calls.length >= 2, '规划调用正常')
})

test('v1.5.0: 技能跨角色共享——planner 学的技能在 primary chat 注入可见', async () => {
  const { dir, file } = makeTmp()
  try {
    const skills = createSkillsStore({ file, debounceMs: 100000 })
    const ctx = makeCtx()
    ctx.tasks = { getStatus: () => [{ id: 'm1', state: 'running', type: 'mine' }] }
    const { registry, provider } = makeRegistry(ctx, [
      { text: '{"name":"高效挖铁","summary":"先观察","steps":["observe_blocks"]}', toolCalls: [] },
      { text: '主角色回复', toolCalls: [] }
    ], {}, { skills })
    // planner 学习（直接 await learnFromTask 委托）
    const learned = await registry.learnFromTask({ entry: { id: 'm1', type: 'mine' }, task: { state: 'completed', counters: {} } })
    assert.equal(learned, true)
    // primary chat 的 system 注入该技能（同一 store 实例）
    await registry.chat('steve', '你好')
    assert.ok(provider.calls.at(-1).system.includes('\n技能:\n- [mine] 高效挖铁'), '技能跨角色共享注入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
