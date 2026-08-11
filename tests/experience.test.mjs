// 经验记忆测试（v1.0.0 C11）：存储（原子写/容量/形状防御/未来版本拒绝）+
// 反思钩子（失败收集/确定性错误排除/注入格式）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createExperienceStore, loadExperience } from '../src/l2/experience.js'
import { AgentInterface } from '../src/l2/agent-interface.js'
import { createActionExecutor } from '../src/core/executor.js'

function makeTmp () {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'exp-'))
  return { dir, file: path.join(dir, 'experience.json') }
}

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

test('add→flush 原子落盘（无 .tmp 残留）+ 内容完整', () => {
  const { dir, file } = makeTmp()
  try {
    const s = createExperienceStore({ file, debounceMs: 100000 })
    s.add({ op: 'goto', error: '移动失败: 无法到达（无路径）', lesson: '先观察地形再规划路径', ts: 1 })
    s.flush()
    assert.ok(existsSync(file))
    assert.ok(!existsSync(file + '.tmp'))
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(disk.schemaVersion, 2)
    assert.equal(disk.items[0].lesson, '先观察地形再规划路径')
    assert.equal(disk.items[0].op, 'goto')
    assert.equal(disk.items[0].count, 1, '新条目 count 初始 1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('容量裁剪：超 capacity 按最旧淘汰（FIFO）', () => {
  const { dir, file } = makeTmp()
  try {
    const s = createExperienceStore({ file, debounceMs: 100000, capacity: 3 })
    for (let i = 0; i < 5; i++) s.add({ op: 'dig', error: 'e', lesson: `lesson-${i}` })
    s.flush()
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(disk.items.length, 3)
    assert.equal(disk.items[0].lesson, 'lesson-2', '最旧两条被淘汰')
    assert.equal(disk.items[2].lesson, 'lesson-4')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recent 新→旧排序 + 形状防御（坏数据按空）', () => {
  const { dir, file } = makeTmp()
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, items: [{ op: 'a', lesson: 'l1' }, { lesson: 123 }, { op: 'b' }] }))
    const s = createExperienceStore({ file, debounceMs: 100000 })
    assert.equal(s.size(), 1, '缺 lesson 字符串的条目被过滤')
    s.add({ op: 'goto', error: 'e', lesson: 'l2' })
    const recent = s.recent(2)
    assert.equal(recent[0].lesson, 'l2', 'recent 新→旧')
    assert.equal(recent[1].lesson, 'l1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未来版本拒绝加载（明确报错）', () => {
  const { dir, file } = makeTmp()
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, items: [] }))
    assert.throws(() => loadExperience(file), /schemaVersion=99/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 反思钩子（AgentInterface 层）----

function makeCtx (botOverrides = {}) {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
    chat: () => {},
    ...botOverrides
  }
  return { cfg: { ops: ['op1'], l2: { maxActionsPerCall: 8 } }, logger: makeLogger(), bot, tasks: {}, conn: { getStatus: () => ({ state: 'connected' }) }, plugins: {} }
}

/** 可脚本化 fake provider（summarize 与 chat 共用）。 */
function makeProvider (script) {
  const calls = []
  return {
    calls,
    async chat (messages, opts = {}) {
      calls.push({ kind: 'chat', messages, system: opts.system })
      const step = script.shift()
      if (!step) return { text: '（脚本结束）', toolCalls: [] }
      return step
    },
    async summarize (prompt) {
      calls.push({ kind: 'summarize', prompt })
      return '教训：先观察再行动'
    }
  }
}

test('反思：运行时失败（NoPath）→ 总结 → 经验入库', async () => {
  const { dir, file } = makeTmp()
  try {
    const experience = createExperienceStore({ file, debounceMs: 100000 })
    const ctx = makeCtx()
    const provider = makeProvider([
      { text: null, toolCalls: [{ id: 't1', name: 'act', arguments: { actions: [{ op: 'goto', args: { x: 1, y: 2, z: 3 } }] } }] },
      { text: '好', toolCalls: [] },
      { text: '教训：先观察再行动', toolCalls: [] } // 反思的 summarize 调用
    ])
    const executor = createActionExecutor(ctx, { audit: null })
    // 让 goto 失败：bot 缺 movement 依赖（pathfinder.goto undefined → 移动失败）
    const agent = new AgentInterface(ctx, { provider, executor, experience, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
    await agent.chat('op1', '走过去')
    await new Promise(r => setTimeout(r, 30)) // 反思是 fire-and-forget——等微任务完成
    experience.flush()
    assert.ok(experience.size() >= 1, `经验应沉淀: ${experience.size()}`)
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(disk.items[0].op, 'goto')
    assert.ok(disk.items[0].lesson.includes('教训'), disk.items[0].lesson)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('反思：确定性错误（权限/参数）不反思', async () => {
  const { dir, file } = makeTmp()
  try {
    const experience = createExperienceStore({ file, debounceMs: 100000 })
    const ctx = makeCtx()
    const provider = makeProvider([
      { text: null, toolCalls: [{ id: 't1', name: 'act', arguments: { actions: [{ op: 'goto', args: { x: 1, y: 2, z: 3 } }] } }] },
      { text: '好', toolCalls: [] }
    ])
    const executor = createActionExecutor(ctx, { audit: null })
    // 非 op 调用 goto → 权限不足（确定性错误）
    const agent = new AgentInterface(ctx, { provider, executor, experience, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
    await agent.chat('creeper', '走过去')
    experience.flush()
    assert.equal(experience.size(), 0, '权限不足是确定性错误——不反思')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('经验注入：system 含检索式经验（无失败 op 时回退最近 2 条）', async () => {
  const { dir, file } = makeTmp()
  try {
    const experience = createExperienceStore({ file, debounceMs: 100000 })
    experience.add({ op: 'goto', error: 'e1', lesson: '移动失败先观察地形', ts: 1 })
    const ctx = makeCtx()
    const provider = makeProvider([{ text: '你好', toolCalls: [] }])
    const executor = createActionExecutor(ctx, { audit: null })
    const agent = new AgentInterface(ctx, { provider, executor, experience, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
    await agent.chat('op1', 'hi')
    assert.ok(provider.calls[0].system.includes('经验教训:'), 'system 应含经验注入')
    assert.ok(provider.calls[0].system.includes('移动失败先观察地形'), provider.calls[0].system)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('经验检索：match 按 op 精确匹配；add 去重合并 count', () => {
  const { dir, file } = makeTmp()
  try {
    const s = createExperienceStore({ file, debounceMs: 100000 })
    s.add({ op: 'goto', error: 'e1', lesson: '教训A', ts: 1 })
    s.add({ op: 'dig', error: 'e2', lesson: '教训B', ts: 2 })
    s.add({ op: 'goto', error: 'e1', lesson: '教训A', ts: 3 }) // 重复 → 合并
    assert.equal(s.size(), 2, '同 op+lesson 合并不追加')
    const hit = s.match(['goto'], 3)
    assert.equal(hit.length, 1)
    assert.equal(hit[0].lesson, '教训A')
    assert.equal(hit[0].count, 2, '重复教训计数累计')
    assert.equal(s.match(['unknown'], 3).length, 0, '无匹配返回空（回退最近）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
