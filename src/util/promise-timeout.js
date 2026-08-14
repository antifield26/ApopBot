// @ts-check
/**
 * 给 Promise 加超时。超时后拒绝并附带消息；不泄漏原始 promise（错误被吞掉避免 unhandledRejection）。
 * @param {Promise<any>} promise
 * @param {number} ms
 * @param {string} [message]
 * @param {(() => void)|null} [onTimeout] 超时触发时的同步回调（如 abort 内部 signal——
 *   使 handler 的可取消点在 executor 超时时一并收手，避免幽灵动作）
 */
export function withTimeout (promise, ms, message = `操作超时（${ms}ms）`, onTimeout = null) {
  let timer
  const timeout = new Promise((_, reject) => {
    // unref：超时定时器是守卫语义——唯一在跑的工作就是被守卫的 promise 时，
    // 定时器不得拖住进程退出（如任务时长上限 1 小时的挂载定时器会在测试/
    // 优雅退出时把事件循环钉住）。有其它活跃工作时 unref 定时器照常触发
    timer = setTimeout(() => { try { onTimeout?.() } catch { /* 回调失败不影响超时语义 */ } reject(new Error(message)) }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
