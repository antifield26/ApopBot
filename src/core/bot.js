import mineflayer from 'mineflayer'
import { loadMineflayerPlugins } from '../plugins/index.js'

/**
 * 创建 bot 实例（同步）。
 * 拆分为同步 createBot + 异步 loadMineflayerPlugins：事件监听必须先于
 * 任何异步步骤接线，否则连接失败事件会在无监听窗口内丢失（见 ConnectionManager.connect）。
 * @returns {import('mineflayer').Bot}
 */
export function createBot (cfg) {
  return mineflayer.createBot({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    auth: cfg.auth,
    version: cfg.mcVersion,
    // 第 11 轮（D5）：显式 respawn:false——mineflayer 4.37.1 默认 respawn:true，
    // 此前注释声称"mineflayer 不自动 respawn"（前提错误）→ 死亡后 mineflayer 内部
    // 自动重生 + feature-layer death handler 手动 bot.respawn() = 一次死亡双 respawn
    // 包（Paper 容忍但依赖服务器行为）。显式关闭后死亡处理时序完全可控：
    // pauseAll → 播报 → 手动 respawn 单次。
    respawn: false,
    hideErrors: true // 错误走 error 事件，由 ConnectionManager 统一处理
  })
}

/**
 * 装载配置启用的 mineflayer 插件（异步）。
 * @returns {Promise<object>} 已装载的插件实例表
 */
export function loadMineflayerPluginsAsync (bot, cfg, logger) {
  return loadMineflayerPlugins(bot, cfg, logger)
}
