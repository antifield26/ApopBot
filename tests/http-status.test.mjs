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
  server.stop()
  assert.equal(server.isRunning(), false)
  server.start() // 模拟 reload：同一 getCfg 闭包，端口仍是 0 → 新监听
  const port2 = await waitForPort(server)
  assert.ok(port2, '重启后应重新监听')
  assert.notEqual(port2, port1)
})
