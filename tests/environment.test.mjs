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

test('environmentLine: 环境行含正确昼夜（dayTime 来自 /time query 取模——精确时钟不准只显示昼/夜）', () => {
  const bot = {
    entity: { position: { x: 1, y: 64, z: 2 }, yaw: 0 },
    time: { age: 24000, dayTime: 6000 }, // 6000 昼
    isRaining: false,
    game: { dimension: 'minecraft:overworld' },
    blockAt: () => null,
    players: {}
  }
  const line = environmentLine(bot)
  assert.ok(line.includes('第2天昼'), line)
  assert.ok(!line.includes('12:00'), '不输出 hh:mm（/time set 偏移下不准确——用户决策不需要 Bot 返回时间）')
  assert.ok(line.includes('晴'), line)
  assert.ok(line.includes('overworld'), line)
})

test('v1.5.1: 无 dayTime 缓存（查询未就绪）→ 时间未知（不再用 age 近似）', () => {
  const bot = {
    entity: { position: { x: 1, y: 64, z: 2 }, yaw: 0 },
    time: { age: 24000 }, // 只有 age——26.1 协议无 dayTime 字段
    isRaining: false,
    game: { dimension: 'minecraft:overworld' },
    blockAt: () => null,
    players: {}
  }
  const line = environmentLine(bot)
  assert.ok(line.includes('时间未知'), line)
  assert.ok(!line.includes('12:00'), '不得用 age 近似输出时间')
})

test('v1.5.1: environmentLine 玩家行带坐标（LLM 执行 follow/goto 类指令所需）', () => {
  const bot = {
    entity: { position: { x: 10, y: 64, z: 10 }, yaw: 0 },
    time: { age: 0, timeOfDay: 0, isDay: true },
    isRaining: false,
    game: { dimension: 'minecraft:overworld' },
    blockAt: () => null,
    players: {
      steve: { username: 'steve', entity: { position: { x: 20, y: 64, z: 30 } } },
      alex: { username: 'alex', entity: null } // 无实体（远处/未加载）跳过坐标
    }
  }
  const line = environmentLine(bot, 5)
  assert.ok(line.includes('steve(20,64,30)'), line)
  assert.ok(!line.includes('alex('), '无实体的玩家不带坐标')
})

// ---- dangerLine 危险注入（World Model 被动感知）----

import * as discovery from '../src/core/discovery.js'

function makeBotWithPos (x, z) {
  return { entity: { position: { x, y: 64, z } } }
}

test('P1: dangerLine——附近无新鲜危险 → 空串（零成本常态）', () => {
  discovery._reset()
  const bot = makeBotWithPos(0, 0)
  // 无任何记录
  assert.equal(importDangerLine(bot), '')
  // 半径外记录（>128）
  discovery.recordDangerZone({ x: 500, y: 64, z: 500 }, { hostileNames: ['zombie'] })
  assert.equal(importDangerLine(bot), '')
})

test('P1: dangerLine——有新鲜危险 → 摘要行（名字/距离/分钟前）', () => {
  discovery._reset()
  discovery.recordDangerZone({ x: 30, y: 64, z: 0 }, { hostileNames: ['zombie', 'creeper'] })
  const line = importDangerLine(makeBotWithPos(0, 0))
  assert.ok(line.includes('危险: '), line)
  assert.ok(line.includes('zombie/creeper'), line)
  assert.ok(line.includes('30m'), line)
  assert.ok(line.includes('分钟前'), line)
})

test('P1: dangerLine——过期危险（>1h）→ 空串', () => {
  discovery._reset()
  const zone = { x: 30, y: 64, z: 0, threatLevel: 1, hostileNames: ['zombie'], ts: Date.now() - 2 * 60 * 60 * 1000 }
  discovery.importSnapshot({ version: 3, dangerZones: [zone] })
  assert.equal(importDangerLine(makeBotWithPos(0, 0)), '', '过期危险不注入')
})

function importDangerLine (bot) {
  // 动态 import 避免与 environment.test 顶部静态导入冲突（函数提升）
  return dangerLineRef(bot)
}

// 静态导入放文件尾（动态引用防循环）
import { dangerLine as dangerLineRef } from '../src/core/environment.js'
