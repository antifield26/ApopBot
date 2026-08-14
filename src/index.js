// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, validateConfig, assertLogDirWritable } from './core/config.js'
import { createLogger } from './core/logger.js'
import { ConnectionManager } from './core/connection.js'
import { createFeatureLayerManager } from './core/feature-layer.js'
import { createReloadHandler } from './core/reload.js'
import { createL2 } from './l2/index.js'
import { setupSignals } from './core/signals.js'
import { createStatusServer } from './core/http-status.js'
import { createStateStore } from './core/state.js'
import { createNotifier } from './core/notify.js'
import { registerChatLogger } from './core/chat.js'
import * as discovery from './core/discovery.js'
import { withTimeout } from './util/promise-timeout.js'

// 入口：参数 → 配置 → logger → ConnectionManager → 功能层（tasks/命令/L2）→ 信号处理
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let cfg = loadConfig()
const { ok, errors } = validateConfig(cfg)
if (!ok) {
  console.error('配置校验失败:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
try {
  assertLogDirWritable(cfg)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

let logger = createLogger(cfg)
// 聊天发送日志注册（spam kick/消息丢失排查——sendChat 内记发送方/摘要/分片数）。
// 闭包运行时取 ctx.logger：热重载 logRebuild 会替换 logger 变量——注册期捕获的
// 初始 logger 会把聊天日志永久写旧 transport/旧文件（chat.js 模块级单次注册）
registerChatLogger((msg) => ctx.logger.child({ module: 'chat' }).info(msg))

// 进程级错误兜底：未捕获 rejection/异常不得静默崩溃走 NSSM 无限重启循环——
// 与连接层 fatal 语义一致 exit(2) 停止等人工（flush 带 1s 兜底防卡死）
async function fatalExit (err, label) {
  logger.fatal({ err: err?.message ?? String(err) }, `${label} —— 按 fatal 停止等人工`)
  let exited = false
  // 硬杀兜底（同 connection.js fatal 路径——Windows exit(2) 偶发不生效，
  // 残留进程保持连接导致后续重启 duplicate_login）
  const exitNow = () => {
    if (exited) return
    exited = true
    process.exit(2)
    // 硬杀兜底（同 connection.js fatal 路径——Windows exit(2) 偶发不生效，
    // 残留进程保持连接导致后续重启 duplicate_login）。unref：测试进程不被拖住
    const t = setTimeout(() => process.kill(process.pid), 1000)
    t.unref()
  }
  // fatal 停服推送（无人值守时唯一感知通道；ctx.notifier 随 reload 更新）：
  // 先 await 通知（≤3s）再退出——fire-and-forget 后立即 exit(2) 会让 fetch
  // 来不及完成，通知静默丢失
  try {
    await withTimeout(Promise.resolve(ctx.notifier?.send('fatal', `Bot 停止等人工（${label}）`, err?.message ?? String(err))), 3000, 'notify timeout')
  } catch { /* 通知失败不阻塞退出（尽力而为） */ }
  try { logger.flush(exitNow) } catch { exitNow() }
  setTimeout(exitNow, 1000)
}
process.on('unhandledRejection', (err) => fatalExit(err, 'unhandledRejection'))
process.on('uncaughtException', (err) => fatalExit(err, 'uncaughtException'))
// pino transport worker 错误（轮转失败/磁盘满）：记录并降级 stdout，不崩进程
// pino Logger 类型只声明 level-change 事件——error 事件是 transport 层的扩展
const loggerAny = /** @type {any} */ (logger)
loggerAny.on('error', (err) => {
  console.error(`[logger-error] ${err?.message ?? String(err)}`)
})

// 可变运行上下文（!reload / SIGHUP / 配置变化会更新 cfg）
const ctx = {
  cfg,
  logger,
  bot: null,
  plugins: null,
  tasks: null,
  conn: null,
  agent: null,
  commands: null,
  stateStore: null, // ad-hoc 任务/计数器快照（feature-layer 重建时传 TaskManager）
  onReload: null, // !reload 命令走同一 reload 队列（与 SIGHUP/配置监视一致）
  notifier: createNotifier(cfg, logger) // webhook 通知（fatalExit 使用；reload 更新）
}

// 功能层每次 spawn 全量重建（重连后任务/命令/chat 监听必须绑定新 bot）
const layer = createFeatureLayerManager(ctx, logger)

const conn = new ConnectionManager(cfg, logger, {
  onSpawn: (bot) => {
    // 插件通常在 spawn 事件前已装载完成，同步到 ctx 供 !follow/技能使用。
    // 本机/快速握手时 spawn 可先于装载（conn.plugins 为空/旧代）——由
    // onPluginsReady 在装载完成后补发最新句柄（消费点全部运行时读 ctx.plugins）
    ctx.plugins = conn.plugins ?? null
    layer.rebuild(bot)
  },
  onPluginsReady: (plugins) => {
    // spawn 先于插件装载完成时补发最新句柄——陈旧句柄绑定已断开的 client，
    // !follow 在其上 setControlState 会抛错（uncaughtException → fatalExit 停服）
    ctx.plugins = plugins
    // 插件装载晚于 spawn：init 校验插件的配置任务（mine/farm/chop）失败后在此
    // 重试——queue 保证排在 rebuild 之后（rebuild 是队列异步，直接调会与其竞争）
    layer.queue(() => ctx.tasks?.retryPluginFailed?.()).catch(() => {})
  },
  onStateChange: (state) => {
    logger.info({ state }, 'connection state changed')
    // 断线期（最长退避 5 分钟）任务/agent 不得继续在死 bot 上空转失败重试——
    // 拆除功能层（teardown 幂等 + 与 rebuild 串行）；重连成功后 onSpawn → rebuild 重建
    if (state !== 'connected') {
      // queue 原样返回 run 的 rejection——此处不接 catch 则 teardown 抛错 =
      // unhandledRejection → fatalExit 停服（teardown 内部虽全防御，纵深防线）
      layer.queue(() => layer.teardown()).catch(err => logger.warn({ err: err.message }, 'teardown 失败'))
    }
  },
  // fatal 断线通知（无人值守唯一感知通道）：classified = 断线分类结果——
  // 此前致命断线路径无任何 notifier 调用，README 承诺的 fatal 推送不成立
  onFatal: (classified) => ctx.notifier?.send('fatal', '致命断线，退出等待人工介入', classified?.detail ?? '')
})
ctx.conn = conn

// 运行状态快照：data/state.json，5s 防抖写；优雅退出时 flush
ctx.stateStore = createStateStore({ logger })
// 探索记忆接入持久化通道（recordResource/recordAnchor 修改后 5s 防抖落盘）
discovery.attachStore(ctx.stateStore)

// 当前生效的配置文件路径（--config 参数，否则 config/config.json 存在时用生产路径，
// 最后退回 default.json），用于热监视——与 loadConfig 的回退顺序一致
function activeConfigPath () {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--config')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  const prodFile = path.join(ROOT, 'config', 'config.json')
  if (fs.existsSync(prodFile)) return prodFile
  return path.join(ROOT, 'config', 'default.json')
}

// 配置文件热监视（fs.watch 防抖 500ms；rename 事件重挂 watcher）
function watchConfig () {
  const file = activeConfigPath()
  let timer = null
  let watcher
  const arm = () => {
    try {
      watcher = fs.watch(file, () => {
        clearTimeout(timer)
        // queue 会把 reload 运行时异常上抛——监视路径 fire-and-forget，须吞掉
        //（错误已由 queue 日志留痕；!reload/SIGHUP 路径各自处理反馈）
        timer = setTimeout(() => { reloadQueued().catch(() => {}) }, 500)
      })
      watcher.on('error', () => { /* 文件被替换时 watcher 会失效，由 rename 分支重挂 */ })
    } catch {
      /* 文件不存在等场景：SIGHUP/!reload 仍可用 */
    }
  }
  arm()
  // fs.watch 对"替换保存"（rename 事件）的常规处理：文件被 rename 后 watcher 失效，需重挂
  const guard = setInterval(() => {
    if (watcher && !fs.existsSync(file)) { watcher.close(); watcher = null }
    if (!watcher && fs.existsSync(file)) arm()
  }, 3000).unref?.()
  return () => { clearTimeout(timer); clearInterval(guard); watcher?.close() }
}
const stopWatch = watchConfig()

// 只读 HTTP 状态端点：/health + /metrics，默认关闭（cfg.http.enabled=true 才监听）
const statusServer = createStatusServer(() => ctx.cfg, logger, () => ({
  conn: ctx.conn,
  bot: ctx.bot, // /metrics 坐标/血量/饱食度（运维看"卡在哪"）
  rebuildFails: ctx._rebuildFails ?? 0, // 功能层重建失败计数（重建失败后 ctx.bot 置空——观测通道）
  discoveryStats: discovery.stats(), // 探索记忆统计
  tasks: ctx.tasks?.getStatus() ?? [],
  sessionCount: ctx.agent?.sessionCount?.() ?? 0,
  // 多角色状态（v1.4.0：各角色 busy/会话数/planEnabled——运维看哪个角色在跑）
  roleStats: ctx.agent?.roleStats?.() ?? null,
  lastLlmLatencyMs: ctx.agent?.usage?.latencyMs ?? null,
  lastLlmUsage: ctx.agent?.usage ? {
    inputTokens: ctx.agent.usage.inputTokens,
    outputTokens: ctx.agent.usage.outputTokens
  } : null,
  // 记忆文件字节数（data/ 四件套——观测持久化面健康/膨胀）
  memoryBytes: ['state.json', 'sessions.json', 'experience.json', 'skills.json'].map(f => {
    const p = path.join(ROOT, 'data', f)
    try { return { file: f, bytes: fs.statSync(p).size } } catch { return { file: f, bytes: 0 } }
  }),
  // 动作原语调用计数（LLM/脚本/命令三源合计——executor 实例经 agent 可达）
  actionCounts: ctx.agent?.executor?.actionStats?.() ?? null,
  notifyStats: ctx.notifier?.stats?.() ?? null
}))
statusServer.start()

/**
 * 重载配置并热更新（实现见 src/core/reload.js——入口 import 即连接无法单测，
 * 抽取后依赖注入可行为测试）：校验 → 更新 ctx.cfg/conn.cfg → 日志配置变化重建
 * logger → L2 变化重建 agent → HTTP 变化重启监听 → 任务 diff 重载。
 * SIGHUP / 配置变化 / !reload 均走此路径（经 layer.queue 串行化）。
 * 定义位置在 statusServer 创建之后（reload 依赖其 stop/start）。
 */
const reload = createReloadHandler({
  ctx,
  getLogger: () => logger,
  setLogger: (l) => { logger = l },
  conn,
  statusServer,
  loadConfig,
  validateConfig,
  createLogger,
  createNotifier,
  createL2
}).reload
const reloadQueued = () => layer.queue(reload)
ctx.onReload = reloadQueued

setupSignals({
  logger,
  conn,
  ctx,
  onReload: reloadQueued
})

conn.connect().catch((err) => {
  logger.fatal({ err: err.message }, 'initial connect failed')
  process.exit(1)
})

// 供 signals.js 与测试引用的生命周期句柄（避免顶层作用域被 GC）
export { cfg, ctx, conn, layer, stopWatch, statusServer }
