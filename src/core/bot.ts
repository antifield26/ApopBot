import mineflayer from 'mineflayer'
import { loadMineflayerPlugins } from '../plugins/index.ts'

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
    // 显式 respawn:false——mineflayer 默认自动重生；若不关闭，死亡后自动重生 +
    // feature-layer death handler 手动 bot.respawn() = 一次死亡双 respawn 包。
    // 显式关闭后死亡处理时序完全可控：pauseAll → 播报 → 手动 respawn 单次。
    respawn: false,
    hideErrors: true // 错误走 error 事件，由 ConnectionManager 统一处理
  })
}

/**
 * 装载配置启用的 mineflayer 插件（异步）。
 * @returns {Promise<object>} 已装载的插件实例表
 */
export function loadMineflayerPluginsAsync (bot, cfg, logger) {
  return loadMineflayerPlugins(bot, cfg, logger).then((plugins) => {
    // pathfinder A* 计算超时：默认 5000ms——26.1 复杂/远距离场景 5 秒算不出路径
    //（实测 collect_blocks 远距离寻路 "Took to long to decide path to goal" →
    // 任务软失败假完成）。15s 给足搜索预算（A* 分片 tickTimeout 不变——响应性
    // 由 tick 分片保证，仅单次搜索的墙钟预算放宽）。
    if (bot.pathfinder) bot.pathfinder.thinkTimeout = 15000
    return plugins
  })
}
