import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReloadHandler } from '../src/core/reload.js'

// 热重载处理器行为测试（M10 抽取自 index.js——入口 import 即连接无法单测；
// 依赖注入后逐行为断言，替换此前"读源码断言行序"的脆弱守卫）。

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

/**
 * 组装假依赖。cfg 默认形状覆盖 reload 读到的全部键（log/l2/http）。
 * @param {{ loadConfig?: () => any, validateConfig?: (cfg: any) => any }} [overrides]
 */
function makeDeps (overrides = {}) {
  const baseCfg = {
    log: { level: 'info', rotate: false, pretty: false, dir: null },
    l2: { enabled: true, maxSteps: 15 },
    http: { enabled: false, port: 0 }
  }
  const ctx = {
    cfg: baseCfg,
    logger: makeLogger(),
    agent: null,
    tasks: null,
    notifier: null
  }
  const calls = { notifier: [], createL2: [], stop: 0, start: 0, taskReload: [], updateCfg: [] }
  const deps = {
    ctx,
    getLogger: () => ctx.logger,
    setLogger: (l) => { ctx.logger = l },
    conn: {
      log: ctx.logger,
      updateCfg: (cfg) => { calls.updateCfg.push(cfg) }
    },
    statusServer: {
      stop: async () => { calls.stop++ },
      start: () => { calls.start++ }
    },
    loadConfig: () => ({ ...baseCfg }),
    validateConfig: () => ({ ok: true, errors: [] }),
    createLogger: () => makeLogger(),
    createNotifier: (cfg) => { calls.notifier.push(cfg); return { cfg } },
    createL2: (cfg) => { calls.createL2.push(cfg); return { cfg } }
  }
  Object.assign(deps, overrides)
  return { deps, ctx, calls }
}

test('M10: loadConfig 抛错 → 返回 false 且 cfg 不变', async () => {
  const { deps, ctx } = makeDeps({ loadConfig: () => { throw new Error('read boom') } })
  const { reload } = createReloadHandler(deps)
  const before = ctx.cfg
  assert.equal(await reload(), false)
  assert.equal(ctx.cfg, before, '失败不得替换 cfg')
})

test('M10: validateConfig 失败 → 返回 false 且 cfg 不变', async () => {
  const { deps, ctx } = makeDeps({ validateConfig: () => ({ ok: false, errors: ['boom'] }) })
  const { reload } = createReloadHandler(deps)
  const before = ctx.cfg
  assert.equal(await reload(), false)
  assert.equal(ctx.cfg, before, '校验失败不得替换 cfg')
})

test('M10: L2 变化 → agent.stop + createL2 重建；无变化不重建', async () => {
  let stopCalls = 0
  const { deps, ctx, calls } = makeDeps({
    loadConfig: () => ({ ...ctx.cfg, l2: { enabled: true, maxSteps: 99 } })
  })
  ctx.agent = { stop: async () => { stopCalls++ } }
  const { reload } = createReloadHandler(deps)
  assert.equal(await reload(), true)
  assert.equal(calls.createL2.length, 1, 'l2 变化应重建 agent')
  assert.equal(stopCalls, 1, '旧 agent 应被 stop')
  // 二次 reload：l2 无变化 → 不重建不 stop
  await reload()
  assert.equal(calls.createL2.length, 1, '无变化不重建 agent')
  assert.equal(stopCalls, 1, '无变化不 stop agent')
})

test('M10: HTTP 变化 → statusServer stop+start；log dir 变化 → logger 重建', async () => {
  let setCalls = 0
  const { deps, ctx, calls } = makeDeps({
    loadConfig: () => ({ ...ctx.cfg, http: { enabled: true, port: 1234 }, log: { ...ctx.cfg.log, dir: '/new/dir' } })
  })
  deps.setLogger = (l) => { setCalls++; ctx.logger = l }
  const { reload } = createReloadHandler(deps)
  assert.equal(await reload(), true)
  assert.equal(calls.stop, 1, 'http 变化应 stop')
  assert.equal(calls.start, 1, 'http 变化应 start')
  assert.equal(setCalls, 1, 'log dir 变化应重建 logger（setLogger）')
  // 二次 reload：无变化 → 不重启不重建
  await reload()
  assert.equal(calls.stop, 1, '无变化不重启 http')
  assert.equal(setCalls, 1, '无变化不重建 logger')
})

test('M10: 仅 level 变化 → 不重建 transport（setLogger 不被调）', async () => {
  let setCalls = 0
  const { deps, ctx, calls } = makeDeps({
    loadConfig: () => ({ ...ctx.cfg, log: { ...ctx.cfg.log, level: 'debug' } })
  })
  deps.setLogger = (l) => { setCalls++; ctx.logger = l }
  const { reload } = createReloadHandler(deps)
  assert.equal(await reload(), true)
  assert.equal(setCalls, 0, '仅 level 变化不重建 transport（pino-roll 双 fd 坏 JSONL 防线）')
  assert.equal(calls.stop, 0, 'http 无变化不重启')
  assert.equal(ctx.cfg.log.level, 'debug', '新 cfg 已生效（ctx.cfg 赋值）')
})

test('M10: tasks.reload 收到新 cfg；conn.updateCfg 同步；notifier 重建', async () => {
  const { deps, ctx, calls } = makeDeps({
    loadConfig: () => ({ ...ctx.cfg, http: { enabled: true, port: 1 } })
  })
  const reloaded = []
  ctx.tasks = { reload: async (cfg) => { reloaded.push(cfg) } }
  const { reload } = createReloadHandler(deps)
  assert.equal(await reload(), true)
  assert.equal(reloaded.length, 1, 'tasks.reload 应收到新 cfg')
  assert.equal(reloaded[0].http.port, 1)
  assert.equal(calls.updateCfg.length, 1, 'conn.updateCfg 应同步新 cfg')
  assert.equal(ctx.notifier.cfg.http.port, 1, 'notifier 随 reload 重建')
})

test('M10: enabled=true 而 agent 为 null → 布尔变化判定触发重建（l2Changed 为 false 也重建）', async () => {
  const { deps, ctx, calls } = makeDeps({
    loadConfig: () => ({ ...ctx.cfg, l2: { enabled: true } })
  })
  ctx.agent = null
  const { reload } = createReloadHandler(deps)
  assert.equal(await reload(), true)
  assert.equal(calls.createL2.length, 1, 'enabled=true 但 agent 为 null 必须重建（仅 l2Changed 判定会漏建）')
})
