// @ts-check
// 时间查询（26.1 适配）：协议 775 的 update_time 包只有 age（world age）——
// dayTime/clock 数据全部移除，age 与游戏钟的差 = 玩家睡觉重置的累积偏移，无法推算。
// 方案：Bot 经游戏内命令 `/time query daytime` 查询真实游戏钟（服务器返回聊天消息），
// 定时刷新缓存到 bot.time.dayTime（environmentLine 读它——formatTime 语义不变）。
//
// 权限注意：`/time query` 在 vanilla 需 permission level 2（op）——Bot 非 op 时
// 服务器拒绝，查询失败输出"时间未知"（不再用 age 近似——用户明确要求移除）。
//
// 命令选择：用 `/minecraft:time` 显式 namespace——服务器可能装插件（EssentialsX 类）
// 覆盖 `/time`（实测 26.1 Paper + 插件环境下 `/time query` 返回插件帮助而非时间），
// namespace 前缀调用原版命令绕过覆盖。
// 参数注意：26.1 改版——/time query 候选项为 gametime/day/early_game/moon/
// villager_schedule/time（**无 daytime**）；`time` = 当前时间 of day（睡觉会重置），
// `gametime` = 世界总刻。查询 `time`。
//
// 解析容错：服务器返回格式本地化（英文 "The time is 12345" / 中文 "时间是 12345"），
// 用双模式正则；只接受 Server 来源消息（self 过滤已有 fl-chat，这里再过滤 username）。

const QUERY_INTERVAL_MS = 30000

/**
 * 挂载时间查询：定时执行 /minecraft:time query time + 解析聊天返回缓存。
 * @param {Record<string, any>} ctx 可变上下文（bot/logger 实时读取）
 * @param {import('mineflayer').Bot} bot
 * @param {() => Record<string, any>} log 惰性取当前 logger
 */
export function installTimeQuery (ctx, bot, log) {
  log().info({ intervalMs: QUERY_INTERVAL_MS }, 'time-query: 已挂载（/minecraft:time query time）')
  const query = () => {
    try {
      bot.chat('/minecraft:time query time')
      log().info({ cmd: '/minecraft:time query time' }, 'time-query: 发起查询')
    } catch (err) {
      // 聊天通道未就绪/发送失败——记录以便排查（此路径曾吞错导致静默无回复）
      log().warn({ err: err?.message ?? String(err) }, 'time-query: 查询发送失败')
    }
  }
  // /time query 返回是系统消息（systemChat 通道）——bot.on('chat') 只收玩家聊天
  //（26.1 协议：系统消息走 messagestr，sender 为 null；玩家消息 sender 为玩家名）
  //
  // 26.1 实测：translate 消息（commands.time.query.absolute）的 with 参数用新键
  // `""`（非 text）+ 数组值（{"":[0,22811813]}——末元素为时钟总刻）——prismarine-chat
  // 不认识新键，渲染时数值丢失（"Clock minecraft:overworld is at  tick(s)"）。
  // 故直接在 _client 层解析原始 JSON（在 prismarine-chat 处理之前/之后均无妨——
  // 各自独立监听）。
  bot._client.on('systemChat', (data) => {
    try {
      const raw = data?.formattedMessage ?? data?.content
      if (typeof raw !== 'string') return
      const j = JSON.parse(raw)
      if (j?.translate !== 'commands.time.query.absolute') return
      const p = j?.with?.[1]
      const val = p && typeof p === 'object' ? (p[''] ?? p.text ?? p.value) : undefined
      // 26.1 数组形式 [0, 总刻]——取末元素；旧格式直接数值
      const n = Array.isArray(val) ? val[val.length - 1] : val
      cacheDayTime(Number(n))
    } catch { /* 非 JSON/结构不符——忽略（其他系统消息） */ }
  })

  /** 校验并缓存 dayTime（raw % 24000；非法值忽略） */
  const cacheDayTime = (raw) => {
    const dayTime = Number.isInteger(raw) && raw >= 0 ? raw % 24000 : NaN
    if (Number.isInteger(dayTime) && dayTime >= 0 && dayTime < 24000) {
      /** @type {Record<string, any>} */
      const t = bot.time
      t.dayTime = dayTime
      t.isDay = dayTime < 13000
      log().info({ dayTime, raw }, 'time: /time query 解析成功')
    }
  }

  // 文本正则兜底（旧格式/其他 locale 渲染完整时）——解析逻辑与 JSON 通道共用
  bot.on('messagestr', (msg, _position, _originalMsg, sender) => {
    if (sender !== null && sender !== undefined) return // 玩家聊天不处理
    const text = String(msg ?? '')
    // 诊断：记录全部系统消息（权限拒绝/格式不匹配定位）——debug 级避免每 30s 刷屏
    log().debug({ text: text.slice(0, 160) }, 'time: 系统消息')
    // 26.1 回复格式（本地化）：英文 "The time is 12345" / 中文 "时间是 12345" /
    // 26.1 改版中文 "时钟minecraft:overworld处于22769069刻"
    const m = /The time is (\d+)|时间是 (\d+)|时间为 (\d+)|时钟[\w:]+处于(\d+)刻/.exec(text)
    if (m) {
      const raw = Number(m[1] ?? m[2] ?? m[3] ?? m[4])
      cacheDayTime(raw)
    }
  })
  // 首查立即执行（上线后 1s——等待连接稳定），之后定时（unref——不拖进程退出）
  setInterval(query, QUERY_INTERVAL_MS).unref?.()
  setTimeout(query, 1000).unref?.()
}
