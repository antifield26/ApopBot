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

test('OllamaProvider: tool_calls 解析与 max_tokens 传参', async () => {
  const calls = mockFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: 'a', function: { name: 'status', arguments: '{"x":1}' } }] } }] })
  }))
  const l2 = { ...l2Base, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', maxTokens: 512 }
  const p = createProvider({ l2 }, makeLogger())
  const res = await p.chat([{ role: 'user', content: 'x' }])
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(calls[0].body.max_tokens, 512, 'OpenAI 兼容 body 应带 max_tokens')
  assert.deepEqual(res.toolCalls, [{ id: 'a', name: 'status', arguments: { x: 1 } }])
  restoreFetch()
})

test('provider: auto 模式 cloud 失败真实回退 ollama（各调用一次）', async () => {
  const calls = mockFetch((url) => url.includes('anthropic')
    ? { ok: false, status: 500, text: async () => 'cloud down' }
    : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'fallback-ok' } }] }) })
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
