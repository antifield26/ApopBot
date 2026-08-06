// follow 插件回归测试（混合跟随实现：近距离 setControlState 直接控制 + 跳跃，
// 卡住/远距切 pathfinder 绕行——GoalFollow 不跳跃会丢失目标，实测修复）。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { followPlugin } from '../src/plugins/follow.js'

function makeBot (pos = new Vec3(0, 64, 0)) {
  const bot = new EventEmitter()
  bot.controls = {}
  bot.entity = { position: pos }
  bot.setGoalCalls = []
  bot.pathfinder = { setGoal: (g) => bot.setGoalCalls.push(g) }
  bot.setControlState = (k, v) => { bot.controls[k] = v }
  bot.lookAt = async () => {}
  bot.blockAt = () => ({ name: 'stone' }) // 前方默认有地面（非虚空）
  followPlugin(bot)
  return bot
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

test('follow: 目标高于 Bot → 跳跃（jump=true，解决 GoalFollow 不跳丢失跟随）', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0))
  const player = { id: 7, position: new Vec3(2, 65.8, 0) } // y 差 1.8 > JUMP_Y_DIFF 0.6
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.forward, true)
  assert.equal(bot.controls.jump, true, '目标在上方时应持续跳跃')
})

test('follow: 目标同高度（y 差 < 0.6）→ 不跳跃', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0))
  const player = { id: 7, position: new Vec3(3, 64.2, 0) }
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.forward, true)
  assert.equal(bot.controls.jump, false)
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

test('follow: 缺 pathfinder 时 setTarget 明确报错', () => {
  const bot = new EventEmitter()
  followPlugin(bot)
  assert.throws(() => bot.follow.setTarget({ id: 1 }), /需要 pathfinder/)
})

// ---- sticky jump（爬升模式）：目标高于阈值持续跳跃直到高度修正 ----

test('follow: 目标持续高于 → 跳跃保持（sticky，不因瞬时差波动松开）', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0))
  // 目标在高台（y 差 1.8 恒定——即使位置数据滞后，只要判定高于就持续跳）
  const player = { id: 7, position: new Vec3(3, 65.8, 0) }
  bot.follow.setTarget(player)
  for (let i = 0; i < 4; i++) mock.timers.tick(500) // 2s 内 4 个 tick
  assert.equal(bot.controls.jump, true, '高度差未修正前应持续按住跳跃键')
  assert.equal(bot.controls.forward, true)
})

test('follow: 高度差修正（≤0.3）→ 停止跳跃', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0))
  // 目标 y 数据滞后更新：先高（触发爬升），随后修正为同高度
  let targetY = 65.8
  const player = { id: 7, position: new Vec3(3, 65.8, 0) }
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.jump, true, '触发爬升模式')
  // 模拟 Bot 跳起 + 目标数据修正：y 差降到 0.2
  bot.entity.position.y = 65.6
  mock.timers.tick(500)
  assert.equal(bot.controls.jump, false, '高度差修正后应停止跳跃')
})

test('follow: 爬升中卡住（y 无位移）→ 切寻路绕行', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0))
  const player = { id: 7, position: new Vec3(3, 66, 0) } // y 差 2 > 0.6
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.jump, true, '应进入爬升模式')
  // 6 轮 y 不动（头顶有方块跳不过去）→ 卡住计数到阈值 → 切寻路
  for (let i = 0; i < 6; i++) mock.timers.tick(500)
  assert.equal(bot.controls.jump, false, '卡住后停止跳跃')
  assert.ok(bot.setGoalCalls.length >= 1, '爬升失败应切 pathfinder 绕行')
})

test('follow: 到达后停止跳跃并清除爬升模式（跳上高台不再继续跳）', (t) => {
  useMockTimers(t)
  const bot = makeBot(new Vec3(0, 64, 0))
  const player = { id: 7, position: new Vec3(3, 65.8, 0) }
  bot.follow.setTarget(player)
  mock.timers.tick(500)
  assert.equal(bot.controls.jump, true)
  // Bot 跳上高台：与目标水平距离 ≤ REACH 且同高度
  bot.entity.position.y = 65.8
  bot.entity.position.x = 2
  mock.timers.tick(500)
  assert.equal(bot.controls.jump, false, '到达后不应持续跳跃')
  assert.equal(bot.controls.forward, false)
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
