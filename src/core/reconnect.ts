// 断线原因分类（mindcraft LoginGuard 的进程内轻量版）与指数退避计算。
// 全部为纯函数，便于单测。

// 分类表：关键词（小写匹配）→ { type, isFatal }
// fatal = 需人工介入，不应无限重试；非 fatal = 重连值得（临时性原因）
// 语义：未知/空原因默认非 fatal（24/7 headless bot 应退避扛过维护窗口，而非烧服务管理器重启预算）。
const CLASSIFIERS = [
  { type: 'name_conflict', fatal: true, keywords: ['name_taken', 'duplicate_login', 'already connected', 'already logged in', 'username is already'] },
  { type: 'access_denied', fatal: true, keywords: ['whitelist', 'not white-listed', 'banned', 'suspended', 'verify'] },
  // maintenance 必须在 version_mismatch 之前：维护/更新踢出消息常含 "version"
  // （"Server updating to version X"）——若先命中 version_mismatch（fatal）则
  // 本可退避扛过的维护窗口被误判致命 → exit(2) 停服等人工
  { type: 'maintenance', fatal: false, keywords: ['maintenance', 'updating', 'restarting', 'server is closed', 'server closed'] },
  // version 关键词只用明确的版本不匹配措辞：裸 'version'/'client' 覆盖面太宽
  //（维护消息/网络层文本均含）；协议号分支（protocol/unsupported）在下方兜底
  { type: 'version_mismatch', fatal: true, keywords: ['outdated', 'out of date', 'protocol version', 'version mismatch', 'not compatible', 'incompatible'] },
  { type: 'behavior', fatal: false, keywords: ['flying', 'spam', 'speed'] },
  { type: 'server_full', fatal: false, keywords: ['server is full', 'full server'] },
  // 消息违规（§ 颜色码/非法字符踢出）：Bot 自身 bug 或误操作，无限重连无意义 → fatal 等人工
  { type: 'illegal_message', fatal: true, keywords: ['illegal_characters', 'multiplayer.disconnect.illegal'] },
  // 同时覆盖 Node.js 原生网络错误码（etimedout / socket hang up / econnreset 等）；
  // enotfound = DNS 解析失败（域名连接场景），归 network_error 非 fatal 退避重连
  { type: 'network_error', fatal: false, keywords: ['timeout', 'timed out', 'etimedout', 'enotfound', 'connection lost', 'hang up', 'reset', 'econnreset', 'refused', 'keepalive', 'ehostunreach', 'enetunreach', 'eai_again', 'network', 'socketclosed', 'socket closed', 'closed'] }
]

/**
 * 将断开原因归类。reason 可能是字符串、Error 或 kick 消息对象。
 * @param {Record<string, any>} [opts] { minecraftVersion }
 * @returns {{ type: string, isFatal: boolean, detail: string }}
 */
export function classifyDisconnect (reason, opts: Record<string, any> = {}) {
  const { minecraftVersion } = opts ?? {}
  let text = ''
  let detail = ''
  if (typeof reason === 'string') {
    text = reason
    detail = reason
  } else if (reason instanceof Error) {
    // AggregateError（Node 网络层合并 IPv4/IPv6 尝试）message 常为空：
    // code/errors 是 Error 子类扩展字段（Node 网络错误/聚合错误）
    const e = reason as Error & { code?: string, errors?: Array<{ message?: string, code?: string }> }
    text = e.message
    if (!text && e.code) text = e.code
    if (!text && Array.isArray(e.errors)) {
      text = e.errors.map(er => er?.message || er?.code || String(er)).join(', ')
    }
    detail = text || `(${e.name ?? 'Error'})`
  } else if (reason && typeof reason === 'object') {
    text = reason.text ?? reason.message ?? JSON.stringify(reason)
    detail = text
  } else if (reason === undefined || reason === null) {
    text = ''
    detail = '(no reason given)'
  }

  const lower = String(text).toLowerCase()
  for (const { type, fatal, keywords } of CLASSIFIERS) {
    if (keywords.some(kw => lower.includes(kw))) {
      return { type, isFatal: fatal, detail }
    }
  }
  // 版本相关错误也可能是数字形式（协议号）——只用明确组合：裸 'protocol'/
  // 'unsupported'（如插件消息 "unsupported client plugin"）覆盖面太宽
  if (minecraftVersion && lower.includes('protocol') &&
      (lower.includes('version') || lower.includes('unsupported') || lower.includes('client'))) {
    return { type: 'version_mismatch', isFatal: true, detail }
  }
  // 未知/空原因：非 fatal（退避重连，交给服务管理器的重启语义做最终兜底）
  return { type: 'other', isFatal: false, detail }
}

/**
 * 指数退避 + 抖动 + 最小间隔防抖。
 * attempt: 1-based 第几次重连。返回 { delayMs }。
 * delay = min(base * factor^(attempt-1), max)，再乘 jitter 随机 ±。
 * 若距 lastFailMs 不足 minGapMs，则补齐到 minGapMs（10s 防抖，防崩溃循环）。
 */
export function nextBackoff ({ attempt, baseMs, maxMs, factor, jitter, minGapMs, lastFailMs = 0, nowMs = Date.now() }) {
  const exponential = Math.min(baseMs * Math.pow(factor, Math.max(0, attempt - 1)), maxMs)
  const jitterFactor = 1 + (Math.random() * 2 - 1) * jitter
  let delayMs = exponential * jitterFactor

  if (minGapMs > 0) {
    const elapsed = Math.max(0, nowMs - lastFailMs)
    if (elapsed < minGapMs) delayMs = Math.max(delayMs, minGapMs - elapsed)
  }
  return { delayMs: Math.max(0, Math.round(delayMs)) }
}
