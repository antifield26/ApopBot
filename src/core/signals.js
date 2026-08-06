// 进程信号处理：SIGINT/SIGTERM 优雅退出（Windows 下 NSSM stop 发送 Ctrl+C 事件 → Node 映射 SIGINT，走同一路径）。
// 热重载：无 SIGHUP 的平台（Windows）用配置监视 + !reload；Linux 下 SIGHUP 仍注册（systemd ExecReload）。

import { withTimeout } from '../util/promise-timeout.js'

// 优雅退出整体上限：必须低于 NSSM AppStopTimeout（默认 30s），否则卡死会被强杀成非干净退出
const SHUTDOWN_TIMEOUT_MS = 15000

/**
 * 注册信号处理。注意 deps 须包含可变 ctx（tasks/agent 在 spawn 后才初始化，须在
 * 关闭/重载时读取最新值，不能注册时捕获 null）。
 * @param {object} deps { logger, conn, ctx, onReload: () => Promise<void> }
 */
export function setupSignals (deps) {
  let shuttingDown = false

  async function gracefulShutdown (signal) {
    if (shuttingDown) return
    shuttingDown = true
    // 热重载会重建 logger——flush 用当前实例，避免关闭时丢新 logger 的最后几条日志
    const log = deps.ctx?.logger ?? deps.logger
    log.info({ signal }, 'shutting down')
    try {
      await withTimeout((async () => {
        await deps.ctx.tasks?.stopAll()
        await deps.ctx.agent?.stop()
        await deps.conn?.disconnect?.() // 双可选链：conn 为空对象时 disconnect 是 undefined，直接调用会 TypeError（实测）
        await new Promise((resolve) => { log.flush(resolve) })
      })(), SHUTDOWN_TIMEOUT_MS, 'shutdown timeout')
    } catch (err) {
      log.error({ err: err.message }, 'shutdown error or timeout——强制退出')
      process.exit(1)
      return // exit 后不得继续走正常退出路径（mock 下可见双 exit）
    }
    process.exit(0)
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

  process.on('SIGHUP', async () => {
    deps.logger.info('SIGHUP received, reloading config and tasks')
    try {
      await deps.onReload()
    } catch (err) {
      deps.logger.error({ err: err.message }, 'reload failed')
    }
  })

  // 返回句柄供测试直接调用（process.on 注册无法 await）
  return { gracefulShutdown }
}
