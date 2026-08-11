// 临时脚本：从 ChatGPT share HTML 提取对话文本（用完删除）
import { readFileSync } from 'node:fs'
const html = readFileSync('C:/Users/25371/AppData/Local/Temp/chatgpt-share.html', 'utf8')
const texts = []
const re = /"content":"((?:[^"\\]|\\.)*)"/g
let m
while ((m = re.exec(html)) !== null) {
  const raw = m[1]
  if (raw.length > 300) texts.push(raw)
}
console.log('长文本段数:', texts.length)
texts.forEach((t, i) => {
  // 反转义 JSON
  const decoded = t.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&')
  console.log(`\n===== 段 ${i + 1}（${decoded.length} 字符）=====`)
  console.log(decoded.slice(0, 3000))
})
