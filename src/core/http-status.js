// 只读 HTTP 状态端点（U3）：/health 与 /metrics，本机运维可观测（curl 即可）。
// 零新依赖（node:http），默认关闭（cfg.http.enabled=false）。
// 安全边界：只绑 127.0.0.1、只读、无写操作；暴露到局域网需自行加反向代理/防火墙。
// getCfg 是函数（热重载后取最新配置）；getState 每次请求时取最新状态快照。

import http from 'node:http'

export function createStatusServer (getCfg, logger, getState) {
  let server = null

  function start () {
    const cfg = getCfg()
    if (server || !cfg.http?.enabled) return
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      const url = req.url ?? '/'
      let status = 200
      let body
      try {
        if (url === '/health') {
          body = healthPayload(getState())
        } else if (url === '/metrics') {
          body = metricsPayload(getState())
        } else {
          status = 404
          body = { error: 'not found', endpoints: ['/health', '/metrics'] }
        }
      } catch (err) {
        status = 500
        body = { error: err.message }
        logger.error({ err: err.message }, 'http status handler error')
      }
      res.writeHead(status)
      res.end(JSON.stringify(body))
    })
    server.on('error', (err) => logger.warn({ err: err.message }, 'http status server error'))
    server.listen(cfg.http.port, '127.0.0.1')
    logger.info({ port: cfg.http.port }, 'http status server listening on 127.0.0.1')
  }

  function stop () {
    if (!server) return
    server.close()
    server = null
  }

  // 测试访问器
  return {
    start,
    stop,
    isRunning: () => server !== null,
    port: () => server?.address()?.port ?? null
  }
}

function healthPayload (s) {
  return {
    ok: s.conn?.state === 'connected',
    process: {
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
    connection: {
      state: s.conn?.state ?? 'unknown',
      reconnectCount: s.conn?.reconnectCount ?? 0,
      lastError: s.conn?.lastError ?? null
    }
  }
}

function metricsPayload (s) {
  const mem = process.memoryUsage()
  return {
    process: {
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024)
    },
    connection: {
      state: s.conn?.state ?? 'unknown',
      attempt: s.conn?.attempt ?? 0,
      reconnectCount: s.conn?.reconnectCount ?? 0,
      lastError: s.conn?.lastError ?? null
    },
    tasks: (s.tasks ?? []).map(t => ({
      id: t.id,
      type: t.type,
      state: t.state,
      waitingReason: t.waitingReason ?? null,
      runCount: t.runCount ?? 0,
      counters: t.counters ?? {}
    })),
    l2: {
      sessions: s.sessionCount ?? 0,
      lastLatencyMs: s.lastLlmLatencyMs ?? null, // U5 计量接入
      lastUsageTokens: s.lastLlmUsage ?? null
    }
  }
}
