// LLM Provider 抽象（双 Provider：云端 Anthropic 兼容 API + 本地 Ollama）。
// 接口：chat(messages, { tools, system, signal }) →
//   Promise<{ text: string|null, toolCalls: Array<{id, name, arguments}> }>
//   kind(): 'cloud'|'ollama'（第六轮 C10：agent-interface 分层提示词按它分支）
//   contextWindow(): 上下文窗口（agent-interface 预算裁剪用；云端返回 cloudMaxContextWindow）
//
// 归一化：内部 messages 为 { role: 'user'|'assistant', content, toolCalls?, toolResults? }；
// CloudProvider 转 Anthropic Messages API 的 tool_use/tool_result block 结构，
// OllamaProvider 转 OpenAI 兼容的 tool_calls/tool 消息结构。
//
// 安全：API key 只从环境变量读取（l2.cloudApiKeyEnv），绝不进配置文件、绝不写入日志。
// 实现依赖 Node 22 全局 fetch，零新增依赖。

// 超时/长度可配置（l2.cloudTimeoutMs / ollamaTimeoutMs / maxTokens；默认 60s/1024——
// 低配机 Ollama 约 10-30 tok/s，20s 超时会误杀长回复）
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_TOKENS = 1024
// 第六轮 C10：云端上下文窗口默认 64k（无 cloudMaxContextWindow 配置时——预算守卫与
// 提示词扩容的容量基础；32k 上下文端点请在配置调低）
const DEFAULT_CLOUD_CONTEXT_WINDOW = 65536

// 云端扩展层剥除（第六轮 C10）：auto 粘滞回退发生在 chat 内部——system 已由
// agent-interface 构造（含扩展层），回退步必须剥除，否则 Ollama 收到 64k 才
// 该用的扩展层（4B 上下文装不下）。按分隔标记切分返回前半段（核心层）。
import { CLOUD_EXTENSION_MARKER } from './agent-interface.js'
export function stripCloudExtension (system) {
  return system.split(CLOUD_EXTENSION_MARKER)[0]
}
// Ollama 网络类错误单次重试退避（U5）：低配机 CPU 抢占导致偶发连接重置是真实场景；
// 一次重试成本远低于整次对话失败。4xx（配置错）与 AbortError 不重试。
const RETRY_BACKOFF_MS = 2000

/** HTTP 状态错误（携带 status 供重试判定）。 */
class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

/** 是否值得重试：非 abort 且非 4xx（网络层 TypeError / 5xx 瞬时）。 */
function isRetryable (err) {
  if (err?.name === 'AbortError') return false
  if (err?.status && err.status < 500) return false
  return true
}

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
    _latched: false,
    // 第六轮 C10：当前生效侧（分层提示词与预算窗口都按它动态分支——粘滞前 cloud/
    // 粘滞后 ollama；agent-interface 每轮调用）
    kind () {
      return this._latched ? 'ollama' : 'cloud'
    },
    /** A2：预算窗口动态化——粘滞前按云端（64k，扩容提示词不触发裁剪），粘滞后按 ollama（兜底必 fit）。 */
    contextWindow () {
      return this._latched ? ollama.contextWindow() : cloud.contextWindow()
    },
    /**
     * 本轮对话内粘滞回退（C7/V）：cloud 失败一次后其余步骤直走 ollama——
     * 云端挂起（防火墙丢包 → 60s 超时）时无粘滞的 maxSteps=5 对话最坏 5×60s 才完成。
     * agent-interface 每轮 chat() 开头调用 resetFallback 重置粘滞。
     */
    resetFallback () {
      this._latched = false
    },
    /** U9：双 provider 连通性诊断（!agent doctor）。 */
    async diagnose () {
      const [c, o] = await Promise.all([cloud.diagnose(), ollama.diagnose()])
      return { mode: 'auto', providers: [c, o] }
    },
    async chat (messages, opts = {}) {
      // C10：粘滞分支同样剥除扩展层（agent-interface 按 kind() 动态分支是主防线，
      // 此处纵深兜底——任何路径漏切时 ollama 也不收扩展层）
      if (this._latched) return ollama.chat(messages, { ...opts, system: stripCloudExtension(opts.system ?? '') })
      try {
        return await cloud.chat(messages, opts)
      } catch (err) {
        this._latched = true
        log.warn({ err: err.message }, 'cloud provider 失败，本轮对话余下步骤回退 ollama')
        // C10：回退步剥除云端扩展层——system 已由 agent-interface 按 cloud 构造，
        // 不剥除则 Ollama 收到 64k 窗口才该用的扩展层（4B 上下文装不下）
        return ollama.chat(messages, { ...opts, system: stripCloudExtension(opts.system ?? '') })
      }
    }
  }
}

/**
 * 连通性探测（U9：!agent doctor）——短超时 5s 的裸 GET。
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
    this.contextWindowValue = l2.cloudMaxContextWindow ?? DEFAULT_CLOUD_CONTEXT_WINDOW
  }

  /** 第六轮 C10：云端上下文窗口（agent-interface 预算裁剪用——云端同样走预算守卫）。 */
  contextWindow () {
    return this.contextWindowValue
  }

  /** U9：连通性探测（缺 key 不发请求，明确报未配置）。 */
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
    // token 计量（U5）：usage 结构 input_tokens/output_tokens
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

class OllamaProvider {
  constructor (l2, log) {
    this.l2 = l2
    this.log = log
    // L2 进化（A1）：compat 端点（/v1/chat/completions）不处理 options.num_ctx——
    // 官方 wont-fix（ollama#2963/#6544），超窗静默截断无报错；native /api/chat
    // 才接受 options.num_ctx/num_predict。tool_calls 消息格式与 OpenAI 兼容同构，
    // 转换函数近乎原样复用，仅 URL/options/响应解析变化
    this.baseUrl = (l2.ollamaUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '') + '/api/chat'
    this.model = l2.ollamaModel ?? 'qwen3.5:4b'
    this.timeoutMs = l2.ollamaTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxTokens = l2.maxTokens ?? DEFAULT_MAX_TOKENS
    // 上下文窗口（A2 预算裁剪用）：qwen3.5:4b 默认窗 2048 太小（10 条历史已逼近），
    // 默认 4096（8GB 机 KV≈+1.5GB 贴近红线但预算裁剪兜底；可降 2048）
    this.numCtx = l2.ollamaNumCtx ?? 4096
    // 第六轮 C10：provider 类型标记（分层提示词分支）
    this.kind = 'ollama'
  }

  /** A2：上下文窗口（agent-interface 预算裁剪用）。 */
  contextWindow () {
    return this.numCtx
  }

  /** U9：连通性探测（!agent doctor）。 */
  async diagnose () {
    const r = await diagnoseEndpoint(this.baseUrl)
    return { ...r, label: 'ollama' }
  }

  async chat (messages, { tools = [], system = '', signal } = {}) {
    const body = {
      model: this.model,
      stream: false,
      // native /api/chat：生成参数在 options（max_tokens → num_predict）
      options: { num_ctx: this.numCtx, num_predict: this.maxTokens },
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
    // 网络类错误重试一次（2s 退避）：低配机偶发连接重置是真实场景（U5）
    try {
      return await this._chatOnce(body, signal)
    } catch (err) {
      if (!isRetryable(err)) throw err
      this.log.warn({ err: err.message }, 'ollama 请求失败，2s 后重试一次')
      await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS))
      return this._chatOnce(body, signal)
    }
  }

  async _chatOnce (body, signal) {
    const t0 = Date.now()
    const data = await this._post(body, signal)
    // native 响应：data.message（非 choices[0].message）；usage 在 prompt_eval_count/eval_count
    const msg = data.message
    const toolCalls = (msg?.tool_calls ?? []).map((tc, i) => {
      // native /api/chat 的 arguments 是对象（非 OpenAI 兼容的 JSON 字符串）——
      // JSON.parse(对象) 抛错被吞 → LLM 参数全部丢失成 {}（带参技能全失效）。
      // 字符串才 parse（防御其他端点/未来变化），对象直接用
      const raw = tc.function?.arguments
      let args = {}
      if (typeof raw === 'string') {
        try { args = JSON.parse(raw) } catch { /* 参数解析失败按空 */ }
      } else if (raw && typeof raw === 'object') {
        args = raw
      }
      return { id: tc.id ?? `tc_${i}`, name: tc.function?.name, arguments: args }
    })
    // token 计量（U5）：prompt_eval_count/eval_count（native 语义）
    return {
      text: msg?.content ?? null,
      toolCalls,
      usage: {
        inputTokens: data.prompt_eval_count ?? null,
        outputTokens: data.eval_count ?? null
      },
      latencyMs: Date.now() - t0
    }
  }

  async _post (body, signal) {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: makeSignal(signal, this.timeoutMs)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new HttpError(res.status, `ollama API ${res.status}: ${text.slice(0, 200)}`)
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
        // native /api/chat 的 arguments 必须传对象（map）——OpenAI 兼容的 JSON
        // 字符串会让 Ollama 解析报 400 'can't find closing }'（实测：第二轮必炸）。
        // 注意：Ollama 响应解析侧也要对应处理（_chatOnce 已做双形态）
        function: { name: tc.name, arguments: tc.arguments ?? {} }
      }))
    }]
  }
  return [{ role: m.role, content: m.content ?? '' }]
}
