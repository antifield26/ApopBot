// release.mjs 纯函数测试（第六轮 C4 版本管理：computeNextVersion 递增语义 +
// bumpFiles 双文件同步；git 命令打印路径手动演练）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { computeNextVersion, bumpFiles } from '../scripts/release.mjs'

test('computeNextVersion: patch 递增最低位', () => {
  assert.equal(computeNextVersion('0.2.0', 'patch'), '0.2.1')
  assert.equal(computeNextVersion('0.2.9', 'patch'), '0.2.10') // 进位不进位到 minor
})

test('computeNextVersion: minor 递增并归零 patch', () => {
  assert.equal(computeNextVersion('0.2.9', 'minor'), '0.3.0')
})

test('computeNextVersion: major 递增并归零低位', () => {
  assert.equal(computeNextVersion('0.2.0', 'major'), '1.0.0')
  assert.equal(computeNextVersion('1.9.9', 'major'), '2.0.0')
})

test('computeNextVersion: 非法输入报错', () => {
  assert.throws(() => computeNextVersion('abc', 'patch'), /非法版本号/)
  assert.throws(() => computeNextVersion('0.2', 'patch'), /三段/)
  assert.throws(() => computeNextVersion('0.2.0', 'hotfix'), /未知递增类型/)
})

test('bumpFiles: package.json 与 package-lock.json 三处版本同步', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-test-'))
  const pkgPath = path.join(dir, 'package.json')
  const lockPath = path.join(dir, 'package-lock.json')
  writeFileSync(pkgPath, JSON.stringify({ version: '0.2.0' }, null, 2) + '\n')
  writeFileSync(lockPath, JSON.stringify({
    name: 'minecraft-bot',
    version: '0.2.0',
    lockfileVersion: 3,
    packages: { '': { name: 'minecraft-bot', version: '0.2.0' }, 'node_modules/x': { version: '1.0.0' } }
  }, null, 2) + '\n')
  try {
    const files = bumpFiles('0.2.1', { pkgPath, lockPath })
    assert.deepEqual(files, [pkgPath, lockPath])
    assert.equal(JSON.parse(readFileSync(pkgPath, 'utf8')).version, '0.2.1')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert.equal(lock.version, '0.2.1')
    assert.equal(lock.packages[''].version, '0.2.1')
    // 其他包条目不受影响
    assert.equal(lock.packages['node_modules/x'].version, '1.0.0')
    // 末尾换行保留（JSON 规范）
    assert.ok(readFileSync(pkgPath, 'utf8').endsWith('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bumpFiles: lock 无 packages[""] 时只写根 version（容错）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-test-'))
  const pkgPath = path.join(dir, 'package.json')
  const lockPath = path.join(dir, 'package-lock.json')
  writeFileSync(pkgPath, JSON.stringify({ version: '1.0.0' }, null, 2) + '\n')
  writeFileSync(lockPath, JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3 }, null, 2) + '\n')
  try {
    bumpFiles('1.0.1', { pkgPath, lockPath })
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).version, '1.0.1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
