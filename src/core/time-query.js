// @ts-check
// 时间查询（26.1 适配）：协议 775 的 update_time 包只有 age（world age）——
// dayTime/clock 数据全部移除，age 与游戏钟的差 = 玩家睡觉重置的累积偏移，无法推算。
// 方案：Bot 经游戏内命令 `/time query daytime` 查询真实游戏钟（服务器返回聊天消息），
// 定时刷新缓存到 bot.time.dayTime（environmentLine 读它——formatTime 语义不变）。
//
// 权限注意：`/time query` 在 vanilla 需 permission level 2（op）——Bot 非 op 时
// 服务器拒绝，查询失败输出"时间未知"（不再用 age 近似——用户明确要求移除）。
//
// 解析容错：服务器返回格式本地化（英文 "The time is 12345" / 中文 "时间是 12345"），
// 用双模式正则；只接受 Server 来源消息（self 过滤已有 fl-chat，这里再过滤 username）。

const QUERY_INTERVAL_MS = 30000

/**
 * 挂载时间查询：定时执行 /time query daytime + 解析聊天返回缓存。
 * @param {Record<string, any>} ctx 可变上下文（bot/logger 实时读取）
 * @param {import('mineflayer').Bot} bot
 * @param {() => Record<string, any>} log 惰性取当前 logger
 */
export function installTimeQuery (ctx, bot, log) {
  const query = () => {
    try {
      bot.chat('/time query daytime')
    } catch { /* 聊天通道未就绪 */ }
  }
  bot.on('chat', (username, message) => {
    if (username !== 'Server') return
    const m = /The time is (\d+)|时间是 (\d+)|时间为 (\d+)/.exec(String(message ?? ''))
    if (m) {
      const dayTime = Number(m[1] ?? m[2] ?? m[3])
      if (Number.isInteger(dayTime) && dayTime >= 0 && dayTime < 24000) {
        // dayTime 是 mineflayer Time 类型外的扩展字段（26.1 协议无此数据，time-query 注入）
        /** @type {Record<string, any>} */
        const t = bot.time
        t.dayTime = dayTime
        t.isDay = dayTime < 13000
        log().info({ dayTime }, 'time: /time query 解析成功')
      }
    }
  })
  // 首查立即执行（上线后 1s——等待连接稳定），之后定时（unref——不拖进程退出）
  setInterval(query, QUERY_INTERVAL_MS).unref?.()
  setTimeout(query, 1000).unref?.()
}
