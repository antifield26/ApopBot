// 脚本任务执行器测试（v1.0.0 C6）：DSL 解释（loop/if/break/return/条件六型/模板
// 求值/软失败/计数器/deadline）+ BaseTask 状态机语义映射（暂停在步骤间/取消中断/
// 自然完成）+ afk/fish 脚本行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScriptTask, ScriptRunner } from '../src/tasks/runner.js'
import { Vec3 } from 'vec3'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (botOverrides = {}) {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
    look: () => {},
    chat (msg) { this.messages.push(msg) },
    messages: [],
    fish: async () => {},
    inventory: { slots: [], items: () => [] },
    ...botOverrides
  }
  return {
    bot,
    logger: makeLogger(),
    config: { ops: [], l2: { maxActionsPerCall: 8 }, log: {} },
    getConfig: () => ({ ops: [], l2: { maxActionsPerCall: 8 }, log: {} })
  }
}

function makeTask (scriptDef, options = {}, ctx = null) {
  return new ScriptTask('t1', scriptDef.id, options, ctx ?? makeCtx(), scriptDef)
}

const MINI_SCRIPT = {
  id: 'mini',
  exclusive: false,
  naturalCompletion: false,
  maxActions: 1000,
  script: { steps: [
    { op: 'observe_status', args: {}, as: 's0' },
    { ctrl: 'loop', max: 3, body: [
      { ctrl: 'wait', ms: 5 },
      { op: 'look', args: { yaw: 0.05, relative: true }, count: 'wiggles' },
      { ctrl: 'if', cond: { type: 'counter', name: 'wiggles', gte: 2 }, then: [{ ctrl: 'break' }] }
    ] },
    { op: 'look', args: { yaw: 0.1, relative: true }, as: 'lastLook' },
    { ctrl: 'if', cond: { type: 'last', ok: true }, then: [{ op: 'reply', args: { text: 'done' } }] },
    { ctrl: 'return', value: 'completed' }
  ] }
}

test('DSL: 顺序/循环/break/条件/计数器/模板/return 全链路', async () => {
  const ctx = makeCtx()
  const task = makeTask(MINI_SCRIPT, {}, ctx)
  await task.start()
  assert.equal(task.state, 'completed', 'return completed → 自然完成')
  assert.equal(task.counters.wiggles, 2, 'break 在 2 次 wiggle 后跳出（而非 3 次循环上限）')
  assert.ok(ctx.bot.messages.includes('done'), 'if last.ok 分支执行 reply')
})

test('DSL: 模板求值——$引用 / ${options} / {expr}', async () => {
  const seen = []
  const script = {
    id: 'tpl',
    exclusive: false,
    naturalCompletion: false,
    maxActions: 100,
    script: { steps: [
      { op: 'observe_blocks', args: { blockName: 'iron_ore' }, as: 'blocks' },
      { op: 'collect_blocks', args: { positions: '$blocks.candidates', maxBlocks: '${maxBlocks}', area: { x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 1 } }, as: 'collected' },
      { ctrl: 'wait', ms: { expr: '${seconds} * 1000' } },
      { ctrl: 'if', cond: { type: 'result', ref: 'collected', field: 'inventoryFull', equals: true }, then: [{ op: 'reply', args: { text: 'full' } }] },
      { ctrl: 'return', value: 'completed' }
    ] }
  }
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { blocksByName: { iron_ore: { id: 44 } } },
    findBlocks: ({ matching }) => (matching({ type: 44 }) ? [new Vec3(5, 63, 0)] : []),
    blockAt: () => ({ boundingBox: 'empty', name: 'air' }),
    collectBlock: { collect: async (batch) => { seen.push(batch); return { collected: batch.length } } },
    chat: () => { seen.push('chat') },
    once: () => {},
    removeListener: () => {}
  }
  const ctx = makeCtx(bot)
  const task = makeTask(script, { maxBlocks: 4, seconds: 0.01 }, ctx)
  await task.start()
  assert.equal(task.state, 'completed')
  assert.equal(seen[0].length, 1, '$blocks.candidates 结果引用解析')
  assert.equal(seen[0][0].x, 5)
  assert.equal(seen[0][0].y, 63)
  assert.equal(seen[0][0].z, 0)
})

test('DSL: 软失败——动作失败记录 lastResult，if last.ok:false 分支可处理', async () => {
  const script = {
    id: 'soft',
    exclusive: false,
    naturalCompletion: false,
    maxActions: 100,
    script: { steps: [
      { op: 'observe_blocks', args: { blockName: 'missing_block' }, as: 'scan' },
      { ctrl: 'if', cond: { type: 'last', ok: false }, then: [{ op: 'reply', args: { text: '没找到' } }] },
      { ctrl: 'if', cond: { type: 'last', ok: true }, then: [{ op: 'reply', args: { text: '找到了' } }] },
      { ctrl: 'return', value: 'completed' }
    ] }
  }
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, registry: { blocksByName: {} }, findBlocks: () => [], blockAt: () => null, chat: () => {} }
  const ctx = makeCtx(bot)
  const task = makeTask(script, {}, ctx)
  await task.start()
  assert.equal(task.state, 'completed', '软失败不中断任务')
  assert.equal(task.counters?.caught ?? 0, 0)
})

test('BaseTask 语义映射: stop 中断脚本（abort signal 贯通）', async () => {
  const script = {
    id: 'stop',
    exclusive: false,
    naturalCompletion: false,
    maxActions: 100,
    script: { steps: [
      { ctrl: 'loop', max: 'infinite', body: [
        { op: 'wait', args: { ms: 60000 } }, // 长等待（signal race 可中断）
        { op: 'look', args: { yaw: 0.05, relative: true } }
      ] }
    ] }
  }
  const ctx = makeCtx()
  const task = makeTask(script, {})
  task.start()
  await new Promise(r => setImmediate(r))
  await task.stop()
  assert.equal(task.state, 'stopped')
})

test('BaseTask 语义映射: pause 在步骤间生效（wait 可被打断）', async () => {
  const script = {
    id: 'pause',
    exclusive: false,
    naturalCompletion: false,
    maxActions: 100,
    script: { steps: [
      { ctrl: 'loop', max: 'infinite', body: [
        { op: 'wait', args: { ms: 60000 } },
        { op: 'look', args: { yaw: 0.05, relative: true } }
      ] }
    ] }
  }
  const task = makeTask(script, {})
  task.start()
  await new Promise(r => setImmediate(r))
  await task.pause()
  assert.equal(task.state, 'paused', 'pause 应立即生效（打断内部等待）')
  await task.resume()
  assert.equal(task.state, 'running')
  await task.stop()
})

test('deadline 条件: durationMinutes 到时 → return completed', async () => {
  const script = {
    id: 'dl',
    exclusive: false,
    naturalCompletion: false,
    maxActions: 100,
    script: { steps: [
      { ctrl: 'loop', max: 'infinite', body: [
        { ctrl: 'if', cond: { type: 'deadline', passed: true }, then: [{ ctrl: 'return', value: 'completed' }] },
        { ctrl: 'wait', ms: 5 }
      ] }
    ] }
  }
  const task = makeTask(script, { durationMinutes: 0.0001 }) // 0.006s
  task.startedAt = Date.now() - 1000 // 模拟已运行 1s（超过 deadline）
  await task.start()
  assert.equal(task.state, 'completed', 'deadline 到 → 自然完成')
})

// ---- afk 脚本 ----

test('afk 脚本: 周期 wait + look 转动（wiggles 计数）', async () => {
  const looks = []
  const ctx = makeCtx({ look: (yaw) => looks.push(yaw) })
  const { default: afkScript } = await import('../src/tasks/scripts/afk.js')
  const task = makeTask(afkScript, { intervalMinutes: 0.0001 }, ctx) // 直构造不走 schema（task-schemas 要求 ≥1）
  task.start()
  await new Promise(r => setTimeout(r, 30))
  await task.stop()
  assert.ok(looks.length >= 1, `afk 应至少转动一次视角: ${looks.length}`)
  assert.ok(task.counters.wiggles >= 1, 'wiggles 计数')
})

test('afk 脚本: intervalMinutes 缺省/非法 → init 校验（task-schemas 已拦，防御）', async () => {
  const { default: afkScript } = await import('../src/tasks/scripts/afk.js')
  const task = makeTask(afkScript, {})
  // options 校验在 task-schemas（manager 入口拦截）；此处验证脚本对缺省值不抛
  task.startedAt = Date.now()
  task.start()
  await new Promise(r => setImmediate(r))
  await task.stop()
})

// ---- fish 脚本 ----

test('fish 脚本: 背包满（stopWhenInventoryFull）→ 自然完成', async () => {
  const slots = Array.from({ length: 34 }, () => ({ type: 1, count: 1 }))
  const items = Array.from({ length: 34 }, (_, i) => ({ name: 'fish' + i, count: 1 }))
  const ctx = makeCtx({ inventory: { slots, items: () => items } })
  const { default: fishScript } = await import('../src/tasks/scripts/fish.js')
  const task = makeTask(fishScript, { durationMinutes: 10, stopWhenInventoryFull: true }, ctx)
  await task.start()
  assert.equal(task.state, 'completed', '背包满 → 完成')
})

test('fish 脚本: 时长到 → 自然完成（deadline）', async () => {
  const ctx = makeCtx()
  const { default: fishScript } = await import('../src/tasks/scripts/fish.js')
  // startedAt 由 BaseTask.run() 设置——durationMinutes 用微值（~12ms）等真实到期
  const task = makeTask(fishScript, { durationMinutes: 0.0002, stopWhenInventoryFull: false }, ctx)
  await new Promise(r => setTimeout(r, 10)) // 确保 deadline 条件先于循环启动
  await task.start()
  assert.equal(task.state, 'completed', 'deadline → 完成')
})

test('fish 脚本: 抛竿失败 → 软失败 + 5s 等待后重试（不中断）', async () => {
  let fishCalls = 0
  const ctx = makeCtx({
    fish: async () => { fishCalls++; throw new Error('fish timeout') }
  })
  const { default: fishScript } = await import('../src/tasks/scripts/fish.js')
  const task = makeTask(fishScript, { durationMinutes: 10, stopWhenInventoryFull: false }, ctx)
  task.start()
  await new Promise(r => setTimeout(r, 30))
  await task.stop()
  assert.ok(fishCalls >= 1, 'fish 至少调用一次')
  assert.ok(task.state === 'running' || task.state === 'stopped', `失败不应 fail 任务（当前 ${task.state}）`)
})
