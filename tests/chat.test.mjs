import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, sendChat, stripColorCodes } from '../src/core/chat.js'

test('chunkText: 短文本不分片', () => {
  assert.deepEqual(chunkText('hello', 250), ['hello'])
  assert.deepEqual(chunkText('', 250), [''])
})

test('chunkText: 长文本按 maxLength 硬切', () => {
  const long = 'x'.repeat(700)
  const chunks = chunkText(long, 250)
  assert.equal(chunks.length, 3)
  for (const c of chunks) assert.ok(c.length <= 250)
  assert.equal(chunks.join(''), long, '拼接后应与原文一致')
})

test('chunkText: § 颜色码不被截断', () => {
  const text = `${'§a'.repeat(3)}${'x'.repeat(300)}`
  const chunks = chunkText(text, 250)
  for (const c of chunks) {
    // § 后必须是颜色字符（不允许 § 单独出现在片尾）
    assert.notEqual(c[c.length - 1], '§', '颜色码不能断在 § 之后')
  }
  assert.equal(chunks.join(''), text)
})

test('chunkText: 空白处优先断开', () => {
  const text = `${'a'.repeat(200)} ${'b'.repeat(200)}`
  const chunks = chunkText(text, 250)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0], 'a'.repeat(200) + ' ') // 在空白后断开
  assert.equal(chunks[1], 'b'.repeat(200))
})

test('sendChat: 逐片发送且每片不超上限', async () => {
  const sent = []
  const bot = { chat: (m) => sent.push(m) }
  const long = '§c' + '中'.repeat(400) // 中文按字符计
  const n = await sendChat(bot, long, 250)
  assert.equal(n, sent.length)
  assert.ok(n >= 2)
  for (const m of sent) assert.ok(m.length <= 250)
  assert.equal(sent.join(''), '中'.repeat(400), '拼接后应等于剥色后的原文')
})

test('sendChat: 无 chat 方法的 bot 返回 0（容错）', async () => {
  assert.equal(await sendChat({}, 'x'), 0)
})

test('sendChat: 空/纯空白文本不发包（!say 无参或纯 §）', async () => {
  const sent = []
  const bot = { chat: (m) => sent.push(m) }
  assert.equal(await sendChat(bot, ''), 0)
  assert.equal(await sendChat(bot, '§a'), 0, '纯颜色码剥色后为空')
  assert.equal(await sendChat(bot, '   '), 0)
  assert.deepEqual(sent, [], '不得发送空包')
})

test('M7: 并发 sendChat 串行化——多源长消息分片不交错', async () => {
  const sent = []
  const bot = { chat: (m) => sent.push(m) }
  const a = 'A'.repeat(30)
  const b = 'B'.repeat(30)
  const p1 = sendChat(bot, a, 10) // 3 片
  const p2 = sendChat(bot, b, 10) // 3 片
  await Promise.all([p1, p2])
  assert.equal(sent.length, 6)
  assert.equal(sent.slice(0, 3).join(''), a, '第一条消息分片应连续（修复前跨消息交错混排）')
  assert.equal(sent.slice(3).join(''), b, '第二条消息分片应连续')
})

test('stripColorCodes: 剥离 § 颜色码（Paper 26.1.2 非法字符踢出修复）', () => {
  assert.equal(stripColorCodes('§a[status] ok'), '[status] ok')
  assert.equal(stripColorCodes('§c权限不足'), '权限不足')
  assert.equal(stripColorCodes('plain text'), 'plain text')
  assert.equal(stripColorCodes('尾部§'), '尾部')
  assert.equal(stripColorCodes('§a§l混合§r格式'), '混合格式')
})

test('sendChat: 发送时统一剥离颜色码', async () => {
  const sent = []
  const bot = { chat: (m) => sent.push(m) }
  await sendChat(bot, '§a[status] pos=1,2,3', 250)
  assert.deepEqual(sent, ['[status] pos=1,2,3'])
  assert.ok(!sent.join('').includes('§'), '发送内容不得含 §')
})

test('registry 速率限制：op 命令冷却期内静默丢弃', async () => {
  const { CommandRegistry } = await import('../src/commands/registry.js')
  const registry = new CommandRegistry({ child: () => ({ debug () {}, warn () {}, error () {} }) })
  const calls = []
  registry.register({
    name: 'secret',
    handler: async () => { calls.push(1) }
  })
  const ctx = { bot: { chat: () => {} }, cfg: { ops: ['op1'], chat: { commandCooldownMs: 10000 } } }
  await registry.dispatch('!secret', { sender: 'op1', ctx })
  await registry.dispatch('!secret', { sender: 'op1', ctx }) // 冷却期内
  assert.equal(calls.length, 1, '冷却期内第二次应被丢弃')
  // 冷却期过后（cooldown 归零）可再次执行——同一 registry 验证状态机
  ctx.cfg.chat.commandCooldownMs = 0
  await registry.dispatch('!secret', { sender: 'op1', ctx })
  assert.equal(calls.length, 2)
})

test('L3 修复：chunkText maxLength ≤ 0/非有限值防御（不再死循环）', () => {
  const long = 'x'.repeat(100)
  assert.deepEqual(chunkText(long, 0), [long], 'maxLength 0 不应死循环')
  assert.deepEqual(chunkText(long, -1), [long], '负值不应死循环')
  assert.deepEqual(chunkText(long, Infinity), [long], '非有限值不应死循环')
})
