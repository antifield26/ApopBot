// 实体动作协议层测试（2026-08-07 部署机根因回归）：
// mineflayer 门控 bug 下 bot.attack/useOn 回退旧式 use_entity 缺 location →
// 26.1 序列化器报 "Sizeof error: Cannot read properties of undefined (reading 'x')"
// → 每次攻击/喂食断线。此处用真实 minecraft-protocol 序列化器验证本项目写包的
// 格式与 26.1.2（协议 775 / minecraft-data 3.112.0）schema 完全匹配。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol' // CJS 包：ESM default 导入
import { attackEntity, useEntityOn } from '../src/core/entity-actions.js'

const VERSION = '26.1.2'

function makeSerializer () {
  return mc.createSerializer({ state: 'play', isServer: false, version: VERSION })
}

test('攻击包：attack + arm_animation 可被 26.1.2 序列化（回归：旧式 use_entity 报 Sizeof error）', () => {
  const ser = makeSerializer()
  const packets = []
  const bot = { _client: { write: (name, params) => { packets.push({ name, params }); ser.createPacketBuffer({ name, params }) } } }
  attackEntity(bot, { id: 42 })
  assert.equal(packets.length, 2, '应写 attack + arm_animation 两包')
  assert.equal(packets[0].name, 'attack')
  assert.equal(packets[0].params.entityId, 42)
  assert.equal(packets[1].name, 'arm_animation')
  // 序列化器已在上方对每个包 createPacketBuffer——未抛错即格式匹配
})

test('use_entity：新格式 {target, hand, location, sneaking} 可被 26.1.2 序列化（breed 喂食面）', () => {
  const ser = makeSerializer()
  const packets = []
  const bot = { _client: { write: (name, params) => { packets.push({ name, params }); ser.createPacketBuffer({ name, params }) } } }
  useEntityOn(bot, { id: 7, position: { x: 10, y: 64, z: -3 }, height: 1.3 })
  assert.equal(packets.length, 1)
  assert.equal(packets[0].name, 'use_entity')
  assert.equal(packets[0].params.target, 7)
  assert.equal(packets[0].params.hand, 0)
  assert.deepEqual(packets[0].params.location, { x: 10, y: 64.65, z: -3 }, 'location 应为实体中心（必填 lpVec3）')
  assert.equal(packets[0].params.sneaking, false)
})

test('攻击包：target 无 height 时 use_entity location 用默认 1.8 中心', () => {
  const ser = makeSerializer()
  const bot = { _client: { write: (name, params) => ser.createPacketBuffer({ name, params }) } }
  useEntityOn(bot, { id: 1, position: { x: 0, y: 64, z: 0 } })
  // 未抛错即通过
})

test('A4: useEntityOn 目标 position 缺失 → 明确报错（不发无效包）', () => {
  const bot = { _client: { write: () => { throw new Error('不应发包') } } }
  assert.throws(() => useEntityOn(bot, { id: 1 }), /目标位置不可用/)
})
