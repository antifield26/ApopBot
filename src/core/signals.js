// 进程信号处理：SIGINT/SIGTERM 优雅退出；SIGHUP 热重载（systemd ExecReload）。

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
    deps.logger.info({ signal }, 'shutting down')
    try {
      await deps.ctx.tasks?.stopAll()
      await deps.ctx.agent?.stop()
      await deps.conn?.disconnect()
    } catch (err) {
      deps.logger.error({ err: err.message }, 'shutdown error')
    } finally {
      await new Promise((resolve) => { deps.logger.flush(resolve) })
      process.exit(0)
    }
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
}
