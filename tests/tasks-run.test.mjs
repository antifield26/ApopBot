// 任务 run 主循环回归测试（阶段 0 测试安全网：此前 6 类任务只测 init，主循环零覆盖）。
// 风格：注入 stub bot（不 mock mineflayer），用"有限工作负载"驱动自然完成，
// 或 fire-and-forget 启动后 stop() 打断（_internalWait 可被 stop 唤醒，测试不用等长等待）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { MineTask } from '../src/tasks/mine.js'
import { FishTask } from '../src/tasks/fish.js'
import { FarmTask } from '../src/tasks/farm.js'
import { ChopTask } from '../src/tasks/chop.js'
import { CombatTask } from '../src/tasks/combat.js'
import { BreedTask } from '../src/tasks/breed.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (bot) {
  return { bot, logger: makeLogger(), config: {} }
}

/** 让事件循环跑几轮微任务/setImmediate（不推进真实 timer）。 */
async function settle (n = 3) {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r))
}

const AREA1 = { x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 0 } // 1×1×1 小区域

// ---- MineTask ----

test('mine run: 背包满（NoChests）→ 等待清空，stop 打断退出', async () => {
  const bot = {
    registry: { blocksByName: { iron_ore: { id: 44 } } },
    collectBlock: {
      collect: async () => { throw Object.assign(new Error('no chest locations'), { code: 'NoChests' }) },
      cancelTask () {}
    },
    pathfinder: { stop () {} },
    findBlocks: () => [new Vec3(5, 5, 5)],
    blockAt: (p) => ({ position: p, type: 44 })
  }
  const task = new MineTask('m', 'mine', { blockTypes: ['iron_ore'] }, makeCtx(bot))
  const p = task.start()
  await settle(6)
  assert.equal(task.waitingReason, 'inventory-full', 'NoChests 应进入背包满等待而非 30s 误报')
  assert.equal(task.counters.mined ?? 0, 0)
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

test('mine run: collect 中断 → 重试等待，stop 打断', async () => {
  const bot = {
    registry: { blocksByName: { iron_ore: { id: 44 } } },
    collectBlock: {
      collect: async () => { throw new Error('path unreachable') },
      cancelTask () {}
    },
    pathfinder: { stop () {} },
    findBlocks: () => [new Vec3(5, 5, 5)],
    blockAt: (p) => ({ position: p, type: 44 })
  }
  const task = new MineTask('m', 'mine', { blockTypes: ['iron_ore'] }, makeCtx(bot))
  const p = task.start()
  await settle(6)
  assert.equal(task.waitingReason, 'collect-retry')
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

test('C4/J 修复：pause 打断 collect 批次（批间检查，不再等整批 64 块完成）', async () => {
  const collectCalls = []
  const bot = {
    registry: { blocksByName: { iron_ore: { id: 44 } } },
    collectBlock: {
      // 1ms 真实延时：瞬时 resolve 会让循环形成纯微任务链饿死 macrotask（setImmediate
      // 永不执行 → 测试挂起）——真实 collect 耗时数秒，不存在该问题，fake 需让出事件循环
      collect: async (blocks) => { await new Promise(r => setTimeout(r, 1)); collectCalls.push(blocks.length) },
      cancelTask () {}
    },
    pathfinder: { stop () {} },
    findBlocks: () => [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => new Vec3(i, 64, 0)), // 9 块
    blockAt: (p) => ({ position: p, type: 44 })
  }
  const task = new MineTask('m', 'mine', { blockTypes: ['iron_ore'] }, makeCtx(bot))
  const p = task.start()
  const waitMs = (ms) => new Promise(r => setTimeout(r, ms))
  await waitMs(50) // 足够 2+ 批（每批 collect 1ms + 循环）
  assert.ok(collectCalls.length >= 1, '应分批 collect')
  assert.ok(collectCalls.every(n => n <= 4), `每批不得超过 4 块: ${collectCalls}`)
  await task.pause()
  await waitMs(30) // 在途批次完成
  const callsAtPause = collectCalls.length
  await waitMs(50)
  assert.equal(collectCalls.length, callsAtPause, '暂停后不应继续收集')
  await task.resume()
  await waitMs(50)
  assert.ok(collectCalls.length > callsAtPause, '恢复后应继续收集')
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

test('C8/R 修复：farm 区域超出扫描半径 → 告警而非静默 idle（anchor 改区域中心）', async () => {
  const warns = []
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { wheat: { id: 1 } } },
    findBlocks: () => [],
    blockAt: () => null
  }
  const logger = { child: () => logger, info () {}, warn: (o, m) => warns.push(m), error () {}, debug () {} }
  const task = new FarmTask('f', 'farm', {
    area: { x1: 1000, y1: 64, z1: 1000, x2: 1010, y2: 64, z2: 1010 }, cropTypes: ['wheat']
  }, { bot, logger, config: {} })
  const p = task.start()
  await new Promise(r => setTimeout(r, 50))
  assert.ok(warns.some(w => w.includes('超出扫描半径')), `应有距离告警: ${warns}`)
  await task.stop()
  await p
})

test('C8/R 修复：mine 区域超出扫描半径 → 告警（同 farm 同款）', async () => {
  const warns = []
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { iron_ore: { id: 44 } } },
    findBlocks: () => [],
    blockAt: () => null,
    collectBlock: { collect: async () => {}, cancelTask () {} },
    pathfinder: { stop () {} }
  }
  const logger = { child: () => logger, info () {}, warn: (o, m) => warns.push(m), error () {}, debug () {} }
  const task = new MineTask('m', 'mine', {
    blockTypes: ['iron_ore'],
    area: { x1: 1000, y1: 64, z1: 1000, x2: 1010, y2: 64, z2: 1010 }
  }, { bot, logger, config: {} })
  const p = task.start()
  await new Promise(r => setTimeout(r, 50))
  assert.ok(warns.some(w => w.includes('超出扫描半径')), `应有距离告警: ${warns}`)
  await task.stop()
  await p
})

// ---- FishTask ----

test('fish run: 背包满停止（不再抛竿）', async () => {
  let fishCalls = 0
  const bot = { fish: async () => { fishCalls++ }, inventory: { slots: Array(36).fill({}) } }
  const task = new FishTask('f', 'fish', { durationMinutes: 1, stopWhenInventoryFull: true }, makeCtx(bot))
  await task.start()
  assert.equal(task.state, 'completed')
  assert.equal(fishCalls, 0, '背包满时不应抛竿')
})

test('fish run: stop 立即打断挂起的 bot.fish()（不再等 10s stop 上限）', async () => {
  let resolveFish
  const bot = { fish: () => new Promise(r => { resolveFish = r }), inventory: { slots: [] } }
  const task = new FishTask('f', 'fish', { durationMinutes: 1 }, makeCtx(bot))
  const p = task.start()
  await settle(6)
  assert.equal(task.state, 'running', 'fish() 挂起时任务应保持 running')
  const t0 = Date.now()
  await task.stop()
  assert.ok(Date.now() - t0 < 5000, '取消信号应让 run 立即退出（修复前 stop 等 10s 上限）')
  await p
  assert.equal(task.state, 'stopped')
  resolveFish() // 清理悬空 promise（race 丢弃分支的 rejection 已挂 noop catch）
  await settle(2)
})

test('fish run: 抛竿失败 → 计数不变，stop 打断重试等待', async () => {
  let fishCalls = 0
  const bot = {
    fish: async () => { fishCalls++; throw new Error('reeled too fast') },
    inventory: { slots: [] }
  }
  const task = new FishTask('f', 'fish', { durationMinutes: 1 }, makeCtx(bot))
  const p = task.start()
  await settle(6)
  assert.ok(fishCalls >= 1)
  assert.equal(task.counters.caught ?? 0, 0)
  assert.equal(task.waitingReason, 'fish-retry')
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

// ---- FarmTask ----

test('farm run: 区域空 + stopWhenIdle:true → 自然完成', async () => {
  const bot = {
    registry: { blocksByName: { wheat: { id: 1 } } },
    collectBlock: {},
    pathfinder: {},
    findBlocks: () => [],
    blockAt: (p) => ({ position: p, name: 'air', type: 0 })
  }
  const task = new FarmTask('fm', 'farm', { area: AREA1, cropTypes: ['wheat'], stopWhenIdle: true }, makeCtx(bot))
  await task.start()
  assert.equal(task.state, 'completed')
  assert.equal(task.counters.harvested ?? 0, 0)
})

test('farm run: 默认巡逻——区域空时等待不完成（stop 打断）', async () => {
  const bot = {
    registry: { blocksByName: { wheat: { id: 1 } } },
    collectBlock: {},
    pathfinder: {},
    findBlocks: () => [],
    blockAt: (p) => ({ position: p, name: 'air', type: 0 })
  }
  const task = new FarmTask('fm', 'farm', { area: AREA1, cropTypes: ['wheat'], growthCheckSeconds: 1 }, makeCtx(bot))
  const p = task.start()
  await new Promise(r => setTimeout(r, 1500)) // 跨过 idle 等待（1s）
  assert.equal(task.state, 'running', '区域空闲默认应巡逻等待而非秒完成')
  assert.equal(task.waitingReason, 'idle')
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

test('farm run: 收割成熟作物 → 计数 → 完成后停止', async () => {
  let mature = true
  const bot = {
    registry: { blocksByName: { wheat: { id: 1 } } },
    collectBlock: { collect: async () => { mature = false }, cancelTask () {} },
    pathfinder: { stop () {} },
    findBlocks: () => (mature ? [new Vec3(0, 64, 0)] : []),
    blockAt: () => mature
      ? { name: 'wheat', type: 1, getProperties: () => ({ age: 7 }) }
      : { name: 'air', type: 0 },
    inventory: { items: () => [] },
    equip: async () => {},
    placeBlock: async () => {}
  }
  const task = new FarmTask('fm', 'farm', { area: AREA1, cropTypes: ['wheat'] }, makeCtx(bot))
  await task.start()
  assert.equal(task.state, 'completed')
  assert.equal(task.counters.harvested, 1, '成熟作物应收割一次')
})

test('farm run: 种植（equip + placeBlock）→ planted 计数', async () => {
  const actions = []
  const bot = {
    registry: { blocksByName: { wheat: { id: 1 }, farmland: { id: 3 } } },
    collectBlock: {},
    pathfinder: {},
    findBlocks: () => [new Vec3(0, 64, 0)],
    blockAt: () => ({ name: 'farmland', type: 3 }),
    inventory: { items: () => [{ name: 'wheat_seeds' }] },
    equip: async (it) => { actions.push(['equip', it.name]) },
    placeBlock: async (soil) => { actions.push(['place', soil.name]) }
  }
  const task = new FarmTask('fm', 'farm', { area: AREA1, cropTypes: ['wheat'], maxCycles: 1 }, makeCtx(bot))
  await task.start()
  assert.equal(task.state, 'completed')
  assert.equal(task.counters.planted, 1)
  assert.deepEqual(actions.map(a => a[0]), ['equip', 'place'], '种植应为先装备种子再放置')
})

// ---- ChopTask ----

test('chop run: 背包满（NoChests）→ 等待清空，stop 打断', async () => {
  const bot = {
    registry: { blocksByName: { oak_log: { id: 10 } } },
    collectBlock: {
      collect: async () => { throw Object.assign(new Error('no chest'), { code: 'NoChests' }) },
      cancelTask () {}
    },
    pathfinder: { stop () {} },
    findBlocks: () => [new Vec3(0, 64, 0)], // 必须在 AREA1 区域内，否则被区域过滤 → 自然完成
    blockAt: (p) => ({ position: p, type: 10 })
  }
  const task = new ChopTask('c', 'chop', { area: AREA1 }, makeCtx(bot))
  const p = task.start()
  await settle(6)
  assert.equal(task.waitingReason, 'inventory-full')
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

// ---- CombatTask ----

test('combat run: 无目标 + stopWhenNoTargets:true → 自然完成', async () => {
  const bot = new EventEmitter()
  Object.assign(bot, {
    pathfinder: { setGoal: () => {}, stop () {} },
    entity: { position: new Vec3(0, 64, 0) },
    health: 20,
    nearestEntity: () => null,
    registry: { entitiesArray: [] }
  })
  const task = new CombatTask('cb', 'combat', { stopWhenNoTargets: true }, makeCtx(bot))
  await task.start()
  assert.equal(task.state, 'completed')
})

test('combat run: 默认巡逻——无怪时持续等待不完成（stop 打断）', async () => {
  const bot = new EventEmitter()
  Object.assign(bot, {
    pathfinder: { setGoal: () => {}, stop () {} },
    entity: { position: new Vec3(0, 64, 0) },
    health: 20,
    nearestEntity: () => null,
    registry: { entitiesArray: [] }
  })
  const task = new CombatTask('cb', 'combat', {}, makeCtx(bot))
  const p = task.start()
  await new Promise(r => setTimeout(r, 3500)) // 跨过一轮 no-target 等待（3s）
  assert.equal(task.state, 'running', '无怪时默认应巡逻等待而非完成')
  assert.equal(task.waitingReason, 'no-target')
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

test('combat run: 攻击 → entityGone 击杀 → maxTargets 完成', async () => {
  const attacks = []
  const hostile = { id: 1, type: 'hostile', position: new Vec3(1, 64, 0) } // 距离 1 < attackRange 3.5
  const bot = new EventEmitter()
  Object.assign(bot, {
    pathfinder: { setGoal: () => {}, stop () {} },
    entity: { position: new Vec3(0, 64, 0) },
    health: 20,
    autoEat: {},
    inventory: { items: () => [] },
    equip: async () => {},
    attack: (t) => attacks.push(t),
    nearestEntity: (filter) => (filter(hostile) ? hostile : null)
  })
  const task = new CombatTask('cb', 'combat', { maxTargets: 1, attackCooldownMs: 0 }, makeCtx(bot))
  const p = task.start()
  // 第 1 轮：找目标 → 攻击 → 循环尾 500ms 扫描等待（真实 timer）
  await new Promise(r => setTimeout(r, 700))
  assert.ok(attacks.length >= 1, '接近后应发起攻击')
  bot.emit('entityGone', hostile) // 击杀 → kills=1 → 下一轮循环条件退出
  await p
  assert.equal(task.state, 'completed')
  assert.equal(task.counters.kills, 1)
  assert.ok(task.counters.attacks >= 1, '应至少发起一次攻击')
})

test('C5/Q 修复：低血撤退——敌人同格（零向量）→ 不构造 NaN 目标，原地等待', async () => {
  let gotoCalls = 0
  const bot = new EventEmitter()
  Object.assign(bot, {
    pathfinder: { setGoal: () => {}, stop () {}, goto: () => { gotoCalls++; return Promise.resolve() } },
    entity: { position: new Vec3(0, 64, 0) },
    health: 2, // 低于 minHealth 8 → 走低血处理
    autoEat: { eat: async () => { throw new Error('no food') } }, // 进食失败 → 撤退分支
    inventory: { items: () => [] },
    nearestEntity: () => ({ type: 'hostile', position: new Vec3(0, 64, 0) }), // 与 bot 同格
    registry: { entitiesArray: [] }
  })
  const task = new CombatTask('cb', 'combat', {}, makeCtx(bot))
  const p = task.start()
  await new Promise(r => setTimeout(r, 100))
  assert.equal(gotoCalls, 0, '零向量不得构造 NaN 撤退目标')
  assert.equal(task.waitingReason, 'retreat-low-health')
  await task.stop()
  await p
})

// ---- BreedTask ----

test('breed run: 无动物 + stopWhenNoAnimals:true → 自然完成', async () => {
  const bot = new EventEmitter()
  Object.assign(bot, {
    pathfinder: { setGoal: () => {}, stop () {} },
    entity: { position: new Vec3(0, 64, 0) },
    nearestEntity: () => null
  })
  const task = new BreedTask('br', 'breed', { stopWhenNoAnimals: true }, makeCtx(bot))
  await task.start()
  assert.equal(task.state, 'completed')
})

test('breed run: 默认巡逻——无动物时等待不完成（stop 打断）', async () => {
  const bot = new EventEmitter()
  Object.assign(bot, {
    pathfinder: { setGoal: () => {}, stop () {} },
    entity: { position: new Vec3(0, 64, 0) },
    nearestEntity: () => null
  })
  const task = new BreedTask('br', 'breed', {}, makeCtx(bot))
  const p = task.start()
  await new Promise(r => setTimeout(r, 100))
  assert.equal(task.state, 'running', '无动物默认应巡逻等待而非秒完成')
  assert.equal(task.waitingReason, 'no-animal')
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

test('breed run: 喂食两次（equip + useOn×2）→ fed 计数，stop 打断幼崽等待', async () => {
  const actions = []
  const cow = { id: 1, name: 'cow', position: new Vec3(2, 64, 0) } // 距离 2 ≤ 3 → approach 立即
  const bot = new EventEmitter()
  Object.assign(bot, {
    pathfinder: { setGoal: () => {}, stop () {} },
    entity: { position: new Vec3(0, 64, 0) },
    nearestEntity: (filter) => (filter(cow) ? cow : null),
    inventory: { items: () => [{ name: 'wheat' }] },
    equip: async (it) => { actions.push(['equip', it.name]) },
    useOn: (a) => { actions.push(['useOn', a.id]) }
  })
  const task = new BreedTask('br', 'breed', { maxBreedings: 4, useCooldownMs: 0 }, makeCtx(bot))
  const p = task.start()
  // useCooldownMs=0 的间隔是真实 setTimeout(0)——setImmediate 不推进 timer 阶段，须真实等几 ms
  await new Promise(r => setTimeout(r, 30))
  await settle(3) // approach → feed（equip + useOn×2）→ 进入 5s 幼崽等待
  assert.equal(task.counters.fed, 2, '应喂食两次')
  assert.deepEqual(actions.map(a => a[0]), ['equip', 'useOn', 'useOn'])
  assert.equal(task.waitingReason, 'waiting-baby')
  await task.stop() // 打断 5s 等待
  await p
  assert.equal(task.state, 'stopped')
})

test('chop run: 默认巡逻——无树时等待不完成（stop 打断）', async () => {
  const bot = {
    registry: { blocksByName: { oak_log: { id: 10 } } },
    collectBlock: {},
    pathfinder: {},
    findBlocks: () => [],
    blockAt: (p) => ({ position: p, type: 10 })
  }
  const task = new ChopTask('c', 'chop', { area: AREA1 }, makeCtx(bot))
  const p = task.start()
  await new Promise(r => setTimeout(r, 50))
  assert.equal(task.state, 'running', '无树默认应巡逻等待（树会重新长）而非秒完成')
  assert.equal(task.waitingReason, 'no-target')
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

test('chop run: stopWhenDone:true → 无树自然完成', async () => {
  const bot = {
    registry: { blocksByName: { oak_log: { id: 10 } } },
    collectBlock: {},
    pathfinder: {},
    findBlocks: () => [],
    blockAt: (p) => ({ position: p, type: 10 })
  }
  const task = new ChopTask('c', 'chop', { area: AREA1, stopWhenDone: true }, makeCtx(bot))
  await task.start()
  assert.equal(task.state, 'completed')
})
