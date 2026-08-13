// @ts-check
// 只读 HTTP 状态端点：/health 与 /metrics，本机运维可观测（curl 即可）。
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
    server.on('error', (err) => {
      logger.warn({ err: err.message }, 'http status server error')
      // EADDRINUSE 等监听失败后必须置 null——server 非 null 使后续
      // start() 短路，/health /metrics 在本进程生命周期内永久死亡（热重载重试
      // 也无用；error 事件在 node http server 上主要来自 listen 失败——请求
      // 处理错误已由 handler try/catch 承接）
      server = null
    })
    server.listen(cfg.http.port, '127.0.0.1')
    logger.info({ port: cfg.http.port }, 'http status server listening on 127.0.0.1')
  }

  async function stop () {
    if (!server) return
    const s = server
    server = null
    // await close 完成再返回：热重载 stop→start 同端口时，close 未完成 listen
    // 会 EADDRINUSE → error 处理器置 server=null → 端点永久死亡（C6/K 同源）
    await new Promise((/** @type {(v?: unknown) => void} */ resolve) => {
      s.close(() => resolve())
      s.closeAllConnections?.() // keep-alive 连接不阻塞 close（本地短请求，罕见但防挂）
    })
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
  const e = s.bot?.entity?.position
  const disc = s.discoveryStats ?? null
  return {
    process: {
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024)
    },
    bot: {
      // bot 当前坐标/血量/饱食度——配合 tasks.waitingReason 判断"卡在哪"
      //（如坐标不动 + waitingReason=no-target = 无怪；inventory-full = 背包满）
      position: e ? [Math.round(e.x), Math.round(e.y), Math.round(e.z)] : null,
      health: s.bot?.health ?? null, // update_health 包通道（26.1 实体元数据不解析 health）
      food: s.bot?.food ?? null
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
      // 多角色（v1.4.0）：各角色 busy/会话数/planEnabled
      roles: Array.isArray(s.roleStats) ? s.roleStats.map(r => ({
        name: r.name,
        busy: r.busy,
        sessions: r.sessions,
        planEnabled: r.planEnabled
      })) : null,
      lastLatencyMs: s.lastLlmLatencyMs ?? null,
      lastUsageTokens: s.lastLlmUsage ?? null
    },
    // 探索记忆统计（anchors/资源记录/覆盖范围）
    discovery: disc ? {
      anchors: disc.anchors ?? 0,
      resources: disc.resources ?? 0,
      covered: disc.covered ?? '无'
    } : null,
    // 记忆文件字节数（data/ 三件套——持久化面健康/膨胀）
    memory: Array.isArray(s.memoryBytes) ? Object.fromEntries(s.memoryBytes.map(m => [m.file, m.bytes])) : null,
    // 动作原语调用计数（LLM/脚本/命令三源合计）
    actions: s.actionCounts ?? null,
    // webhook 推送计数（发送成功/失败）
    notify: s.notifyStats ?? null
  }
}
