// @ts-check
// 任务长 idle LLM 播报——waitingReason 持续超过 IDLE_THRESHOLD_MS 时经 LLM 一句话
// 解释（玩家/运维感知"卡在哪"）。模块级 interval（跨重建保留——重建新建 interval
// 会累积泄漏），重建时只更新引用；已播报按 `任务id:原因` 去重 + 冷却。
// summarize 自带 60s 全局冷却。
import { sendChat } from './chat.js'

const IDLE_POLL_MS = 60000 // 每分钟检查一次
const IDLE_THRESHOLD_MS = 10 * 60000 // waitingReason 持续 10 分钟才播报
const IDLE_REANNOUNCE_MS = 60 * 60000 // 同一任务同原因至少 1 小时才再播报
const idleWatcher = { bot: null, ctx: null, announced: new Map() }
setInterval(() => {
  const { bot, ctx } = idleWatcher
  if (!bot || !ctx?.tasks || !ctx.agent?.summarize) return
  const now = Date.now()
  for (const t of ctx.tasks.getStatus()) {
    if (t.state !== 'running' || !t.waitingReason || !t.waitingSince) continue
    const key = `${t.id}:${t.waitingReason}`
    const last = idleWatcher.announced.get(key) ?? 0
    if (now - t.waitingSince > IDLE_THRESHOLD_MS && now - last > IDLE_REANNOUNCE_MS) {
      idleWatcher.announced.set(key, now)
      // 上限 64：防 announced 无限增长（长期运行的等待组合有限）
      if (idleWatcher.announced.size > 64) {
        idleWatcher.announced.delete(idleWatcher.announced.keys().next().value)
      }
      const mins = Math.round((now - t.waitingSince) / 60000)
      ctx.agent.summarize(`任务 ${t.id}（${t.type}）已等待 ${mins} 分钟（原因：${t.waitingReason}）。用一句话向服务器玩家播报任务当前状态。`)
        .then((s) => { if (s) sendChat(bot, `§e[任务 ${t.id}] ${s}`).catch(() => {}) })
        .catch(() => {})
    }
  }
}, IDLE_POLL_MS).unref?.()

/** 测试钩子：清空 idle 播报去重表（跨用例共享）。 */
export function _resetIdleWatcher () {
  idleWatcher.bot = null
  idleWatcher.ctx = null
  idleWatcher.announced.clear()
}

/**
 * 更新 idle 播报 watcher 引用（模块级 interval 跨重建保留，重建只换引用）。
 * @param {Record<string, any>} ctx 可变上下文（tasks/agent 实时读取）
 * @param {import('mineflayer').Bot} bot
 */
export function bindIdleWatcher (ctx, bot) {
  idleWatcher.bot = bot
  idleWatcher.ctx = ctx
}
