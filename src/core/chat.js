// 聊天发送安全层：服务端单条消息上限 256 字符，超长会被截断/拒绝。
// sendChat 将长文本按 cfg.chat.maxLength 分片发送（优先在 § 颜色码/空白处断开，
// 避免把颜色码或单词截成两半），片间 100ms 间隔防刷屏触发服务端速率限制。

const INTER_MESSAGE_DELAY_MS = 100

/**
 * 将文本按 maxLength 分片（纯函数，便于单测）。
 * 断开优先级：§ 颜色码之后 > 空白处 > 硬切。
 * @param {string} text
 * @param {number} maxLength
 * @returns {string[]}
 */
export function chunkText (text, maxLength) {
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
export async function sendChat (bot, text, maxLength = 250) {
  if (!bot?.chat) return 0
  const chunks = chunkText(String(text), maxLength)
  for (let i = 0; i < chunks.length; i++) {
    bot.chat(chunks[i])
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, INTER_MESSAGE_DELAY_MS))
    }
  }
  return chunks.length
}
