// !find 命令测试：地表候选查询、行走报告、失败如实反馈、busy 防重入、exclusive 警告。
// 仿 commands-builtin 的 makeCtx 风格；goto stub 手动控制 settle。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { createCommandRegistry } from '../src/commands/commands.ts'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

/** 可控 goto：{ promise, resolve, reject }。 */
function deferredGoto () {
  let resolveFn, rejectFn
  const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

function makeCtx (overrides = {}) {
  const bot = {
    chat: async (msg) => { bot.messages.push(msg) },
    messages: [],
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { iron_ore: { id: 44 }, bamboo: { id: 99 } } },
    findBlocks: ({ matching }) => {
      if (matching({ type: 44 })) return [new Vec3(10, 64, 0), new Vec3(30, 65, 0)] // 最近 10,64,0
      return []
    },
    // 上方 2 格空 → 全部候选视为地表
    blockAt: () => ({ boundingBox: 'empty', name: 'air' }),
    // C2 end-race 需要事件 API（本组测试不模拟断线，no-op 即可）
    once: () => {},
    removeListener: () => {},
    pathfinder: {
      setGoal: () => {},
      stop: () => {},
      goto: () => Promise.resolve()
    }
  }
  const cfg = { ops: ['op1'], chat: { maxLength: 250, commandCooldownMs: 0 } }
  const ctx = {
    bot, cfg, logger: makeLogger(),
    tasks: { getStatus: () => [] },
    plugins: {}, conn: { getStatus: () => ({}) }, agent: null,
    onReload: async () => true,
    ...overrides
  }
  return { ctx, bot }
}

async function dispatch (ctx, msg, sender = 'op1') {
  const registry = createCommandRegistry(ctx)
  return registry.dispatch(msg, { sender, ctx })
}

function lastMsg (bot) {
  return bot.messages.at(-1) ?? ''
}

test('!find 缺方块名 → 用法提示', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!find')
  assert.ok(lastMsg(bot).includes('用法'))
})

test('!find 非法 maxDistance → 明确报错', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!find iron_ore 999')
  assert.ok(lastMsg(bot).includes('16-256'))
})

test('!find 未知方块 → 明确报错', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!find not_a_block')
  assert.ok(lastMsg(bot).includes('未知方块类型'))
})

test('!find 无候选 → 明确反馈', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!find bamboo') // findBlocks 只匹配 44
  assert.ok(lastMsg(bot).includes('没有暴露在地表的 bamboo'))
})

test('C8/W 修复：!find 找到并到达 → 报告实际到达坐标（可达最近 ≠ 欧氏最近）', async () => {
  const { ctx, bot } = makeCtx()
  await dispatch(ctx, '!find iron_ore')
  const msg = lastMsg(bot)
  assert.ok(msg.includes('找到 iron_ore'), msg)
  assert.ok(msg.includes('已到达 0,64,0'), `应报实际到达点（bot 位置）而非候选: ${msg}`)
  assert.ok(msg.includes('水平距离 10m'), msg)
})

test('!find 无法到达（NoPath）→ 如实反馈 + 最近候选', async () => {
  const d = deferredGoto()
  const { ctx } = makeCtx({
    bot: {
      chat: async (msg) => { bot2.messages.push(msg) },
      messages: [],
      entity: { position: new Vec3(0, 64, 0) },
      registry: { blocksByName: { iron_ore: { id: 44 } } },
      findBlocks: () => [new Vec3(10, 64, 0)],
      blockAt: () => ({ boundingBox: 'empty', name: 'air' }),
      once: () => {},
      removeListener: () => {},
      pathfinder: { setGoal: () => {}, stop: () => {}, goto: () => d.promise }
    }
  })
  const bot2 = ctx.bot
  const p = dispatch(ctx, '!find iron_ore')
  d.reject(Object.assign(new Error('NoPath'), { name: 'NoPath' }))
  await p
  const msg = lastMsg(bot2)
  assert.ok(msg.includes('无法到达'), msg)
  assert.ok(msg.includes('10,64,0'), '失败也应报告最近候选坐标')
})

test('!find 行走期间防重入（busy）', async () => {
  const d = deferredGoto()
  const { ctx } = makeCtx({
    bot: {
      chat: async (msg) => { bot2.messages.push(msg) },
      messages: [],
      entity: { position: new Vec3(0, 64, 0) },
      registry: { blocksByName: { iron_ore: { id: 44 } } },
      findBlocks: () => [new Vec3(10, 64, 0)],
      blockAt: () => ({ boundingBox: 'empty', name: 'air' }),
      once: () => {},
      removeListener: () => {},
      pathfinder: { setGoal: () => {}, stop: () => {}, goto: () => d.promise }
    }
  })
  const bot2 = ctx.bot
  const p1 = dispatch(ctx, '!find iron_ore') // 行走挂起
  await new Promise(r => setImmediate(r)) // 让 findBusy 置位
  await dispatch(ctx, '!find iron_ore') // 重入 → 拒绝
  assert.ok(lastMsg(bot2).includes('仍在进行中'))
  d.resolve() // 放行第一个
  await p1
  assert.ok(lastMsg(bot2).includes('找到 iron_ore'), '第一个 find 应正常完成')
})

test('!find 运行中 exclusive 任务 → 警告后继续（C8/S：走仲裁器登记）', async () => {
  const arb = await import('../src/core/arbiter.ts')
  arb.setExclusiveOwner('guard-base')
  try {
    const { ctx, bot } = makeCtx({
      tasks: { getStatus: () => [{ id: 'guard-base', type: 'combat', state: 'running' }] }
    })
    await dispatch(ctx, '!find iron_ore')
    const messages = bot.messages.join(';')
    assert.ok(messages.includes('注意'), '应提示与运行中任务的冲突')
    assert.ok(messages.includes('guard-base'), '应显示冲突任务 id')
    assert.ok(messages.includes('找到 iron_ore'), '警告后应放行继续')
  } finally {
    arb.setExclusiveOwner(null)
  }
})
