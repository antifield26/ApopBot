// HTTP 状态端点测试（U3）：/health、/metrics 形状、404、关闭不监听、热重载重启。
// 用 port 0 让系统分配端口（经返回的 port() 访问器读取），避免测试端口冲突。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createStatusServer } from '../src/core/http-status.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

function makeState (overrides = {}) {
  return {
    conn: { state: 'connected', reconnectCount: 2, attempt: 1, lastError: null, ...(overrides.conn ?? {}) },
    tasks: [
      { id: 'm1', type: 'mine', state: 'running', waitingReason: 'no-target', runCount: 1, counters: { mined: 3 } }
    ],
    sessionCount: 2,
    ...overrides
  }
}

function makeServer (state = makeState(), cfg = { http: { enabled: true, port: 0 } }) {
  const logger = makeLogger()
  const server = createStatusServer(() => cfg, logger, () => state)
  server.start()
  return server
}

/** listen 是异步的——轮询等端口就绪（系统分配端口 0 场景）。 */
async function waitForPort (server, timeout = 1500) {
  const t0 = Date.now()
  while (server.port() === null && Date.now() - t0 < timeout) {
    await new Promise(r => setTimeout(r, 10))
  }
  return server.port()
}

function fetchJson (port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) } catch { resolve({ status: res.statusCode, body: data }) }
      })
    }).on('error', reject)
  })
}

test('/health：200 且含 ok/process/connection 形状', async (t) => {
  const server = makeServer()
  t.after(() => server.stop())
  const port = await waitForPort(server)
  assert.ok(port, '端口 0 应由系统分配')
  const r = await fetchJson(port, '/health')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.connection.state, 'connected')
  assert.equal(r.body.connection.reconnectCount, 2)
  assert.ok(typeof r.body.process.rssMb === 'number')
})

test('/metrics：200 且含 tasks/l2 形状', async (t) => {
  const server = makeServer()
  t.after(() => server.stop())
  const port = await waitForPort(server)
  const r = await fetchJson(port, '/metrics')
  assert.equal(r.status, 200)
  assert.equal(r.body.tasks.length, 1)
  assert.equal(r.body.tasks[0].id, 'm1')
  assert.deepEqual(r.body.tasks[0].counters, { mined: 3 })
  assert.equal(r.body.l2.sessions, 2)
  assert.ok(Array.isArray(r.body.tasks))
})

test('v1.4.0: /metrics l2.roles——多角色状态透传（busy/会话数/planEnabled）', async (t) => {
  const server = makeServer(makeState({
    roleStats: [
      { name: 'primary', busy: false, sessions: 2, planEnabled: true },
      { name: 'planner', busy: true, sessions: 0, planEnabled: false }
    ]
  }))
  t.after(() => server.stop())
  const port = await waitForPort(server)
  const r = await fetchJson(port, '/metrics')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.l2.roles, [
    { name: 'primary', busy: false, sessions: 2, planEnabled: true },
    { name: 'planner', busy: true, sessions: 0, planEnabled: false }
  ])
})

test('/metrics：roleStats 缺省（单 agent/未启用）→ l2.roles null', async (t) => {
  const server = makeServer(makeState({ roleStats: null }))
  t.after(() => server.stop())
  const port = await waitForPort(server)
  const r = await fetchJson(port, '/metrics')
  assert.equal(r.body.l2.roles, null)
})

test('/metrics：含 memory/actions/notify（持久化面健康与动作计数观测）', async (t) => {
  const server = makeServer(makeState({
    memoryBytes: [
      { file: 'state.json', bytes: 133 },
      { file: 'sessions.json', bytes: 4221 }
    ],
    actionCounts: { observe_status: 3, dig: 1 },
    notifyStats: { sent: 5, failed: 0 }
  }))
  t.after(() => server.stop())
  const port = await waitForPort(server)
  const r = await fetchJson(port, '/metrics')
  assert.equal(r.status, 200)
  assert.equal(r.body.memory['state.json'], 133)
  assert.equal(r.body.actions.observe_status, 3)
  assert.equal(r.body.actions.dig, 1)
  assert.deepEqual(r.body.notify, { sent: 5, failed: 0 })
  // 缺省（旧 getState 快照）→ null 而非报错
  const server2 = makeServer()
  t.after(() => server2.stop())
  const port2 = await waitForPort(server2)
  const r3 = await fetchJson(port2, '/metrics')
  assert.equal(r3.body.memory, null)
  assert.equal(r3.body.actions, null)
  assert.equal(r3.body.notify, null)
})

test('U12: /metrics 含 bot 坐标/血量/饱食度与等待原因（运维判断"卡在哪"）', async (t) => {
  const state = makeState({
    bot: {
      entity: { position: { x: 10.6, y: 64.2, z: -5.4 } },
      health: 12,
      food: 7
    }
  })
  const server = makeServer(state)
  t.after(() => server.stop())
  const port = await waitForPort(server)
  const r = await fetchJson(port, '/metrics')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.bot.position, [11, 64, -5], '坐标应取整')
  assert.equal(r.body.bot.health, 12)
  assert.equal(r.body.bot.food, 7)
  assert.equal(r.body.tasks[0].waitingReason, 'no-target')
  // 无实体（断线期）→ position null
  const server2 = makeServer(makeState({ bot: null }))
  t.after(() => server2.stop())
  const port2 = await waitForPort(server2)
  const r2 = await fetchJson(port2, '/metrics')
  assert.equal(r2.body.bot.position, null, '断线期 position 应为 null 而非 500')
})

test('/health：断线状态 ok=false', async (t) => {
  const server = makeServer(makeState({ conn: { state: 'reconnecting', reconnectCount: 5, lastError: 'ECONNRESET' } }))
  t.after(() => server.stop())
  const port = await waitForPort(server)
  const r = await fetchJson(port, '/health')
  assert.equal(r.body.ok, false)
  assert.equal(r.body.connection.reconnectCount, 5)
  assert.equal(r.body.connection.lastError, 'ECONNRESET')
})

test('未知路径 → 404 + 端点列表', async (t) => {
  const server = makeServer()
  t.after(() => server.stop())
  const port = await waitForPort(server)
  const r = await fetchJson(port, '/nope')
  assert.equal(r.status, 404)
  assert.deepEqual(r.body.endpoints, ['/health', '/metrics'])
})

test('enabled=false 不监听（isRunning false）', () => {
  const server = makeServer(makeState(), { http: { enabled: false, port: 8123 } })
  assert.equal(server.isRunning(), false)
  server.stop() // 幂等
})

test('热重载：stop 后改配置再 start（新端口生效）', async (t) => {
  const cfg = { http: { enabled: true, port: 0 } }
  const server = makeServer(makeState(), cfg)
  t.after(() => server.stop())
  const port1 = await waitForPort(server)
  await server.stop()
  assert.equal(server.isRunning(), false)
  server.start() // 模拟 reload：同一 getCfg 闭包，端口仍是 0 → 新监听
  const port2 = await waitForPort(server)
  assert.ok(port2, '重启后应重新监听')
  assert.notEqual(port2, port1)
})

test('P1-15 修复：stop await close 完成——同端口立即重启不 EADDRINUSE', async (t) => {
  const cfg = { http: { enabled: true, port: 0 } }
  const server = makeServer(makeState(), cfg)
  t.after(() => server.stop())
  const port1 = await waitForPort(server)
  // 同端口立即重启（stop await close 完成再 start——此前 close 未完成 listen
  // 同端口 → EADDRINUSE → error 处理器置 server=null → 端点永久死亡）
  cfg.http.port = port1
  await server.stop()
  server.start()
  const r = await fetchJson(port1, '/health')
  assert.equal(r.status, 200, '同端口重启后端点应存活')
  assert.equal(server.isRunning(), true)
})
// C6/K 回归（httpChanged/logRebuild 判定必须在 ctx.cfg 赋值之前——否则两侧恒等
// 热重载死代码）：随 reload 抽取（M10）已由 tests/reload.test.mjs 行为测试覆盖
//（"HTTP 变化 → stop+start" / "log dir 变化 → setLogger"），源码顺序守卫删除。
