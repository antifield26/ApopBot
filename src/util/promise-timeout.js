// @ts-check
/**
 * 给 Promise 加超时。超时后拒绝并附带消息；不泄漏原始 promise（错误被吞掉避免 unhandledRejection）。
 */
export function withTimeout (promise, ms, message = `操作超时（${ms}ms）`) {
  let timer
  const timeout = new Promise((_, reject) => {
    // unref：超时定时器是守卫语义——唯一在跑的工作就是被守卫的 promise 时，
    // 定时器不得拖住进程退出（如任务时长上限 1 小时的挂载定时器会在测试/
    // 优雅退出时把事件循环钉住）。有其它活跃工作时 unref 定时器照常触发
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
