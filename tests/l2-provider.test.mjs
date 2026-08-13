// L2 Provider HTTP 层测试：mock 全局 fetch 覆盖真实网络路径
// v1.0.0 C2：单 Provider（仅云端 Anthropic 兼容 API，non-reasoning）——
// Ollama/auto 相关测试已随本地 provider 移除。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/l2/provider.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

const l2Base = { enabled: true, model: 'm', maxSteps: 5, cooldownMs: 0 }

/** mock 全局 fetch；返回调用记录 [{ url, opts, body }]。 */
function mockFetch (handler) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null })
    return handler(url, opts)
  }
  return calls
}
function restoreFetch () { delete globalThis.fetch }

test('CloudProvider: DeepSeek 式 base URL 自动补全 /v1/messages（无 /v1/v1 双路径）', async () => {
  const calls = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }] }) }))
  const l2 = { ...l2Base, cloudBaseUrl: 'https://api.deepseek.com/anthropic' }
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2 }, makeLogger())
    const res = await p.chat([{ role: 'user', content: 'x' }])
    assert.equal(res.text, 'hi')
    assert.equal(calls[0].url, 'https://api.deepseek.com/anthropic/v1/messages')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('CloudProvider: 完整端点（/v1/messages 结尾）不追加', async () => {
  const calls = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ content: [] }) }))
  const l2 = { ...l2Base, cloudBaseUrl: 'https://api.anthropic.com/v1/messages' }
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2 }, makeLogger())
    await p.chat([{ role: 'user', content: 'x' }])
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('CloudProvider: model/max_tokens/tools 传参正确', async () => {
  const calls = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ content: [] }) }))
  const l2 = { ...l2Base, cloudBaseUrl: 'https://api.anthropic.com/v1/messages', maxTokens: 2048 }
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2 }, makeLogger())
    await p.chat([{ role: 'user', content: 'x' }], { tools: [{ name: 'status', description: 's', parameters: { type: 'object' } }] })
    assert.equal(calls[0].body.model, 'm')
    assert.equal(calls[0].body.max_tokens, 2048, 'max_tokens 应使用 l2.maxTokens')
    assert.equal(calls[0].body.tools[0].name, 'status')
    assert.equal(calls[0].body.tools[0].input_schema.type, 'object')
    assert.equal(calls[0].opts.headers['x-api-key'], 'sk-test', 'API key 从环境变量读取')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('DeepSeek 预设：thinking=disabled 显式发送且不带 reasoning_effort（端点 400 冲突）', async () => {
  const calls = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ content: [] }) }))
  const l2 = { ...l2Base, thinking: 'disabled', effort: 'low' }
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2 }, makeLogger())
    await p.chat([{ role: 'user', content: 'x' }])
    assert.deepEqual(calls[0].body.thinking, { type: 'disabled' })
    assert.equal('reasoning_effort' in calls[0].body, false,
      'disabled 不得带 reasoning_effort（DeepSeek 400: thinking options type cannot be disabled when reasoning_effort is set）')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('thinking=enabled + effort 注入 reasoning_effort', async () => {
  const calls = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ content: [] }) }))
  const l2 = { ...l2Base, thinking: 'enabled', effort: 'high' }
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2 }, makeLogger())
    await p.chat([{ role: 'user', content: 'x' }])
    assert.deepEqual(calls[0].body.thinking, { type: 'enabled' })
    assert.equal(calls[0].body.reasoning_effort, 'high')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('CloudProvider: tool_use block 解析', async () => {
  mockFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'tool_use', id: 't1', name: 'status', input: {} }, { type: 'text', text: 'done' }] })
  }))
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2: { ...l2Base } }, makeLogger())
    const res = await p.chat([{ role: 'user', content: 'x' }])
    assert.equal(res.text, 'done')
    assert.deepEqual(res.toolCalls, [{ id: 't1', name: 'status', arguments: {} }])
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('CloudProvider: HTTP 错误抛出（不泄露响应体全文）', async () => {
  mockFetch(() => ({ ok: false, status: 500, text: async () => 'internal boom' }))
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2: { ...l2Base } }, makeLogger())
    await assert.rejects(p.chat([{ role: 'user', content: 'x' }]), /cloud API 500: internal boom/)
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('U9: diagnose 端点可达即连通（405 是方法错不是网络错）', async () => {
  mockFetch(() => ({ ok: false, status: 405, text: async () => 'method not allowed' }))
  const l2 = { ...l2Base, cloudBaseUrl: 'https://api.anthropic.com/v1/messages' }
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2 }, makeLogger())
    const r = await p.diagnose()
    assert.equal(r.ok, true, '端点可达即连通')
    assert.equal(r.status, 405)
    assert.equal(r.label, 'cloud')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('U9: diagnose cloud 缺 key → 明确不可达且不发请求', async () => {
  let called = false
  mockFetch(() => { called = true; return { ok: true, status: 200 } })
  const l2 = { ...l2Base, cloudApiKeyEnv: 'NONEXISTENT_KEY_XYZ' }
  const p = createProvider({ l2 }, makeLogger())
  const r = await p.diagnose()
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('API key'), r.error)
  assert.equal(called, false, '缺 key 不应发网络请求')
  restoreFetch()
})

test('U5: cloud usage 解析（input_tokens/output_tokens）+ latency', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 7, output_tokens: 3 } }) })
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const l2 = { ...l2Base, cloudApiKeyEnv: 'ANTHROPIC_API_KEY', cloudBaseUrl: 'http://x', cloudTimeoutMs: 5000 }
    const p = createProvider({ l2 }, makeLogger())
    const r = await p.chat([{ role: 'user', content: 'hi' }])
    assert.deepEqual(r.usage, { inputTokens: 7, outputTokens: 3 })
    assert.ok(typeof r.latencyMs === 'number')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('U5: agent 计量累计——chat 工具循环多轮 usage 累加（AgentInterface 层）', async () => {
  const { AgentInterface } = await import('../src/l2/agent-interface.js')
  const { createActionExecutor } = await import('../src/core/executor.js')
  const ctx = { cfg: { ops: [], l2: { maxActionsPerCall: 8 } }, logger: makeLogger(), bot: {}, tasks: { getStatus: () => [] }, conn: { getStatus: () => ({ state: 'connected' }) }, plugins: {} }
  const calls = []
  const provider = {
    async chat (messages, _opts = {}) {
      calls.push(messages)
      if (calls.length === 1) return { text: null, toolCalls: [{ id: 't1', name: 'act', arguments: { actions: [{ op: 'observe_status', args: {} }] } }], usage: { inputTokens: 10, outputTokens: 4 }, latencyMs: 100 }
      return { text: 'done', toolCalls: [], usage: { inputTokens: 8, outputTokens: 2 }, latencyMs: 200 }
    }
  }
  const executor = createActionExecutor(ctx, { audit: null })
  const agent = new AgentInterface(ctx, { provider, executor, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
  await agent.chat('steve', 'hi')
  assert.equal(agent.usage.inputTokens, 18, '两轮 usage 应累加')
  assert.equal(agent.usage.outputTokens, 6)
  assert.equal(agent.usage.latencyMs, 200, 'latency 取最后一次')
})

test('C10: CloudProvider contextWindow 返回 cloudMaxContextWindow（缺省 65536）+ kind 标记', () => {
  const p1 = createProvider({ l2: { ...l2Base } }, makeLogger())
  assert.equal(p1.contextWindow(), 65536, '缺省云端窗口 65536')
  assert.equal(p1.kind, 'cloud')
  const p2 = createProvider({ l2: { ...l2Base, cloudMaxContextWindow: 32768 } }, makeLogger())
  assert.equal(p2.contextWindow(), 32768, '配置 32768 生效')
})

test('L9 修复：退避等待中止 → 抛 AbortError（chat 层认 name 不再误报"处理出错"）', async () => {
  // fetch 恒网络错误 → 进入 500ms 退避等待 → 等待窗口内 abort
  mockFetch(async () => { throw new Error('ECONNREFUSED') })
  const l2 = { ...l2Base, cloudBaseUrl: 'https://api.anthropic.com/v1/messages' }
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2 }, makeLogger())
    const controller = new AbortController()
    const pending = p._post({}, controller.signal)
    setTimeout(() => controller.abort(), 50) // 落在退避等待窗口
    await assert.rejects(pending, (err) => err?.name === 'AbortError', '中止应抛 AbortError（修复前为普通 Error → 误报故障）')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})
