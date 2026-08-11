// 聊天监听绑定：chatHandler 创建与 bot.on('chat') 挂载。
// 服务器会回显 Bot 自己的消息——不自过滤会把 LLM 回复/!say 内容里以 ! 开头的
// 文本当命令解析（非 op 玩家可借 LLM 触发 op 命令）。
// 监听挂在传入的 bot 实例上，随重建/断线自然释放。
import { sendChat } from './chat.js'

/**
 * 挂载聊天监听：每次重建生成新 handler 引用（旧监听随旧 bot 消亡）。
 * @param {object} ctx 可变上下文（cfg/commands 实时读取）
 * @param {import('mineflayer').Bot} bot
 * @param {() => object} log 惰性取当前 logger（热重载后换 transport）
 */
export function installChatListener (ctx, bot, log) {
  ctx.chatHandler = async (sender, msg) => {
    if (sender === ctx.cfg.username) return
    if (!msg || !msg.startsWith('!')) return
    const hit = await ctx.commands?.dispatch(msg, { sender, ctx }).catch((err) => {
      log().error({ err: err.message }, 'dispatch error')
      return true // 出错不算未知命令
    })
    // 未知命令静默是"指令无效"体验的一部分——明确反馈（含可用命令提示）。
    // 统一走 sendChat：剥 § 颜色码 + 分片（服务端对含 § 消息直接踢出 → fatal 停服，
    // 裸 bot.chat 发 § 前缀会触发）
    if (hit === false) {
      const names = (ctx.commands?.list() ?? []).map(c => `!${c.name}`).join(' ')
      try { await sendChat(bot, `§c未知命令（可用: ${names}）`, ctx.cfg.chat?.maxLength) } catch { /* 聊天通道可能未就绪 */ }
    }
  }
  bot.on('chat', ctx.chatHandler)
}
