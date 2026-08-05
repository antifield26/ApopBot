import pino from 'pino'
import path from 'node:path'

/**
 * 创建结构化日志：pino 双目标 transport（pino-roll 文件按天轮转 + stdout → journald）。
 */
export function createLogger (cfg) {
  const targets = [
    {
      target: 'pino-roll',
      options: {
        file: path.join(cfg.log.dir, 'bot.log'),
        frequency: cfg.log.rotate.frequency,
        mkdir: true,
        limit: { count: cfg.log.rotate.keepDays }
      }
    },
    {
      target: cfg.log.pretty ? 'pino-pretty' : 'pino/file',
      options: {}
    }
  ]

  return pino({
    level: cfg.log.level,
    base: { service: 'minecraft-bot' },
    transport: { targets }
  })
}

/**
 * 创建不带文件目标的纯 stdout 日志（用于 smoke/诊断脚本，避免轮转依赖）。
 */
export function createConsoleLogger (level = 'info', pretty = false) {
  return pino({
    level,
    base: { service: 'minecraft-bot' },
    transport: { targets: [{ target: pretty ? 'pino-pretty' : 'pino/file', options: {} }] }
  })
}
