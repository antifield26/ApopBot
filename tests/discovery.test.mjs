// 探索记忆（L2 进化 B1）测试：容量边界/去重/淘汰/快照往返。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as discovery from '../src/core/discovery.js'

test.beforeEach(() => discovery._reset())

test('B1: recordResource 去重——同 chunk 只刷新 ts 不新增', () => {
  const r1 = discovery.recordResource('iron_ore', { x: 10, y: 63, z: 8 })
  const r2 = discovery.recordResource('iron_ore', { x: 11, y: 64, z: 9 }) // 同 chunk (0,0)
  assert.equal(r1, true, '首次发现应为新记录')
  assert.equal(r2, false, '同 chunk 再发现不是新记录')
  assert.equal(discovery.query('iron_ore', { x: 0, y: 0, z: 0 }).length, 1)
  // 不同 chunk 是新记录
  assert.equal(discovery.recordResource('iron_ore', { x: 30, y: 63, z: 8 }), true) // chunk (1,0)
  assert.equal(discovery.query('iron_ore').length, 2)
})

test('B1: 每块名上限 16 条，超限淘汰最旧', () => {
  for (let i = 0; i < 20; i++) discovery.recordResource('coal_ore', { x: i * 20, y: 60, z: 0 })
  const list = discovery.query('coal_ore', null, 20) // 传 maxCount 看全量
  assert.equal(list.length, 16, '每块名最多 16 条')
  assert.ok(!list.some(r => r.x === 0), '最早的记录应被淘汰')
  assert.ok(list.some(r => r.x === 19 * 20), '最新的保留')
})

test('B1: 全局 512 条上限——超限淘汰全局最旧', () => {
  // 每名 16 上限先生效（33 × 16 = 528 > 512）→ 全局淘汰再触发
  for (let n = 0; n < 33; n++) {
    for (let i = 0; i < 16; i++) discovery.recordResource(`ore_${n}`, { x: i * 20, y: 60, z: n * 20 })
  }
  const s = discovery.stats()
  assert.equal(s.resources, 512, '全局最多 512 条')
  // 全局淘汰按 ts 最旧——第一个名字的最早记录应被淘汰
  const first = discovery.query('ore_0', null, 20)
  assert.equal(first.length, 16 - 16, '最旧名字的记录被全局淘汰')
  assert.equal(discovery.query('ore_32', null, 20).length, 16, '最后的名字保留全量')
})

test('B1: anchors 上限 256 环形淘汰', () => {
  for (let i = 0; i < 300; i++) discovery.recordAnchor({ x: i, y: 64, z: 0 })
  assert.equal(discovery.stats().anchors, 256)
  const s = discovery.snapshot()
  assert.ok(!s.anchors.some(a => a.x === 0), '最旧锚点应被淘汰')
})

test('B1: 快照往返——attachStore 后 setMemory 持久化 + importSnapshot 回灌', () => {
  const saved = []
  discovery.attachStore({ setMemory: (m) => { saved.push(m) } })
  discovery.recordResource('diamond_ore', { x: 100, y: 12, z: -50 })
  discovery.recordAnchor({ x: 0, y: 64, z: 0 })
  assert.ok(saved.length >= 1, '修改应触发 setMemory')
  const snap = saved.at(-1)
  assert.equal(snap.version, 1)
  assert.equal(snap.resources.diamond_ore.length, 1)
  assert.equal(snap.anchors.length, 1)
  // 清空后回灌
  discovery._reset()
  discovery.importSnapshot(snap)
  assert.equal(discovery.query('diamond_ore').length, 1)
  assert.equal(discovery.stats().anchors, 1)
  discovery.attachStore(null)
})

test('B1: importSnapshot 形状防御——坏数据按空处理', () => {
  discovery.importSnapshot(null)
  discovery.importSnapshot({ resources: { iron_ore: 'bad' }, anchors: 'bad' })
  assert.equal(discovery.stats().resources, 0)
  assert.equal(discovery.stats().anchors, 0)
})

test('B1: query 按当前位置距离升序', () => {
  discovery.recordResource('gold_ore', { x: 100, y: 30, z: 0 })
  discovery.recordResource('gold_ore', { x: 10, y: 30, z: 0 })
  const r = discovery.query('gold_ore', { x: 0, y: 64, z: 0 }, 5)
  assert.equal(r[0].x, 10, '近的在前')
  assert.equal(r[1].x, 100)
})
