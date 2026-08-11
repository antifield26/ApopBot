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
// 工具耐久管理：挖掘前工具保障（材料等级排序 + 将坏替换）。唯一消费者：build 族 collect_blocks。
import { withTimeout } from '../util/promise-timeout.js'

// 工具材料等级（升序——netherite 最优）
const TOOL_MATERIAL_RANK = ['wooden', 'stone', 'iron', 'diamond', 'netherite']

/** 方块 → 工具类（矿石/石头 → 镐；原木/木板 → 斧；沙/土 → 锹；无 → null 空手）。 */
function toolClassFor (blockName) {
  const n = String(blockName ?? '')
  if (/_ore$|stone|diorite|andesite|granite|deepslate|netherrack|obsidian|tuff$/.test(n)) return 'pickaxe'
  if (/_log$|_wood$|_planks$/.test(n)) return 'axe'
  if (/^sand|gravel|dirt|grass_block|clay|mud/.test(n)) return 'shovel'
  return null
}

/** 工具材料等级（非工具/未知 = -1）。 */
function toolRank (name) {
  const m = String(name ?? '').match(/^(wooden|stone|iron|diamond|netherite)_(\w+)$/)
  return m ? TOOL_MATERIAL_RANK.indexOf(m[1]) : -1
}

/** 工具耐久将坏判定（durability = 最大耐久；durabilityUsed 已用）。 */
function toolWorn (item) {
  return typeof item?.durability === 'number' && item.durability > 0 &&
    (item.durabilityUsed ?? 0) / item.durability > 0.8
}

/**
 * 挖掘前工具保障（工具耐久管理）：目标方块有对应工具类时——手持空/非该类工具/
 * 将坏 → 从背包换该类最高材料等级且耐用的工具（只升不降，减少无谓切换）。
 * 失败静默（空手也能挖，仅速度慢——不阻塞收集流程）。
 * @returns {Promise<string|null>} 换上的工具名（未换 null）
 */
export async function ensureMiningTool (bot, blockName, logger) {
  const cls = toolClassFor(blockName)
  if (!cls || !bot?.equip || !bot?.inventory) return null
  const held = bot.heldItem
  const heldIsTool = held?.name?.endsWith(`_${cls}`)
  const heldOk = heldIsTool && !toolWorn(held)
  if (heldOk) return null // 当前工具可用
  const items = bot.inventory.items?.() ?? []
  let best = null
  for (const it of items) {
    if (!it.name?.endsWith(`_${cls}`)) continue
    if (toolWorn(it)) continue
    if (!best || toolRank(it.name) > toolRank(best.name)) best = it
  }
  if (!best) return null
  // 手持已是同类但材料更低且背包装得下更高材料 → 升；手持非同类 → 直接换
  if (heldIsTool && toolRank(best.name) <= toolRank(held.name)) return null
  try {
    await withTimeout(bot.equip(best, 'hand'), 10000, 'equip timeout')
    logger?.debug?.({ tool: best.name }, '挖掘工具已更换')
    return best.name
  } catch { return null }
}

