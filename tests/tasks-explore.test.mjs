// ExploreTask（L2 进化 C2）测试：螺旋生成器纯函数/终止/计数器/area 裁剪。
// 风格同 tasks-run.test.mjs：stub bot + 有限工作负载驱动自然完成或 stop 打断。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { ExploreTask } from '../src/tasks/explore.js'
import { spiralWaypoints } from '../src/core/explore.js'
import * as discovery from '../src/core/discovery.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (bot) {
  return { bot, logger: makeLogger(), config: {} }
}

function makeExploreBot () {
  const bot = new EventEmitter()
  Object.assign(bot, {
    // movement 统一层需要 pathfinder.goto（到达判定）+ setGoal/stop
    pathfinder: { setGoal: () => {}, stop () {}, goto: () => Promise.resolve() },
    entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { iron_ore: { id: 44 } } },
    findBlocks: () => [],
    inventory: { items: () => [] }
  })
  return bot
}

async function settle (n = 3) {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r))
}

test.beforeEach(() => discovery._reset())

test('螺旋生成器：环数/站点数/覆盖范围正确', () => {
  const pts = spiralWaypoints(0, 0, 64, 32)
  // maxDistance 64 / step 32 → 2 环；环 1 4 站（round(8)=8 但 min 4？round(8*1)=8）、环 2 16 站
  assert.equal(pts.filter(p => p.ring === 1).length, 8, '第 1 环 8 站')
  assert.equal(pts.filter(p => p.ring === 2).length, 16, '第 2 环 16 站')
  assert.equal(pts.length, 24)
  // 所有站点在 maxDistance 范围内（Chebyshev 半径）
  for (const p of pts) {
    assert.ok(Math.max(Math.abs(p.x), Math.abs(p.z)) <= 64, `站点 (${p.x},${p.z}) 应在范围内`)
  }
  // 第 1 环站距中心 = 32（Chebyshev）
  const r1 = pts.find(p => p.ring === 1)
  assert.equal(Math.max(Math.abs(r1.x), Math.abs(r1.z)), 32)
})

test('螺旋生成器：maxDistance 钳制为整数环', () => {
  const pts = spiralWaypoints(100, -50, 100, 32) // 3 环（100/32=3.1 → 3）
  assert.equal(Math.max(...pts.map(p => p.ring)), 3)
  assert.ok(pts.every(p => p.x >= 100 - 96 && p.x <= 100 + 96), '中心偏移正确')
})

test('explore run: 无 stopWhenDone——环完成后以当前位置重启（有界漫游）', async () => {
  const bot = makeExploreBot()
  const task = new ExploreTask('e1', 'explore', { maxDistance: 32, checkIntervalSeconds: 0.1 }, makeCtx(bot))
  const p = task.start()
  await new Promise(r => setTimeout(r, 60))
  assert.equal(task.state, 'running')
  assert.ok(task.counters.waypoints >= 1, `应有已访问站点: ${JSON.stringify(task.counters)}`)
  assert.ok(task.counters.rings >= 1, `应完成至少 1 环: ${JSON.stringify(task.counters)}`)
  await task.stop()
  await p
  assert.equal(task.state, 'stopped')
})

test('explore run: stopWhenDone——螺旋完成后自然完成', async () => {
  const bot = makeExploreBot()
  const task = new ExploreTask('e2', 'explore', { maxDistance: 16, stopWhenDone: true, checkIntervalSeconds: 0.1 }, makeCtx(bot))
  const p = task.start()
  await new Promise(r => setTimeout(r, 1000)) // 1 环 8 站 × (goto + 100ms 节奏)
  assert.equal(task.state, 'completed', `螺旋完成应自然完成（state=${task.state}）`)
  assert.ok(task.counters.rings >= 1, `rings=${task.counters.rings}`)
  await p
})

test('explore run: area 裁剪——站点全部在盒外 → 覆盖完成（stopWhenDone）', async () => {
  const bot = makeExploreBot()
  // 螺旋中心 (0,0) 半径 32 → 站点都在 area 外（area 在远处）
  const area = { x1: 1000, y1: 0, z1: 1000, x2: 1010, y2: 128, z2: 1010 }
  const task = new ExploreTask('e3', 'explore', { maxDistance: 32, area, stopWhenDone: true, checkIntervalSeconds: 0.1 }, makeCtx(bot))
  const p = task.start()
  await new Promise(r => setTimeout(r, 100)) // 连续 16 站被裁 → 覆盖完成
  assert.equal(task.state, 'completed', '区域已覆盖应自然完成')
  await p
})

test('P2-4 修复: 站点地面 y 采样——悬崖/山顶站点不再用 bot 当前 y', async () => {
  const bot = makeExploreBot()
  let blockAtCalls = 0
  bot.blockAt = (p) => {
    blockAtCalls++
    // y=64 处是空气，y=63 处是石头 → 地面 y=64；模拟目标站点 (32, ?, 0) 在悬崖顶
    return p.y >= 64 ? { boundingBox: 'empty' } : { boundingBox: 'solid' }
  }
  const task = new ExploreTask('e5', 'explore', { maxDistance: 32, stopWhenDone: true, checkIntervalSeconds: 0.1 }, makeCtx(bot))
  await task.init()
  const ground = task._groundY(32, 0)
  assert.equal(ground, 64, '地面 y 应为 64（石头顶+1）')
  assert.ok(blockAtCalls >= 2, '应向下采样多个高度')
  await task.stop()
})

test('explore run: 采样记录写入 DiscoveryMap（found 计数）', async () => {
  const bot = makeExploreBot()
  let calls = 0
  bot.findBlocks = ({ matching }) => {
    calls++
    return matching({ type: 44 }) ? [new Vec3(10, 63, 0)] : []
  }
  const task = new ExploreTask('e4', 'explore', { maxDistance: 16, stopWhenDone: true, checkIntervalSeconds: 0.1 }, makeCtx(bot))
  const p = task.start()
  await new Promise(r => setTimeout(r, 1000)) // 1 环 8 站完成
  assert.equal(task.state, 'completed')
  assert.ok(task.counters.discovered >= 1, `应发现铁矿石: ${JSON.stringify(task.counters)}`)
  assert.ok(calls > 0, '应调用 findBlocks 采样')
  assert.ok(discovery.query('iron_ore', null, 20).length >= 1, '发现应写入探索记忆')
  await p
})
