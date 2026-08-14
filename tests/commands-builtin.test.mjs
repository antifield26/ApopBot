// 内置命令 handler 测试（零覆盖补齐：此前仅 !ping 经 feature-layer 集成覆盖）。
// 用真实 createCommandRegistry + fake ctx（chat 记录、tasks/conn/agent stubs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommandRegistry } from '../src/commands/commands.ts'

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
    act: async (user, name) => ({ ok: true, result: `done:${name}` })
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

test('U8 修复：!task list 显示排队位置/时长剩余/下次 cron 触发', async () => {
  const { ctx, bot } = makeCtx({
    tasks: {
      getStatus: () => [{
        id: 's1', type: 'combat', state: 'running', counters: {},
        waitingReason: null, lastError: null,
        queuePosition: 2, remainingMinutes: 5,
        // 显式 +08:00 偏移：nextRunAt 是绝对时刻，按 scheduleTimezone（默认
        // Asia/Shanghai）渲染——CI runner 时区是 UTC，无偏移的本地字符串会在
        // 不同时区解释成不同绝对时刻 → 渲染结果漂移（第八轮时区修复后暴露）
        nextRunAt: new Date('2026-08-07T12:34:00+08:00')
      }]
    }
  })
  await dispatch(ctx, '!task list')
  const msg = lastMsg(bot)
  assert.ok(msg.includes('排队#2'), msg)
  assert.ok(msg.includes('余5m'), msg)
  assert.ok(msg.includes('下次12:34'), msg)
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

test('A4 修复：!task new 后任务 init 抛错（failed）→ 如实反馈（不再只报"已创建"误导排障）', async () => {
  const { ctx, bot, calls } = makeCtx({
    tasks: {
      getStatus: () => [{
        id: 'bad1', type: 'mine', state: 'failed', counters: {},
        waitingReason: null, lastError: '未知方块类型: nope_ore'
      }],
      addTask: (e) => { calls.addTask.push(e) }
    }
  })
  await dispatch(ctx, '!task new mine bad1 {"blockTypes":["nope_ore"]}')
  assert.equal(calls.addTask.length, 1, '任务应被创建（失败发生在启动阶段）')
  assert.ok(bot.messages.some(m => m.includes('已创建任务 bad1')), bot.messages.join('|'))
  assert.ok(bot.messages.some(m => m.includes('启动失败')), `应反馈启动失败: ${bot.messages.join('|')}`)
  assert.ok(bot.messages.some(m => m.includes('未知方块类型')), bot.messages.join('|'))
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

test('C8/S 修复：!follow 在 exclusive 任务运行时拒绝（移动互斥，不再双控制器冲突）', async () => {
  const arb = await import('../src/core/arbiter.ts')
  arb.setExclusiveOwner('guard-base')
  try {
    const { ctx, bot } = makeCtx({ plugins: { follow: { stop: () => {}, setTarget: () => {} } } })
    await dispatch(ctx, '!follow steve')
    assert.ok(lastMsg(bot).includes('无法跟随'), lastMsg(bot))
    assert.ok(lastMsg(bot).includes('guard-base'), '应提示冲突任务 id')
  } finally {
    arb.setExclusiveOwner(null)
  }
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

test('C7/Y 修复：!agent chat 非 op 可用（permission all；危险操作仍由技能层强制）', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!agent chat 你好', 'creeper')
  assert.ok(lastMsg(bot).includes('echo:你好'), lastMsg(bot))
})

test('U9: !agent doctor 回显模式/延迟/单 provider 连通性（v1.0.0 仅云端）', async () => {
  const { ctx, bot } = makeCtx({
    agent: {
      chat: async () => ({ reply: 'x' }),
      act: async () => ({ ok: true, result: 'x' }),
      diagnose: async () => [
        { label: 'cloud', ok: true, status: 405 }
      ],
      provider: { mode: 'cloud' },
      usage: { latencyMs: 123 }
    }
  })
  await dispatch(ctx, '!agent doctor')
  const msg = lastMsg(bot)
  assert.ok(msg.includes('cloud'), msg)
  assert.ok(msg.includes('cloud: 连通'), msg)
  assert.ok(msg.includes('123ms'), msg)
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

test('!agent goal set --plan=JSON——设置目标与计划（op）', async () => {
  const goalCalls = []
  const { ctx, bot } = makeCtx({
    agent: {
      chat: async () => ({ reply: 'ok' }),
      act: async () => ({ ok: true, result: 'ok' }),
      setGoal: (user, text, plan) => { goalCalls.push({ user, text, plan }) },
      getGoal: () => ({ text: '目标', plan: ['挖矿', '烧炼'], setBy: 'op1' }),
      clearGoal: () => {}
    }
  })
  await dispatch(ctx, '!agent goal set 建基地 --plan=["挖木头","造工具","盖房"]')
  assert.equal(goalCalls.length, 1)
  assert.equal(goalCalls[0].text, '建基地')
  assert.deepEqual(goalCalls[0].plan, ['挖木头', '造工具', '盖房'])
  assert.ok(lastMsg(bot).includes('计划 3 步'), lastMsg(bot))
})

test('!agent goal set --plan 非法 JSON → 明确报错（不设置）', async () => {
  const goalCalls = []
  const { ctx, bot } = makeCtx({
    agent: {
      chat: async () => ({ reply: 'ok' }),
      act: async () => ({ ok: true, result: 'ok' }),
      setGoal: (u, t, p) => { goalCalls.push({ user: u, text: t, plan: p }) },
      getGoal: () => null,
      clearGoal: () => {}
    }
  })
  await dispatch(ctx, '!agent goal set 建基地 --plan=not-json')
  assert.ok(lastMsg(bot).includes('计划必须是 JSON'), lastMsg(bot))
  assert.equal(goalCalls.length, 0, '非法计划不应设置')
  await dispatch(ctx, '!agent goal set 建基地 --plan="挖木头"')
  assert.ok(lastMsg(bot).includes('字符串数组'), lastMsg(bot))
})

test('M16: --plan 含空格 JSON 从全文提取——plan 不丢失、目标文本不被污染', async () => {
  const goalCalls = []
  const { ctx } = makeCtx({
    agent: {
      chat: async () => ({ reply: 'ok' }),
      act: async () => ({ ok: true, result: 'ok' }),
      setGoal: (u, t, p) => { goalCalls.push({ user: u, text: t, plan: p }) },
      getGoal: () => null,
      clearGoal: () => {}
    }
  })
  // token 切分会把含空格 JSON 拆散（parser 只对 { 起头跟踪括号）——修复前
  // plan 静默丢失、目标文本混入 --plan 片段且无报错
  await dispatch(ctx, '!agent goal set 建一座大基地 --plan=["挖 木头","造 工具"]')
  assert.equal(goalCalls.length, 1, '应正常设置')
  assert.equal(goalCalls[0].text, '建一座大基地', `目标文本不得被污染: ${goalCalls[0].text}`)
  assert.deepEqual(goalCalls[0].plan, ['挖 木头', '造 工具'], `plan 不得丢失: ${JSON.stringify(goalCalls[0].plan)}`)
})

test('!agent goal 查看——显示目标与计划', async () => {
  const { ctx, bot } = makeCtx({
    agent: {
      chat: async () => ({ reply: 'ok' }),
      act: async () => ({ ok: true, result: 'ok' }),
      setGoal: () => {},
      getGoal: () => ({ text: '建基地', plan: ['挖木头', '造工具'], setBy: 'op1' }),
      clearGoal: () => {}
    }
  })
  await dispatch(ctx, '!agent goal')
  assert.ok(lastMsg(bot).includes('建基地'), lastMsg(bot))
  assert.ok(lastMsg(bot).includes('挖木头→造工具'), lastMsg(bot))
})

// ---- 多角色路由（v1.4.0）：!agent role list / role <name> <action> / 便捷形式 ----

function makeRoleAgent () {
  return {
    chat: async (user, text) => ({ reply: `primary:${text}` }),
    act: async (user, name) => ({ ok: true, result: `done:${name}` }),
    get: (name) => name === 'planner'
      ? { chat: async (u, t) => ({ reply: `planner:${t}` }), act: async () => ({ ok: true, result: 'planner-done' }) }
      : null,
    roleStats: () => [
      { name: 'primary', busy: false, sessions: 1, planEnabled: true },
      { name: 'planner', busy: false, sessions: 0, planEnabled: true }
    ]
  }
}

test('v1.4.0: !agent role list → 输出角色统计', async () => {
  const { ctx, bot } = makeCtx({ agent: makeRoleAgent() })
  await dispatch(ctx, '!agent role list')
  const msg = lastMsg(bot)
  assert.ok(msg.includes('primary'), msg)
  assert.ok(msg.includes('planner'), msg)
  assert.ok(msg.includes('1会话'), msg)
})

test('v1.4.0: !agent role <name> <action> 显式路由 + [role] 回复前缀', async () => {
  const { ctx, bot } = makeCtx({ agent: makeRoleAgent() })
  await dispatch(ctx, '!agent role planner chat 看看作物')
  assert.ok(lastMsg(bot).includes('planner:看看作物'), lastMsg(bot))
  assert.ok(lastMsg(bot).includes('[planner]'), '非主角色回复带角色前缀')
})

test('v1.4.0: !agent <role> <action> 便捷形式（role 非 primary + 次 token 已知动作）', async () => {
  const { ctx, bot } = makeCtx({ agent: makeRoleAgent() })
  await dispatch(ctx, '!agent planner chat 规划一下')
  assert.ok(lastMsg(bot).includes('planner:规划一下'), lastMsg(bot))
})

test('v1.4.0: !agent chat X 恒为 primary 的 chat 动作（回归——无歧义）', async () => {
  const { ctx, bot } = makeCtx({ agent: makeRoleAgent() })
  await dispatch(ctx, '!agent chat 你好')
  assert.ok(lastMsg(bot).includes('primary:你好'), lastMsg(bot))
  assert.ok(!lastMsg(bot).includes('[planner]'), 'primary 回复无角色前缀')
})

test('v1.4.0: !agent chat reset 退化输入 → 按 chat 动作（不会误路由角色）', async () => {
  const { ctx, bot } = makeCtx({ agent: makeRoleAgent() })
  await dispatch(ctx, '!agent chat reset')
  assert.ok(lastMsg(bot).includes('primary:reset'), lastMsg(bot))
})

test('v1.4.0: !agent role 不存在 chat hi → 报错', async () => {
  const { ctx, bot } = makeCtx({ agent: makeRoleAgent() })
  await dispatch(ctx, '!agent role 不存在 chat hi')
  assert.ok(lastMsg(bot).includes('角色不存在'), lastMsg(bot))
})

test('命令矩阵：op 冷却 / 非 op 拒绝 / 混合权限子命令冷却（同一 registry 实例）', async () => {
  const { ctx, bot } = makeCtx()
  ctx.cfg = { ...ctx.cfg, ops: ['op1', 'op2'], chat: { ...ctx.cfg.chat, commandCooldownMs: 750 } }
  const registry = createCommandRegistry(ctx) // 同一实例——冷却 Map 跨 dispatch 共享
  ctx.commands = registry // 真实流程由 feature-layer 注入（handler 内 enforceOpCooldown 读它）
  const disp = (msg, sender) => registry.dispatch(msg, { sender, ctx })
  // 1. op 命令冷却（per-sender 桶跨 op 命令共享）：两次 !status
  await disp('!status', 'op1')
  assert.ok(lastMsg(bot).includes('pos='), '首次正常执行')
  await disp('!status', 'op1')
  assert.ok(lastMsg(bot).includes('命令冷却中'), `op 命令冷却应拦截: ${lastMsg(bot)}`)
  // 2. 非 op 拒绝（拒绝路径不占冷却）
  await disp('!status', 'intruder')
  assert.ok(lastMsg(bot).includes('权限不足'), '非 op 拒绝')
  // 3. 混合权限子命令（!home set 注册 all、handler 内 op 门）——op2 独立桶验证
  await disp('!home set base', 'op2')
  assert.ok(lastMsg(bot).includes('已记录'), `首次 home set 成功: ${lastMsg(bot)}`)
  await disp('!home set base2', 'op2')
  assert.ok(lastMsg(bot).includes('命令冷却中'), `混合权限子命令应计冷却（修复前绕过）: ${lastMsg(bot)}`)
  // 4. 非 op !home set → 权限不足
  await disp('!home set base3', 'intruder')
  assert.ok(lastMsg(bot).includes('权限不足'), '非 op home set 拒绝')
  // 清理探索记忆（模块级状态）
  const discovery = await import('../src/core/discovery.ts')
  discovery._reset()
})
