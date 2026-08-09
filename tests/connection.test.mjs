import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ConnectionManager } from '../src/core/connection.js'

/**
 * 轮询等待条件成立（替换固定 setTimeout——CI 慢机器/Node 版本差异下固定等待
 * 时序漂移，windows-latest Node 26 实测失败：状态断言在 80ms 后仍是 connecting）。
 * @returns {Promise<boolean>} 超时返回 false（调用方断言给出实际值）
 */
async function pollUntil (fn, timeoutMs = 3000, intervalMs = 10) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return fn()
}

// 可注入的假 bot：EventEmitter + quit（quit 触发 end，模拟 mineflayer 语义）
class FakeBot extends EventEmitter {
  constructor () {
    super()
    this.quitCalls = 0
  }

  quit () {
    this.quitCalls++
    this.emit('end')
  }
}

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {}, fatal () {}, flush (cb) { cb?.() } }
}

function makeCfg (overrides = {}) {
  return {
    host: 'localhost',
    port: 25565,
    username: 'mcbot',
    mcVersion: '26.1.2',
    spawnTimeoutMs: 200, // 测试用短超时：避免 pending spawn timer 拖住测试进程
    reconnect: { baseMs: 50, maxMs: 500, factor: 2, jitter: 0, minGapMs: 0 },
    ...overrides
  }
}

/**
 * 构造 ConnectionManager：createBot 每次返回新的 FakeBot（模拟真实重连产生新实例），
 * 所有已创建的 bot 收集在 bots 数组中。
 */
function makeConn (opts = {}) {
  const { hooks = {}, cfg = makeCfg(), pluginResult = {}, pluginDelayMs = 0, pluginError = null } = opts
  const bots = []
  const conn = new ConnectionManager(cfg, makeLogger(), hooks, {
    createBot: () => {
      const b = new FakeBot()
      bots.push(b)
      return b
    },
    loadMineflayerPlugins: async () => {
      if (pluginDelayMs) await new Promise(r => setTimeout(r, pluginDelayMs))
      if (pluginError) throw pluginError
      return pluginResult
    }
  })
  return { conn, bots }
}

test('M1 修复：插件装载期间的事件不丢失（error → reconnecting）', async () => {
  const { conn, bots } = makeConn({ pluginDelayMs: 100 })
  const spawnSpy = { count: 0 }
  const states = []
  conn.hooks.onSpawn = (b) => { spawnSpy.count++; assert.equal(b, bots[0]) }
  conn.hooks.onStateChange = (s) => states.push(s)

  const connectPromise = conn.connect()
  // 插件仍在装载（未 resolve）时连接失败 —— 事件必须被已接线的监听捕获
  bots[0].emit('error', new Error('connect ECONNREFUSED 127.0.0.1:25565'))
  await connectPromise

  // 核心断言：error 被捕获并进入重连调度（reconnectCount 递增），
  // 而不是卡在 CONNECTING 永远无调度。_reconnectTimer 可能已被 50ms 退避消费掉。
  assert.ok(conn.reconnectCount >= 1, '应已计入一次重连（卡 CONNECTING 时不会递增）')
  assert.ok(states.includes('reconnecting'), `应经过 reconnecting，实际状态序列: ${states}`)
  assert.equal(spawnSpy.count, 0, '未 spawn 不应触发 onSpawn')
  await conn.disconnect()
})

test('代际守卫：陈旧 bot 的 spawn 超时不得 quit/调度重连（防双 bot 并发 → name_conflict fatal）', async () => {
  // 场景：connect#1（A）断线 → 重连 connect#2（B，换代）；A 的陈旧 spawn 超时随后触发，
  // 必须被代际守卫拦截——否则 A.quit() → 陈旧 end → 错误调度 connect#3 → 双 bot 并发
  const { conn, bots } = makeConn({
    cfg: makeCfg({
      spawnTimeoutMs: 500, // A 的超时在 B 建立（t≈50）之后才触发（t=500）
      reconnect: { baseMs: 50, maxMs: 200, factor: 2, jitter: 0, minGapMs: 0 }
    })
  })
  const p1 = conn.connect()
  bots[0].emit('error', new Error('ECONNRESET'))
  await p1
  assert.equal(conn.reconnectCount, 1)

  // t≈50ms：重连建立 connect#2（bot B，换代 seq=2）——轮询等待（CI 慢机器时序漂移）
  assert.ok(await pollUntil(() => bots.length >= 2), `应已建立第二个连接（实际 ${bots.length}）`)

  // 时序：A 的超时挂于 t≈0+500，B 的超时挂于 t≈50+500。
  // 等两者都已触发：A 的陈旧超时被代际守卫拦截（不得 quit A——否则陈旧 end
  // 会调度 connect#3 造成双 bot 并发）；B 的超时属当前代际正常 quit。
  assert.ok(await pollUntil(() => bots[1]?.quitCalls >= 1), 'B 的超时应触发 quit')
  try {
    assert.equal(bots[0].quitCalls, 0, '陈旧 spawn 超时不得 quit 旧 bot（拦截点：seq 1 ≠ 2）')
    assert.equal(bots[1].quitCalls, 1, '当前代际的 spawn 超时正常 quit')
    assert.ok(conn.reconnectCount >= 2, 'B 超时应计入重连')
  } finally {
    // 断言失败也必须清理：否则残留的 reconnect 循环（connect#3+ 每 500ms 超时重连）永不停歇
    await conn.disconnect()
  }
})

test('M1 修复：插件装载失败 → 非致命重连', async () => {
  const { conn } = makeConn({ pluginError: new Error('plugin boom') })
  await conn.connect()
  assert.equal(conn.state, 'reconnecting')
  assert.ok(conn.reconnectCount >= 1)
  await conn.disconnect()
})

test('onSpawn 每次 spawn 触发（B1 前提：重连产生新 bot 实例）', async () => {
  const spawnSpy = { count: 0 }
  const { conn, bots } = makeConn({ hooks: { onSpawn: () => spawnSpy.count++ } })
  await conn.connect()
  bots[0].emit('spawn')
  assert.equal(spawnSpy.count, 1, '首次 spawn 触发一次')
  assert.equal(conn.state, 'connected')

  // 模拟断线重连：end（无 reason → M2 语义非 fatal）→ 退避 → 新 connect（新 bot）
  bots[0].emit('end')
  assert.equal(conn.state, 'reconnecting')
  assert.ok(await pollUntil(() => bots.length >= 2), '退避后应创建第二个 bot 实例')
  bots[1].emit('spawn')
  assert.equal(spawnSpy.count, 2, '重连后的 spawn 再次触发 onSpawn（B1 前提）')
  assert.equal(conn.state, 'connected')
  await conn.disconnect()
})

test('M4 修复：connect() 重置陈旧 _timeoutQuit', async () => {
  const { conn } = makeConn()
  conn._timeoutQuit = true // 模拟上一次超时留下的陈旧标记
  await conn.connect()
  assert.equal(conn._timeoutQuit, false, '每次全新 connect 应重置')
  await conn.disconnect()
})

test('M5 修复：updateCfg 更新连接管理器配置', async () => {
  const { conn } = makeConn()
  conn.updateCfg(makeCfg({ host: '10.0.0.5', port: 25566 }))
  assert.equal(conn.cfg.host, '10.0.0.5')
  assert.equal(conn.cfg.port, 25566)
})

test('spawn 超时 → 主动 quit → end 走重连路径（非 fatal）', async () => {
  const { conn, bots } = makeConn({ cfg: makeCfg({ spawnTimeoutMs: 30 }) })
  await conn.connect()
  // 等待 spawn 超时触发 quit（轮询——固定 80ms 在 CI 慢机器上漂移）
  assert.ok(await pollUntil(() => bots[0].quitCalls >= 1), '超时应主动 quit')
  assert.ok(await pollUntil(() => conn.state === 'reconnecting'), `应进入 reconnecting（实际 ${conn.state}）`)
  await conn.disconnect()
})

test('断线分类：致命原因 → 不调度重连并 exit(2)', async () => {
  // fatal 路径会 process.exit(2)：测试中接管 exit 防止杀掉测试进程
  const exitCodes = []
  const origExit = process.exit
  process.exit = (code) => { exitCodes.push(code) }
  try {
    const { conn, bots } = makeConn()
    await conn.connect()
    bots[0].emit('kicked', 'Your username is already logged in!')
    assert.equal(conn.state, 'connecting') // fatal 路径不进入 reconnecting
    assert.equal(conn.reconnectCount, 1)
    // 等待 flush 窗口：必须真的 exit(2)（轮询）
    assert.ok(await pollUntil(() => exitCodes.length >= 1), 'fatal 应调用 process.exit(2)')
    assert.deepEqual(exitCodes, [2], 'fatal 应调用 process.exit(2)')
    await conn.disconnect()
  } finally {
    process.exit = origExit
  }
})

test('P0 修复：spawn 在插件装载期间已触发 → 超时兜底不得误杀（监听先于装载注册）', async () => {
  // 场景：插件装载慢（300ms），spawn 在装载期间已触发（本机/快速握手）。
  // 修复前 spawn 超时 Promise 在装载完成后才注册 bot.once('spawn')——事件已过，
  // 超时（300+150ms）后误杀正常 bot 并触发重连循环。
  const { conn, bots } = makeConn({ pluginDelayMs: 300, cfg: makeCfg({ spawnTimeoutMs: 150 }) })
  const spawnSpy = { count: 0 }
  conn.hooks.onSpawn = () => spawnSpy.count++
  const p = conn.connect()
  await new Promise(r => setTimeout(r, 50)) // 装载中
  bots[0].emit('spawn') // 装载期间正常 spawn
  await new Promise(r => setTimeout(r, 550)) // 覆盖装载完成（t≈300）+ 超时窗口（t≈450）
  assert.equal(bots[0].quitCalls, 0, 'spawn 已触发则超时兜底不得 quit 正常 bot')
  assert.equal(spawnSpy.count, 1)
  await p
  await conn.disconnect()
})

test('P1-8 修复：disconnect 清理残留 spawn 超时（不产生虚假二次 quit）', async () => {
  const { conn, bots } = makeConn({ cfg: makeCfg({ spawnTimeoutMs: 80 }) })
  await conn.connect()
  await conn.disconnect()
  assert.equal(conn.bot, null, 'disconnect 后 bot 应清空')
  assert.equal(conn._spawnPromise, null)
  assert.equal(bots[0].quitCalls, 1, 'disconnect 主动 quit 恰好一次')
  // 残留超时窗口（80ms）过去：代际已换代，不得再 quit 已断开的 bot
  await new Promise(r => setTimeout(r, 150))
  assert.equal(bots[0].quitCalls, 1, '残留 spawn 超时不得对已 quit 的 bot 二次 quit')
})

test('致命原因后 end 事件不触发重连（_fatalExit 守卫）', async () => {
  const exitCodes = []
  const origExit = process.exit
  process.exit = (code) => { exitCodes.push(code) }
  try {
    const { conn, bots } = makeConn()
    await conn.connect()
    bots[0].emit('kicked', 'You are not white-listed on this server')
    bots[0].emit('end') // kicked 后 mineflayer 会关闭连接 → end
    assert.ok(await pollUntil(() => exitCodes.length >= 1), 'fatal 应 exit(2)')
    assert.deepEqual(exitCodes, [2])
    assert.equal(conn.state, 'connecting', 'fatal 后不得进入 reconnecting')
    assert.ok(conn.attempt <= 1, 'fatal 后不得调度重连')
    await conn.disconnect()
  } finally {
    process.exit = origExit
  }
})
