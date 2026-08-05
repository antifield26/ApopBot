import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, validateConfig, assertLogDirWritable } from './core/config.js'
import { createLogger } from './core/logger.js'
import { ConnectionManager } from './core/connection.js'
import { createFeatureLayerManager } from './core/feature-layer.js'
import { setupSignals } from './core/signals.js'

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
  onReload: null // !reload 命令走同一 reload 队列（与 SIGHUP/配置监视一致）
}

// 功能层每次 spawn 全量重建（B1：重连后任务/命令/chat 监听必须绑定新 bot）
const layer = createFeatureLayerManager(ctx, logger)

const conn = new ConnectionManager(cfg, logger, {
  onSpawn: (bot) => { layer.rebuild(bot) },
  onStateChange: (state) => {
    logger.info({ state }, 'connection state changed')
  }
})
ctx.conn = conn

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
    return
  }
  const { ok: valid, errors: errs } = validateConfig(newCfg)
  if (!valid) {
    logger.warn({ errors: errs }, 'reload 配置校验失败，保留旧配置')
    return
  }

  const logChanged = JSON.stringify(newCfg.log) !== JSON.stringify(ctx.cfg.log)
  ctx.cfg = newCfg
  ctx.conn.updateCfg(newCfg)

  if (logChanged) {
    logger.info({ level: newCfg.log.level }, '日志配置变化，重建 logger')
    // 注：pino v9 transport worker 无法主动拆除，反复改日志配置会累积文件句柄（接受，文档化）
    logger = createLogger(newCfg)
    ctx.logger = logger
    ctx.conn.log = logger
  }

  if (ctx.tasks) await ctx.tasks.reload(newCfg)
  logger.info('config reloaded')
}
const reloadQueued = () => layer.queue(reload)
ctx.onReload = reloadQueued

// 当前生效的配置文件路径（--config 参数或默认 default.json），用于热监视
function activeConfigPath () {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--config')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  return path.join(ROOT, 'config', 'default.json')
}

// 配置文件热监视（O5：fs.watch 防抖 500ms；rename 事件重挂 watcher）
function watchConfig () {
  const file = activeConfigPath()
  let timer = null
  let watcher
  const arm = () => {
    try {
      watcher = fs.watch(file, () => {
        clearTimeout(timer)
        timer = setTimeout(reloadQueued, 500)
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
  return () => { clearTimeout(timer); watcher?.close() }
}
const stopWatch = watchConfig()

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
export { cfg, ctx, conn, layer, stopWatch }
