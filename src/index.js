import { loadConfig, validateConfig } from './core/config.js'
import { createLogger } from './core/logger.js'
import { ConnectionManager } from './core/connection.js'
import { TaskManager } from './tasks/manager.js'
import { createCommandRegistry } from './commands/commands.js'
import { createL2 } from './l2/index.js'
import { setupSignals } from './core/signals.js'

// 入口：参数 → 配置 → logger → ConnectionManager → 任务/命令/L2 → 信号处理

let cfg = loadConfig()
const { ok, errors } = validateConfig(cfg)
if (!ok) {
  console.error('配置校验失败:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

const logger = createLogger(cfg)

// 可变运行上下文（!reload 命令会更新 cfg）
const ctx = {
  cfg,
  logger,
  bot: null,
  plugins: null,
  tasks: null,
  conn: null,
  agent: null,
  commands: null
}

const conn = new ConnectionManager(cfg, logger, {
  onSpawn: (bot) => {
    ctx.bot = bot
    initAfterSpawn()
  },
  onStateChange: (state) => {
    logger.info({ state }, 'connection state changed')
  }
})
ctx.conn = conn

// 任务与命令在 spawn 后初始化（需要 bot 实例）；信号在启动时注册
function initAfterSpawn () {
  if (ctx.tasks) return // 只在首次 spawn 初始化
  logger.info('initializing tasks, commands, L2')

  ctx.tasks = new TaskManager(ctx.cfg, logger, { bot: ctx.bot })
  ctx.tasks.load(ctx.cfg).catch((err) => logger.error({ err: err.message }, 'task load error'))

  ctx.commands = createCommandRegistry(ctx)
  ctx.agent = createL2(ctx.cfg, ctx)

  ctx.bot.on('chat', (sender, msg) => {
    if (!msg.startsWith('!')) return
    ctx.commands.dispatch(msg, { sender, ctx }).catch((err) => logger.error({ err: err.message }, 'dispatch error'))
  })
}

// 热重载：SIGHUP / 配置文件变化 → 重载配置 + 任务
async function reload () {
  const newCfg = loadConfig()
  const { ok: valid, errors: errs } = validateConfig(newCfg)
  if (!valid) {
    logger.warn({ errors: errs }, 'reload 配置校验失败，保留旧配置')
    return
  }
  ctx.cfg = newCfg
  await ctx.tasks?.reload(newCfg)
}

setupSignals({ logger, conn, ctx, onReload: reload })

conn.connect().catch((err) => {
  logger.fatal({ err: err.message }, 'initial connect failed')
  process.exit(1)
})
