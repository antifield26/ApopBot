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

import { registerObserve } from './observe.ts'
import { registerMove } from './move.ts'
import { registerBuild } from './build.ts'
import { registerCombat } from './combat.ts'
import { registerInteract } from './interact.ts'
import { registerItem } from './item.ts'
import { registerFlow } from './flow.ts'
import { registerTask } from './task.ts'

const FAMILIES = [registerObserve, registerMove, registerBuild, registerCombat, registerInteract, registerItem, registerFlow, registerTask]

/**
 * 创建原语注册表。ctx = { bot, cfg, logger, tasks, conn, plugins }（与 skills 同源）。
 * 返回可变 Map——ScriptRunner 注入任务局部 op（explore 的 spiral_step）依赖此形态。
 * @returns {Map<string, object>} op → 原语定义
 */
export function createPrimitiveRegistry (ctx) {
  const reg = new Map()
  const register = (op, def) => {
    if (reg.has(op)) throw new Error(`原语重复注册: ${op}`)
    reg.set(op, def)
  }
  for (const family of FAMILIES) family(register, ctx)
  return reg
}
