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
    startTask: async (id) => { calls.startTask.push(id); return true }, // 非 null = 启动成功（async 下 return Promise 会被解包）
    stopTask: async (id) => { calls.stopTask.push(id); return true },
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

test('C5 修复：!task new 非法 options → 拒绝（afk intervalMinutes 0 不再忙循环）', async () => {
  const { ctx, bot, calls } = makeCtx()
  await dispatch(ctx, '!task new afk a1 {"intervalMinutes":0}')
  assert.ok(lastMsg(bot).includes('参数校验失败'), lastMsg(bot))
  assert.equal(calls.addTask.length, 0, '校验失败不应创建任务')
  await dispatch(ctx, '!task new mine m1 {"blockTypes":[]}')
  assert.ok(lastMsg(bot).includes('参数校验失败'), lastMsg(bot))
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

test('!task start 成功 → 已启动反馈', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!task start m1')
  assert.ok(lastMsg(bot).includes('已启动'))
})

test('!task start 排队（startTask 返回 null 且任务存在）→ 排队反馈', async () => {
  const { ctx, bot } = makeCtx({
    tasks: {
      getStatus: () => [{ id: 'g1', state: 'created' }],
      startTask: async () => null,
      addTask: () => {}, removeTask: async () => {},
      stopTask: async () => {}, pauseTask: async () => {}, resumeTask: async () => {}
    }
  })
  await dispatch(ctx, '!task start g1')
  assert.ok(lastMsg(bot).includes('已排队'), '排队应明确反馈而非静默')
})

test('B 修复：!task start 常驻任务立即回复（不 await run 完成 promise）', async () => {
  const { ctx, bot } = makeCtx({
    tasks: {
      getStatus: () => [{ id: 'm1', state: 'running' }],
      startTask: () => new Promise(() => {}) // 模拟常驻任务：run promise 永不 settle
    }
  })
  await dispatch(ctx, '!task start m1')
  assert.ok(lastMsg(bot).includes('已启动'), '应立即回复，而非挂到任务结束')
})

test('B 修复：!task start 启动失败 → 如实反馈失败原因', async () => {
  const { ctx, bot } = makeCtx({
    tasks: {
      getStatus: () => [{ id: 'm1', state: 'failed', lastError: 'init boom' }],
      startTask: () => new Promise(() => {})
    }
  })
  await dispatch(ctx, '!task start m1')
  assert.ok(lastMsg(bot).includes('启动失败'), lastMsg(bot))
  assert.ok(lastMsg(bot).includes('init boom'), '应带失败原因')
})

test('L 修复：!reload 运行时异常 → 如实反馈（不再假成功）', async () => {
  const { ctx, bot } = makeCtx({ onReload: async () => { throw new Error('boom') } })
  await dispatch(ctx, '!reload')
  assert.ok(lastMsg(bot).includes('重载失败'), lastMsg(bot))
  assert.ok(lastMsg(bot).includes('运行时错误'), lastMsg(bot))
})

test('!task start 任务不存在 → 明确报错', async () => {
  const { ctx, bot } = makeCtx({
    tasks: {
      getStatus: () => [],
      startTask: async () => null, // 生产语义：任务不存在 → null
      addTask: () => {}, removeTask: async () => {},
      stopTask: async () => {}, pauseTask: async () => {}, resumeTask: async () => {}
    }
  })
  await dispatch(ctx, '!task start ghost')
  assert.ok(lastMsg(bot).includes('任务不存在'), '不存在 id 应明确报错而非静默')
})

test('!task stop/pause 存在 → 操作反馈', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!task stop m1')
  assert.ok(lastMsg(bot).includes('已停止任务 m1'))
  await dispatch(ctx, '!task pause m1')
  assert.ok(lastMsg(bot).includes('已暂停任务 m1'))
})

test('!task resume 暂停中任务 → 恢复反馈', async () => {
  const { ctx, bot } = makeCtx({
    tasks: {
      getStatus: () => [{ id: 'm1', state: 'paused' }],
      startTask: async () => true, stopTask: async () => true,
      addTask: () => {}, removeTask: async () => {},
      pauseTask: async () => true, resumeTask: async () => true
    }
  })
  await dispatch(ctx, '!task resume m1')
  assert.ok(lastMsg(bot).includes('已恢复任务 m1'))
})

test('!task stop 不存在 → 明确报错', async () => {
  const { ctx, bot } = makeCtx({
    tasks: {
      getStatus: () => [],
      startTask: async () => null, stopTask: async () => false, // 生产语义：不存在 → false
      addTask: () => {}, removeTask: async () => {},
      pauseTask: async () => false, resumeTask: async () => false
    }
  })
  await dispatch(ctx, '!task stop ghost')
  assert.ok(lastMsg(bot).includes('任务不存在'))
})

test('!task pause 未运行任务（created 排队）→ 明确提示', async () => {
  const { ctx, bot } = makeCtx({
    tasks: {
      getStatus: () => [{ id: 'g1', state: 'created' }],
      startTask: async () => true, stopTask: async () => true,
      addTask: () => {}, removeTask: async () => {},
      pauseTask: async () => true, resumeTask: async () => true
    }
  })
  await dispatch(ctx, '!task pause g1')
  assert.ok(lastMsg(bot).includes('未在运行'), '排队任务 pause 应明确提示而非静默 no-op')
})

test('!task resume 非暂停任务 → 明确提示', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!task resume m1') // m1 是 running
  assert.ok(lastMsg(bot).includes('未在暂停状态'))
})

test('!reload 失败 → 如实反馈（配置无效保留旧配置）', async () => {
  const { ctx, bot } = makeCtx({ onReload: async () => false })
  await dispatch(ctx, '!reload')
  assert.ok(lastMsg(bot).includes('重载失败'))
})

test('dispatch 层：未知命令返回 false（chatHandler 负责反馈，见 feature-layer.test）', async () => {
  const { ctx } = makeCtx()
  const registry = createCommandRegistry(ctx)
  const hit = await registry.dispatch('!fly-away', { sender: 'op1', ctx })
  assert.equal(hit, false)
})
