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
// 仓库管理：背包满（NoChests）时自动存储。唯一消费者：build 族 collect_blocks。
import { Vec3 } from 'vec3'
import { withTimeout } from '../util/promise-timeout.ts'

/**
 * 自动存储：背包满（NoChests）时附近找箱子/木桶存入物品——避免 mine/chop/farm
 * 脚本在背包满时干等。规则：
 * - 只搜 32 格内 chest/barrel（至多开 3 个，防 UI 卡死）
 * - 工具（*_sword/_pickaxe/_axe/_shovel/_hoe）与可食用物品不存（保持装备与食物）
 * - 单箱存 ≥1 项即返回（收集流程可继续）；全部失败返回 0（回退 inventoryFull 语义）
 * 失败任何一步静默（autonomy 的附加层——绝不阻塞/抛错）。
 * @returns {Promise<{ stored: number, found: Vec3[] }>}
 */
export async function autoDeposit (bot, logger, cfg = null) {
  if (!bot?.openContainer || !bot?.findBlocks) return { stored: 0, found: [] }
  let found
  try {
    // 配置仓库优先（storage.chests 固定坐标）；未配置才附近搜索 32 格内箱子
    const configured = (cfg?.storage?.chests ?? []).map(c => new Vec3(c.x, c.y, c.z))
    found = configured.length > 0
      ? configured
      : bot.findBlocks({ matching: (b) => b.name === 'chest' || b.name === 'barrel', maxDistance: 32, count: 8 })
  } catch { return { stored: 0, found: [] } }
  if (found.length === 0) return { stored: 0, found: [] }
  const isTool = (n) => /_sword$|_pickaxe$|_axe$|_shovel$|_hoe$/.test(n ?? '')
  let stored = 0
  for (const pos of found.slice(0, 3)) {
    let container = null
    try {
      const block = bot.blockAt(pos)
      if (!block) continue
      container = await withTimeout(bot.openContainer(block), 8000, 'open chest timeout')
      const items = bot.inventory?.items?.() ?? []
      for (const it of items) {
        const name = it?.name ?? ''
        if (isTool(name) || (bot.registry?.itemsByName?.[name]?.foodPoints ?? 0) > 0) continue
        try {
          const ok = await withTimeout(container.deposit(it.type, it.metadata ?? null, it.count), 8000, 'deposit timeout')
          if (ok) stored++
        } catch { /* 该物品存入失败跳过 */ }
        if (stored >= 1) break // 存入即可继续收集（背包留空位）
      }
      if (stored > 0) break
    } catch (err) {
      logger?.warn?.({ err: err.message }, '自动存储失败（回退 inventoryFull 语义）')
    } finally {
      try { container?.close() } catch { /* 容器可能已关闭 */ }
    }
  }
  return { stored, found }
}

