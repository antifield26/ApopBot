// LLM Provider 抽象（双 Provider：云端 Anthropic 兼容 API + 本地 Ollama）。
// 接口：chat(messages, { tools, system, signal }) →
//   Promise<{ text: string|null, toolCalls: Array<{id, name, arguments}> }>
//
// 归一化：内部 messages 为 { role: 'user'|'assistant', content, toolCalls?, toolResults? }；
// CloudProvider 转 Anthropic Messages API 的 tool_use/tool_result block 结构，
// OllamaProvider 转 OpenAI 兼容的 tool_calls/tool 消息结构。
//
// 安全：API key 只从环境变量读取（l2.cloudApiKeyEnv），绝不进配置文件、绝不写入日志。
// 实现依赖 Node 22 全局 fetch，零新增依赖。

const FETCH_TIMEOUT_MS = 20000
const MAX_TOKENS = 1024

/** 组装 provider 实例（auto = cloud 优先，失败回退 ollama 一次）。 */
export function createProvider (cfg, logger) {
  const l2 = cfg.l2 ?? {}
  const log = logger.child({ module: 'l2-provider' })
  const mode = l2.provider ?? 'auto'
  const cloud = new CloudProvider(l2, log)
  const ollama = new OllamaProvider(l2, log)
  if (mode === 'cloud') return cloud
  if (mode === 'ollama') return ollama
  return {
    mode: 'auto',
    async chat (messages, opts = {}) {
      try {
        return await cloud.chat(messages, opts)
      } catch (err) {
        log.warn({ err: err.message }, 'cloud provider 失败，回退 ollama')
        return ollama.chat(messages, opts)
      }
    }
  }
}

function makeSignal (signal) {
  // 外部 abort + 超时兜底（Node 22 支持 AbortSignal.any）
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

class CloudProvider {
  constructor (l2, log) {
    this.l2 = l2
    this.log = log
    this.apiKey = process.env[l2.cloudApiKeyEnv] ?? process.env.ANTHROPIC_API_KEY
    // baseUrl 兼容两种写法：完整端点（.../v1/messages）或 base URL（如 DeepSeek 的
    // https://api.deepseek.com/anthropic，实测 404，需自动补全路径）
    this.baseUrl = (l2.cloudBaseUrl ?? 'https://api.anthropic.com/v1/messages').replace(/\/+$/, '')
    if (!this.baseUrl.endsWith('/v1/messages')) this.baseUrl += '/v1/messages'
    this.model = l2.model ?? 'claude-sonnet-5'
  }

  async chat (messages, { tools = [], system = '', signal } = {}) {
    if (!this.apiKey) {
      throw new Error(`未配置 API key（环境变量 ${this.l2.cloudApiKeyEnv ?? 'ANTHROPIC_API_KEY'}）`)
    }
    const body = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: messages.map(toAnthropicMessage)
    }
    if (tools.length > 0) {
      body.tools = tools.map(({ name, description, parameters }) => ({
        name,
        description,
        input_schema: parameters ?? { type: 'object', properties: {} }
      }))
    }
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: makeSignal(signal)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`cloud API ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = await res.json()
    const toolCalls = []
    let text = ''
    for (const block of data.content ?? []) {
      if (block.type === 'text') text += block.text
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: block.input })
    }
    return { text: text || null, toolCalls }
  }
}

class OllamaProvider {
  constructor (l2, log) {
    this.l2 = l2
    this.log = log
    this.baseUrl = (l2.ollamaUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '') + '/v1/chat/completions'
    this.model = l2.ollamaModel ?? 'qwen2.5:7b'
  }

  async chat (messages, { tools = [], system = '', signal } = {}) {
    const body = {
      model: this.model,
      stream: false,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.flatMap(toOpenAIMessages)
      ]
    }
    if (tools.length > 0) {
      body.tools = tools.map(({ name, description, parameters }) => ({
        type: 'function',
        function: { name, description, parameters: parameters ?? { type: 'object', properties: {} } }
      }))
    }
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: makeSignal(signal)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ollama API ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = await res.json()
    const msg = data.choices?.[0]?.message
    const toolCalls = (msg?.tool_calls ?? []).map((tc, i) => {
      let args = {}
      try { args = JSON.parse(tc.function?.arguments ?? '{}') } catch { /* 参数解析失败按空 */ }
      return { id: tc.id ?? `tc_${i}`, name: tc.function?.name, arguments: args }
    })
    return { text: msg?.content ?? null, toolCalls }
  }
}

/** 内部消息 → Anthropic Messages API 消息数组。 */
function toAnthropicMessage (m) {
  if (m.toolResults?.length) {
    return {
      role: 'user',
      content: m.toolResults.map(r => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: typeof r.output === 'string' ? r.output : JSON.stringify(r.output)
      }))
    }
  }
  if (m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.toolCalls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} }))
      ]
    }
  }
  return { role: m.role, content: m.content ?? '' }
}

/** 内部消息 → OpenAI 兼容消息数组（tool 结果拆成多条 tool 消息）。 */
function toOpenAIMessages (m) {
  if (m.toolResults?.length) {
    return m.toolResults.map(r => ({
      role: 'tool',
      tool_call_id: r.id,
      content: typeof r.output === 'string' ? r.output : JSON.stringify(r.output)
    }))
  }
  if (m.toolCalls?.length) {
    return [{
      role: 'assistant',
      content: m.content ?? '',
      tool_calls: m.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) }
      }))
    }]
  }
  return [{ role: m.role, content: m.content ?? '' }]
}
