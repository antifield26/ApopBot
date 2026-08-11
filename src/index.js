// @ts-check
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, validateConfig, assertLogDirWritable } from './core/config.js'
import { createLogger } from './core/logger.js'
import { ConnectionManager } from './core/connection.js'
import { createFeatureLayerManager } from './core/feature-layer.js'
import { createL2 } from './l2/index.js'
import { setupSignals } from './core/signals.js'
import { createStatusServer } from './core/http-status.js'
import { createStateStore } from './core/state.js'
import { createNotifier } from './core/notify.js'
import * as discovery from './core/discovery.js'

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

// 进程级错误兜底：未捕获 rejection/异常不得静默崩溃走 NSSM 无限重启循环——
// 与连接层 fatal 语义一致 exit(2) 停止等人工（flush 带 1s 兜底防卡死）
function fatalExit (err, label) {
  logger.fatal({ err: err?.message ?? String(err) }, `${label} —— 按 fatal 停止等人工`)
  // fatal 停服推送（无人值守时唯一感知通道；ctx.notifier 随 reload 更新）
  ctx.notifier?.send('fatal', `Bot 停止等人工（${label}）`, err?.message ?? String(err))
  let exited = false
  const exitNow = () => { if (!exited) { exited = true; process.exit(2) } }
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
  }
})
ctx.conn = conn

// 运行状态快照：data/state.json，5s 防抖写；优雅退出时 flush
ctx.stateStore = createStateStore({ logger })
// 探索记忆接入持久化通道（recordResource/recordAnchor 修改后 5s 防抖落盘）
discovery.attachStore(ctx.stateStore)

/**
 * 重载配置并热更新：校验 → 更新 ctx.cfg/conn.cfg → 日志配置变化重建 logger →
 * 任务 diff 重载。SIGHUP / 配置变化 / !reload 均走此路径（经 layer.queue 串行化）。
 */
async function reload () {
  let newCfg
  try {
    newCfg = loadConfig()
  } catch (err) {
    logger.warn({ err: err.message }, 'reload 配置读取失败，保留旧配置')
    return false
  }
  const { ok: valid, errors: errs } = validateConfig(newCfg)
  if (!valid) {
    logger.warn({ errors: errs }, 'reload 配置校验失败，保留旧配置')
    return false
  }

  const logChanged = JSON.stringify(newCfg.log) !== JSON.stringify(ctx.cfg.log)
  const l2Changed = JSON.stringify(newCfg.l2) !== JSON.stringify(ctx.cfg.l2)
  // http 变更检测必须在赋值前计算——赋值后两侧恒等，stop/start 永不执行
  const httpChanged = JSON.stringify(newCfg.http) !== JSON.stringify(ctx.cfg.http)
  ctx.cfg = newCfg
  ctx.conn.updateCfg(newCfg)
  ctx.notifier = createNotifier(newCfg, logger) // webhook 配置随 reload 更新（fatalExit 使用）

  if (logChanged) {
    const rotateChanged = JSON.stringify(newCfg.log.rotate) !== JSON.stringify(ctx.cfg.log.rotate)
    if (rotateChanged || newCfg.log.pretty !== ctx.cfg.log.pretty || newCfg.log.dir !== ctx.cfg.log.dir) {
      logger.info({ level: newCfg.log.level }, '日志配置变化，重建 logger')
      // 注：pino v9 transport worker 无法主动拆除，反复改日志配置会累积文件句柄（接受，文档化）
      logger = createLogger(newCfg)
      ctx.logger = logger
      ctx.conn.log = logger
    } else {
      // 仅 level 变化 → 只调 level 不重建 transport——重建后新旧两个 pino-roll
      // 指向同一 bot.log，轮转 rename 时旧 fd 写被改名文件（丢行/坏 JSONL）
      logger.level = newCfg.log.level
      ctx.logger.level = newCfg.log.level
      logger.info({ level: newCfg.log.level }, '日志级别变更（transport 复用）')
    }
  }

  // L2 配置变化 → 重建 agent（createL2 构造时持有冻结的 cfg.l2 引用；
  // enabled=false→true 时 ctx.agent 为 null 也必须生效）
  if (l2Changed || Boolean(newCfg.l2?.enabled) !== Boolean(ctx.agent)) {
    await ctx.agent?.stop()
    ctx.agent = createL2(newCfg, ctx)
    logger.info('L2 配置变化，重建 agent')
  }

  // HTTP 状态端点配置变化 → 重启监听（getCfg 闭包取最新配置）
  if (httpChanged) {
    statusServer.stop()
    statusServer.start()
  }

  if (ctx.tasks) await ctx.tasks.reload(newCfg)
  logger.info('config reloaded')
  return true // 成功标志（!reload 命令反馈用）
}
const reloadQueued = () => layer.queue(reload)
ctx.onReload = reloadQueued

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
  discoveryStats: discovery.stats(), // 探索记忆统计
  tasks: ctx.tasks?.getStatus() ?? [],
  sessionCount: ctx.agent?.sessionCount?.() ?? 0,
  lastLlmLatencyMs: ctx.agent?.usage?.latencyMs ?? null,
  lastLlmUsage: ctx.agent?.usage ? {
    inputTokens: ctx.agent.usage.inputTokens,
    outputTokens: ctx.agent.usage.outputTokens
  } : null
}))
statusServer.start()

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
