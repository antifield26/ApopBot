import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyChanges, updateCheckCompat } from '../scripts/upstream-lib.mjs'

test('applyChanges: mineflayer 版本替换 + git overrides 移除、npm overrides 保留', () => {
  const pkg = {
    dependencies: { mineflayer: 'github:PrismarineJS/mineflayer#b30c85cb24d9fc7a009f61fe71a4fead516f8802' },
    overrides: {
      'minecraft-protocol': 'github:PrismarineJS/minecraft-protocol#3fb78a8da17cbce774a6cf8d78dfd889f1fbb8bf',
      'minecraft-data': '3.112.0'
    }
  }
  const next = applyChanges(pkg, '4.40.0')
  assert.equal(next.dependencies.mineflayer, '^4.40.0')
  assert.equal(next.overrides['minecraft-protocol'], undefined, 'git override 应移除')
  assert.equal(next.overrides['minecraft-data'], '3.112.0', 'npm override 应保留')
})

test('applyChanges: overrides 清空后删除整个键', () => {
  const pkg = { dependencies: { mineflayer: 'x' }, overrides: { 'minecraft-protocol': 'github:PrismarineJS/minecraft-protocol#abc' } }
  const next = applyChanges(pkg, '4.40.0')
  assert.equal(next.overrides, undefined)
})

test('applyChanges: 不修改输入对象（纯函数）', () => {
  const pkg = { dependencies: { mineflayer: 'x' }, overrides: { 'minecraft-data': '3.112.0' } }
  applyChanges(pkg, '4.40.0')
  assert.equal(pkg.dependencies.mineflayer, 'x', '输入对象不应被修改')
  assert.ok(pkg.overrides['minecraft-data'])
})

test('updateCheckCompat: git pin → npm 版本替换', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'upstream-'))
  const compatPath = path.join(dir, 'check-compat.mjs')
  writeFileSync(compatPath, `const EXPECTED = {
  'minecraft-protocol': { kind: 'git', sha: '3fb78a8da17cbce774a6cf8d78dfd889f1fbb8bf' },
  'mineflayer': { kind: 'git', sha: 'b30c85cb24d9fc7a009f61fe71a4fead516f8802' }
}`)
  updateCheckCompat(compatPath, '4.40.0', '1.40.0')
  const src = readFileSync(compatPath, 'utf8')
  assert.ok(src.includes("'mineflayer': { kind: 'npm', version: '4.40.0' }"), src)
  assert.ok(src.includes("'minecraft-protocol': { kind: 'npm', version: '1.40.0' }"), src)
  assert.ok(!src.includes('kind: \'git\''), '不应残留 git pin 条目')
  rmSync(dir, { recursive: true, force: true })
})

test('updateCheckCompat: 未匹配到 git pin 条目时抛错（防静默失败）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'upstream-'))
  const compatPath = path.join(dir, 'check-compat.mjs')
  writeFileSync(compatPath, 'const EXPECTED = { \'mineflayer\': { kind: \'npm\', version: \'4.40.0\' } }')
  assert.throws(() => updateCheckCompat(compatPath, '4.41.0', '1.41.0'), /未匹配/)
  rmSync(dir, { recursive: true, force: true })
})
