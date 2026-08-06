// 内置命令 handler 测试（零覆盖补齐：此前仅 !ping 经 feature-layer 集成覆盖）。
// 用真实 createCommandRegistry + fake ctx（chat 记录、tasks/conn/agent stubs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommandRegistry } from '../src/commands/commands.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (overrides = {}) {
  const bot = {
    chat: async (msg) => { bot.messages.push(msg) },
    messages: [],
    entity: { position: { x: 10, y: 64, z: -5 }, yaw: 1.5 },
    health: 20,
    food: 18,
    players: { steve: { username: 'Steve', entity: { id: 1 } } } // 故意大写：测大小写不敏感匹配
  }
  const calls = { onReload: 0, startTask: [], stopTask: [], addTask: [], removeTask: [] }
  const tasks = {
    getStatus: () => [{ id: 'm1', state: 'running', counters: { mined: 3 }, waitingReason: null, lastError: null }],
    addTask: (e) => { calls.addTask.push(e) },
    removeTask: async (id) => { calls.removeTask.push(id) },
    startTask: async (id) => { calls.startTask.push(id) },
    stopTask: async (id) => { calls.stopTask.push(id) },
    pauseTask: async () => {},
    resumeTask: async () => {}
  }
  const conn = { getStatus: () => ({ state: 'connected', reconnectCount: 2 }) }
  const agent = {
    chat: async (user, text) => ({ reply: `echo:${text}` }),
    act: async (user, name, params) => ({ ok: true, result: `done:${name}` })
  }
  const cfg = { ops: ['op1'], chat: { maxLength: 250, commandCooldownMs: 0 } }
  const ctx = {
    bot, cfg, logger: makeLogger(), tasks, conn, agent,
    plugins: {},
    onReload: async () => { calls.onReload++ },
    ...overrides
  }
  return { ctx, calls, bot }
}

async function dispatch (ctx, msg, sender = 'op1') {
  const registry = createCommandRegistry(ctx)
  return registry.dispatch(msg, { sender, ctx })
}

function lastMsg (bot) {
  return bot.messages.at(-1) ?? ''
}

test('!ping → pong', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!ping', 'anyone') // permission: all
  assert.ok(lastMsg(bot).includes('pong'))
})

test('!status → 位置/生命/连接/任务摘要', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!status')
  const msg = lastMsg(bot)
  assert.ok(msg.includes('pos=10,64,-5'))
  assert.ok(msg.includes('hp=20'))
  assert.ok(msg.includes('reconnects=2'))
  assert.ok(msg.includes('m1:running'))
})

test('!task list → 状态行（含 counters）', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!task list')
  assert.ok(lastMsg(bot).includes('m1:running'))
  assert.ok(lastMsg(bot).includes('mined'))
})

test('!task new 缺参 → 用法提示', async () => {
  const { ctx, bot, calls } = makeCtx()
  await dispatch(ctx, '!task new')
  assert.ok(lastMsg(bot).includes('用法'))
  assert.equal(calls.addTask.length, 0)
})

test('!task new 合法 → addTask + 成功消息', async () => {
  const { ctx, bot, calls } = makeCtx()
  await dispatch(ctx, '!task new mine gold-mine {"blockTypes":["gold_ore"]}')
  assert.equal(calls.addTask.length, 1)
  assert.equal(calls.addTask[0].id, 'gold-mine')
  assert.deepEqual(calls.addTask[0].options, { blockTypes: ['gold_ore'] })
  assert.ok(lastMsg(bot).includes('已创建任务 gold-mine'))
})

test('!task start/stop/remove → 对应 manager 调用', async () => {
  const { ctx, calls } = makeCtx()
  await dispatch(ctx, '!task start m1')
  assert.deepEqual(calls.startTask, ['m1'])
  await dispatch(ctx, '!task stop m1')
  assert.deepEqual(calls.stopTask, ['m1'])
  await dispatch(ctx, '!task remove m1')
  assert.deepEqual(calls.removeTask, ['m1'])
})

test('!task 未知操作 → 提示可用操作', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!task fly m1')
  assert.ok(lastMsg(bot).includes('未知操作'))
})

test('!reload → onReload 队列 + 成功消息', async () => {
  const { ctx, bot, calls } = makeCtx()
  await dispatch(ctx, '!reload')
  assert.equal(calls.onReload, 1)
  assert.ok(lastMsg(bot).includes('配置已重载'))
})

test('!say 超长文本透传', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!say hello world')
  assert.equal(lastMsg(bot), 'hello world')
})

test('!pos → 坐标与朝向', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!pos')
  assert.equal(lastMsg(bot), 'pos=10,64,-5 yaw=1.5')
})

test('!follow 未启用插件 → 明确报错', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!follow steve')
  assert.ok(lastMsg(bot).includes('未启用 follow 插件'))
})

test('!follow off → 停止跟随', async () => {
  let stopped = false
  const { ctx, bot } = makeCtx({
    plugins: { follow: { stop: () => { stopped = true }, setTarget: () => {} } }
  })
  await dispatch(ctx, '!follow off')
  assert.equal(stopped, true)
  assert.ok(lastMsg(bot).includes('已停止跟随'))
})

test('!follow 玩家名大小写不敏感（Steve → steve）', async () => {
  let target = null
  const { ctx, bot } = makeCtx({
    plugins: { follow: { stop: () => {}, setTarget: (e) => { target = e } } }
  })
  await dispatch(ctx, '!follow STEVE')
  assert.ok(target, '应匹配到玩家实体（大小写不敏感）')
  assert.ok(lastMsg(bot).includes('开始跟随 STEVE'))
})

test('!follow 找不到玩家 → 报错', async () => {
  const { ctx, bot } = makeCtx({ plugins: { follow: { stop: () => {}, setTarget: () => {} } } })
  await dispatch(ctx, '!follow nobody')
  assert.ok(lastMsg(bot).includes('找不到玩家'))
})

test('!agent 未启用 → 提示配置 l2.enabled', async () => {
  const { ctx, bot } = makeCtx({ agent: null })
  await dispatch(ctx, '!agent chat hi')
  assert.ok(lastMsg(bot).includes('L2 未启用'))
})

test('!agent chat → 调用 agent.chat 并透传回复', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!agent chat 你好')
  assert.ok(lastMsg(bot).includes('echo:你好'))
})

test('!agent act 非 op → 权限不足', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!agent act status', 'creeper')
  assert.ok(lastMsg(bot).includes('权限不足'))
})

test('!agent act op → 调用 act 并展示结果', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!agent act status {}')
  assert.ok(lastMsg(bot).includes('done:status'))
})
