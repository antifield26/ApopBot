// @ts-check
// 动作原语注册表（按族拆分）：LLM act 动作数组与任务脚本共用的原子动作层。
// 每个原语 { schema, permission, exclusiveClass, guardText, timeoutMs, cooldownMs?, handler }。
// 约定（与 skills.execute 同源，由 executor 统一执行管线保证）：
// - handler(ctx, args, runtime) 返回 result（成功）；业务性"无事可做"（无目标/
//   无物品/冷却）也返回文案（ok:true——动作已有效执行）；真正的异常 throw
//   （executor 转 { ok:false, result: err.message }）
// - runtime = { signal: AbortSignal|null, user, taskId }——signal 贯通长时等待
//   （fish/eat/wait 的 race；movement 的 isInterrupted 组合谓词）
// - exclusive 守卫统一上提 executor（按 exclusiveClass），handler 不再自查
// 权限分级：观察/流程类 all；会改变世界状态（移动/构建/战斗/交互/物品/任务）op。
// 观察类返回结构化对象（LLM 收到 JSON、脚本读字段）；动作类返回简短中文文案。
// 动作冷却共享态（dig/place/attack 防刷；equip/use_item 等不拦）。判定在 handler 内
// "只对实际执行生效"（业务性校验失败——距离/占用等——不占冷却，与原技能层一致）；
// cooldownMs 字段保留供 executor 层展示/扩展，冷却执行点在 handler。
// 模块级共享——拆族后若按文件复制会让 dig/place/attack 冷却互相独立（行为漂移）。
export const ACTION_COOLDOWN_MS = 500
const lastActionAt = new Map()
export function checkActionCooldown (name) {
  const now = Date.now()
  const last = lastActionAt.get(name) ?? 0
  if (now - last < ACTION_COOLDOWN_MS) {
    throw new Error(`${name} 冷却中（${Math.ceil((ACTION_COOLDOWN_MS - (now - last)) / 1000)}s 后重试）`)
  }
  lastActionAt.set(name, now)
}

/**
 * 竞速取消：signal abort 时立即以 AbortError 拒绝（底层 promise 继续执行——
 * 多数 mineflayer 动作无公开取消 API；调用方不再等待，残余副作用由底层自然
 * 收敛）。onAbort 钩子供真可取消的动作（collectBlock.cancelTask）挂取消调用。
 * 监听器 finally 配对移除（wait/fish/sleep 同款纪律——任务级 signal 生命周期
 * 数天，不配对移除会累积泄漏）。
 * @param {Promise<any>} promise 底层动作
 * @param {AbortSignal|null|undefined} signal 任务级取消信号
 * @param {string} [message] abort 时错误文案
 * @param {(() => void)|null} [onAbort] abort 时同步调用的取消钩子（可抛，不影响中止语义）
 * @returns {Promise<any>}
 */
export function raceAbort (promise, signal, message = '动作被中断', onAbort = null) {
  if (!signal) return promise
  if (signal.aborted) {
    try { onAbort?.() } catch { /* 取消钩子失败不影响中止语义 */ }
    return Promise.reject(new DOMException(message, 'AbortError'))
  }
  let listener = null
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      listener = () => {
        try { onAbort?.() } catch { /* 取消钩子失败不影响中止语义 */ }
        reject(new DOMException(message, 'AbortError'))
      }
      signal.addEventListener('abort', listener, { once: true })
    })
  ]).finally(() => {
    if (listener) signal.removeEventListener('abort', listener)
  })
}

/**
 * 可中断睡眠：abort 时立即以 AbortError 拒绝（片间等待/冷却轮询用——
 * stop 后不再空等片间间隔）。监听器 finally 配对移除。
 * @param {number} ms
 * @param {AbortSignal|null|undefined} signal
 * @returns {Promise<void>}
 */
export function interruptibleSleep (ms, signal) {
  if (!signal) return new Promise(r => setTimeout(r, ms))
  if (signal.aborted) return Promise.reject(new DOMException('等待被中断', 'AbortError'))
  let onAbort = null
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('等待被中断', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

