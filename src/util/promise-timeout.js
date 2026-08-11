// @ts-check
/**
 * 给 Promise 加超时。超时后拒绝并附带消息；不泄漏原始 promise（错误被吞掉避免 unhandledRejection）。
 */
export function withTimeout (promise, ms, message = `操作超时（${ms}ms）`) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
