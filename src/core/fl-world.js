// @ts-check
// 世界事件感知：方块变化（探索记忆失效）与实体/收集事件（LLM 被动感知）。
// 地形记忆失效：方块变化（被挖/被放/火烧/水冲等）→ 该坐标的探索记忆删除——记忆
// 只增不减会让 query_map 长期返回过期坐标。只覆盖已加载区块（mineflayer
// blockUpdate 的感知范围）——远处记忆变化由 query_map 查询验证兜底。
// 世界事件被动感知：事件写入 agent.pendingEvents，玩家下次对话时 LLM 注入感知
//（不做主动唤醒——busy 门/玩家冷却/权限语义约束）。高频事件由 notifyEvent 按类型
// 去重合并只保最新状态。监听挂 bot 实例随重建/断线自然释放。
import * as discovery from './discovery.js'

/**
 * 挂载地形记忆失效监听（blockUpdate → 删除该坐标探索记忆）。
 * @param {Record<string, any>} ctx 保留签名一致性（handler 直接用 discovery 单例）
 * @param {import('mineflayer').Bot} bot
 */
export function installMemoryInvalidation (ctx, bot) {
  bot.on('blockUpdate', (oldBlock) => {
    const p = oldBlock?.position
    if (p) discovery.removeResourceAt(p.x, p.y, p.z)
  })
}

/**
 * 挂载世界事件被动感知（低血/饥饿、被攻击、重要资源收集 → notifyEvent）。
 * @param {Record<string, any>} ctx 可变上下文（agent 实时读取）
 * @param {import('mineflayer').Bot} bot
 */
export function installWorldSensing (ctx, bot) {
  bot.on('health', () => {
    const hp = bot.health
    const food = bot.food
    if (typeof hp === 'number' && hp > 0 && hp < 10) {
      ctx.agent?.notifyEvent?.('low', `血量低 ${Math.round(hp)}`)
    } else if (typeof food === 'number' && food > 0 && food < 6) {
      ctx.agent?.notifyEvent?.('low', `饥饿 ${Math.round(food)}`)
    }
  })
  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity) return
    const who = source?.username ?? source?.name ?? source?.type ?? 'unknown'
    // 最近伤害来源（fl-death 死亡播报读取——真实死因而非 LLM 编造；
    // 60s 新鲜窗口，超时视为无明确攻击者=环境伤害）
    ctx.lastDamageSource = { who, ts: Date.now() }
    ctx.agent?.notifyEvent?.('attacked', `被 ${who} 攻击`)
    // 危险区域被动记录：怪物攻击（source 非自己/非玩家——排除环境自伤与 PvP）
    // → 目击位置落记忆（explore 之外的威胁：combat 中/基地夜袭）
    if (source && source !== bot.entity && !source.username && bot.entity?.position) {
      const name = source.name ?? source.type
      if (name) {
        discovery.recordDangerZone(bot.entity.position, { hostileNames: [name] }, bot?.game?.dimension?.replace(/^minecraft:/, '') ?? null)
      }
    }
  })
  // 重要资源收集（钻石/绿宝石/远古残骸/铁/金/红石/青金石——高频杂物不记）
  bot.on('playerCollect', (collector, collected) => {
    if (collector !== bot.entity) return
    const name = collected?.name ?? collected?.type ?? ''
    if (/diamond|emerald|ancient_debris|iron|gold|redstone|lapis/.test(name)) {
      ctx.agent?.notifyEvent?.('collect', `获得 ${name}`)
    }
  })
}
