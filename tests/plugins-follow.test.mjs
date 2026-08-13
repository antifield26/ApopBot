// follow 插件回归测试（混合跟随实现：近距离 setControlState 直接控制 + 跳跃，
// 卡住/远距切 pathfinder 绕行——GoalFollow 不跳跃会丢失目标，实测修复）。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { followPlugin } from '../src/plugins/follow.js'

/**
 * @param {Vec3} [pos]
 * @param {(pos: Vec3) => object|null} [blockAtImpl] 前方方块检测（跳跃判定用）；
 *   默认返回空气（不触发跳跃），非虚空（不触发切寻路）
 */
function makeBot (pos = new Vec3(0, 64, 0), blockAtImpl) {
  const bot = new EventEmitter()
  bot.controls = {}
  bot.entity = { position: pos }
  bot.setGoalCalls = []
  bot.pathfinder = { setGoal: (g) => bot.setGoalCalls.push(g) }
  bot.setControlState = (k, v) => { bot.controls[k] = v }
  bot.lookAt = async () => {}
  bot.blockAt = blockAtImpl ?? (() => ({ boundingBox: 'empty', name: 'air' })) // 前方默认空（不跳）
  bot.messages = []
  bot.chat = (m) => bot.messages.push(m) // C1：entityGone 提示走 sendChat
  followPlugin(bot)
  return bot
}

/** 前方实心方块（台阶/墙）的 blockAt 实现。 */
function solidAhead (pos) {
  const x = Math.floor(pos.x)
  const y = Math.floor(pos.y)
  const z = Math.floor(pos.z)
  // 前方 1 格（与 Bot 同 y 层）实心，其余返回空气
  return (x === 1 && y === 64 && z === 0)
    ? { boundingBox: 'block', name: 'stone' }
    : { boundingBox: 'empty', name: 'air' }
}

/** 启用 mock timers（默认 setInterval；Date 需显式——冷却判断用模拟时钟）。 */
function useMockTimers (t, apis = ['setInterval']) {
  mock.timers.enable({ apis })
  t.after(() => mock.timers.reset())
}

test('follow: 目标在直接控制范围内 → 前进（forward=true）', (t) => {
  useMockTimers(t)
  const bot = makeBot()
  const player = { id: 7, position: new Vec3(3, 64, 0) } // 距离 3 > REACH 2.5
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.forward, true, '应持续前进')
  assert.equal(bot.setGoalCalls.filter(g => g !== null).length, 0, '近距离不创建寻路目标（setGoal(null) 是清残留，不计）')
})

test('follow: 前方有实心方块（台阶/墙）→ 跳跃（按移动方向方块判定，非目标高度）', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0), solidAhead)
  const player = { id: 7, position: new Vec3(3, 64, 0) } // 目标同高度——但前方 1 格是台阶
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.forward, true)
  assert.equal(bot.controls.jump, true, '前方有障碍应跳跃（目标高度差不足以判定）')
})

test('follow: 前方空 → 不跳跃（即使目标在远处高处——不再无效跳跃）', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0)) // 前方默认空气
  const player = { id: 7, position: new Vec3(3, 65.8, 0) } // 目标 y 差 1.8 但前方无阻挡
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.forward, true)
  assert.equal(bot.controls.jump, false, '前方无阻挡不应因目标高度差而跳')
})

test('follow: 距离 ≤ REACH → 停止移动', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0))
  const player = { id: 7, position: new Vec3(2, 64, 0) } // 距离 2 ≤ 2.5
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.forward, false)
})

test('follow: 原地卡住（3s 无位移）→ 切 pathfinder 绕行', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0))
  const player = { id: 7, position: new Vec3(5, 64, 0) }
  bot.follow.setTarget(player)
  // 前 3 轮 tick 位置不变 → 卡住计数 3（< STUCK_TICKS 6）仍直接控制
  for (let i = 0; i < 3; i++) mock.timers.tick(500)
  assert.equal(bot.controls.forward, true, '3s 内仍是直接控制')
  // 第 6 轮 → 卡住 → 停止移动并创建寻路目标
  for (let i = 0; i < 3; i++) mock.timers.tick(500)
  assert.equal(bot.controls.forward, false, '卡住后停止直接控制')
  assert.ok(bot.setGoalCalls.length >= 1, '卡住后应切 pathfinder 绕行')
})

test('follow: 前方 2 格虚空 → 直接切寻路（防直走掉落）', (t) => {
  useMockTimers(t)
  const bot = makeBot()
  bot.blockAt = () => null // 前方无地面
  const player = { id: 7, position: new Vec3(3, 64, 0) }
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.forward, false, '前方虚空不应直走')
  assert.ok(bot.setGoalCalls.length >= 1)
})

test('follow: stop 停止控制并清除目标', (t) => {
  useMockTimers(t)
  const bot = makeBot()
  bot.follow.setTarget({ id: 1, position: new Vec3(5, 64, 0) })
  mock.timers.tick(500)
  assert.equal(bot.controls.forward, true)
  bot.follow.stop()
  assert.equal(bot.follow.getTarget(), null)
  assert.equal(bot.controls.forward, false)
  assert.equal(bot.setGoalCalls.at(-1), null, 'stop 应清除寻路目标')
  mock.timers.tick(1500) // timer 已清：不再有控制输出
  assert.equal(bot.controls.forward, false)
})

test('follow: entityGone 自动停止跟随', (t) => {
  useMockTimers(t)
  const bot = makeBot()
  const player = { id: 42, position: new Vec3(5, 64, 0) }
  bot.follow.setTarget(player)
  bot.emit('entityGone', player)
  assert.equal(bot.follow.getTarget(), null)
  assert.equal(bot.controls.forward, false)
})

test('C1 修复：目标消失提示走 sendChat（不含 §——Paper 踢出防护）', async () => {
  const bot = makeBot()
  const player = { id: 42, username: 'steve', position: new Vec3(5, 64, 0) }
  bot.follow.setTarget(player)
  bot.emit('entityGone', player)
  // sendChat 经模块级串行队列（多源分片防交错）——发送延迟一个微任务
  await new Promise(r => setImmediate(r))
  const msg = bot.messages.find(m => m.includes('已停止跟随'))
  assert.ok(msg, `应聊天提示: ${bot.messages}`)
  assert.ok(!msg.includes('§'), `发送内容不得含 §: ${msg}`)
})

test('follow: 缺 pathfinder 时 setTarget 明确报错', () => {
  const bot = new EventEmitter()
  followPlugin(bot)
  assert.throws(() => bot.follow.setTarget({ id: 1 }), /需要 pathfinder/)
})

// ---- 前方方块跳跃（sticky：前方实心持续跳，越过障碍后松开）----

test('follow: 前方持续实心 → 跳跃保持（sticky，不因跳跃中瞬时误判松开）', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0), solidAhead)
  const player = { id: 7, position: new Vec3(3, 64, 0) }
  bot.follow.setTarget(player)
  for (let i = 0; i < 4; i++) mock.timers.tick(500) // 2s 内 4 个 tick
  assert.equal(bot.controls.jump, true, '前方障碍未越过应持续按住跳跃键')
  assert.equal(bot.controls.forward, true)
})

test('follow: 越过障碍（前方变空连续 2 tick）→ 停止跳跃', (t) => {
  useMockTimers(t)
  // 前方方块可切换：先实心（触发跳跃），Bot 跃过后变空
  let solid = true
  const bot = makeBot(new Vec3(0, 64, 0), (pos) => solid ? solidAhead(pos) : { boundingBox: 'empty', name: 'air' })
  const player = { id: 7, position: new Vec3(3, 64, 0) }
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.jump, true, '前方实心应触发跳跃')
  solid = false // Bot 已跃过台阶
  mock.timers.tick(500)
  assert.equal(bot.controls.jump, true, '连续 1 tick 空仍保持（防跳跃中瞬时误判）')
  mock.timers.tick(500)
  assert.equal(bot.controls.jump, false, '连续 2 tick 前方空 → 停止跳跃')
})

test('follow: 前方水/岩浆 → 不跳跃（可走/规避）', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0), () => ({ boundingBox: 'block', name: 'water' }))
  const player = { id: 7, position: new Vec3(3, 64, 0) }
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.jump, false, '前方水不应跳跃')
})

test('follow: 跳跃中卡住（y 无位移，前方持续实心）→ 切寻路绕行', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0), solidAhead)
  const player = { id: 7, position: new Vec3(3, 64, 0) }
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.jump, true, '前方实心应跳跃')
  // 6 轮 y 不动（跳不过去）→ 卡住计数到阈值 → 切寻路
  for (let i = 0; i < 6; i++) mock.timers.tick(500)
  assert.equal(bot.controls.jump, false, '卡住后停止跳跃')
  assert.ok(bot.setGoalCalls.length >= 1, '跳跃失败应切 pathfinder 绕行')
})

test('follow: 到达（dist ≤ REACH）且目标在面前高台 → 前进+跳跃爬升（1 格障碍不停）', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0), solidAhead)
  const player = { id: 7, position: new Vec3(1, 65.8, 0) } // 水平 1 格（≤REACH），目标在台上
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  // 回归：此前只 set jump 不 forward → 原地跳永远上不去台 → "1 格障碍前停止移动"
  assert.equal(bot.controls.forward, true, '目标在台上且前方台壁 → 应前进爬升（此前只跳不前进）')
  assert.equal(bot.controls.jump, true, '爬升应持续跳跃')
  // 爬上台后（y 对齐）→ 停下不再跳
  bot.entity.position.y = 65.8
  mock.timers.tick(500)
  assert.equal(bot.controls.forward, false)
  assert.equal(bot.controls.jump, false)
})

// ---- 寻路模式 A* 重置风暴与双控制器（实测"移动一段距离后原地不动"）----

test('follow: 寻路模式目标持续移动 → 重建受冷却限制（防 A* 重置风暴）', (t) => {
  useMockTimers(t, ['setInterval', 'Date']) // Date 也 mock：冷却判断用模拟时钟
  const bot = makeBot(new Vec3(0, 64, 0))
  const player = { id: 7, position: new Vec3(10, 64, 0) } // dist 10 ≥ DIRECT_RANGE → pathing
  bot.follow.setTarget(player)
  mock.timers.tick(500) // 首次（!lastGoalPos 无条件重建）
  const firstGoalCount = bot.setGoalCalls.filter(g => g !== null).length
  assert.ok(firstGoalCount >= 1, '首次应建立寻路目标')
  // 目标持续移动（每 tick 3 格 > PATH_UPDATE_DIST）但 1.5s 冷却内 → 不得重建
  for (let i = 0; i < 2; i++) {
    player.position.x += 3
    mock.timers.tick(500)
  }
  const after = bot.setGoalCalls.filter(g => g !== null).length
  assert.equal(after, firstGoalCount, '冷却内目标移动不应重建 goal（setGoal 会重置 A* → 原地不动）')
  // 冷却过后目标继续移动 → 允许重建追目标
  player.position.x += 3
  mock.timers.tick(1000) // 累计 2.5s > 1.5s 冷却
  const final = bot.setGoalCalls.filter(g => g !== null).length
  assert.ok(final > after, '冷却过后应重建 goal 追目标')
})

test('follow: 寻路模式接近（REACH 与回直接控制之间）→ 清除寻路目标（防双控制器冲突）', (t) => {
  useMockTimers(t, ['setInterval', 'Date'])
  const bot = makeBot(new Vec3(0, 64, 0))
  const player = { id: 7, position: new Vec3(10, 64, 0) }
  bot.follow.setTarget(player)
  mock.timers.tick(500) // pathing + setGoal
  assert.ok(bot.setGoalCalls.at(-1) !== null, '远距应建立寻路目标')
  player.position.x = 2.8 // dist 2.8：> REACH 2.5（不停下）、< DIRECT_RANGE*0.5 3（回直接控制）
  mock.timers.tick(500)
  assert.equal(bot.setGoalCalls.at(-1), null, '回直接控制前应 setGoal(null) 停 pathfinder')
  mock.timers.tick(500) // 下一 tick 走 direct 分支 → forward
  assert.equal(bot.controls.forward, true, '应回到直接控制前进')
})

test('follow: 已跟上（dist ≤ REACH）→ 清除残留寻路 goal（防 pathfinder 继续驱动移动）', (t) => {
  useMockTimers(t, ['setInterval', 'Date'])
  const bot = makeBot(new Vec3(0, 64, 0))
  const player = { id: 7, position: new Vec3(10, 64, 0) }
  bot.follow.setTarget(player)
  mock.timers.tick(500) // pathing + setGoal
  player.position.x = 2 // dist 2 ≤ REACH 2.5
  mock.timers.tick(500)
  assert.equal(bot.setGoalCalls.at(-1), null, '已跟上时必须清寻路 goal')
  assert.equal(bot.controls.forward, false, '已跟上应停下')
})

test('follow: 切换目标立即重建 goal（lastGoalPos 重置——不残留旧目标的重算冷却）', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0), solidAhead) // 前方实心 → 卡住后切寻路绕行
  const a = { id: 1, position: new Vec3(10, 64, 0) } // 远处（>DIRECT_RANGE）→ 寻路模式
  const b = { id: 2, position: new Vec3(10, 64, 10) }
  bot.follow.setTarget(a)
  mock.timers.tick(500) // 建立 A 的 goal（lastGoalTime 已记录）
  const goalCallsAfterA = bot.setGoalCalls.filter(g => g !== null).length
  assert.ok(goalCallsAfterA >= 1, 'A 的 goal 应已建立')
  // 冷却期（1.5s）内切换目标：B 的 goal 必须立即建立——lastGoalPos 重置使
  // 首 tick 无条件重建（修复缺失场景：切换后残留冷却阻塞新目标寻路）
  mock.timers.tick(200)
  bot.follow.setTarget(b)
  mock.timers.tick(500)
  const goalCallsAfterB = bot.setGoalCalls.filter(g => g !== null).length
  assert.ok(goalCallsAfterB > goalCallsAfterA, `切换目标应立即重建 goal（实际 ${goalCallsAfterA} → ${goalCallsAfterB}）`)
  bot.follow.stop()
})
