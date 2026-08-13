// @ts-check
// 聊天发送安全层：服务端单条消息上限 256 字符，超长会被截断/拒绝。
// sendChat 将长文本按 cfg.chat.maxLength 分片发送（优先在空白处断开，
// 避免把单词截成两半），片间 300ms 间隔——Paper 默认反刷屏检测
//（disconnect.spam kick，实测 6 片消息 100ms 间隔触发）按 10s 窗口计数，
// 单条长回复 6 片 0.5s 发完即踢；300ms 虽不能完全规避窗口叠加（多源短消息
// 同 10s 内仍是风险），但消除了单条消息自触发的主因，配合发送日志可追溯。
//
// 颜色码剥离：聊天消息含 § 颜色码会被服务器直接踢出
//（multiplayer.disconnect.illegal_characters）。源码中的 §a/§c 前缀
// 保留作设计标记，发送层统一剥离（若服务器日后允许颜色码，改此处即可恢复）。

const INTER_MESSAGE_DELAY_MS = 300

// 发送队列（模块级）：多源并发（任务通知/命令回复/LLM 回复/重连提示/
// idle 播报/guard 播报）的长消息分片会交错混排——片间 300ms 只约束单条消息
// 内间隔，跨消息无锁。串行化后每条消息的分片连续发送；队列失败不毒化后续
//（sendQueue 接 catch 空分支）。
/** @type {Promise<unknown>} */
let sendQueue = Promise.resolve()

// 发送日志（可观测性）：spam kick 排查需要知道"谁发了什么"——
// index.js 启动时 registerChatLogger 注入一次，sendChat 内部记 info
//（发送方/文本摘要/分片数）。未注册（测试/无 logger）时静默零成本。
/** @type {((msg: object) => void)|null} */
let chatLogger = null

/**
 * 注册聊天发送日志（启动时注入；spam kick/消息丢失排查用）。
 * @param {(msg: object) => void} logger pino child
 */
export function registerChatLogger (logger) {
  chatLogger = logger
}

/**
 * 移除聊天颜色码（§ 及合法颜色字符）。
 * @param {string|unknown} text
 * @returns {string}
 */
export function stripColorCodes (text) {
  return String(text)
    .replace(/§[0-9a-fk-orx]/gi, '') // §a-§f / §k-§o / §r / §x（RGB 十六进制头）
    .replace(/§/g, '') // 孤立 §（结尾等）
}

/**
 * 将文本按 maxLength 分片（纯函数，便于单测）。
 * 断开优先级：§ 颜色码之后 > 空白处 > 硬切。
 * @param {string} text
 * @param {number} maxLength
 * @returns {string[]}
 */
export function chunkText (text, maxLength) {
  // 防御：maxLength ≤ 0/非有限值时 while 恒真且 cut 恒 0 → 死循环（生产配置
  // 32-256 校验挡住，此为导出纯函数的自防御）
  if (maxLength <= 0 || !Number.isFinite(maxLength)) return [text]
  if (text.length <= maxLength) return [text]
  const chunks = []
  let rest = text
  while (rest.length > maxLength) {
    let cut = maxLength
    // 最后一个 § 颜色码之后断开（§ 颜色码占 2 字符，不能拆开）
    for (let i = 0; i < maxLength; i++) {
      if (rest[i] === '§' && i + 2 <= maxLength) cut = i + 2
    }
    // 无颜色码：在 maxLength 之前的最后一个空白处断开（避免碎片过小）
    if (cut === maxLength) {
      const sp = rest.lastIndexOf(' ', maxLength)
      if (sp > maxLength / 2) cut = sp + 1
    }
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * 安全发送聊天消息（自动分片）。返回分片数。
 * @param {import('mineflayer').Bot} bot
 * @param {string} text
 * @param {number} [maxLength] 默认 250（256 上限留冗余）
 * @returns {Promise<number>}
 */
export function sendChat (bot, text, maxLength = 250) {
  if (!bot?.chat) return Promise.resolve(0)
  const clean = stripColorCodes(text)
  if (!clean.trim()) return Promise.resolve(0) // 空/纯空白（!say 无参或纯 §）不发包——空消息行为未验证，避免触发服务端拒绝
  const run = sendQueue.then(() => doSend(bot, clean, maxLength))
  sendQueue = run.catch(() => {}) // 队列失败不毒化后续发送
  return run
}

/** 发送队列串行段：分片 + 片间间隔（只在队列上下文中执行）。 */
async function doSend (bot, clean, maxLength) {
  const chunks = chunkText(clean, maxLength)
  if (chatLogger) chatLogger({ chunks: chunks.length, text: clean.slice(0, 80) })
  for (let i = 0; i < chunks.length; i++) {
    bot.chat(chunks[i])
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, INTER_MESSAGE_DELAY_MS))
    }
  }
  return chunks.length
}
