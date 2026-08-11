// @ts-check
// 玩家跟踪与上线问候：playerJoined/playerLeft 记账 + 固定模板问候。
// 模块级已知玩家 Set 与按玩家冷却（跨重建保留——player_info 首包会把登录时
// 已在线的玩家全部触发 playerJoined，重连后闭包重建会把在线玩家当新人问候全服）。
// 只问候不告别（下线告别对离场玩家不可见）、只走固定模板（LLM 不参与）、
// 独立 60s 按玩家冷却防刷屏——问候永不阻塞/不刷屏，也不占 summarize 全局冷却
import { sendChat } from './chat.js'

const knownPlayers = new Set()
const lastGreetAt = new Map()
const GREET_COOLDOWN_MS = 60000

/** 测试钩子：重置上线问候状态（模块级 knownPlayers/冷却跨用例共享）。 */
export function _resetGreetState () {
  knownPlayers.clear()
  lastGreetAt.clear()
}

/**
 * 挂载玩家跟踪：离开玩家移出已知集合——重新加入时才会再次触发问候。
 * @param {Record<string, any>} ctx 可变上下文（cfg.username 实时读取）
 * @param {import('mineflayer').Bot} bot
 */
export function installPlayerTracking (ctx, bot) {
  bot.on('playerJoined', (p) => {
    const name = p?.username
    if (!name || name === ctx.cfg.username) return
    if (knownPlayers.has(name)) return // 首包洪峰去重：在线玩家不算新人
    knownPlayers.add(name)
    const now = Date.now()
    if (now - (lastGreetAt.get(name) ?? 0) < GREET_COOLDOWN_MS) return
    lastGreetAt.set(name, now)
    sendChat(bot, `§a[bot] 欢迎回来，${name}`).catch(() => {})
  })
  bot.on('playerLeft', (p) => {
    const name = p?.username
    if (!name || name === ctx.cfg.username) return
    knownPlayers.delete(name)
  })
}
