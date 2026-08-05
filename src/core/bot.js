import mineflayer from 'mineflayer'
import { loadMineflayerPlugins } from '../plugins/index.js'

/**
 * 创建 bot 实例并装载配置启用的插件。
 * @returns {Promise<{ bot: import('mineflayer').Bot, plugins: object }>}
 */
export async function createBotWithPlugins (cfg, logger) {
  const bot = mineflayer.createBot({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    auth: cfg.auth,
    version: cfg.mcVersion,
    hideErrors: true // 错误走 error 事件，由 ConnectionManager 统一处理
  })

  const plugins = await loadMineflayerPlugins(bot, cfg, logger)
  return { bot, plugins }
}
