// 死亡/重生处理：createBot 显式 respawn:false → 死亡后 bot 停在死亡界面，重生时序
// 完全可控。死亡 → 通知 + 暂停全部任务 + 停止跟随 + 请求重生；L2 可用时经 LLM
// 一句话播报死因；重生后自动恢复暂停的任务 + 播报重生位置。
// deathPaused 是 promise：respawn 侧 await 保证"先暂停完、再恢复"——快速重生服
// respawn 可能先于 pauseAll 完成到达，同步读取会漏掉暂停名单。
// 监听挂传入的 bot 实例上，随重建/断线自然释放；每次 install 产生新 promise 链。
import { sendChat } from './chat.js'

/**
 * 挂载死亡/重生处理。
 * @param {object} ctx 可变上下文（tasks/plugins/agent 实时读取）
 * @param {import('mineflayer').Bot} bot
 * @param {() => object} log 惰性取当前 logger
 * @param {() => object} notifier 惰性取 webhook 通知器（reload 换 webhook 后实时生效）
 */
export function installDeathHandling (ctx, bot, log, notifier) {
  let deathPaused = Promise.resolve([]) // 本次死亡暂停任务 id 的 promise（重生时恢复）
  bot.on('death', () => {
    const p = ctx.tasks?.pauseAll() ?? Promise.resolve([])
    deathPaused = p.then((ids) => {
      if (ids.length) log().info({ tasks: ids }, 'death: tasks paused')
      return ids
    }).catch((err) => {
      log().warn({ err: err.message }, 'death: pause tasks failed')
      return []
    })
    ctx.plugins?.follow?.stop?.()
    const pos = bot.entity?.position
    const loc = pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '未知位置'
    sendChat(bot, `§c[bot] 已死亡（${loc}）——任务已暂停，自动重生中`).catch(() => { /* 聊天通道未就绪 */ })
    // 死亡推送（webhook 独立于游戏聊天——无人值守时玩家可能不在线）
    notifier().send('death', `Bot 死亡（${loc}）`, '任务已暂停，自动重生中')
    // LLM 一句话播报（附加层——任何失败回退模板，不得阻塞重生）
    if (ctx.agent?.summarize) {
      ctx.agent.summarize(`Bot 在 Minecraft 服务器死亡（坐标 ${loc}）。用一句话向服务器玩家播报（如可能的死因），简洁。`)
        .then((s) => {
          if (s) {
            sendChat(bot, `§c[bot] ${s}`).catch(() => {})
            // LLM 文案进 webhook（无人值守时唯一感知通道；固定模板推送已有）
            notifier().send('death', `Bot 死亡（${loc}）`, `LLM 死因播报: ${s}`)
          }
        })
        .catch(() => {})
    }
    try { bot.respawn() } catch { /* 重生通道未就绪 */ }
  })
  bot.on('respawn', async () => {
    // 恢复本次死亡暂停的任务（手动暂停的保持暂停）；await 暂停 promise 确保
    // pauseAll 完成后再恢复（快速重生服 respawn 先到的竞态）
    const ids = await deathPaused
    deathPaused = Promise.resolve([])
    for (const id of ids) {
      ctx.tasks?.resumeTask(id).catch(() => { /* 任务可能已结束 */ })
    }
    const pos = bot.entity?.position
    const loc = pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '未知位置'
    sendChat(bot, `§a[bot] 已重生（${loc}），任务已恢复`).catch(() => { /* 聊天通道未就绪 */ })
    notifier().send('respawn', `Bot 已重生（${loc}）`, '任务已恢复')
  })
}
