// LLM Provider（v1.0.0 C2：单 Provider——仅云端 Anthropic 兼容 API，non-reasoning 模式）。
// 接口：chat(messages, { tools, system, signal }) →
//   Promise<{ text: string|null, toolCalls: Array<{id, name, arguments}>, usage, latencyMs }>
//   kind(): 'cloud'（agent-interface 兼容保留；恒 'cloud'）
//   contextWindow(): 上下文窗口（agent-interface 预算裁剪用）
//
// 归一化：内部 messages 为 { role: 'user'|'assistant', content, toolCalls?, toolResults? }；
// 转 Anthropic Messages API 的 tool_use/tool_result block 结构。
//
// non-reasoning 模式（v1.0.0 决策）：不传 thinking budget——模型直接输出可执行结果，
// 保证低延迟与高输出质量；提示词相应直白（见 agent-interface.js CORE_SYSTEM_PROMPT）。
//
// 安全：API key 只从环境变量读取（l2.cloudApiKeyEnv），绝不进配置文件、绝不写入日志。
// 实现依赖 Node 22 全局 fetch，零新增依赖。

const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_TOKENS = 1024
// 第六轮 C10：云端上下文窗口默认 64k（无 cloudMaxContextWindow 配置时——预算守卫与
// 提示词扩容的容量基础；32k 上下文端点请在配置调低）
const DEFAULT_CLOUD_CONTEXT_WINDOW = 65536

/** HTTP 状态错误（携带 status 供诊断）。 */
class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

/** 组装 provider 实例（v1.0.0 C2：唯一路径——云端；无本地/auto 分支）。 */
export function createProvider (cfg, logger) {
  const l2 = cfg.l2 ?? {}
  const log = logger.child({ module: 'l2-provider' })
  return new CloudProvider(l2, log)
}

/**
 * 连通性探测（!agent doctor）——短超时 5s 的裸 GET。
 * 端点可达即视为连通（405/404 是方法/路径问题而非网络问题，status 供用户判断）。
 */
async function diagnoseEndpoint (baseUrl) {
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) })
    return { ok: true, endpoint: baseUrl, status: res.status }
  } catch (err) {
    return { ok: false, endpoint: baseUrl, error: err.message }
  }
}

function makeSignal (signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // 外部 abort + 超时兜底（Node 22 支持 AbortSignal.any）
  const timeout = AbortSignal.timeout(timeoutMs)
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
    // 只对不含 /messages 结尾的端点自动补全（避免 https://host/v1 → /v1/v1/messages 双路径）
    if (!/\/messages$/.test(this.baseUrl)) this.baseUrl += '/v1/messages'
    this.model = l2.model ?? 'claude-sonnet-5'
    this.timeoutMs = l2.cloudTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxTokens = l2.maxTokens ?? DEFAULT_MAX_TOKENS
    // 第六轮 C10：云端上下文窗口（预算守卫用）——l2.cloudMaxContextWindow 可配
    this.kind = 'cloud'
    this.mode = 'cloud' // !agent doctor 展示（v1.0.0：唯一 provider）
    this.contextWindowValue = l2.cloudMaxContextWindow ?? DEFAULT_CLOUD_CONTEXT_WINDOW
  }

  /** 上下文窗口（agent-interface 预算裁剪用）。 */
  contextWindow () {
    return this.contextWindowValue
  }

  /** 连通性探测（缺 key 不发请求，明确报未配置）。 */
  async diagnose () {
    if (!this.apiKey) {
      return { ok: false, label: 'cloud', endpoint: this.baseUrl, error: `未配置 API key（环境变量 ${this.l2.cloudApiKeyEnv ?? 'ANTHROPIC_API_KEY'}）` }
    }
    const r = await diagnoseEndpoint(this.baseUrl)
    return { ...r, label: 'cloud' }
  }

  async chat (messages, { tools = [], system = '', signal } = {}) {
    if (!this.apiKey) {
      throw new Error(`未配置 API key（环境变量 ${this.l2.cloudApiKeyEnv ?? 'ANTHROPIC_API_KEY'}）`)
    }
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      // non-reasoning：不传 thinking budget（Anthropic 默认即非推理模式）
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
    const t0 = Date.now()
    const data = await this._post(body, signal)
    const toolCalls = []
    let text = ''
    for (const block of data.content ?? []) {
      if (block.type === 'text') text += block.text
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: block.input })
    }
    // token 计量：usage 结构 input_tokens/output_tokens
    return {
      text: text || null,
      toolCalls,
      usage: {
        inputTokens: data.usage?.input_tokens ?? null,
        outputTokens: data.usage?.output_tokens ?? null
      },
      latencyMs: Date.now() - t0
    }
  }

  async _post (body, signal) {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: makeSignal(signal, this.timeoutMs)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new HttpError(res.status, `cloud API ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
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
