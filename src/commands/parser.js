// 聊天命令解析：'!task start "mine iron" foo' → { name: 'task', args: ['start', 'mine iron', 'foo'] }
// shell 式引号语义：仅 token 开头的 " 作为引号分隔符，token 内部的 " 按字面保留
// （支持 JSON 参数如 !agent act mine {"a":1}）。
// 未闭合引号返回 error（不再静默吞掉消息尾部）；\" 转义可输入字面双引号。
// 纯函数便于单测。

/**
 * @param {string} line 完整的聊天消息（含 ! 前缀）
 * @returns {{ name: string|null, args: string[], error?: string }}
 */
export function parseCommand (line) {
  if (typeof line !== 'string') return { name: null, args: [] }
  const trimmed = line.trim()
  if (!trimmed.startsWith('!')) return { name: null, args: [] }

  const tokens = []
  let current = ''
  let inQuotes = false
  let tokenStarted = false
  let escaped = false
  let braceDepth = 0 // 以 { 开头的 JSON token：括号内空格不分割（支持 !task new 带空格的 JSON）
  let inJsonStr = false // JSON token 内字符串值状态（引号成对切换）——字符串值里的 { } 不计 depth
  let jsonEscaped = false // 第 11 轮：JSON 字符串值内的转义（\"）——被转义的引号不翻转 inJsonStr

  for (const ch of trimmed.slice(1)) {
    if (escaped) {
      current += ch
      tokenStarted = true
      escaped = false
    } else if (ch === '\\' && inQuotes) {
      // 转义仅在引号内生效（\" 与 \\）：裸 \ 按字面（Windows 路径不被破坏）
      escaped = true
    } else if (ch === '"' && !tokenStarted) {
      inQuotes = true
      tokenStarted = true
    } else if (ch === '"' && inQuotes) {
      inQuotes = false
    } else if (ch === ' ' && !inQuotes && braceDepth === 0) {
      if (tokenStarted) {
        tokens.push(current)
        current = ''
        tokenStarted = false
        inJsonStr = false // token 结束：JSON 字符串状态复位（新 token 从 { 重新判定）
      }
    } else {
      // 第 8 轮：braceDepth 只对 JSON 顶层计数——JSON 字符串值里的 { } 此前也计入
      // （'{"a": "x{"}' 的 { 使 depth=2），后续空格不再分割 → 整串合并为一个 token
      // → JSON.parse 失败报"参数必须是 JSON"（吞掉本应独立的后续参数）。
      // JSON token 的引号不走 inQuotes（shell 语义：仅 token 开头的 " 是引号分隔符）——
      // 以 { 开头的 token 内单独跟踪字符串状态（合法 JSON 的引号必然成对）
      if (!inQuotes) {
        // 第 11 轮：JSON 字符串值内先处理转义——`\"` 使 inJsonStr 连续误翻转
        // 两次 → 字符串结束引号后 } 不计 depth → braceDepth 残留 → 后续参数被
        // 并入 JSON token（合法 JSON 参数解析失败，如 {"desc":"say \"hi\""}）
        if (jsonEscaped) {
          jsonEscaped = false
        } else if (ch === '\\' && inJsonStr) {
          jsonEscaped = true
        } else if (ch === '"' && current.startsWith('{')) {
          inJsonStr = !inJsonStr
        }
        if (!inJsonStr) {
          if (ch === '{') braceDepth++
          else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
        }
      }
      current += ch
      tokenStarted = true
    }
  }
  if (escaped) current += '\\' // 行尾悬空转义按字面
  if (tokenStarted) tokens.push(current)

  if (tokens.length === 0) return { name: null, args: [] }
  if (inQuotes) return { name: tokens[0].toLowerCase(), args: tokens.slice(1), error: '未闭合的引号' }
  return { name: tokens[0].toLowerCase(), args: tokens.slice(1) }
}
