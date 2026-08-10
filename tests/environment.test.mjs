// 环境快照时间映射测试（第 9 轮）：Minecraft timeOfDay 0 = 游戏钟 6:00（日出）——
// 此前直接映射恒早 6 小时。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTime, directionFromYaw, environmentLine } from '../src/core/environment.js'

test('formatTime: timeOfDay 0 = 游戏钟 06:00（日出），非 00:00', () => {
  assert.equal(formatTime(0), '06:00', 'timeOfDay 0（日出）应为 06:00')
  assert.equal(formatTime(6000), '12:00', '正午（timeOfDay 6000）应为 12:00')
  assert.equal(formatTime(12000), '18:00', '日落（timeOfDay 12000）应为 18:00')
  assert.equal(formatTime(18000), '00:00', '午夜（timeOfDay 18000）应为 00:00')
  assert.equal(formatTime(23000), '05:00', '黎明前应为 05:00')
  assert.equal(formatTime(25000), '07:00', '超 24000 取模（25000 % 24000 = 1000 → 07:00）')
  assert.equal(formatTime(NaN), '?', '非法值兜底')
})

test('directionFromYaw: 原版 yaw 约定（0=南，顺时针）', () => {
  assert.equal(directionFromYaw(0), '南')
  assert.equal(directionFromYaw(Math.PI / 2), '西')
  assert.equal(directionFromYaw(Math.PI), '北')
  assert.equal(directionFromYaw(-Math.PI / 2), '东')
  assert.equal(directionFromYaw(NaN), '?')
})

test('environmentLine: 环境行含正确时间与昼夜', () => {
  const bot = {
    entity: { position: { x: 1, y: 64, z: 2 }, yaw: 0 },
    time: { age: 24000, timeOfDay: 6000, isDay: true },
    isRaining: false,
    game: { dimension: 'minecraft:overworld' },
    blockAt: () => null,
    players: {}
  }
  const line = environmentLine(bot)
  assert.ok(line.includes('第2天12:00昼'), line)
  assert.ok(line.includes('晴'), line)
  assert.ok(line.includes('overworld'), line)
})
