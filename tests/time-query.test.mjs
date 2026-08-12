// 时间查询（26.1 适配）测试：/time query daytime 定时执行 + 聊天解析缓存。
// fake bot 用 EventEmitter（emit chat 模拟服务器返回）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { installTimeQuery } from '../src/core/time-query.js'
import { environmentLine } from '../src/core/environment.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeEnv () {
  const bot = new EventEmitter()
  bot.chat = (msg) => { bot.chatCalls.push(msg) }
  bot.chatCalls = []
  bot.time = { age: 19660000 }
  const ctx = { bot, logger: makeLogger() }
  installTimeQuery(ctx, bot, () => ctx.logger)
  return { bot, ctx }
}

test('time-query: Server 消息解析 → 缓存 dayTime 到 bot.time.dayTime', () => {
  const { bot } = makeEnv()
  bot.emit('messagestr', 'The time is 12345', 'system', null, null)
  assert.equal(bot.time.dayTime, 12345, '英文格式解析')
  assert.equal(bot.time.isDay, true, '12345 < 13000 昼')
  bot.emit('messagestr', '时间是 22222', 'system', null, null)
  assert.equal(bot.time.dayTime, 22222, '中文格式解析')
  assert.equal(bot.time.isDay, false, '22222 >= 13000 夜')
})

test('time-query: 非 Server 来源 / 非法值不缓存', () => {
  const { bot } = makeEnv()
  bot.emit('messagestr', 'The time is 99999', 'chat', null, 'steve')
  bot.emit('messagestr', 'The time is abc', 'system', null, null)
  bot.emit('messagestr', '您没有权限执行此命令', 'system', null, null)
  assert.equal(bot.time.dayTime, undefined, '非法来源/值不缓存')
})

test('time-query: 定时发起查询命令（/minecraft: 显式 namespace 绕过插件覆盖）', async () => {
  const { bot } = makeEnv()
  // 首查 1s 后（QUERY_INTERVAL 30s 太长不测）——手动验证 chat 调用存在
  await new Promise((r) => setTimeout(r, 1500))
  assert.ok(bot.chatCalls.length >= 1, '上线后应发起 /time query')
  assert.equal(bot.chatCalls[0], '/minecraft:time query daytime')
})

test('time-query: 查询缓存驱动 environmentLine（集成）', () => {
  const { bot } = makeEnv()
  bot.emit('messagestr', 'The time is 11767', 'system', null, null) // 实际 17:46 的 dayTime
  bot.entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0 }
  bot.isRaining = false
  bot.game = { dimension: 'minecraft:overworld' }
  bot.blockAt = () => null
  bot.players = {}
  const line = environmentLine(bot)
  assert.ok(line.includes('17:46'), line)
})
