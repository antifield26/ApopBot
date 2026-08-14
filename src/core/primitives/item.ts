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
// 物品（op / item，不拦 exclusive）
import { Vec3 } from 'vec3'
import { withTimeout } from '../../util/promise-timeout.ts'

/**
 * 注册item族原语。register = index.js 工厂注入的注册函数（含重复注册检查）；
 * _ctx 保留供族文件间约定签名（handler 经 c 首参取 ctx，不经此参数）。
 */
export function registerItem (register, _ctx) {
  // ============ 物品（op / item，不拦 exclusive） ============
  register('equip', {
    schema: {
      type: 'object',
      required: ['itemName'],
      properties: { itemName: { type: 'string', description: '物品名（如 iron_pickaxe/diamond_sword/stone）' } }
    },
    permission: 'op',
    exclusiveClass: 'item',
    guardText: '',
    timeoutMs: 10000,
    handler: async (c, { itemName }) => {
      const item = c.bot.inventory?.items()?.find(it => it.name === itemName)
      if (!item) return `背包里没有 ${itemName}（observe_inventory 查看）`
      try {
        await withTimeout(c.bot.equip(item, 'hand'), 10000, 'equip timeout') // 断线保护
      } catch (err) {
        // equip 无取消 API：超时后底层可能已完成装备——按实际手持校验，一致
        // 则视为成功（避免"幽灵装备"被误报失败后调用方重试造成双重副作用）
        if (c.bot.heldItem?.name === itemName) return `已装备 ${itemName}`
        throw err
      }
      return `已装备 ${itemName}`
    }
  })
  register('store_items', {
    schema: {
      type: 'object',
      properties: {
        chestLocations: { type: 'array', description: '目标箱子坐标（缺省 = storage.chests 配置仓库，再退附近搜索）' },
        keepTools: { type: 'boolean', description: '保留工具（默认 true——不存工具/食物）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'item',
    guardText: '卸货',
    timeoutMs: 60000,
    handler: async (c, { chestLocations, keepTools }) => {
      if (!c.bot?.openContainer) throw new Error('卸货能力不可用（插件缺失）')
      // 目标箱子：显式 chestLocations → storage.chests 配置仓库 → 附近 32 格搜索
      let targets
      if (Array.isArray(chestLocations) && chestLocations.length) {
        targets = chestLocations.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.z))
      } else {
        const configured = (c.cfg?.storage?.chests ?? []).map(p => ({ x: p.x, y: p.y, z: p.z }))
        if (configured.length) targets = configured
        else {
          try {
            targets = c.bot.findBlocks({ matching: (b) => b.name === 'chest' || b.name === 'barrel', maxDistance: 32, count: 4 })
          } catch { targets = [] }
        }
      }
      if (targets.length === 0) throw new Error('没有可用箱子（配置 storage.chests 或提供 chestLocations）')
      const isTool = (n) => /_sword$|_pickaxe$|_axe$|_shovel$|_hoe$/.test(n ?? '')
      const isFood = (n) => (c.bot.registry?.itemsByName?.[n]?.foodPoints ?? 0) > 0
      let stored = 0
      let boxes = 0
      for (const t of targets.slice(0, 3)) {
        let container = null
        try {
          const block = c.bot.blockAt(new Vec3(t.x, t.y, t.z))
          if (!block) continue
          container = await withTimeout(c.bot.openContainer(block), 8000, 'open chest timeout')
          boxes++
          for (const it of c.bot.inventory?.items?.() ?? []) {
            const name = it?.name ?? ''
            if (keepTools !== false && (isTool(name) || isFood(name))) continue
            try {
              const ok = await withTimeout(container.deposit(it.type, it.metadata ?? null, it.count), 8000, 'deposit timeout')
              if (ok) stored++
            } catch { /* 该物品存入失败跳过 */ }
          }
        } catch (err) {
          c.logger.warn({ err: err.message }, '卸货失败（跳过该箱）')
        } finally {
          try { container?.close() } catch { /* 容器可能已关闭 */ }
        }
      }
      return { stored, boxes }
    }
  })
  register('fetch_items', {
    schema: {
      type: 'object',
      required: ['itemName'],
      properties: {
        itemName: { type: 'string', description: '取回的物品名' },
        count: { type: 'integer', min: 1, max: 64, description: '数量（缺省 = 全部）' },
        chestLocations: { type: 'array', description: '目标箱子坐标（缺省 = storage.chests 配置仓库）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'item',
    guardText: '取货',
    timeoutMs: 60000,
    handler: async (c, { itemName, count, chestLocations }) => {
      if (!c.bot?.openContainer) throw new Error('取货能力不可用（插件缺失）')
      let targets
      if (Array.isArray(chestLocations) && chestLocations.length) {
        targets = chestLocations.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.z))
      } else {
        targets = (c.cfg?.storage?.chests ?? []).map(p => ({ x: p.x, y: p.y, z: p.z }))
      }
      if (targets.length === 0) throw new Error('没有可用箱子（配置 storage.chests 或提供 chestLocations）')
      let fetched = 0
      for (const t of targets.slice(0, 3)) {
        let container = null
        try {
          const block = c.bot.blockAt(new Vec3(t.x, t.y, t.z))
          if (!block) continue
          container = await withTimeout(c.bot.openContainer(block), 8000, 'open chest timeout')
          const item = container.items()?.find(it => it.name === itemName)
          if (!item) continue
          const take = Math.min(count ?? item.count, item.count)
          const ok = await withTimeout(container.withdraw(item.type, item.metadata ?? null, take), 8000, 'withdraw timeout')
          if (ok) fetched += take
          if (fetched >= (count ?? Infinity)) break
        } catch (err) {
          c.logger.warn({ err: err.message }, '取货失败（跳过该箱）')
        } finally {
          try { container?.close() } catch { /* 容器可能已关闭 */ }
        }
      }
      return fetched > 0 ? { fetched } : `仓库里没有 ${itemName}`
    }
  })
  register('drop', {
    schema: {
      type: 'object',
      properties: {
        itemName: { type: 'string', description: '物品名（缺省 = 手持物品）' },
        count: { type: 'integer', min: 1, max: 64, description: '丢弃数量（缺省 = 全部）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'item',
    guardText: '',
    timeoutMs: 10000,
    handler: async (c, { itemName, count }) => {
      if (!c.bot?.tossStack) throw new Error('drop 能力不可用（插件缺失）')
      let item
      if (itemName) {
        item = c.bot.inventory?.items()?.find(it => it.name === itemName)
        if (!item) return `背包里没有 ${itemName}`
      } else {
        const held = c.bot.heldItem
        if (!held) return '手里没有物品'
        item = held
      }
      await withTimeout(c.bot.tossStack(item, count ?? item.count), 10000, 'drop timeout')
      return `已丢弃 ${item.name} ${count ?? item.count} 个`
    }
  })
  register('use_item', {
    schema: { type: 'object', properties: {} },
    permission: 'op',
    exclusiveClass: 'item',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c) => {
      if (!c.bot?.activateItem) throw new Error('use_item 能力不可用（插件缺失）')
      const held = c.bot.heldItem?.name ?? '手持物品'
      await withTimeout(c.bot.activateItem(), 5000, 'use_item timeout')
      return `已使用 ${held}`
    }
  })
  register('eat', {
    schema: { type: 'object', properties: {} },
    permission: 'op',
    exclusiveClass: 'item',
    guardText: '',
    timeoutMs: 10000,
    handler: async (c) => {
      // combat 低血进食同款路径（autoEat 插件）
      if (!c.bot?.autoEat?.eat) return { ate: false, reason: 'autoEat 插件未启用（配置 mineflayerPlugins.autoEat=true）' }
      try {
        await withTimeout(c.bot.autoEat.eat(), 10000, 'eat timeout')
        return { ate: true }
      } catch (err) {
        return { ate: false, reason: err.message }
      }
    }
  })

}
