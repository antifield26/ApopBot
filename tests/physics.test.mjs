// prismarine-physics 半嵌挡测试（第 9 轮爬升根治）。
// 背景：本地物理的 computeOffsetX/Z 允许"位置与方块重叠（半嵌）"的水平移动
// （穿墙），而服务器 vanilla 语义拒绝（校验拉回）→ bot 每 tick 被服务器拉回 +
// mineflayer 把 onGround 置 false → 起跳冻结 → 卡在爬升点。
// 修复（patch prismarine-physics 1.11.1）：半嵌位水平前进 → 挡（不穿墙）；
// 未重叠 → 原截断逻辑；实体在块另一侧 → 自由（离开方向）；后退 → 原逻辑。
// 这些测试锁定 patch 语义，防止未来升级 node_modules 时回退（check:compat
// 哨兵"半嵌（X 重叠）：挡"提供双保险）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import AABB from '../node_modules/prismarine-physics/lib/aabb.js'

// 场景常量：墙块 x∈[1,2] y∈[65,66] z∈[-10,10]（1 格高墙，模拟贴墙）
const wall = new AABB(1, 65, -10, 2, 66, 10)

test('computeOffsetX: 未重叠前进 → 原截断（贴墙停）', () => {
  // bot AABB [0.4, 1.0] 在墙左，前进 0.2 → 截断到恰好贴墙（maxX = 1）
  const player = new AABB(0.4, 65, 0, 1.0, 66.8, 1)
  const off = wall.computeOffsetX(player, 0.2)
  assert.ok(Math.abs(off - (1.0 - 1.0)) < 1e-9, `截断到贴墙，实际 ${off}`)
})

test('computeOffsetX: 半嵌前进 → 挤回块外（脱嵌，非死锁）', () => {
  // bot 右缘 1.2 已嵌入墙块 0.2，前进 0.2 → 挤回 -0.2（右缘到块左 1.0，脱嵌）
  const player = new AABB(0.6, 65, 0, 1.2, 66.8, 1)
  const off = wall.computeOffsetX(player, 0.2)
  assert.ok(Math.abs(off - (1 - 1.2 - 1e-4)) < 1e-9, `半嵌前进应挤回（-0.2001），实际 ${off}`)
  // 挤回后恰好贴墙（右缘 = 块左）→ 后续前进走截断分支（稳定贴墙）
  const pushed = new AABB(0.6, 65, 0, 1.0, 66.8, 1)
  assert.ok(Math.abs(wall.computeOffsetX(pushed, 0.2) - 0) < 1e-9, '贴墙后前进被截断')
})

test('computeOffsetX: 半嵌向 -X（深入块方向）→ 挤回（脱嵌）', () => {
  // bot 半嵌（左缘 0.8 在墙左、右缘 1.2 在墙内），向 -X 走 -0.2
  // （bot 左缘在块左——向 -X 是离开方向，应自由）
  const player = new AABB(0.8, 65, 0, 1.2, 66.8, 1)
  assert.equal(wall.computeOffsetX(player, -0.2), -0.2, '左缘在块左时向 -X 离开自由')
  // bot 完全在块内偏右（左缘 1.5 在块 [1,2] 内），向 -X 走 → 挤回（脱嵌到块左）
  const deep = new AABB(1.5, 65, 0, 2.1, 66.8, 1)
  const off = wall.computeOffsetX(deep, -0.2)
  assert.ok(Math.abs(off - (2 - 1.5 + 1e-4)) < 1e-9, `块内左移应挤回 +0.5001，实际 ${off}`)
})

test('computeOffsetX: 实体在块另一侧前进 → 自由（离开方向）', () => {
  // bot 完全在墙右（[2.2, 2.8]），前进（+X 远离墙）→ 自由
  const player = new AABB(2.2, 65, 0, 2.8, 66.8, 1)
  assert.equal(wall.computeOffsetX(player, 0.2), 0.2, '远离方向必须自由')
  // 半嵌但移动方向是离开（右缘已出块另一侧 [1.5, 2.1]，向 +X）→ 自由
  const leaving = new AABB(1.5, 65, 0, 2.1, 66.8, 1)
  assert.equal(wall.computeOffsetX(leaving, 0.2), 0.2, '右缘已出块时前进（离开）必须自由')
})

test('computeOffsetX: 垂直不重叠（bot 在墙顶上方）→ 自由（不挡水平）', () => {
  // bot 底 66.5 > 墙顶 66 → 站墙顶水平移动不被墙块挡
  const player = new AABB(1.2, 66.5, 0, 1.8, 68.3, 1)
  assert.equal(wall.computeOffsetX(player, 0.2), 0.2, '墙顶上方水平移动自由')
})

test('computeOffsetZ: 半嵌前进 → 挤回（对称性）', () => {
  const wallZ = new AABB(-10, 65, 1, 10, 66, 2) // 墙块 z∈[1,2]
  const player = new AABB(0, 65, 0.6, 1, 66.8, 1.2) // 半嵌 z 0.2
  const off = wallZ.computeOffsetZ(player, 0.2)
  assert.ok(Math.abs(off - (1 - 1.2 - 1e-4)) < 1e-9, `半嵌位 Z 前进应挤回（-0.2001），实际 ${off}`)
  const player2 = new AABB(0, 65, 0.8, 1, 66.8, 1.2) // 半嵌后退
  assert.equal(wallZ.computeOffsetZ(player2, -0.2), -0.2, '后退（离开）必须自由')
})

test('computeOffsetY: 不变（天花板挡/落地挡/半嵌起跳自由）', () => {
  const ceiling = new AABB(-10, 67, -10, 10, 68, 10) // 天花板在 y=67
  // 天花板：bot 顶 66.9（恰在天花板底 67 下）向上跳 0.42 → 截断到顶 = 67
  const player = new AABB(0, 66, 0, 1, 66.9, 1)
  const off = ceiling.computeOffsetY(player, 0.42)
  assert.ok(Math.abs(off - (67 - 66.9)) < 1e-9, `天花板应截断（顶对齐），实际 ${off}`)
  // 落地：bot 底 67.5 向下落 → 自由（未着地）
  const ground = new AABB(-10, 66, -10, 10, 67, 10) // 地面块顶 67
  const faller = new AABB(0, 67.5, 0, 1, 69.3, 1)
  assert.equal(ground.computeOffsetY(faller, -0.3), -0.3, '未着地自由下落')
  const near = new AABB(0, 67.2, 0, 1, 69.0, 1)
  assert.ok(Math.abs(ground.computeOffsetY(near, -0.3) - (67 - 67.2)) < 1e-9, '着地截断到块顶')
  // 半嵌起跳（Y 与墙块重叠但 X/Z 重叠条件满足）——Y 原公式不挡（bot 顶 > 块底）
  const playerWall = new AABB(0.6, 65, 0, 1.2, 66.8, 1) // 半嵌墙
  const yOff = wall.computeOffsetY(playerWall, 0.42)
  assert.equal(yOff, 0.42, 'Y 轴保持原语义（半嵌起跳自由——服务器实测接受）')
})
