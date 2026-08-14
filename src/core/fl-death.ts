// 死亡/重生处理：createBot 显式 respawn:false → 死亡后 bot 停在死亡界面，重生时序
// 完全可控。死亡 → 通知 + 暂停全部任务 + 停止跟随 + 请求重生；L2 可用时经 LLM
// 一句话播报死因；重生后自动恢复暂停的任务 + 播报重生位置。
// deathPaused 是 promise：respawn 侧 await 保证"先暂停完、再恢复"——快速重生服
// respawn 可能先于 pauseAll 完成到达，同步读取会漏掉暂停名单。
// 监听挂传入的 bot 实例上，随重建/断线自然释放；每次 install 产生新 promise 链。
import { sendChat } from './chat.ts'

/**
 * 挂载死亡/重生处理。
 * @param {Record<string, any>} ctx 可变上下文（tasks/plugins/agent 实时读取）
 * @param {import('mineflayer').Bot} bot
 * @param {() => Record<string, any>} log 惰性取当前 logger
 * @param {() => Record<string, any>} notifier 惰性取 webhook 通知器（reload 换 webhook 后实时生效）
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
    // 中止进行中的 LLM 工具循环（!agent chat 的 maxSteps 循环可能跨死亡持续——
    // 死亡状态下 LLM 继续执行 start/stop_task 等操作会破坏任务生命周期）
    try { ctx.agent?.stop?.() } catch { /* 中止失败静默 */ }
    const pos = bot.entity?.position
    const loc = pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '未知位置'
    // 真实死因：fl-world entityHurt 记录的最近伤害来源（60s 新鲜窗口）——
    // 死亡播报用事实而非让 LLM 编造；无来源 = 环境伤害（摔/烧/溺水/苦力怕爆炸无实体源）
    const src = ctx.lastDamageSource
    const srcText = src && Date.now() - src.ts < 60000
      ? `，被 ${src.who} 击杀`
      : '（无明确攻击者，可能是环境伤害）'
    sendChat(bot, `§c[bot] 已死亡（${loc}）${srcText}——任务已暂停，自动重生中`).catch(() => { /* 聊天通道未就绪 */ })
    // 死亡推送（webhook 独立于游戏聊天——无人值守时玩家可能不在线）
    notifier().send('death', `Bot 死亡（${loc}）`, `任务已暂停，自动重生中${srcText}`)
    // LLM 一句话播报（附加层——任何失败回退模板，不得阻塞重生）。
    // prompt 带真实伤害来源——LLM 基于事实总结，不再凭空猜测死因
    if (ctx.agent?.summarize) {
      ctx.agent.summarize(`Bot 在 Minecraft 服务器死亡（坐标 ${loc}${srcText}）。用一句话向服务器玩家播报死因，简洁。`)
        .then((s) => {
          if (s) {
            sendChat(bot, `§c[bot] ${s}`).catch(() => {})
            // LLM 文案进 webhook（无人值守时唯一感知通道；固定模板推送已有）
            notifier().send('death', `Bot 死亡（${loc}）`, `LLM 死因播报: ${s}`)
          }
        })
        .catch(() => {})
    }
    // 重生 + 有界重试：respawn 同步抛错（客户端已死/通道未就绪）时无自愈——
    // bot 停在死亡界面、任务永久暂停。3 次 × 2s 重试（respawn 只发包、幂等；
    // 服务端确认后 'respawn' 事件触发即停——防重复发包）
    const tryRespawn = () => {
      try { bot.respawn(); return true } catch { return false }
    }
    if (!tryRespawn()) {
      let respawnTries = 0
      const retryTimer = setInterval(() => {
        if (++respawnTries > 3 || tryRespawn()) clearInterval(retryTimer)
      }, 2000)
      retryTimer.unref?.()
      bot.once('respawn', () => clearInterval(retryTimer))
    }
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
    // 如实播报：ids 空（死亡时无运行任务）不发"任务已恢复"——误导排查
    if (ids.length) {
      sendChat(bot, `§a[bot] 已重生（${loc}），任务已恢复`).catch(() => { /* 聊天通道未就绪 */ })
      notifier().send('respawn', `Bot 已重生（${loc}）`, `任务已恢复: ${ids.join(', ')}`)
    } else {
      sendChat(bot, `§a[bot] 已重生（${loc}）`).catch(() => { /* 聊天通道未就绪 */ })
      notifier().send('respawn', `Bot 已重生（${loc}）`, '无暂停任务')
    }
  })
}
