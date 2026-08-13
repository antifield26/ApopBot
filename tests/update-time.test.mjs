// update_time 协议形状测试（26.1 clockUpdates 回归）：
// patch 曾按原始 Buffer 逐字节解析 clockUpdates，但 26.1 反序列化后是
// 对象数组 [{id,totalTicks,partialTick,rate}]——恒 null → timeOfDay 被
// world age 污染。用真实 minecraft-protocol 序列化器验证形状（同
// entity-actions.test.mjs 的协议形状级回归写法）。
// 方向注意：update_time 是服务器→客户端包——构造用 isServer: true 序列化器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol' // CJS 包：ESM default 导入

const VERSION = '26.1.2'

function makePair () {
  const ser = mc.createSerializer({ state: 'play', isServer: true, version: VERSION })
  const deser = mc.createDeserializer({ state: 'play', isServer: false, version: VERSION })
  return { ser, deser }
}

test('update_time: clockUpdates 反序列化为对象数组（patch 的 Buffer 解析前提失效）', () => {
  const { ser, deser } = makePair()
  const buf = ser.createPacketBuffer({
    name: 'update_time',
    params: { age: 1000n, clockUpdates: [{ id: 0, totalTicks: 23456, partialTick: 0, rate: 1 }] }
  })
  const params = deser.parsePacketBuffer(buf).data.params
  assert.ok(Array.isArray(params.clockUpdates), 'clockUpdates 应为对象数组（非原始 Buffer）')
  assert.equal(params.clockUpdates[0].id, 0)
  assert.equal(params.clockUpdates[0].totalTicks, 23456, 'totalTicks 反序列化为数值')
  assert.equal(typeof params.clockUpdates[0].partialTick, 'number')
  assert.equal(typeof params.clockUpdates[0].rate, 'number')
  assert.equal(BigInt(params.age), 1000n, 'age 为 i64（SignedBigInt 包装，BigInt() 转换）')
})

test('update_time: patch 解析表达式取 id=0 条目的 totalTicks/rate（修复后数据通路）', () => {
  const { ser, deser } = makePair()
  const buf = ser.createPacketBuffer({
    name: 'update_time',
    params: { age: 1000n, clockUpdates: [{ id: 0, totalTicks: 23456, partialTick: 0, rate: 1 }] }
  })
  const parsed = deser.parsePacketBuffer(buf).data.params
  const clockUpdate = Array.isArray(parsed.clockUpdates)
    ? parsed.clockUpdates.find(c => c.id === 0) ?? null
    : null
  assert.ok(clockUpdate, '应取到 id=0 时钟条目')
  assert.equal(clockUpdate.totalTicks, 23456, 'packetTime 数据源（clockUpdate.totalTicks）')
  assert.equal(clockUpdate.rate, 1, 'doDaylightCycle 数据源（clockUpdate.rate）')
})
