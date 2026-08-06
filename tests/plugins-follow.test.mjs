// follow 插件回归测试（修复：goals 从包导出获取，bot.pathfinder 上无 goals——
// 旧实现 new goals.GoalFollow 抛 "Cannot read properties of undefined (reading 'GoalFollow')"）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { followPlugin } from '../src/plugins/follow.js'
import pathfinderPkg from 'mineflayer-pathfinder'
const { goals } = pathfinderPkg

function makeBot () {
  const bot = new EventEmitter()
  bot.setGoalCalls = []
  bot.pathfinder = { setGoal: (goal, dynamic) => bot.setGoalCalls.push({ goal, dynamic }) }
  followPlugin(bot)
  return bot
}

test('follow: setTarget 使用包级 goals.GoalFollow（非 bot.pathfinder.goals）', () => {
  const bot = makeBot()
  assert.equal(bot.pathfinder.goals, undefined, '前置：bot.pathfinder 上确实没有 goals（旧实现在此炸）')
  const player = { id: 7, position: { x: 1, y: 2, z: 3 } }
  bot.follow.setTarget(player)
  assert.equal(bot.setGoalCalls.length, 1)
  assert.ok(bot.setGoalCalls[0].goal instanceof goals.GoalFollow, '应为包级 goals.GoalFollow 实例')
  assert.equal(bot.setGoalCalls[0].dynamic, true)
  assert.equal(bot.follow.getTarget(), player)
})

test('follow: stop 清除目标与寻路', () => {
  const bot = makeBot()
  bot.follow.setTarget({ id: 1, position: { x: 0, y: 0, z: 0 } })
  bot.follow.stop()
  assert.equal(bot.follow.getTarget(), null)
  assert.equal(bot.setGoalCalls.at(-1).goal, null, 'stop 应清除寻路目标')
})

test('follow: entityGone 自动停止跟随', () => {
  const bot = makeBot()
  const player = { id: 42, position: { x: 0, y: 0, z: 0 } }
  bot.follow.setTarget(player)
  bot.emit('entityGone', player)
  assert.equal(bot.follow.getTarget(), null)
})

test('follow: 缺 pathfinder 时 setTarget 明确报错', () => {
  const bot = new EventEmitter()
  followPlugin(bot)
  assert.throws(() => bot.follow.setTarget({ id: 1 }), /需要 pathfinder/)
})
