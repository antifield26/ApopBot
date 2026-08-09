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
    blockAt: (p) => ({ boundingBox: 'empty', name: 'air', position: p }), // Block 契约：collectblock 读 target.position
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
  // collect_blocks 按 Block 契约转 blockAt（collectblock 读 target.position）
  assert.equal(seen[0][0].position.x, 5)
  assert.equal(seen[0][0].position.y, 63)
  assert.equal(seen[0][0].position.z, 0)
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

// ---- mine/chop 脚本（v1.0.0 C7）----

function makeCollectBot (opts = {}) {
  const collects = []
  const mined = new Set() // 已挖位置（fake 世界状态——collect 后候选消失）
  const pool = [
    { p: new Vec3(10, 63, 0), type: 44 }, // iron_ore
    { p: new Vec3(10, 64, 0), type: 55 }, // oak_log
    { p: new Vec3(12, 64, 0), type: 55 }, // oak_log
    { p: new Vec3(14, 64, 0), type: 56 }  // oak_wood
  ]
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { blocksByName: { iron_ore: { id: 44 }, oak_log: { id: 55 }, oak_wood: { id: 56 } } },
    findBlocks: ({ matching }) => pool
      .filter(c => matching({ type: c.type }) && !mined.has(c.p.x + ',' + c.p.y + ',' + c.p.z))
      .map(c => c.p),
    blockAt: (p) => {
      if (opts.emptyWorld === true) return null
      // 地表语义：y≥64 是空气（isSurfaceAt 要求上方 2 格空/透明——
      // iron_ore@63 上方 64/65；oak_log@64 上方 65/66）
      if (p.y >= 64) return { boundingBox: 'empty', name: 'air', position: p }
      return { boundingBox: 'solid', name: 'ore', position: p, type: p.y === 63 ? 44 : 55 }
    },
    collectBlock: {
      collect: async (batch, _opts) => {
        collects.push(batch)
        for (const b of batch) mined.add(b.position.x + ',' + b.position.y + ',' + b.position.z)
        if (opts.noChests === true) {
          const err = new Error('No chests')
          err.code = 'NoChests'
          throw err
        }
        return { collected: batch.length }
      },
      cancelTask: () => {}
    },
    pathfinder: { stop: () => {} },
    once: () => {},
    removeListener: () => {}
  }
  return { bot, collects }
}

test('mine 脚本: 扫描→收集循环（counters.mined 累计）', async () => {
  const { bot, collects } = makeCollectBot()
  const ctx = makeCtx(bot)
  const { default: mineScript } = await import('../src/tasks/scripts/mine.js')
  const task = makeTask(mineScript, { blockTypes: ['iron_ore'], stopWhenDone: true }, ctx)
  await task.start()
  assert.equal(task.state, 'completed', 'stopWhenDone + 挖空 → 完成')
  assert.ok(collects.length >= 1, 'collect 被调用')
  assert.ok(task.counters.mined >= 1, `mined 计数: ${task.counters.mined}`)
})

test('mine 脚本: 无目标 + stopWhenDone=false → 5min 等待（不完成）', async () => {
  const { bot } = makeCollectBot({ emptyWorld: true })
  const ctx = makeCtx(bot)
  const { default: mineScript } = await import('../src/tasks/scripts/mine.js')
  const task = makeTask(mineScript, { blockTypes: ['iron_ore'] }, ctx)
  task.start()
  await new Promise(r => setTimeout(r, 30))
  assert.ok(task.state === 'running', '无目标且未 stopWhenDone → 保持运行（5min no-target 等待）')
  assert.ok(task.waitingReason === 'no-target' || task.waitingReason === 'script-wait', `等待原因: ${task.waitingReason}`)
  await task.stop()
})

test('mine 脚本: NoChests → inventoryFull → 5min 等待（不误判失败）', async () => {
  const { bot } = makeCollectBot({ noChests: true })
  const ctx = makeCtx(bot)
  const { default: mineScript } = await import('../src/tasks/scripts/mine.js')
  const task = makeTask(mineScript, { blockTypes: ['iron_ore'], stopWhenDone: true }, ctx)
  task.start()
  await new Promise(r => setTimeout(r, 30))
  assert.ok(task.state === 'running', '背包满 → 等待清空而非完成')
  assert.ok((task.counters.mined ?? 0) === 0, 'inventoryFull 不计 mined')
  await task.stop()
})

test('mine 脚本: init 校验——未知方块类型报错（failed）', async () => {
  const { bot } = makeCollectBot()
  const ctx = makeCtx(bot)
  const { default: mineScript } = await import('../src/tasks/scripts/mine.js')
  const task = makeTask(mineScript, { blockTypes: ['not_a_block'] }, ctx)
  await task.start()
  assert.equal(task.state, 'failed', 'init 校验失败 → failed')
  assert.ok(task.lastError.includes('未知方块类型'), task.lastError)
})

test('chop 脚本: 缺省正则（/_log$|_wood$/）扫描全部原木', async () => {
  const { bot, collects } = makeCollectBot()
  const ctx = makeCtx(bot)
  const { default: chopScript } = await import('../src/tasks/scripts/chop.js')
  const task = makeTask(chopScript, { stopWhenDone: true }, ctx)
  await task.start()
  assert.equal(task.state, 'completed', 'chop 完成')
  assert.ok(collects.length >= 1)
  assert.ok(task.counters.chopped >= 3, `chopped 计数（oak_log×2 + oak_wood×1）: ${task.counters.chopped}`)
})

test('chop 脚本: 显式 logTypes 只伐指定类型', async () => {
  const { bot, collects } = makeCollectBot()
  const ctx = makeCtx(bot)
  const { default: chopScript } = await import('../src/tasks/scripts/chop.js')
  const task = makeTask(chopScript, { logTypes: ['oak_log'], stopWhenDone: true }, ctx)
  await task.start()
  assert.equal(task.state, 'completed')
  assert.ok(collects.length >= 1)
  assert.equal(task.counters.chopped, 2, '只伐 oak_log×2（不伐 oak_wood）')
})

// ---- farm 脚本（v1.0.0 C8）----

/** farm 场景 fake bot：区域内有 1 块成熟小麦 + 1 块耕地。 */
function makeFarmBot (opts = {}) {
  const collects = []
  const planted = []
  let seeds = 10 // 种子库存（equip 后清零——fake 世界状态，验证种植优先于等待）
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { blocksByName: { wheat: { id: 59 }, farmland: { id: 60 } } },
    findBlocks: ({ matching }) => {
      // 候选池：小麦 (11,63,0) + 耕地 (10,62,0)——耕地正上方 (10,63,0) 必须空
      //（plant_crops 检查占用）
      const pool = [
        { p: new Vec3(11, 63, 0), type: 59 },
        { p: new Vec3(10, 62, 0), type: 60 }
      ]
      return pool.filter(c => matching({ type: c.type })).map(c => c.p)
    },
    blockAt: (p) => {
      if (p.x === 11 && p.y === 63) return { name: 'wheat', type: 59, boundingBox: 'solid', position: p, getProperties: () => ({ age: opts.mature !== false ? 7 : 3 }) }
      if (p.y === 62 && p.x === 10) return { name: 'farmland', type: 60, boundingBox: 'solid', position: p }
      return { boundingBox: 'empty', name: 'air', position: p }
    },
    inventory: { items: () => (seeds > 0 ? [{ name: 'wheat_seeds', count: seeds }] : []) },
    equip: async () => { seeds = 0 },
    placeBlock: async (ref) => { planted.push(ref.position) },
    collectBlock: {
      collect: async (batch) => { collects.push(batch); return { collected: batch.length } },
      cancelTask: () => {}
    },
    pathfinder: { stop: () => {} },
    once: () => {},
    removeListener: () => {}
  }
  return { bot, collects, planted }
}

const FARM_AREA = { x1: 0, y1: 0, z1: 0, x2: 20, y2: 100, z2: 20 }

test('farm 脚本: 成熟收割 → continue（不种植/不等待）→ 完成', async () => {
  const { bot, collects } = makeFarmBot()
  const ctx = makeCtx(bot)
  const { default: farmScript } = await import('../src/tasks/scripts/farm.js')
  const task = makeTask(farmScript, { area: FARM_AREA, cropTypes: ['wheat'] }, ctx)
  await task.start()
  assert.equal(task.state, 'completed', '收割一轮后完成（maxCycles 默认 1）')
  assert.ok(collects.length >= 1, '成熟小麦被收割')
  assert.ok(task.counters.harvested >= 1, `harvested 计数: ${task.counters.harvested}`)
})

test('farm 脚本: 无成熟 → 种植（replant 默认）→ 未成熟 → 等待生长', async () => {
  const { bot, planted } = makeFarmBot({ mature: false })
  const ctx = makeCtx(bot)
  const { default: farmScript } = await import('../src/tasks/scripts/farm.js')
  const task = makeTask(farmScript, { area: FARM_AREA, cropTypes: ['wheat'], growthCheckSeconds: 1, maxCycles: 2 }, ctx) // 2 轮：第 1 轮种植，第 2 轮 growing——1s 等待 50ms 检查时仍在
  task.start()
  await new Promise(r => setTimeout(r, 50))
  assert.ok(planted.length >= 1, '耕地被种植（wheat_seeds）')
  assert.ok(task.waitingReason === 'growing' || task.state === 'running', `等待生长: ${task.waitingReason}`)
  await task.stop()
})

test('farm 脚本: replant=false → 不种植；stopWhenIdle → 完成', async () => {
  const { bot, planted } = makeFarmBot({ mature: false })
  const ctx = makeCtx(bot)
  const { default: farmScript } = await import('../src/tasks/scripts/farm.js')
  const task = makeTask(farmScript, { area: FARM_AREA, cropTypes: ['wheat'], replant: false, stopWhenIdle: true, growthCheckSeconds: 0.01 }, ctx)
  await task.start()
  assert.equal(task.state, 'completed', '空闲 + stopWhenIdle → 完成')
  assert.equal(planted.length, 0, 'replant=false 不种植')
})

test('farm 脚本: init 校验——未知作物报错（failed）', async () => {
  const { bot } = makeFarmBot()
  const ctx = makeCtx(bot)
  const { default: farmScript } = await import('../src/tasks/scripts/farm.js')
  const task = makeTask(farmScript, { area: FARM_AREA, cropTypes: ['dragon_fruit'] }, ctx)
  await task.start()
  assert.equal(task.state, 'failed')
  assert.ok(task.lastError.includes('未知作物'), task.lastError)
})

// ---- combat/breed 脚本（v1.0.0 C9）----

function makeCombatBot (opts = {}) {
  const packets = []
  const entities = new Map()
  const hostile = { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(3, 64, 0), height: 1.8 }
  entities.set(1, hostile)
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    health: 20,
    entities,
    nearestEntity: () => null,
    registry: { entitiesArray: [{ id: 1, type: 'hostile' }], blocksByName: {} },
    pathfinder: { setGoal: () => {}, stop: () => {} },
    inventory: { items: () => [{ name: 'iron_sword', count: 1 }] },
    equip: async () => {},
    autoEat: { eat: async () => {} },
    lookAt: () => {},
    _client: { write: (name, params) => { packets.push({ name, ...params }); if (name === 'attack') entities.delete(1) } }, // 一击击杀
    chat: () => {},
    once: () => {},
    removeListener: () => {},
    ...(opts.bot ?? {})
  }
  return { bot, packets }
}

test('combat 脚本: 无目标 + stopWhenNoTargets → 完成', async () => {
  const { bot } = makeCombatBot({ bot: { entities: new Map() } })
  const ctx = makeCtx(bot)
  const { default: combatScript } = await import('../src/tasks/scripts/combat.js')
  const task = makeTask(combatScript, { stopWhenNoTargets: true }, ctx)
  await task.start()
  assert.equal(task.state, 'completed', '无目标 + stopWhenNoTargets → 完成')
})

test('combat 脚本: 击杀 → kills 计数 → maxTargets 上限完成', async () => {
  const { bot, packets } = makeCombatBot()
  const ctx = makeCtx(bot)
  const { default: combatScript } = await import('../src/tasks/scripts/combat.js')
  const task = makeTask(combatScript, { maxTargets: 1, checkIntervalSeconds: 0.01 }, ctx)
  await task.start()
  assert.equal(task.state, 'completed', '击杀 1 个（maxTargets 1）→ 完成')
  assert.equal(task.counters.kills, 1, 'kills 计数')
  assert.equal(packets.filter(p => p.name === 'attack').length, 1, '应发攻击包（entity-actions 原始包）')
})

test('combat 脚本: 武器自动装备（init 钩子解析背包第一把剑）', async () => {
  const { bot } = makeCombatBot({ bot: { entities: new Map() } })
  const equipped = []
  bot.equip = async (item) => { equipped.push(item.name) }
  const ctx = makeCtx(bot)
  const { default: combatScript } = await import('../src/tasks/scripts/combat.js')
  const task = makeTask(combatScript, { stopWhenNoTargets: true }, ctx)
  await task.start()
  assert.ok(equipped.includes('iron_sword'), `应自动装备剑: ${JSON.stringify(equipped)}`)
})

test('combat 脚本: init 校验——aggroRange < attackRange 报错（配置陷阱）', async () => {
  const { bot } = makeCombatBot()
  const ctx = makeCtx(bot)
  const { default: combatScript } = await import('../src/tasks/scripts/combat.js')
  const task = makeTask(combatScript, { aggroRange: 2, attackRange: 5 }, ctx)
  await task.start()
  assert.equal(task.state, 'failed')
  assert.ok(task.lastError.includes('aggroRange'), task.lastError)
})

test('breed 脚本: 无动物 + stopWhenNoAnimals → 完成', async () => {
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } }, entities: new Map(), pathfinder: { stop: () => {} }, inventory: { items: () => [] } }
  const ctx = makeCtx(bot)
  const { default: breedScript } = await import('../src/tasks/scripts/breed.js')
  const task = makeTask(breedScript, { stopWhenNoAnimals: true }, ctx)
  await task.start()
  assert.equal(task.state, 'completed', '无动物 + stopWhenNoAnimals → 完成')
})

test('breed 脚本: 喂食成功 → 等待幼崽 → breedings 计数', async () => {
  const animals = new Map()
  const cow = { id: 1, name: 'cow', type: 'animal', position: { x: 2, y: 64, z: 0 }, height: 1.3 }
  animals.set(1, cow)
  const packets = []
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: animals,
    pathfinder: { stop: () => {} },
    inventory: { items: () => [{ name: 'wheat', count: 10 }] },
    equip: async () => {},
    lookAt: () => {},
    _client: { write: (name, params) => { packets.push({ name, ...params }); if (name === 'use_entity') animals.delete(1) } }, // 喂食后目标替换（幼崽）
    chat: () => {},
    once: () => {},
    removeListener: () => {}
  }
  const ctx = makeCtx(bot)
  const { default: breedScript } = await import('../src/tasks/scripts/breed.js')
  const task = makeTask(breedScript, { maxBreedings: 1, useCooldownMs: 500 }, ctx) // schema min 500
  await task.start()
  assert.equal(task.state, 'completed', '繁殖 1 次（maxBreedings 1）→ 完成')
  assert.equal(task.counters.breedings, 1, 'breedings 计数（targetGone）')
  assert.ok(packets.some(p => p.name === 'use_entity'), '应发 use_entity 包（entity-actions 原始包）')
})

// ---- explore 脚本（v1.0.0 C10：任务局部 op spiral_step）----

test('explore 脚本: 螺旋一站推进（goto + 锚点登记 + waypoints 计数）', async () => {
  const anchors = []
  const { default: exploreScript } = await import('../src/tasks/scripts/explore.js')
  const discovery = await import('../src/core/discovery.js')
  discovery._reset()
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (p) => (p.y <= 64 ? { boundingBox: 'solid', name: 'stone', position: p } : { boundingBox: 'empty', name: 'air', position: p }),
    pathfinder: { setGoal: () => {}, stop: () => {}, goto: async () => {} },
    findBlocks: () => [],
    once: () => {},
    removeListener: () => {}
  }
  const ctx = makeCtx(bot)
  const task = makeTask(exploreScript, { checkIntervalSeconds: 0.01, maxDistance: 64 }, ctx)
  task.start()
  await new Promise(r => setTimeout(r, 50))
  assert.ok(task.counters.waypoints >= 1, `应至少访问 1 站: ${JSON.stringify(task.counters)}`)
  assert.ok(task.state === 'running', '探索持续运行（无 stopWhenDone）')
  await task.stop()
  assert.ok(discovery.query('iron_ore', null, 5).length >= 0, '锚点登记不抛错')
  discovery._reset()
})

test('explore 脚本: stopWhenDone 环满 → 自然完成', async () => {
  const { default: exploreScript } = await import('../src/tasks/scripts/explore.js')
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (p) => (p.y <= 64 ? { boundingBox: 'solid', name: 'stone', position: p } : { boundingBox: 'empty', name: 'air', position: p }),
    pathfinder: { setGoal: () => {}, stop: () => {}, goto: async () => {} },
    findBlocks: () => [],
    once: () => {},
    removeListener: () => {}
  }
  const ctx = makeCtx(bot)
  // maxDistance 极小时 spiralWaypoints 立即超限 → 空环 → stopWhenDone 完成
  const task = makeTask(exploreScript, { stopWhenDone: true, maxDistance: 1, checkIntervalSeconds: 0.01 }, ctx)
  await task.start()
  assert.equal(task.state, 'completed', '环满 + stopWhenDone → 完成')
})
