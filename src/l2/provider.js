// @ts-check
// LLM Provider：单 Provider——仅云端 Anthropic 兼容 API（non-reasoning 模式）。
// 接口：chat(messages, { tools, system, signal }) →
//   Promise<{ text: string|null, toolCalls: Array<{id, name, arguments}>, usage, latencyMs }>
//   kind(): 'cloud'（agent-interface 兼容保留；恒 'cloud'）
//   contextWindow(): 上下文窗口（agent-interface 预算裁剪用）
//
// 归一化：内部 messages 为 { role: 'user'|'assistant', content, toolCalls?, toolResults? }；
// 转 Anthropic Messages API 的 tool_use/tool_result block 结构。
//
// thinking/effort（预设 DeepSeek）：l2.thinking='disabled'（默认）显式发
// thinking:{type:'disabled'}，但**不传** reasoning_effort——DeepSeek Anthropic 兼容端点
// 校验严格，将两者视为互斥（400: thinking options type cannot be disabled when
// reasoning_effort is set；官方 Anthropic 端点会忽略矛盾字段而 DeepSeek 拒绝）。
// l2.thinking='enabled' 时发 thinking:{type:'enabled'} + reasoning_effort: l2.effort
// （low/medium/high/max）。提示词相应直白（见 agent-interface.js CORE_SYSTEM_PROMPT）。
//
// 安全：API key 只从环境变量读取（l2.cloudApiKeyEnv），绝不进配置文件、绝不写入日志。
// 实现依赖 Node 22 全局 fetch，零新增依赖。

const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_TOKENS = 1024
// 云端上下文窗口默认 64k（无 cloudMaxContextWindow 配置时——预算守卫与提示词
// 扩容的容量基础；32k 上下文端点请在配置调低）
const DEFAULT_CLOUD_CONTEXT_WINDOW = 65536

/** HTTP 状态错误（携带 status 供诊断）。 */
class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

/** 组装 provider 实例（唯一路径——云端；无本地/auto 分支）。 */
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
    // baseUrl 兼容两种写法：完整端点（.../v1/messages）或 base URL（预设 DeepSeek
    // https://api.deepseek.com/anthropic——Anthropic 兼容路由；裸域名会补到 OpenAI 路由 404）
    this.baseUrl = (l2.cloudBaseUrl ?? 'https://api.deepseek.com/anthropic').replace(/\/+$/, '')
    // 补全规则：/messages 结尾不变；/v1 结尾补 /messages；其余补 /v1/messages。
    // 只判 /messages$ 会把 `https://host/v1` 结尾追加成 /v1/v1/messages 双路径
    //（Anthropic 惯例配置即 404）
    if (/\/messages$/.test(this.baseUrl)) {
      /* 完整端点，不变 */
    } else if (/\/v1$/.test(this.baseUrl)) {
      this.baseUrl += '/messages'
    } else {
      this.baseUrl += '/v1/messages'
    }
    this.model = l2.model ?? 'deepseek-v4-flash'
    this.thinking = l2.thinking ?? 'disabled'
    this.effort = l2.effort ?? 'low'
    this.thinkingBudgetTokens = l2.thinkingBudgetTokens ?? 4096
    this.timeoutMs = l2.cloudTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxTokens = l2.maxTokens ?? DEFAULT_MAX_TOKENS
    // 云端上下文窗口（预算守卫用）——l2.cloudMaxContextWindow 可配
    this.kind = 'cloud'
    this.mode = 'cloud' // !agent doctor 展示（唯一 provider）
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

  /**
   * 对话补全（Anthropic Messages 协议）。
   * @param {Array<object>} messages
   * @param {{ tools?: Array<Record<string, any>>, system?: string, signal?: AbortSignal }} opts
   */
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
    // thinking/effort（预设 DeepSeek）：disabled 显式关思考但不带 reasoning_effort
    // （DeepSeek 端点两者互斥 400，见文件头注释）；enabled 时按 effort 注入并带
    // budget_tokens（Anthropic 协议必填——严格端点缺该字段 400）
    if (this.thinking === 'enabled') {
      body.thinking = { type: 'enabled', budget_tokens: this.thinkingBudgetTokens }
      body.reasoning_effort = this.effort
    } else {
      body.thinking = { type: 'disabled' }
    }
    if (tools.length > 0) {
      body.tools = tools.map(({ name, description, parameters } = {}) => ({
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
    // 云端抖动重试：429/5xx/网络错误指数退避重试（至多 2 次重试）——单次抖动会
    // 杀死整轮工具循环（已耗 token 与已执行副作用全部作废）。
    // 4xx（除 429）不重试（参数/鉴权错误重试无意义）；用户中止不重试。
    const isRetryable = (status) => status === 429 || status >= 500
    const wait = async (ms) => {
      if (!signal) { await new Promise(r => setTimeout(r, ms)); return }
      /** @type {Promise<void>} */
      const delay = new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(t); reject(new DOMException('请求已中止', 'AbortError')) }
        const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      await delay
    }
    let lastErr = null
    for (let attempt = 0; attempt <= 2; attempt++) {
      // AbortError 语义（agent-interface 的 chat 只认 err.name==='AbortError'——
      // 普通 Error('请求已中止') 会被误报"处理出错"而非干净的"请求已中止"）
      if (signal?.aborted) throw new DOMException('请求已中止', 'AbortError')
      let res
      try {
        res = await fetch(this.baseUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(body),
          signal: makeSignal(signal, this.timeoutMs)
        })
      } catch (err) {
        // 超时（AbortSignal.timeout 产生 TimeoutError）不得当网络错误重试——
        // 每次尝试都重新计时，重试会把单次 60s 超时放大为 180s busy 锁死
        if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err
        lastErr = err
        if (attempt < 2) { await wait(500 * 2 ** attempt); continue }
        break
      }
      if (res.ok) return res.json()
      const text = await res.text().catch(() => '')
      lastErr = new HttpError(res.status, `cloud API ${res.status}: ${text.slice(0, 200)}`)
      if (!isRetryable(res.status) || attempt >= 2) break
      // 429 尊重 Retry-After（若提供）；否则 500ms × 2^n 退避，上限 4s
      const ra = Number(res.headers?.get?.('retry-after'))
      const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt
      await wait(Math.min(delay, 4000))
    }
    throw lastErr ?? new Error('cloud API 请求失败')
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
