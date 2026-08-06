// 断线原因分类（mindcraft LoginGuard 的进程内轻量版）与指数退避计算。
// 全部为纯函数，便于单测。

// 分类表：关键词（小写匹配）→ { type, isFatal }
// fatal = 需人工介入，不应无限重试；非 fatal = 重连值得（临时性原因）
// 语义：未知/空原因默认非 fatal（24/7 headless bot 应退避扛过维护窗口，而非烧服务管理器重启预算）。
const CLASSIFIERS = [
  { type: 'name_conflict', fatal: true, keywords: ['name_taken', 'duplicate_login', 'already connected', 'already logged in', 'username is already'] },
  { type: 'access_denied', fatal: true, keywords: ['whitelist', 'not white-listed', 'banned', 'suspended', 'verify'] },
  { type: 'version_mismatch', fatal: true, keywords: ['outdated', 'version', 'client'] },
  { type: 'behavior', fatal: false, keywords: ['flying', 'spam', 'speed'] },
  { type: 'server_full', fatal: false, keywords: ['server is full', 'full server'] },
  { type: 'maintenance', fatal: false, keywords: ['maintenance', 'updating', 'closed', 'restarting'] },
  // 同时覆盖 Node.js 原生网络错误码（etimedout / socket hang up / econnreset 等）
  { type: 'network_error', fatal: false, keywords: ['timeout', 'timed out', 'etimedout', 'connection lost', 'hang up', 'reset', 'econnreset', 'refused', 'keepalive', 'ehostunreach', 'enetunreach', 'eai_again', 'network', 'socketclosed', 'socket closed', 'closed'] }
]

/**
 * 将断开原因归类。reason 可能是字符串、Error 或 kick 消息对象。
 * @returns {{ type: string, isFatal: boolean, detail: string }}
 */
export function classifyDisconnect (reason, { minecraftVersion } = {}) {
  let text = ''
  let detail = ''
  if (typeof reason === 'string') {
    text = reason
    detail = reason
  } else if (reason instanceof Error) {
    text = reason.message
    // AggregateError（Node 网络层合并 IPv4/IPv6 尝试）message 常为空：取 code 与 errors 数组
    if (!text && reason.code) text = reason.code
    if (!text && Array.isArray(reason.errors)) {
      text = reason.errors.map(e => e?.message || e?.code || String(e)).join(', ')
    }
    detail = text || `(${reason.name ?? 'Error'})`
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
  // 版本相关错误也可能是数字形式（协议号）
  if (minecraftVersion && (lower.includes('protocol') || lower.includes('unsupported'))) {
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
