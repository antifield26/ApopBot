// 运维 webhook 通知：任务终态/断线重连/死亡重生/fatal 停服推送手机。
// 低配 PC 无人值守场景：事件只在游戏聊天与日志可见，fatal 停服后无人在线——
// webhook 通道让运维第一时间收到。
//
// 零依赖：Node 全局 fetch + URLSearchParams。平台自动识别（按 URL）：
//   - qyapi.weixin.qq.com → 企业微信机器人格式（JSON {msgtype:'text', text:{content}}）
//   - 其他（Server酱 sctapi/sct.ftqq.com 或自建桥）→ form-encoded {title, desp}
// 失败绝不阻塞主流程：5s 超时 + 单次尝试 + 静默（log.warn 留痕）。
// 不含敏感信息：只推事件摘要（任务 id/类型/计数、坐标、断线原因），不推聊天内容。

/**
 * @param {object} cfg 顶层配置（读 cfg.notify.webhook）
 * @param {import('pino').Logger} logger
 * @returns {{ enabled: boolean, send: (event: string, title: string, body?: string) => Promise<void> }}
 */
export function createNotifier (cfg, logger) {
  const url = cfg?.notify?.webhook
  const log = logger?.child?.({ module: 'notify' }) ?? logger
  if (!url || typeof url !== 'string') {
    return { enabled: false, send: async () => {} }
  }
  return {
    enabled: true,
    async send (event, title, body = '') {
      const isWecom = url.includes('qyapi.weixin.qq.com')
      const text = `[${event}] ${title}${body ? `\n${body}` : ''}`
      try {
        const init = { method: 'POST', signal: AbortSignal.timeout(5000) }
        if (isWecom) {
          init.headers = { 'Content-Type': 'application/json' }
          init.body = JSON.stringify({ msgtype: 'text', text: { content: text.slice(0, 2000) } })
        } else {
          init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
          init.body = new URLSearchParams({ title: title.slice(0, 100), desp: text.slice(0, 3000) })
        }
        const res = await fetch(url, init)
        if (!res.ok) log.warn({ event, status: res.status }, 'webhook 推送失败（HTTP 非 2xx）')
      } catch (err) {
        log.warn({ event, err: err.message }, 'webhook 推送失败（静默，不影响主流程）')
      }
    }
  }
}
