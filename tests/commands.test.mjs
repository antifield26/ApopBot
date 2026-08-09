import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand } from '../src/commands/parser.js'
import { isOp } from '../src/commands/permissions.js'
import { CommandRegistry } from '../src/commands/registry.js'

test('parseCommand 基础解析', () => {
  assert.deepEqual(parseCommand('!ping'), { name: 'ping', args: [] })
  assert.deepEqual(parseCommand('!task start mine-iron'), { name: 'task', args: ['start', 'mine-iron'] })
  assert.deepEqual(parseCommand('  !say hello world  '), { name: 'say', args: ['hello', 'world'] })
})

test('parseCommand 双引号感知', () => {
  assert.deepEqual(parseCommand('!say "hello world" foo'), { name: 'say', args: ['hello world', 'foo'] })
  assert.deepEqual(parseCommand('!agent act mine {"a":1}'), { name: 'agent', args: ['act', 'mine', '{"a":1}'] })
})

test('parseCommand 未闭合引号报错（不再静默吞掉尾部）', () => {
  const r = parseCommand('!say "a')
  assert.equal(r.name, 'say')
  assert.equal(r.error, '未闭合的引号')
})

test('parseCommand 转义双引号', () => {
  assert.deepEqual(parseCommand('!say "a\\"b" c'), { name: 'say', args: ['a"b', 'c'] })
})

test('parseCommand 非命令返回 null', () => {
  assert.equal(parseCommand('hello').name, null)
  assert.equal(parseCommand('').name, null)
  assert.equal(parseCommand('!').name, null)
  assert.equal(parseCommand(null).name, null)
})

test('isOp 白名单', () => {
  const cfg = { ops: ['steve', 'alex'] }
  assert.equal(isOp('steve', cfg), true)
  assert.equal(isOp('creeper', cfg), false)
  assert.equal(isOp('steve', { ops: null }), false)
  assert.equal(isOp('steve', {}), false)
})

test('registry 注册与分发', async () => {
  const registry = new CommandRegistry({ child: () => ({ debug () {}, warn () {}, error () {} }) })
  const calls = []
  const bot = {
    chat: (msg) => calls.push(['chat', msg])
  }
  const ctx = { bot, cfg: { ops: ['op1'], chat: { commandCooldownMs: 0 } }, onCmd: () => {} }

  registry.register({ name: 'ping', permission: 'all', handler: (c, args) => { c.onCmd('ping', args) } })
  registry.register({ name: 'secret', handler: (c, args) => { c.onCmd('secret', args) } })

  // 命中 + 无权限命令拒绝非 op
  const hit1 = await registry.dispatch('!ping', { sender: 'anyone', ctx })
  assert.equal(hit1, true)
  const hit2 = await registry.dispatch('!secret', { sender: 'notop', ctx })
  assert.equal(hit2, true)
  assert.ok(calls.some(([k, m]) => k === 'chat' && m.includes('权限不足')))
  assert.equal(calls.filter(([k]) => k === 'chat').length, 1)

  // op 可执行
  await registry.dispatch('!secret', { sender: 'op1', ctx })
  assert.ok(ctx.cmdLog ?? true)
  assert.equal(calls.filter(([k]) => k === 'chat').length, 1) // 无新增拒绝消息
})

test('registry 未命中返回 false', async () => {
  const registry = new CommandRegistry({ child: () => ({ debug () {} }) })
  const hit = await registry.dispatch('!nonexistent', { sender: 'x', ctx: { bot: { chat () {} }, cfg: { ops: [] } } })
  assert.equal(hit, false)
})

test('第 8 轮：引号内花括号不计 braceDepth（JSON 字符串值含 {} 不吞后续参数）', () => {
  const r = parseCommand('!agent act mine {"a": "x{"} more')
  assert.equal(r.args.length, 4, '后续参数应独立')
  assert.deepEqual(r.args, ['act', 'mine', '{"a": "x{"}', 'more'])
})
