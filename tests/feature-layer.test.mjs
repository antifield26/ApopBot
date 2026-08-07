import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { loadConfig } from '../src/core/config.js'
import { createFeatureLayerManager } from '../src/core/feature-layer.js'

// 假 bot：EventEmitter + chat 收集
class FakeBot extends EventEmitter {
  constructor () {
    super()
    this.messages = []
  }

  chat (msg) { this.messages.push(msg) }
}

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {}, fatal () {}, flush (cb) { cb?.() } }
}

function makeCtx () {
  const cfg = loadConfig({ argv: [], env: {} }) // tasks: [] → load 空转，无需真 bot API
  return { cfg, logger: makeLogger(), bot: null, tasks: null, conn: null, agent: null, commands: null, chatHandler: null }
}

test('B1 修复：每次 spawn 全量重建功能层并挂新 bot 的 chat 监听', async () => {
  const ctx = makeCtx()
  const layer = createFeatureLayerManager(ctx, ctx.logger)

  const bot1 = new FakeBot()
  const bot2 = new FakeBot()
  await layer.rebuild(bot1)
  assert.equal(ctx.bot, bot1)
  assert.ok(ctx.tasks, 'tasks 应已初始化')
  assert.ok(ctx.commands, 'commands 应已初始化')
  assert.equal(bot1.listenerCount('chat'), 1, 'chat 监听应挂在 bot1 上')

  const tasks1 = ctx.tasks
  await layer.rebuild(bot2)
  assert.equal(ctx.bot, bot2, 'ctx.bot 应指向新 bot')
  assert.notEqual(ctx.tasks, tasks1, 'tasks 应为新实例（旧实例已 stopAll 拆除）')
  assert.equal(bot2.listenerCount('chat'), 1, 'chat 监听应挂在 bot2 上')
  assert.equal(ctx.tasks.getStatus().length, 0, '重建后无残留任务')

  await layer.teardown()
})

test('B1 修复：重建后新 bot 上命令可分发（真实 commands 注册表）', async () => {
  const ctx = makeCtx()
  const layer = createFeatureLayerManager(ctx, ctx.logger)

  const bot = new FakeBot()
  await layer.rebuild(bot)

  // 非命令消息不触发分发（不崩溃即可）
  bot.emit('chat', 'steve', 'hello world')

  // !ping 是内置命令（permission all）：必须在新 bot 上命中并回复
  const hit = await ctx.commands.dispatch('!ping', { sender: 'steve', ctx })
  assert.equal(hit, true)
  assert.ok(bot.messages.some(m => m.startsWith('pong')), `应回复 pong，实际: ${bot.messages}`)
  await layer.teardown()
})

test('B1 修复：chatHandler 读取实时 ctx（bot 重建后仍工作）', async () => {
  const ctx = makeCtx()
  const layer = createFeatureLayerManager(ctx, ctx.logger)

  const bot1 = new FakeBot()
  const bot2 = new FakeBot()
  await layer.rebuild(bot1)
  const handler1 = ctx.chatHandler
  await layer.rebuild(bot2)
  assert.notEqual(ctx.chatHandler, handler1, '每次重建生成新 handler 引用（旧监听随旧 bot 消亡）')

  // 触发 bot2 的 chat 监听 → 命令分发到新 bot（!ping 只依赖 bot.chat）
  bot2.emit('chat', 'alex', '!ping')
  await new Promise(r => setTimeout(r, 10))
  assert.ok(bot2.messages.some(m => m.startsWith('pong')), `新 bot 应响应命令，实际: ${bot2.messages}`)
  await layer.teardown()
})

test('chatHandler：未知命令明确反馈（含可用命令列表，不再静默）', async () => {
  const ctx = makeCtx()
  const layer = createFeatureLayerManager(ctx, ctx.logger)
  const bot = new FakeBot()
  await layer.rebuild(bot)
  bot.emit('chat', 'steve', '!fly-away')
  await new Promise(r => setTimeout(r, 10))
  assert.ok(bot.messages.some(m => m.includes('未知命令')), `应反馈未知命令: ${bot.messages}`)
  assert.ok(bot.messages.some(m => m.includes('!ping')), `应列出可用命令: ${bot.messages}`)
  await layer.teardown()
})

test('C1 修复：未知命令反馈走 sendChat（含 § 前缀但发送层剥离——Paper 踢出防护）', async () => {
  const ctx = makeCtx()
  const layer = createFeatureLayerManager(ctx, ctx.logger)
  const bot = new FakeBot()
  await layer.rebuild(bot)
  bot.emit('chat', 'steve', '!fly-away')
  await new Promise(r => setTimeout(r, 10))
  const msg = bot.messages.find(m => m.includes('未知命令'))
  assert.ok(msg, `应反馈未知命令: ${bot.messages}`)
  assert.ok(!msg.includes('§'), `发送内容不得含 §: ${msg}`)
  await layer.teardown()
})

test('U6 修复：死亡 → LLM 播报；重生 → 恢复死亡时暂停的任务', async () => {
  const ctx = makeCtx()
  const layer = createFeatureLayerManager(ctx, ctx.logger)
  const bot = new FakeBot()
  await layer.rebuild(bot)
  let pauseIds = []
  ctx.tasks.pauseAll = async () => { pauseIds = ['a', 'b']; return ['a', 'b'] }
  ctx.plugins = { follow: { stop: () => {} } }
  ctx.agent = { summarize: async () => '被僵尸击杀' }
  bot.entity = { position: { x: 1, y: 2, z: 3 } }
  bot.respawn = () => { bot.respawnCalls = (bot.respawnCalls ?? 0) + 1 }
  bot.emit('death')
  await new Promise(r => setTimeout(r, 20)) // pauseAll + summarize 链完成
  assert.equal(bot.respawnCalls, 1, '应请求重生')
  assert.ok(bot.messages.some(m => m.includes('被僵尸击杀')), `LLM 播报应发送: ${bot.messages}`)
  const resumed = []
  ctx.tasks.resumeTask = async (id) => { resumed.push(id) }
  bot.emit('respawn')
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(resumed, ['a', 'b'], '重生后应恢复本次死亡暂停的任务')
  assert.ok(bot.messages.some(m => m.includes('已重生')), `重生应播报: ${bot.messages}`)
  await layer.teardown()
})

test('U6 修复：LLM 播报失败 → 回退模板（不阻塞重生）', async () => {
  const ctx = makeCtx()
  const layer = createFeatureLayerManager(ctx, ctx.logger)
  const bot = new FakeBot()
  await layer.rebuild(bot)
  ctx.tasks.pauseAll = async () => []
  ctx.agent = { summarize: async () => null } // 播报失败
  bot.respawn = () => {}
  bot.emit('death')
  await new Promise(r => setTimeout(r, 20))
  assert.ok(bot.messages.some(m => m.includes('已死亡')), `模板播报仍应发送: ${bot.messages}`)
  await layer.teardown()
})

test('C6/N 修复：重建时回灌快照计数器（U1 承诺兑现——此前只写不读）', async () => {
  const ctx = makeCtx()
  ctx.stateStore = {
    tasks: [{ id: 'restored-1', type: 'mine', options: { blockTypes: ['iron_ore'] } }],
    counters: { 'restored-1': { mined: 7 } }
  }
  const layer = createFeatureLayerManager(ctx, ctx.logger)
  const bot = new FakeBot()
  await layer.rebuild(bot)
  const st = ctx.tasks.getStatus().find(t => t.id === 'restored-1')
  assert.ok(st, 'ad-hoc 任务应恢复')
  assert.equal(st.counters.mined, 7, '计数器应回灌（此前每次重启归零）')
  await layer.teardown()
})

test('C2 修复：死亡 → 暂停全部任务 + 停止跟随 + 自动重生', async () => {
  const ctx = makeCtx()
  const layer = createFeatureLayerManager(ctx, ctx.logger)
  const bot = new FakeBot()
  await layer.rebuild(bot)
  let pauseAllCalls = 0
  ctx.tasks.pauseAll = async () => { pauseAllCalls++; return ['a', 'b'] }
  let followStops = 0
  ctx.plugins = { follow: { stop: () => { followStops++ } } }
  bot.respawn = () => { bot.respawnCalls = (bot.respawnCalls ?? 0) + 1 }
  bot.emit('death')
  await new Promise(r => setTimeout(r, 10)) // pauseAll promise 链完成
  assert.equal(pauseAllCalls, 1, '应调用 pauseAll')
  assert.equal(followStops, 1, '应停止跟随')
  assert.equal(bot.respawnCalls, 1, '应请求自动重生')
  assert.ok(bot.messages.some(m => m.includes('已死亡')), `应聊天通知: ${bot.messages}`)
  await layer.teardown()
})

test('C1 修复：重连广播走 sendChat（§ 前缀在发送层剥离）', async () => {
  const ctx = makeCtx()
  ctx.conn = { getStatus: () => ({ state: 'connected', reconnectCount: 2 }) }
  const layer = createFeatureLayerManager(ctx, ctx.logger)
  const bot = new FakeBot()
  await layer.rebuild(bot)
  const msg = bot.messages.find(m => m.includes('已重新连接'))
  assert.ok(msg, `重连应广播: ${bot.messages}`)
  assert.ok(!msg.includes('§'), `发送内容不得含 §: ${msg}`)
  await layer.teardown()
})

test('queue 串行化：重叠操作按序执行', async () => {
  const ctx = makeCtx()
  const layer = createFeatureLayerManager(ctx, ctx.logger)
  const order = []
  const p1 = layer.queue(async () => { await new Promise(r => setTimeout(r, 20)); order.push('a') })
  const p2 = layer.queue(async () => { order.push('b') })
  await Promise.all([p1, p2])
  assert.deepEqual(order, ['a', 'b'], '队列应保证顺序')
  await layer.teardown()
})

test('teardown 幂等（重复调用不抛）', async () => {
  const ctx = makeCtx()
  const layer = createFeatureLayerManager(ctx, ctx.logger)
  await layer.rebuild(new FakeBot())
  await layer.teardown()
  await layer.teardown()
  assert.equal(ctx.tasks, null)
  assert.equal(ctx.commands, null)
})
