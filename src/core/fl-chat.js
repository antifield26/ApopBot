// @ts-check
// 聊天监听绑定：chatHandler 创建与 bot.on('message') 挂载（playerChat/systemChat
// 权威通道）。
//
// 身份来源（H6）：legacy 'chat' 事件从渲染文本正则提取显示名——昵称/前缀插件下
// "Sir Steve" 提取为 "Steve"，可伪装 ops 白名单（离线服白名单是唯一认证）。
// message 事件的 sender 是 playerChat 包的 UUID——按 bot.players 精确匹配真实
// 用户名；systemChat 渲染路径（聊天插件改写消息、sender 为 null）无权威身份
// 可用，回退同款正则提取。
//
// 服务器会回显 Bot 自己的消息——不自过滤会把 LLM 回复/!say 内容里以 ! 开头的
// 文本当命令解析（非 op 玩家可借 LLM 触发 op 命令）；自我回显用 sender.uuid
// 与 bot.entity.uuid 比对（权威——昵称插件下显示名 != 用户名，用户名比对会漏）。
// 监听挂在传入的 bot 实例上，随重建/断线自然释放。
import { sendChat } from './chat.js'

// 渲染文本正则（mineflayer LEGACY_VANILLA_CHAT_REGEX 同款）：提取显示名与消息体
const LEGACY_CHAT_REGEX = /^(?:\(.{1,15}\)|\[.{1,15}\]|.){0,5}?(\w+)\s?[>:\-»\])~]+\s(.*)$/

// 回复限流（per-sender token bucket，H5）：全部反馈路径（未知/拒绝/冷却/usage/
// 错误）统一纳入——此前无任何限流，任意玩家 10s 内发 6+ 条 ! 消息 → bot 回 6+
// 条 → Paper spam 检测踢出 bot（0 门槛可反复触发的 DoS，!agent chat 还叠加 LLM
// 额度消耗）。桶满静默丢弃（不执行不回复）；Map 键上限防长期运行无限增长
const replyBuckets = new Map() // sender → { count, windowStart }
const REPLY_BUCKET_MAX_KEYS = 128

function allowReply (sender, cfg) {
  const limit = cfg?.chat?.replyLimit ?? 5
  const windowMs = cfg?.chat?.replyWindowMs ?? 10000
  const now = Date.now()
  let b = replyBuckets.get(sender)
  if (!b || now - b.windowStart >= windowMs) {
    b = { count: 0, windowStart: now }
    replyBuckets.set(sender, b)
    // 键上限：先回收过期窗口，仍超限删最旧（Map 插入序）
    if (replyBuckets.size > REPLY_BUCKET_MAX_KEYS) {
      for (const [k, v] of replyBuckets) if (now - v.windowStart >= windowMs) replyBuckets.delete(k)
      while (replyBuckets.size > REPLY_BUCKET_MAX_KEYS) replyBuckets.delete(replyBuckets.keys().next().value)
    }
  }
  if (b.count >= limit) return false
  b.count++
  return true
}

/** 测试钩子：清空回复限流桶（模块级状态跨测试累积——tests 需独立验证限流语义）。 */
export function _resetReplyBuckets () {
  replyBuckets.clear()
}

/** uuid 归一（去连字符小写——playerChat 包 UUID 与 entity.uuid 格式对齐比较）。 */
function normUuid (v) {
  return String(v ?? '').replace(/-/g, '').toLowerCase()
}

/**
 * 挂载聊天监听：每次重建生成新 handler 引用（旧监听随旧 bot 消亡）。
 * @param {Record<string, any>} ctx 可变上下文（cfg/commands 实时读取）
 * @param {import('mineflayer').Bot} bot
 * @param {() => Record<string, any>} log 惰性取当前 logger（热重载后换 transport）
 */
export function installChatListener (ctx, bot, log) {
  ctx.chatHandler = async (sender, msg) => {
    if (sender === ctx.cfg.username) return
    // trimStart：前导空格消息（" !ping"）与 parser 的 trim 语义对齐——此前
    // startsWith('!') 先于 trim 判定，前导空格被整体忽略
    const line = typeof msg === 'string' ? msg.trimStart() : msg
    if (!line || !line.startsWith('!')) return
    // 回复限流：桶满静默丢弃（防刷屏踢服 DoS——所有反馈路径统一在入口纳入）
    if (!allowReply(sender, ctx.cfg)) return
    const hit = await ctx.commands?.dispatch(line, { sender, ctx }).catch((err) => {
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
  // mineflayer 类型声明 message 事件只带 (jsonMsg, position)——实际 emit 附带
  // (sender, verified)。以 4 参签名 cast 监听器（参数多可赋给参数少的签名），
  // sender 为 playerChat 包的权威 UUID 对象
  bot.on('message', /** @type {(jsonMsg: any, position: string, sender?: { uuid?: unknown }|null, verified?: boolean) => void} */ (jsonMsg, position, sender) => {
    if (position !== 'chat' && position !== 'system') return
    const text = typeof jsonMsg?.toString === 'function' ? jsonMsg.toString() : String(jsonMsg ?? '')
    // 自我回显（权威判断）：sender.uuid 与 bot.entity.uuid 比对——昵称插件下
    // 显示名 != 用户名，后置的用户名比对会漏（LLM 回复以 ! 开头被自解析）
    const selfUuid = normUuid(bot.entity?.uuid)
    if (sender?.uuid && selfUuid && normUuid(sender.uuid) === selfUuid) return
    const m = LEGACY_CHAT_REGEX.exec(text)
    let username = null
    if (sender?.uuid) {
      // 权威身份：uuid → bot.players 精确匹配真实用户名（显示名正则提取不参与
      // 权限判定——防"Sir Steve"伪装 "steve" 过 ops 白名单）
      const uuidStr = normUuid(sender.uuid)
      const found = Object.values(bot.players ?? {}).find(p => normUuid(p?.uuid) === uuidStr)
      if (found?.username) username = found.username
    }
    if (!username && m) username = m[1] // 回退：system 渲染路径/玩家未入表窗口
    const message = m ? m[2] : text
    if (!username) return // 系统公告/无法归属的消息不处理
    void ctx.chatHandler(username, message).catch((err) => {
      log().error({ err: err.message }, 'chat handler error')
    })
  })
}
