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
  for (const t of ['mine', 'fish', 'afk', 'farm', 'chop', 'combat', 'breed']) {
    assert.ok(TASK_OPTION_SCHEMAS[t], `缺 ${t} 的 schema`)
  }
})
