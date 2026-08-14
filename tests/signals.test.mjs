// 信号处理测试：SIGHUP 触发 onReload、优雅退出全流程（tasks→agent→conn→flush→exit）。
// 零覆盖模块补齐（此前 signals.js 无任何测试）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupSignals } from '../src/core/signals.ts'

function makeLogger (opts = {}) {
  return {
    child: () => makeLogger(opts),
    info () {},
    warn () {},
    error () {},
    debug () {},
    // 默认 flush 须调用回调（signals 里 `new Promise(resolve => log.flush(resolve))`）
    flush: opts.flush ?? ((cb) => cb?.())
  }
}

async function settle (n = 3) {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r))
}

test('SIGHUP 触发 onReload（重载队列）', async () => {
  let reloaded = false
  setupSignals({
    logger: makeLogger(),
    conn: {},
    ctx: { logger: makeLogger() },
    onReload: async () => { reloaded = true }
  })
  process.emit('SIGHUP')
  await settle()
  assert.equal(reloaded, true)
})

test('P1-5 修复：SIGHUP 日志走 ctx.logger（热重载后新实例，而非初始 logger）', async () => {
  const calls = []
  const oldLogger = makeLogger()
  const ctxLogger = makeLogger()
  ctxLogger.info = () => { calls.push('ctx-logger') }
  oldLogger.info = () => { calls.push('old-logger') }
  setupSignals({ logger: oldLogger, conn: {}, ctx: { logger: ctxLogger }, onReload: async () => {} })
  process.emit('SIGHUP')
  await settle()
  assert.deepEqual(calls, ['ctx-logger'], 'SIGHUP 日志应写当前 logger 实例（修复前写旧 transport）')
})

test('C5 修复：SIGBREAK 触发优雅退出（Windows Ctrl+Break → 同一优雅路径）', async () => {
  const order = []
  const ctx = {
    logger: makeLogger(),
    tasks: { stopAll: async () => { order.push('tasks') } },
    agent: null
  }
  const exits = []
  const origExit = process.exit
  process.exit = (code) => { exits.push(code) }
  try {
    // 前面的测试各自 setupSignals 也注册了 SIGBREAK handler（process 全局共享）——
    // emit 会触发全部 → 多个 gracefulShutdown 并发 → exit 多次。只保留本次注册的
    // handler（测试文件串行执行，前面的测试已结束，摘除无副作用）
    process.removeAllListeners('SIGBREAK')
    setupSignals({ logger: makeLogger(), conn: {}, ctx, onReload: async () => {} })
    process.emit('SIGBREAK') // 任意平台可 emit（不依赖真实信号）
    // 等待异步关闭链完成（withTimeout 走 timer 相位，setImmediate settle 覆盖不了）
    const deadline = Date.now() + 2000
    while (exits.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  } finally {
    process.exit = origExit
  }
  assert.deepEqual(order, ['tasks'], 'SIGBREAK 应触发优雅关闭（修复前无 handler 默认终止）')
  assert.deepEqual(exits, [0], '应正常 exit(0)')
})

test('gracefulShutdown: 完整顺序 tasks → agent → conn → flush → exit(0)', async () => {
  const order = []
  const flushed = []
  const logger = makeLogger({ flush: (cb) => { order.push('flush'); flushed.push(1); cb?.() } })
  // ctx.logger 必须指向同一 logger——signals 运行时取 ctx.logger（热重载后是新实例）
  const ctx = {
    logger,
    tasks: { stopAll: async () => { order.push('tasks') } },
    agent: { stop: async () => { order.push('agent') } }
  }
  const conn = { disconnect: async () => { order.push('conn') } }
  const exits = []
  const origExit = process.exit
  process.exit = (code) => { exits.push(code) }
  try {
    const { gracefulShutdown } = setupSignals({ logger, conn, ctx, onReload: async () => {} })
    await gracefulShutdown('SIGINT')
  } finally {
    process.exit = origExit
  }
  assert.deepEqual(order, ['tasks', 'agent', 'conn', 'flush'], '关闭顺序应为 tasks→agent→conn→flush')
  assert.deepEqual(exits, [0], '正常完成应 exit(0)')
  assert.equal(flushed.length, 1)
})

test('gracefulShutdown: 幂等（shuttingDown 防重入）', async () => {
  let calls = 0
  const ctx = {
    logger: makeLogger(),
    tasks: { stopAll: async () => { calls++ } },
    agent: null
  }
  const exits = []
  const origExit = process.exit
  process.exit = (code) => { exits.push(code) }
  try {
    const { gracefulShutdown } = setupSignals({ logger: makeLogger(), conn: {}, ctx, onReload: async () => {} })
    await gracefulShutdown('SIGINT')
    await gracefulShutdown('SIGTERM') // 第二次调用应直接忽略
  } finally {
    process.exit = origExit
  }
  assert.equal(calls, 1, '重复信号不应重复执行关闭流程')
  assert.deepEqual(exits, [0])
})

test('gracefulShutdown: 关闭流程抛错/超时 → exit(1)', async () => {
  const ctx = { logger: makeLogger(), tasks: { stopAll: async () => { throw new Error('boom') } }, agent: null }
  const exits = []
  const origExit = process.exit
  process.exit = (code) => { exits.push(code) }
  try {
    const { gracefulShutdown } = setupSignals({ logger: makeLogger(), conn: {}, ctx, onReload: async () => {} })
    await gracefulShutdown('SIGINT')
  } finally {
    process.exit = origExit
  }
  assert.deepEqual(exits, [1], '关闭失败应 exit(1)')
})
