// L2 Provider HTTP 层测试：mock 全局 fetch 覆盖真实网络路径
// （此前仅测 AgentInterface 的 fake provider 路径，HTTP 层零覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProvider } from '../src/l2/provider.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

const l2Base = { enabled: true, provider: 'cloud', model: 'm', maxSteps: 5, cooldownMs: 0 }

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

test('OllamaProvider: tool_calls 解析与 native /api/chat 传参（A1）', async () => {
  const calls = mockFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'status', arguments: '{"x":1}' } }] },
      prompt_eval_count: 10,
      eval_count: 5
    })
  }))
  const l2 = { ...l2Base, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', maxTokens: 512, ollamaNumCtx: 4096 }
  const p = createProvider({ l2 }, makeLogger())
  const res = await p.chat([{ role: 'user', content: 'x' }])
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat', 'native /api/chat（compat 端点不处理 num_ctx）')
  assert.equal(calls[0].body.options.num_ctx, 4096, 'num_ctx 应进 native options')
  assert.equal(calls[0].body.options.num_predict, 512, 'max_tokens → native options.num_predict')
  assert.deepEqual(res.toolCalls, [{ id: 'a', name: 'status', arguments: { x: 1 } }])
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5 }, 'native prompt_eval_count/eval_count 归一化')
  assert.equal(p.contextWindow(), 4096, 'contextWindow 应返回配置窗口')
})

test('修复: Ollama 工具轮 arguments 必须传对象——OpenAI 字符串格式致 400（本地测试实测）', async () => {
  // 根因：toOpenAIMessages 把 arguments JSON.stringify 成字符串（OpenAI 兼容），
  // 而 Ollama native /api/chat 期望对象 → 第二轮（回填 tool_calls）必 400
  // "Value looks like object, but can't find closing '}' symbol"
  const calls = mockFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ message: { role: 'assistant', content: 'done', tool_calls: [] }, prompt_eval_count: 1, eval_count: 1 })
  }))
  const l2 = { ...l2Base, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' }
  const p = createProvider({ l2 }, makeLogger())
  const messages = [
    { role: 'user', content: '打那个僵尸' },
    { toolCalls: [{ id: 'tc_1', name: 'attack', arguments: { filter: 'zombie' } }] },
    { toolResults: [{ id: 'tc_1', output: '已攻击 zombie' }] }
  ]
  await p.chat(messages, { tools: [{ name: 'attack', description: 'a', parameters: { type: 'object' } }] })
  const sent = calls[0].body.messages.find(m => m.role === 'assistant' && m.tool_calls)
  assert.equal(typeof sent.tool_calls[0].function.arguments, 'object', 'arguments 必须是对象（Ollama native 格式，字符串会 400）')
  assert.deepEqual(sent.tool_calls[0].function.arguments, { filter: 'zombie' })
})

test('修复: Ollama 响应 arguments 对象形态直接使用（JSON.parse 对象吞参）', async () => {
  // 真实 Ollama native 响应的 arguments 是对象——原 JSON.parse(对象) 抛错被吞 →
  // 参数全丢成 {}。双形态：字符串 parse、对象直用
  const mock = mockFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'move_to', arguments: { x: 10, y: 64, z: 20 } } }] },
      prompt_eval_count: 1,
      eval_count: 1
    })
  }))
  const l2 = { ...l2Base, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' }
  const p = createProvider({ l2 }, makeLogger())
  const res = await p.chat([{ role: 'user', content: '走过去' }])
  assert.deepEqual(res.toolCalls, [{ id: 'b', name: 'move_to', arguments: { x: 10, y: 64, z: 20 } }], '对象 arguments 应原样保留（此前被 JSON.parse 吞成 {}）')
  mock.length // 抑制未使用告警
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

test('U9: auto 模式诊断返回双 provider', async () => {
  mockFetch(() => ({ ok: false, status: 405, text: async () => 'x' }))
  const l2 = {
    ...l2Base, provider: 'auto',
    cloudBaseUrl: 'http://cloud',
    cloudApiKeyEnv: 'ANTHROPIC_API_KEY',
    ollamaUrl: 'http://ollama'
  }
  process.env.ANTHROPIC_API_KEY = 'k'
  try {
    const p = createProvider({ l2 }, makeLogger())
    const r = await p.diagnose()
    assert.ok(Array.isArray(r.providers) && r.providers.length === 2, 'auto 应诊断双 provider')
    assert.ok(r.providers.every(x => x.ok))
    assert.equal(r.mode, 'auto')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('provider: auto 模式 cloud 失败真实回退 ollama（各调用一次）', async () => {
  const calls = mockFetch((url) => url.includes('anthropic')
    ? { ok: false, status: 500, text: async () => 'cloud down' }
    : { ok: true, status: 200, json: async () => ({ message: { role: 'assistant', content: 'fallback-ok' } }) })
  const l2 = {
    ...l2Base, provider: 'auto',
    cloudBaseUrl: 'https://api.anthropic.com/v1/messages',
    cloudApiKeyEnv: 'ANTHROPIC_API_KEY',
    ollamaUrl: 'http://127.0.0.1:11434'
  }
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2 }, makeLogger())
    const res = await p.chat([{ role: 'user', content: 'x' }])
    assert.equal(res.text, 'fallback-ok')
    assert.equal(calls.length, 2, 'cloud 失败后应真实调用 ollama')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('C7/V 修复：auto 粘滞回退——cloud 失败一次后余下步骤直走 ollama（不重复 60s 空等）', async () => {
  const calls = mockFetch((url) => url.includes('anthropic')
    ? { ok: false, status: 500, text: async () => 'cloud down' }
    : { ok: true, status: 200, json: async () => ({ message: { role: 'assistant', content: 'ok' } }) })
  const l2 = {
    ...l2Base, provider: 'auto',
    cloudBaseUrl: 'https://api.anthropic.com/v1/messages',
    cloudApiKeyEnv: 'ANTHROPIC_API_KEY',
    ollamaUrl: 'http://127.0.0.1:11434'
  }
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  try {
    const p = createProvider({ l2 }, makeLogger())
    await p.chat([{ role: 'user', content: 'x' }]) // cloud 失败 → 回退 ollama，粘滞
    const before = calls.length // cloud + ollama = 2
    await p.chat([{ role: 'user', content: 'y' }])
    assert.equal(calls.length, before + 1, '粘滞后第二次 chat 应直走 ollama（不再打 cloud）')
    p.resetFallback()
    await p.chat([{ role: 'user', content: 'z' }])
    assert.equal(calls.length, before + 1 + 2, 'resetFallback 后应重新尝试 cloud（cloud 失败再回退）')
  } finally {
    delete process.env.ANTHROPIC_API_KEY
    restoreFetch()
  }
})

test('provider: ollamaTimeoutMs 生效（超时被 abort）', async () => {
  mockFetch((url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  }))
  const l2 = { ...l2Base, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', ollamaTimeoutMs: 50 }
  const p = createProvider({ l2 }, makeLogger())
  const t0 = Date.now()
  await assert.rejects(p.chat([{ role: 'user', content: 'x' }]), /aborted|Timeout/)
  assert.ok(Date.now() - t0 < 3000, '应在超时窗口内失败（而非挂起）')
  restoreFetch()
})

// ---- U5：重试退避 + token/耗时计量 ----

test('U5: ollama 网络错误重试一次（2s 退避后成功）+ usage 归一化', async () => {
  let calls = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) throw new TypeError('fetch failed')
    return { ok: true, status: 200, json: async () => ({ message: { role: 'assistant', content: '重试成功', tool_calls: [] }, prompt_eval_count: 10, eval_count: 5 }) }
  }
  try {
    const l2 = { ...l2Base, provider: 'ollama', ollamaUrl: 'http://x', ollamaModel: 'm', ollamaTimeoutMs: 5000 }
    const p = createProvider({ l2 }, makeLogger())
    const r = await p.chat([{ role: 'user', content: 'hi' }])
    assert.equal(calls, 2, '网络错误应重试一次')
    assert.equal(r.text, '重试成功')
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 }, 'native prompt_eval_count/eval_count 应归一化')
    assert.ok(typeof r.latencyMs === 'number')
  } finally {
    restoreFetch()
  }
})

test('U5: ollama 4xx 不重试（配置错重试无意义）', async () => {
  let calls = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => { calls++; return { ok: false, status: 404, text: async () => 'model not found' } }
  try {
    const l2 = { ...l2Base, provider: 'ollama', ollamaUrl: 'http://x', ollamaModel: 'm', ollamaTimeoutMs: 5000 }
    const p = createProvider({ l2 }, makeLogger())
    await assert.rejects(p.chat([{ role: 'user', content: 'hi' }]), /404/)
    assert.equal(calls, 1, '4xx 不应重试')
  } finally {
    restoreFetch()
  }
})

test('U5: ollama AbortError 不重试', async () => {
  let calls = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => { calls++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
  try {
    const l2 = { ...l2Base, provider: 'ollama', ollamaUrl: 'http://x', ollamaModel: 'm', ollamaTimeoutMs: 5000 }
    const p = createProvider({ l2 }, makeLogger())
    await assert.rejects(p.chat([{ role: 'user', content: 'hi' }]), /aborted/)
    assert.equal(calls, 1, '用户中止不应重试')
  } finally {
    restoreFetch()
  }
})

test('U5: cloud usage 解析（input_tokens/output_tokens）+ latency', async () => {
  const origFetch = globalThis.fetch
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
  const { createSkillRegistry } = await import('../src/l2/skills.js')
  const ctx = { cfg: { ops: [] }, logger: makeLogger(), bot: {}, tasks: { getStatus: () => [] }, conn: { getStatus: () => ({ state: 'connected' }) }, plugins: {} }
  const calls = []
  const provider = {
    async chat (messages, opts = {}) {
      calls.push(messages)
      if (calls.length === 1) return { text: null, toolCalls: [{ id: 't1', name: 'status', arguments: {} }], usage: { inputTokens: 10, outputTokens: 4 }, latencyMs: 100 }
      return { text: 'done', toolCalls: [], usage: { inputTokens: 8, outputTokens: 2 }, latencyMs: 200 }
    }
  }
  const skills = createSkillRegistry(ctx)
  const agent = new AgentInterface(ctx, { provider, skills, config: { enabled: true, cooldownMs: 0, maxSteps: 5 } })
  await agent.chat('steve', 'hi')
  assert.equal(agent.usage.inputTokens, 18, '两轮 usage 应累加')
  assert.equal(agent.usage.outputTokens, 6)
  assert.equal(agent.usage.latencyMs, 200, 'latency 取最后一次')
})
