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

