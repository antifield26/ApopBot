// 任务 options schema 校验测试（C5/R3 根治版：ad-hoc options 零校验的入口拦截）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateTaskOptions, TASK_OPTION_SCHEMAS } from '../src/core/task-schemas.js'

test('schema: 合法 options 放行', () => {
  assert.deepEqual(validateTaskOptions('afk', { intervalMinutes: 5 }), { ok: true })
  assert.deepEqual(validateTaskOptions('mine', { blockTypes: ['iron_ore'], radius: 32 }), { ok: true })
  assert.deepEqual(validateTaskOptions('combat', { aggroRange: 12, attackRange: 3.5 }), { ok: true })
  assert.deepEqual(validateTaskOptions('fish', { durationMinutes: 30 }), { ok: true })
})

test('schema: 必填缺失拒绝', () => {
  assert.ok(!validateTaskOptions('afk', {}).ok, 'afk 缺 intervalMinutes 应拒绝')
  assert.ok(!validateTaskOptions('mine', { radius: 10 }).ok, 'mine 缺 blockTypes 应拒绝')
  assert.ok(!validateTaskOptions('fish', { stopWhenInventoryFull: true }).ok, 'fish 缺 durationMinutes 应拒绝')
})

test('schema: 数值越界拒绝（afk 0 分钟忙循环/负 durationMinutes）', () => {
  const r1 = validateTaskOptions('afk', { intervalMinutes: 0 })
  assert.ok(!r1.ok && r1.error.includes('不能小于'), `intervalMinutes 0 应拒绝: ${r1.error}`)
  const r2 = validateTaskOptions('afk', { intervalMinutes: -1 })
  assert.ok(!r2.ok)
  const r3 = validateTaskOptions('fish', { durationMinutes: -5 })
  assert.ok(!r3.ok, '负 durationMinutes 应拒绝')
})

test('schema: 类型错误拒绝', () => {
  const r = validateTaskOptions('mine', { blockTypes: 'iron_ore' })
  assert.ok(!r.ok && r.error.includes('必须是 array'), r.error)
  assert.ok(!validateTaskOptions('combat', { maxTargets: '3' }).ok, '字符串数字应拒绝')
})

test('schema: 未知键放行（向前兼容），未知任务类型放行', () => {
  assert.deepEqual(validateTaskOptions('afk', { intervalMinutes: 1, futureKey: 42 }), { ok: true })
  assert.deepEqual(validateTaskOptions('unknown_type', { anything: true }), { ok: true })
})

test('schema: 通用字段（durationMinutes/notifyChat）放行', () => {
  assert.deepEqual(validateTaskOptions('combat', { notifyChat: true, durationMinutes: 10 }), { ok: true })
})

test('schema: 全部任务类型均有定义（manager TASK_TYPES 一致性防漂移）', () => {
  for (const t of ['mine', 'fish', 'afk', 'farm', 'chop', 'combat', 'breed', 'explore']) {
    assert.ok(TASK_OPTION_SCHEMAS[t], `缺 ${t} 的 schema`)
  }
})

// ---- A2（第四轮）：schema 与代码契约对齐 + 无界值限幅 ----

test('A2/F2: chop 用 logTypes（可选）而非 blockTypes——area-only 配置合法', () => {
  // 此前 schema 必填 blockTypes 但 chop.js 从不读它 → `!task new chop {"area":…}`
  // 被拒而 config 同配置照跑（命令/配置行为不一致）
  assert.deepEqual(validateTaskOptions('chop', { area: { x1: 0, y1: 0, z1: 0, x2: 10, y2: 10, z2: 10 } }), { ok: true })
  assert.deepEqual(validateTaskOptions('chop', { area: {}, logTypes: ['oak_log'] }), { ok: true })
  const r = validateTaskOptions('chop', { area: {}, logTypes: [] })
  assert.ok(!r.ok, '空 logTypes 应拒绝（minItems 1）')
})

test('A2/F7: mine 的 area 可选（与代码 run 内过滤契约一致）', () => {
  assert.deepEqual(validateTaskOptions('mine', { blockTypes: ['iron_ore'], area: { x1: 0, y1: 0, z1: 0, x2: 10, y2: 10, z2: 10 } }), { ok: true })
  // 类型仍是 object：非对象拒绝
  assert.ok(!validateTaskOptions('mine', { blockTypes: ['iron_ore'], area: [1, 2, 3] }).ok)
})

test('A2/P1-2: mine/chop radius 上限 256（同步 findBlocks 枚举限幅）', () => {
  assert.deepEqual(validateTaskOptions('mine', { blockTypes: ['iron_ore'], radius: 256 }), { ok: true })
  const r1 = validateTaskOptions('mine', { blockTypes: ['iron_ore'], radius: 257 })
  assert.ok(!r1.ok && r1.error.includes('不能大于'), r1.error)
  const r2 = validateTaskOptions('chop', { area: {}, radius: 1000000 })
  assert.ok(!r2.ok, 'chop 无界 radius 应拒绝')
  assert.deepEqual(validateTaskOptions('chop', { area: {}, radius: 256 }), { ok: true })
})

// ---- 任务链 next 与 cron 校验（start_task/config 共用入口）----

import { validateNextOptions, validateCron } from '../src/core/task-schemas.js'

test('next: 合法 next（type/id/options/schedule）放行', () => {
  assert.deepEqual(validateNextOptions({ type: 'mine', id: 'm1' }), { ok: true })
  assert.deepEqual(validateNextOptions({ type: 'mine', id: 'm1', options: { blockTypes: ['iron_ore'] } }), { ok: true })
  assert.deepEqual(validateNextOptions({ type: 'fish', id: 'f1', options: { durationMinutes: 30 }, schedule: '0 20 * * *' }), { ok: true })
})

test('next: 缺 id / 未知 type 拒绝', () => {
  assert.ok(!validateNextOptions({ type: 'mine' }).ok, '缺 id 应拒绝')
  assert.ok(!validateNextOptions({ type: 'unknown-type', id: 'x' }).ok, '未知 type 应拒绝')
  assert.ok(!validateNextOptions(null).ok, 'null 应拒绝')
  assert.ok(!validateNextOptions([]).ok, '数组应拒绝')
})

test('next: 嵌套 options 递归校验（非法拒绝）', () => {
  const r = validateNextOptions({ type: 'mine', id: 'm1', options: { radius: 1 } })
  assert.ok(!r.ok && r.error.includes('next.options'), r.error)
})

test('cron: 非法表达式拒绝（调度器静默吞非法 → 任务永不触发）', () => {
  assert.deepEqual(validateCron('0 3 * * *'), { ok: true })
  assert.ok(!validateCron('not-a-cron').ok)
  assert.ok(!validateCron('').ok, '空字符串应拒绝')
  assert.ok(!validateCron(123).ok, '非字符串应拒绝')
})
