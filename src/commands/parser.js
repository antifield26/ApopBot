// 聊天命令解析：'!task start "mine iron" foo' → { name: 'task', args: ['start', 'mine iron', 'foo'] }
// shell 式引号语义：仅 token 开头的 " 作为引号分隔符，token 内部的 " 按字面保留
// （支持 JSON 参数如 !agent act mine {"a":1}）。纯函数便于单测。

/**
 * @param {string} line 完整的聊天消息（含 ! 前缀）
 * @returns {{ name: string|null, args: string[] }}
 */
export function parseCommand (line) {
  if (typeof line !== 'string') return { name: null, args: [] }
  const trimmed = line.trim()
  if (!trimmed.startsWith('!')) return { name: null, args: [] }

  const tokens = []
  let current = ''
  let inQuotes = false
  let tokenStarted = false

  for (const ch of trimmed.slice(1)) {
    if (ch === '"' && !tokenStarted) {
      inQuotes = true
      tokenStarted = true
    } else if (ch === '"' && inQuotes) {
      inQuotes = false
    } else if (ch === ' ' && !inQuotes) {
      if (tokenStarted) {
        tokens.push(current)
        current = ''
        tokenStarted = false
      }
    } else {
      current += ch
      tokenStarted = true
    }
  }
  if (tokenStarted) tokens.push(current)

  if (tokens.length === 0) return { name: null, args: [] }
  return { name: tokens[0].toLowerCase(), args: tokens.slice(1) }
}
