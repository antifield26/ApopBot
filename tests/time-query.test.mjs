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
  // 26.1：messagestr 事件由 chat.js 转发，_client 是原始包层（fake 用同一 EventEmitter 挂 systemChat）
  bot._client = new EventEmitter()
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

test('time-query: 26.1 总刻取模——大数值（totalTicks）→ dayTime = raw % 24000', () => {
  const { bot } = makeEnv()
  // 26.1 /time query time 返回维度时钟 totalTicks（含 set/睡觉跳变）——取模得到 dayTime
  bot.emit('messagestr', 'The time is 19660000', 'system', null, null)
  assert.equal(bot.time.dayTime, 19660000 % 24000, 'totalTicks % 24000 应为 dayTime')
  // 26.1 中文格式（实测："时钟minecraft:overworld处于22769069刻"）
  bot.emit('messagestr', '时钟minecraft:overworld处于22769069刻', 'system', null, null)
  assert.equal(bot.time.dayTime, 22769069 % 24000, '中文时钟格式应解析取模')
  // 负数/NaN 取模兜底
  bot.emit('messagestr', 'The time is -5', 'system', null, null)
  assert.equal(bot.time.dayTime, 22769069 % 24000, '负值不缓存（保留上一次）')
})

test('time-query: 26.1 _client JSON 通道——translate 新键数组解析（实测服务器格式）', () => {
  const { bot } = makeEnv()
  // 实测 formattedMessage：{"with":[{"":"minecraft:overworld"},{"":[0,22811813]}],"translate":"commands.time.query.absolute"}
  bot._client.emit('systemChat', {
    formattedMessage: '{"with":[{"":"minecraft:overworld"},{"":[0,22811813]}],"translate":"commands.time.query.absolute"}'
  })
  assert.equal(bot.time.dayTime, 22811813 % 24000, '新键数组末元素取模')
  // 非时间消息（translate 不匹配）不缓存
  bot._client.emit('systemChat', {
    formattedMessage: '{"translate":"commands.help.show"}'
  })
  assert.equal(bot.time.dayTime, 22811813 % 24000, '其他 translate 消息不处理')
  // content NBT 分支（旧格式 formattedMessage 缺失时）
  bot._client.emit('systemChat', { content: { type: 'compound', value: {} } })
  assert.equal(bot.time.dayTime, 22811813 % 24000, '非字符串 raw 忽略')
})

test('time-query: 定时发起查询命令（/minecraft: 显式 namespace + 26.1 参数 time）', async () => {
  const { bot } = makeEnv()
  // 首查 1s 后（QUERY_INTERVAL 30s 太长不测）——手动验证 chat 调用存在
  await new Promise((r) => setTimeout(r, 1500))
  assert.ok(bot.chatCalls.length >= 1, '上线后应发起 /time query')
  assert.equal(bot.chatCalls[0], '/minecraft:time query time')
})

test('time-query: 查询缓存驱动 environmentLine（集成——只输出昼夜）', () => {
  const { bot } = makeEnv()
  bot.emit('messagestr', 'The time is 11767', 'system', null, null) // dayTime 11767 昼（<13000）
  bot.entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0 }
  bot.isRaining = false
  bot.game = { dimension: 'minecraft:overworld' }
  bot.blockAt = () => null
  bot.players = {}
  const line = environmentLine(bot)
  assert.ok(line.includes('昼'), line)
  assert.ok(!line.includes('17:46'), '精确时钟不准——不输出 hh:mm')
})
