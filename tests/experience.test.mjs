// 经验记忆测试（v1.0.0 C11）：存储（原子写/容量/形状防御/未来版本拒绝）+
// 反思钩子（失败收集/确定性错误排除/注入格式）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createExperienceStore, loadExperience } from '../src/l2/experience.ts'
import { AgentInterface } from '../src/l2/agent-interface.ts'
import { createActionExecutor } from '../src/core/executor.ts'

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

// ---- 技能库（v1.5.0：成功实践沉淀，与经验互补）----

import { createSkillsStore, loadSkills } from '../src/l2/skills.ts'

test('skill: add→flush 原子落盘 + 结构化字段完整', () => {
  const { dir } = makeTmp()
  try {
    const s = createSkillsStore({ file: path.join(dir, 'skills.json'), debounceMs: 100000 })
    s.add({ taskType: 'mine', name: '高效挖铁', summary: '先观察再批量采集', steps: ['observe_blocks 找矿', 'goto 靠近', 'collect_blocks'], pitfalls: ['背包满先存'], sourceTask: 'm1', ts: 1 })
    s.flush()
    const disk = JSON.parse(readFileSync(path.join(dir, 'skills.json'), 'utf8'))
    assert.equal(disk.schemaVersion, 1)
    assert.equal(disk.items.length, 1)
    assert.equal(disk.items[0].taskType, 'mine')
    assert.deepEqual(disk.items[0].steps, ['observe_blocks 找矿', 'goto 靠近', 'collect_blocks'])
    assert.equal(disk.items[0].usage, 1)
    assert.equal(disk.items[0].sourceTask, 'm1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill: 容量裁剪 FIFO（超 capacity 按最旧淘汰）', () => {
  const { dir } = makeTmp()
  try {
    const s = createSkillsStore({ file: path.join(dir, 'skills.json'), debounceMs: 100000, capacity: 3 })
    for (let i = 0; i < 5; i++) s.add({ taskType: 'mine', name: `skill-${i}`, summary: `s${i}`, steps: ['x'] })
    s.flush()
    const disk = JSON.parse(readFileSync(path.join(dir, 'skills.json'), 'utf8'))
    assert.equal(disk.items.length, 3)
    assert.equal(disk.items[0].name, 'skill-2', '最旧两条被淘汰')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill: 同 taskType+name 覆盖刷新 usage++ 不追加', () => {
  const { dir } = makeTmp()
  try {
    const s = createSkillsStore({ file: path.join(dir, 'skills.json'), debounceMs: 100000 })
    s.add({ taskType: 'mine', name: '高效挖铁', summary: 'v1', steps: ['a'], ts: 1 })
    s.add({ taskType: 'mine', name: '高效挖铁', summary: 'v2', steps: ['a', 'b'], sourceTask: 'm2', ts: 2 })
    assert.equal(s.size(), 1, '同 id 覆盖不追加')
    const it = s.recent(1)[0]
    assert.equal(it.summary, 'v2')
    assert.deepEqual(it.steps, ['a', 'b'])
    assert.equal(it.usage, 2, '重复实践强化计数')
    assert.equal(it.sourceTask, 'm2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill: 字段截断（name/summary/steps 条数与长度）', () => {
  const { dir } = makeTmp()
  try {
    const s = createSkillsStore({ file: path.join(dir, 'skills.json'), debounceMs: 100000 })
    s.add({
      taskType: 'mine',
      name: 'x'.repeat(50),
      summary: 'y'.repeat(150),
      steps: Array.from({ length: 8 }, (_, i) => `step-${i}-` + 'z'.repeat(90)),
      pitfalls: Array.from({ length: 5 }, (_, i) => `p${i}`)
    })
    const it = s.recent(1)[0]
    assert.equal(it.name.length, 40)
    assert.equal(it.summary.length, 120)
    assert.equal(it.steps.length, 6, 'steps 取前 6 条')
    assert.equal(it.steps[0].length, 80, '每条 ≤80')
    assert.equal(it.pitfalls.length, 3, 'pitfalls 取前 3 条')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill: match 按 taskType 精确匹配新→旧；无匹配空；recent 新→旧', () => {
  const { dir } = makeTmp()
  try {
    const s = createSkillsStore({ file: path.join(dir, 'skills.json'), debounceMs: 100000 })
    s.add({ taskType: 'mine', name: '挖铁', summary: 's1', steps: ['a'], ts: 1 })
    s.add({ taskType: 'chop', name: '砍树', summary: 's2', steps: ['b'], ts: 2 })
    s.add({ taskType: 'mine', name: '挖煤', summary: 's3', steps: ['c'], ts: 3 })
    const hit = s.match(['mine'], 2)
    assert.equal(hit.length, 2)
    assert.equal(hit[0].name, '挖煤', '新→旧')
    assert.equal(s.match(['combat']).length, 0, '无匹配返回空')
    const recent = s.recent(2)
    assert.equal(recent[0].name, '挖煤')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill: 形状防御（坏数据按空）+ 未来版本拒绝加载', () => {
  const { dir } = makeTmp()
  try {
    const file = path.join(dir, 'skills.json')
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, items: [
      { taskType: 'mine', name: 'ok', steps: ['a'] },
      { name: 'no-tasktype' },
      { taskType: 'mine' },
      { taskType: 'mine', name: 'bad-steps', steps: 'not-array', usage: -5 }
    ] }))
    const s = createSkillsStore({ file, debounceMs: 100000 })
    assert.equal(s.size(), 2, '缺 taskType/name 被过滤')
    const bad = s.recent(2).find(x => x.name === 'bad-steps')
    assert.deepEqual(bad.steps, [], 'steps 非数组强制空')
    assert.equal(bad.usage, 1, 'usage 非正整数归 1')
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, items: [] }))
    assert.throws(() => loadSkills(file), /schemaVersion=99/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 技能学习循环（v1.5.0：任务完成 → LLM 提炼 → 入库）----

import { parseSkillJson } from '../src/l2/agent-interface.ts'

const SKILL_JSON = '{"name":"高效挖铁","summary":"先观察再批量采集","steps":["observe_blocks 找矿","goto 靠近","collect_blocks"],"pitfalls":["背包满先存"]}'
const SKILL_REC = { entry: { id: 'm1', type: 'mine', options: { blockTypes: ['iron_ore'] } }, task: { state: 'completed', counters: { mined: 5 } } }

test('skill 学习: 任务完成 → LLM 提炼 → 入库（system 含总结器人设/输入素材）', async () => {
  const { dir, file } = makeTmp()
  try {
    const skills = createSkillsStore({ file, debounceMs: 100000 })
    const ctx = makeCtx()
    const provider = makeProvider([{ text: SKILL_JSON, toolCalls: [] }])
    const executor = createActionExecutor(ctx, { audit: null })
    const agent = new AgentInterface(ctx, { provider, executor, skills, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
    const ok = await agent.learnFromTask(SKILL_REC)
    assert.equal(ok, true)
    skills.flush()
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(disk.items.length, 1)
    assert.equal(disk.items[0].taskType, 'mine')
    assert.equal(disk.items[0].name, '高效挖铁')
    assert.equal(disk.items[0].sourceTask, 'm1')
    // 调用面：system 含总结器人设、输入含 type/options/counters
    assert.ok(provider.calls[0].system.includes('技能总结器'), 'system 应为总结器人设')
    const input = provider.calls[0].messages[0].content
    assert.ok(input.includes('mine'), input)
    assert.ok(input.includes('iron_ore'), input)
    assert.ok(input.includes('mined'), input)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill 学习: taskType 强制覆盖（LLM 乱起类型名不污染检索键）', async () => {
  const { dir, file } = makeTmp()
  try {
    const skills = createSkillsStore({ file, debounceMs: 100000 })
    const ctx = makeCtx()
    const provider = makeProvider([{ text: '{"name":"挖矿技巧","summary":"s","steps":["a"]}', toolCalls: [] }])
    const executor = createActionExecutor(ctx, { audit: null })
    const agent = new AgentInterface(ctx, { provider, executor, skills, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
    await agent.learnFromTask(SKILL_REC)
    assert.equal(skills.recent(1)[0].taskType, 'mine', '以 rec.entry.type 为准')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill 学习: skillEnabled=false / 冷却 / 非 completed 均不学习', async () => {
  const { dir, file } = makeTmp()
  try {
    const skills = createSkillsStore({ file, debounceMs: 100000 })
    const ctx = makeCtx()
    // 开关关
    let provider = makeProvider([{ text: SKILL_JSON, toolCalls: [] }])
    let executor = createActionExecutor(ctx, { audit: null })
    let agent = new AgentInterface(ctx, { provider, executor, skills, config: { enabled: true, cooldownMs: 0, maxSteps: 5, skillEnabled: false } })
    assert.equal(await agent.learnFromTask(SKILL_REC), false)
    assert.equal(provider.calls.length, 0, '开关关不调 provider')
    // 冷却内
    provider = makeProvider([{ text: SKILL_JSON, toolCalls: [] }])
    executor = createActionExecutor(ctx, { audit: null })
    agent = new AgentInterface(ctx, { provider, executor, skills, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
    agent.lastSkillLearnAt = Date.now()
    assert.equal(await agent.learnFromTask(SKILL_REC), false)
    assert.equal(provider.calls.length, 0)
    // 非 completed（failed/stopped 双保险）
    provider = makeProvider([{ text: SKILL_JSON, toolCalls: [] }])
    executor = createActionExecutor(ctx, { audit: null })
    agent = new AgentInterface(ctx, { provider, executor, skills, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
    assert.equal(await agent.learnFromTask({ ...SKILL_REC, task: { state: 'failed' } }), false)
    assert.equal(await agent.learnFromTask({ ...SKILL_REC, task: { state: 'stopped' } }), false)
    assert.equal(provider.calls.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill 学习: 非法 JSON 静默失败不落盘（围栏变体合法；坏形状丢弃）', async () => {
  const { dir, file } = makeTmp()
  try {
    const skills = createSkillsStore({ file, debounceMs: 100000 })
    const ctx = makeCtx()
    for (const bad of [
      '不是 JSON',
      '{"name":"x","summary":"s"}', // 缺 steps
      '{"name":"x","summary":"s","steps":[]}', // steps 空
      '```json\n{"name":"围栏","summary":"s","steps":["a"]}\n```', // 围栏变体（合法）
      '[1,2,3]' // 非对象
    ]) {
      const provider = makeProvider([{ text: bad, toolCalls: [] }])
      const executor = createActionExecutor(ctx, { audit: null })
      const agent = new AgentInterface(ctx, { provider, executor, skills, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
      await agent.learnFromTask(SKILL_REC)
    }
    skills.flush()
    assert.equal(skills.size(), 1, '围栏变体解析成功；其余静默丢弃')
    assert.equal(skills.recent(1)[0].name, '围栏')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseSkillJson: 围栏剥离/形状校验单元', () => {
  assert.deepEqual(parseSkillJson('```json\n{"name":"n","summary":"s","steps":["a"],"pitfalls":["p"]}\n```'), { name: 'n', summary: 's', steps: ['a'], pitfalls: ['p'] })
  assert.equal(parseSkillJson('{"name":"n","summary":"s","steps":[1,2]}'), null, 'steps 非字符串数组拒绝')
  assert.equal(parseSkillJson('{"summary":"s","steps":["a"]}'), null, '缺 name 拒绝')
  assert.equal(parseSkillJson(''), null)
  assert.equal(parseSkillJson(null), null)
})

test('skill 注入: 活跃任务类型匹配 → system 含 技能: 段', async () => {
  const { dir, file } = makeTmp()
  try {
    const skills = createSkillsStore({ file, debounceMs: 100000 })
    skills.add({ taskType: 'mine', name: '高效挖铁', summary: '先观察再采集', steps: ['observe_blocks', 'collect_blocks'] })
    skills.add({ taskType: 'chop', name: '砍树', summary: 's2', steps: ['a'] })
    const ctx = makeCtx()
    ctx.tasks = { getStatus: () => [{ id: 'm1', state: 'running', type: 'mine' }] }
    const provider = makeProvider([{ text: '好', toolCalls: [] }])
    const executor = createActionExecutor(ctx, { audit: null })
    const agent = new AgentInterface(ctx, { provider, executor, skills, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
    await agent.chat('op1', '你好')
    const sys = provider.calls[0].system
    assert.ok(sys.includes('\n技能:\n- [mine] 高效挖铁'), '应含技能注入段且匹配活跃任务类型')
    assert.ok(sys.includes('steps: 1.observe_blocks'), '应含步骤')
    assert.ok(!sys.includes('\n技能:\n- [chop]'), '不匹配的类型不注入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill 注入: 无匹配回退最近 1 条；skillInjection=false / 无 skills 均无技能段', async () => {
  const { dir, file } = makeTmp()
  try {
    const skills = createSkillsStore({ file, debounceMs: 100000 })
    skills.add({ taskType: 'mine', name: '挖铁', summary: 's1', steps: ['a'], ts: 1 })
    skills.add({ taskType: 'chop', name: '砍树', summary: 's2', steps: ['b'], ts: 2 })
    const ctx = makeCtx()
    ctx.tasks = { getStatus: () => [{ id: 'm1', state: 'running', type: 'combat' }] } // 无 combat 技能
    const provider = makeProvider([{ text: '好', toolCalls: [] }])
    const executor = createActionExecutor(ctx, { audit: null })
    const agent = new AgentInterface(ctx, { provider, executor, skills, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
    await agent.chat('op1', '你好')
    assert.ok(provider.calls[0].system.includes('\n技能:\n- [chop] 砍树'), '无匹配回退最近 1 条')
    // skillInjection=false
    const p2 = makeProvider([{ text: '好', toolCalls: [] }])
    const agent2 = new AgentInterface(ctx, { provider: p2, executor, skills, config: { enabled: true, cooldownMs: 0, maxSteps: 5, skillInjection: false } })
    await agent2.chat('op1', '你好')
    assert.ok(!p2.calls[0].system.includes('\n技能:\n- ['), '开关关无技能注入段')
    // 无 skills 依赖（零成本）
    const p3 = makeProvider([{ text: '好', toolCalls: [] }])
    const agent3 = new AgentInterface(ctx, { provider: p3, executor, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
    await agent3.chat('op1', '你好')
    assert.ok(!p3.calls[0].system.includes('\n技能:\n- ['), '无技能库无技能注入段')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('L14 修复：loadSkills 缺 id 条目归一化 id——add 覆盖刷新不再失效', () => {
  const { dir } = makeTmp()
  try {
    const file = path.join(dir, 'skills.json')
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      items: [{ taskType: 'mine', name: '挖铁', summary: 's1', steps: ['a'] }]
    }))
    const s = createSkillsStore({ file, debounceMs: 100000 })
    const loaded = s.recent(10)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, 'mine:挖铁', '缺 id 条目应归一化 id（与 add 派生一致）')
    // 覆盖刷新生效（修复前 add 按 id 找不到 → 重复实践堆积挤掉有效技能）
    s.add({ taskType: 'mine', name: '挖铁', summary: 's2', steps: ['b'] })
    assert.equal(s.size(), 1, '同 taskType+name 覆盖而非堆积')
    assert.equal(s.recent(1)[0].summary, 's2')
    assert.equal(s.recent(1)[0].usage, 2, 'usage 递增（覆盖刷新语义）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
