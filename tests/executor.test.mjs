// 动作执行器测试（v1.0.0 C3）：单动作管线（权限/exclusive/校验/冷却/超时/审计）+
// 批量语义（fail-fast/预算上限/中断/暂停钩子）。原语层用假注册表隔离（真实原语的
// handler 行为由 l2.test.mjs 的既有技能测试守护；新原语 collect_blocks/observe_blocks
// 等在 C6-C10 任务脚本测试中覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createActionExecutor, validateParams } from '../src/core/executor.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeCtx (overrides = {}) {
  return {
    cfg: { ops: [], l2: { maxActionsPerCall: 8 } },
    logger: makeLogger(),
    bot: {},
    tasks: { getStatus: () => [], isPendingExclusive: () => false },
    conn: { getStatus: () => ({ state: 'connected' }) },
    plugins: {},
    _caller: null,
    ...overrides
  }
}

/** 假原语注册表：记录调用，可按 op 注入行为。 */
function makePrims (behaviors = {}) {
  const calls = []
  const map = new Map()
  const def = (op, { permission = 'op', exclusiveClass = 'flow', guardText = '', timeoutMs = 1000, cooldownMs = 0, handler } = {}) => {
    map.set(op, { schema: { type: 'object', properties: {} }, permission, exclusiveClass, guardText, timeoutMs, cooldownMs,
      handler: handler ?? (async () => `${op}-ok`) })
  }
  def('goto', { permission: 'op', exclusiveClass: 'movement', guardText: '移动', handler: async () => ({ reached: [1, 64, 2] }) })
  def('dig', { permission: 'op', exclusiveClass: 'build', guardText: '挖掘', cooldownMs: 500, handler: async () => '已挖掘' })
  def('observe_status', { permission: 'all', exclusiveClass: 'readonly', handler: async () => ({ health: 20 }) })
  def('wait', { permission: 'all', exclusiveClass: 'flow', handler: async () => ({ waited: 100 }) })
  def('reply', { permission: 'all', exclusiveClass: 'flow', handler: async () => '已发送' })
  def('boom', { permission: 'op', exclusiveClass: 'build', guardText: '爆破', handler: async () => { throw new Error('爆炸了') } })
  def('slow', { permission: 'op', exclusiveClass: 'movement', guardText: '移动', timeoutMs: 50, handler: async () => { await new Promise(r => setTimeout(r, 500)); return 'done' } })
  for (const [op, b] of Object.entries(behaviors)) {
    const cur = map.get(op) ?? { schema: { type: 'object', properties: {} }, permission: 'op', exclusiveClass: 'flow', guardText: '', timeoutMs: 1000 }
    map.set(op, { ...cur, ...b })
  }
  // 记录所有执行（含失败）
  const orig = new Map(map)
  for (const [op, d] of orig) {
    const h = d.handler
    map.set(op, { ...d, handler: async (c, args, runtime) => { calls.push({ op, args, runtime }); return h(c, args, runtime) } })
  }
  return { map, calls }
}

// ---- validateParams（原 skills 搬入的骨架） ----

test('validateParams: required/type/min/max/isFinite', () => {
  const schema = { type: 'object', required: ['x'], properties: { x: { type: 'integer', min: 0, max: 10 }, y: { type: 'number' } } }
  assert.equal(validateParams(schema, { x: 1 }).ok, true)
  assert.equal(validateParams(schema, {}).ok, false)
  assert.equal(validateParams(schema, { x: 1.5 }).ok, false, 'integer 拒绝小数')
  assert.equal(validateParams(schema, { x: -1 }).ok, false, 'min 拦截')
  assert.equal(validateParams(schema, { x: 11 }).ok, false, 'max 拦截')
  assert.equal(validateParams(schema, { x: Infinity }).ok, false, 'isFinite 兜底')
  assert.equal(validateParams(null, {}).ok, true, '无 schema 放行')
})

// ---- 单动作管线 ----

test('executeOne: 未知 op → ok:false', async () => {
  const { map } = makePrims()
  const ex = createActionExecutor(makeCtx(), { primitives: map, audit: null })
  const r = await ex.executeOne('nonsense', {}, { user: 'steve' })
  assert.equal(r.ok, false)
  assert.ok(r.result.includes('未知动作'))
})

test('executeOne: op 原语权限门（非白名单拒绝）', async () => {
  const { map } = makePrims()
  const ex = createActionExecutor(makeCtx(), { primitives: map, audit: null })
  const r = await ex.executeOne('goto', { x: 1, y: 64, z: 2 }, { user: 'steve' })
  assert.equal(r.ok, false)
  assert.ok(r.result.includes('权限不足'), r.result)
})

test('executeOne: op 白名单成员可执行 + all 原语对普通玩家开放', async () => {
  const { map, calls } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  const r1 = await ex.executeOne('goto', { x: 1, y: 64, z: 2 }, { user: 'steve' })
  assert.equal(r1.ok, true)
  const r2 = await ex.executeOne('observe_status', {}, { user: 'alex' })
  assert.equal(r2.ok, true, 'all 原语无需 op')
  assert.equal(calls.length, 2)
})

test('exclusive 守卫：movement/build/combat/interact 拒绝，readonly/item/flow 放行', async () => {
  const arb = await import('../src/core/arbiter.js')
  const { map, calls } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  arb.setExclusiveOwner('g1')
  try {
    const r1 = await ex.executeOne('goto', { x: 1, y: 2, z: 3 }, { user: 'steve' })
    assert.equal(r1.ok, false)
    assert.ok(r1.result.includes('exclusive 任务 g1'), r1.result)
    const r2 = await ex.executeOne('observe_status', {}, { user: 'steve' })
    assert.equal(r2.ok, true, 'readonly 不拦')
    const r3 = await ex.executeOne('reply', { text: 'hi' }, { user: 'steve' })
    assert.equal(r3.ok, true, 'flow 不拦')
    // bypassExclusive（任务脚本）：守卫跳过
    const r4 = await ex.executeOne('goto', { x: 1, y: 2, z: 3 }, { user: 'steve', bypassExclusive: true })
    assert.equal(r4.ok, true, '脚本自身 bypass 放行')
    assert.equal(calls.length, 3, 'goto 只执行一次（拒绝不占执行）')
  } finally {
    arb.setExclusiveOwner(null)
  }
})

test('冷却由原语 handler 自理（v1.0.0 C4 语义）——executor 不拦截重复调用', async () => {
  const { map, calls } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  // 假原语无冷却字段 → 连续调用全部执行（真原语 dig/place/attack 的冷却在
  // primitives 内"只对实际执行生效"——由 l2.test 的 dig 测试守护）
  const r1 = await ex.executeOne('dig', {}, { user: 'steve' })
  const r2 = await ex.executeOne('dig', {}, { user: 'steve' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(calls.length, 2)
})

test('超时：handler 超时 → ok:false（timeout 消息）', async () => {
  const { map } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  const r = await ex.executeOne('slow', {}, { user: 'steve' })
  assert.equal(r.ok, false)
  assert.ok(r.result.includes('slow timeout') || r.result.includes('超时'), r.result)
})

test('handler 抛错 → ok:false（异常兜底，永不外抛）', async () => {
  const { map } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  const r = await ex.executeOne('boom', {}, { user: 'steve' })
  assert.equal(r.ok, false)
  assert.equal(r.result, '爆炸了')
})

// ---- 批量语义 ----

test('executeBatch: 顺序执行 + 结果数组按序对应', async () => {
  const { map, calls } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  const r = await ex.executeBatch([
    { op: 'goto', args: { x: 1, y: 2, z: 3 } },
    { op: 'dig' },
    { op: 'observe_status' }
  ], { user: 'steve' })
  assert.equal(r.ok, true)
  assert.equal(r.results.length, 3)
  assert.deepEqual(r.results.map(x => x.op), ['goto', 'dig', 'observe_status'])
  assert.equal(r.results[1].ok, true)
  assert.equal(calls.length, 3)
})

test('executeBatch: 默认 fail-fast——首个失败即停返回 failedAt', async () => {
  const { map, calls } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  const r = await ex.executeBatch([
    { op: 'goto', args: { x: 1, y: 2, z: 3 } },
    { op: 'boom' },
    { op: 'dig' }
  ], { user: 'steve' })
  assert.equal(r.ok, false)
  assert.equal(r.failedAt, 1)
  assert.equal(r.results.length, 2, '失败后不再执行')
  assert.equal(calls.length, 2, 'dig 未执行')
})

test('executeBatch: continueOnError 续跑', async () => {
  const { map, calls } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  const r = await ex.executeBatch([
    { op: 'boom' },
    { op: 'dig' }
  ], { user: 'steve', continueOnError: true })
  assert.equal(r.ok, true)
  assert.equal(r.results.length, 2)
  assert.equal(r.results[0].ok, false)
  assert.equal(r.results[1].ok, true)
  assert.equal(calls.length, 2)
})

test('executeBatch: 动作数超 maxActionsPerCall → 解析期拒绝（不半执行）', async () => {
  const { map, calls } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 2 } } }), { primitives: map, audit: null })
  const r = await ex.executeBatch([
    { op: 'dig' }, { op: 'dig' }, { op: 'dig' }
  ], { user: 'steve' })
  assert.equal(r.ok, false)
  assert.ok(r.rejected.includes('超过单次上限 2'), r.rejected)
  assert.equal(r.results.length, 0)
  assert.equal(calls.length, 0, '解析期拒绝不执行任何动作')
})

test('executeBatch: 空数组/非法元素 → rejected', async () => {
  const { map } = makePrims()
  const ex = createActionExecutor(makeCtx(), { primitives: map, audit: null })
  assert.equal((await ex.executeBatch([], {})).rejected !== null, true)
  assert.equal((await ex.executeBatch([{ args: {} }], {})).rejected !== null, true, '缺 op 拒绝')
})

test('executeBatch: signal 中断——动作间检查 abort', async () => {
  const { map, calls } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  const ac = new AbortController()
  ac.abort()
  const r = await ex.executeBatch([{ op: 'dig' }, { op: 'dig' }], { user: 'steve', signal: ac.signal })
  assert.equal(r.ok, false)
  assert.equal(r.rejected, 'interrupted')
  assert.equal(calls.length, 0, '中断后不执行')
})

test('executeBatch: waitIfPaused 钩子（脚本暂停）在动作间调用', async () => {
  const { map, calls } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  let paused = 0
  // 用无冷却的 observe_status×3（dig 有 500ms 冷却会自撞）
  const r = await ex.executeBatch([
    { op: 'observe_status' }, { op: 'observe_status' }, { op: 'observe_status' }
  ], { user: 'steve', waitIfPaused: async () => { paused++ } })
  assert.equal(r.ok, true)
  assert.ok(paused >= 2, '每动作前调用暂停钩子')
  assert.equal(calls.length, 3)
})

// ---- 审计挂点 ----

test('审计挂点：每个动作写一条审计（含来源/用户/时长）', async () => {
  const { map } = makePrims()
  const entries = []
  const audit = { append: (e) => entries.push(e) }
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit })
  await ex.executeBatch([{ op: 'dig' }, { op: 'boom' }], { user: 'steve', source: 'llm', taskId: 't1' })
  assert.equal(entries.length, 2)
  assert.equal(entries[0].op, 'dig')
  assert.equal(entries[0].ok, true)
  assert.equal(entries[0].source, 'llm')
  assert.equal(entries[0].user, 'steve')
  assert.equal(entries[0].taskId, 't1')
  assert.equal(entries[1].ok, false)
  assert.ok(entries[0].durationMs >= 0)
})

test('审计失败不阻塞执行（fire-and-forget）', async () => {
  const { map } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), {
    primitives: map,
    audit: { append: () => { throw new Error('disk full') } }
  })
  const r = await ex.executeOne('dig', {}, { user: 'steve' })
  assert.equal(r.ok, true, '审计失败不阻断动作结果')
})

test('缺省 audit：无 log.dir 时 noop 不抛', async () => {
  const { map } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map })
  const r = await ex.executeOne('dig', {}, { user: 'steve' })
  assert.equal(r.ok, true)
})

test('第 8 轮：shape 预校验——非法元素整批拒绝（前序动作不半执行）', async () => {
  const { map, calls } = makePrims()
  const ex = createActionExecutor(makeCtx({ cfg: { ops: ['steve'], l2: { maxActionsPerCall: 8 } } }), { primitives: map, audit: null })
  const r = await ex.executeBatch([
    { op: 'goto', args: { x: 1, y: 64, z: 2 } },
    { args: { x: 9 } } // 缺 op
  ], { user: 'steve' })
  assert.ok(r.rejected.includes('缺少 op'), r.rejected)
  assert.equal(calls.length, 0, '预校验失败——任何动作不得执行（修复前 goto 已真实执行、结果丢弃）')
})

test('第 8 轮：validateParams 顶层类型检查（args 非对象拒绝）', () => {
  const schema = { type: 'object', properties: { x: { type: 'integer' } } }
  assert.equal(validateParams(schema, 123).ok, false)
  assert.equal(validateParams(schema, 'x').ok, false)
  assert.equal(validateParams(schema, [1]).ok, false)
  assert.equal(validateParams(schema, { x: 1 }).ok, true)
})

test('L2 修复：空动作数组拒绝也写审计（与文件头注释一致——解析期拒绝无静默空洞）', async () => {
  const auditEntries = []
  const { map } = makePrims()
  const ex = createActionExecutor(makeCtx(), {
    primitives: map,
    audit: { append: async (e) => { auditEntries.push(e) } }
  })
  const r = await ex.executeBatch([], { user: 'steve', source: 'llm' })
  assert.equal(r.ok, false)
  assert.ok(auditEntries.length >= 1, '空数组拒绝应写审计')
  assert.ok(auditEntries[0].result.includes('动作数组为空'), auditEntries[0].result)
})
