// 运行状态快照测试（U1）：loadState 容错、createStateStore 防抖写/flush/读写往返。
// 用 mkdtemp 临时目录，不触碰真实 data/state.json。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadState, createStateStore } from '../src/core/state.js'

function makeTmpDir (t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcbot-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('loadState: 文件不存在 → 空态', (t) => {
  const dir = makeTmpDir(t)
  assert.deepEqual(loadState(path.join(dir, 'missing.json')), { tasks: [], counters: {}, memory: {} })
})

test('loadState: 损坏 JSON → 空态（不抛错）', (t) => {
  const dir = makeTmpDir(t)
  const file = path.join(dir, 'bad.json')
  writeFileSync(file, '{ not json')
  assert.deepEqual(loadState(file), { tasks: [], counters: {}, memory: {} })
})

test('修复: 文件不存在（冷启动）→ memory getter 不抛（回归："undefined" is not valid JSON）', (t) => {
  // 本地测试冷启动暴露：loadState catch 分支此前漏 memory 键 → feature layer 重建时
  // importSnapshot(ctx.stateStore.memory) 触发 getter → JSON.parse(undefined) 抛错
  const dir = makeTmpDir(t)
  const store = createStateStore({ file: path.join(dir, 'missing.json') })
  assert.deepEqual(store.memory, {}, 'memory getter 应返回空对象而非抛错')
})

test('loadState: 形状防御——tasks 非数组/条目缺 id 过滤', (t) => {
  const dir = makeTmpDir(t)
  const file = path.join(dir, 'shape.json')
  writeFileSync(file, JSON.stringify({ tasks: ['junk', { id: 'ok', type: 'mine' }], counters: null }))
  const s = loadState(file)
  assert.equal(s.tasks.length, 1)
  assert.equal(s.tasks[0].id, 'ok')
  assert.deepEqual(s.counters, {})
})

test('store: setTasks 防抖写（debounce 内不落盘），flush 立即落盘', (t) => {
  const dir = makeTmpDir(t)
  const file = path.join(dir, 'state.json')
  const store = createStateStore({ file, debounceMs: 200 })
  store.setTasks([{ id: 'gold', type: 'mine', options: { blockTypes: ['gold_ore'] } }])
  assert.equal(store.tasks.length, 1, '内存立即可见')
  assert.ok(!fileExists(file), '防抖窗口内不应落盘')
  store.flush()
  assert.ok(fileExists(file), 'flush 后应落盘')
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(disk.tasks[0].id, 'gold')
  assert.equal(disk.tasks[0].options.blockTypes[0], 'gold_ore')
  // C8 原子写：flush 后不得残留 .tmp 中间文件（写失败清理兜底）
  assert.ok(!fileExists(file + '.tmp'), '原子写后不得残留 .tmp')
})

test('store: 防抖到期自动落盘（不调 flush）', (t) => {
  const dir = makeTmpDir(t)
  const file = path.join(dir, 'state.json')
  const store = createStateStore({ file, debounceMs: 50 })
  store.setTasks([{ id: 'a', type: 'afk', options: {} }])
  return new Promise((resolve) => setTimeout(() => {
    try {
      assert.ok(fileExists(file), '防抖到期应自动落盘')
      resolve()
    } catch (err) { resolve(err) }
  }, 120)).then((err) => { if (err) throw err })
})

test('store: setCounter 与读写往返', (t) => {
  const dir = makeTmpDir(t)
  const file = path.join(dir, 'state.json')
  const store = createStateStore({ file })
  store.setCounter('m1', { mined: 5 })
  store.flush()
  const again = createStateStore({ file })
  assert.deepEqual(again.counters, { m1: { mined: 5 } }, '重启后（新实例）计数器应可读')
})

test('C2 修复：process exit 事件同步落盘（防抖窗口内未 flush 的变更不丢）', (t) => {
  const dir = makeTmpDir(t)
  const file = path.join(dir, 'state.json')
  const store = createStateStore({ file, debounceMs: 60000 }) // 防抖远未到期
  store.setCounter('m1', { mined: 3 })
  process.emit('exit') // 触发 exit 处理器（同步 writeFileSync）
  assert.ok(fileExists(file), 'exit 时应同步落盘')
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(disk.counters.m1, { mined: 3 }, 'exit 前未 flush 的变更应落盘')
})

test('C6/N 修复: deleteCounter 移除计数器（removeTask 后快照不残留垃圾数据）', (t) => {
  const dir = makeTmpDir(t)
  const file = path.join(dir, 'state.json')
  const store = createStateStore({ file })
  store.setCounter('m1', { mined: 5 })
  store.setCounter('g1', { kills: 2 })
  store.deleteCounter('m1')
  store.flush()
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(disk.counters, { g1: { kills: 2 } }, '删除后不应残留')
  store.deleteCounter('nonexistent') // 幂等
  store.flush()
})

test('store: tasks 读副本——外部修改不污染内存态', (t) => {
  const dir = makeTmpDir(t)
  const store = createStateStore({ file: path.join(dir, 's.json') })
  store.setTasks([{ id: 'a', type: 'mine', options: { x: 1 } }])
  const copy = store.tasks
  copy[0].id = 'hacked'
  assert.equal(store.tasks[0].id, 'a', '读副本应防外部修改')
})

test('B1: memory 持久化往返 + 读副本（L2 探索记忆通道）', (t) => {
  const dir = makeTmpDir(t)
  const file = path.join(dir, 's.json')
  const store = createStateStore({ file })
  store.setMemory({ version: 1, anchors: [{ x: 1, y: 64, z: 2, ts: 1 }], resources: { iron_ore: [{ x: 10, y: 63, z: 8, ts: 1 }] } })
  store.flush()
  const store2 = createStateStore({ file })
  assert.deepEqual(store2.memory.resources.iron_ore[0].x, 10, '重启后 memory 应保留')
  assert.equal(store2.memory.anchors.length, 1)
  // 读副本防污染
  const copy = store2.memory
  copy.resources = {}
  assert.equal(store2.memory.resources.iron_ore.length, 1)
})

test('B1: loadState 形状防御——memory 非对象按空处理', (t) => {
  const dir = makeTmpDir(t)
  const file = path.join(dir, 's.json')
  writeFileSync(file, JSON.stringify({ memory: 'bad', tasks: [] }))
  const store = createStateStore({ file })
  assert.deepEqual(store.memory, {}, '坏 memory 应按空处理')
})

function fileExists (f) {
  try { readFileSync(f); return true } catch { return false }
}
