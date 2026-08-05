// mineflayer 生态插件装载器：按配置条件装载，顺序敏感（collectblock 依赖 pathfinder 实例化）。
// 插件均为 registry 驱动、不解析协议字节，与 775 兼容（其传递依赖被 overrides 覆盖）。

/**
 * @param {import('mineflayer').Bot} bot
 * @param {object} cfg  完整配置对象
 * @param {object} logger
 * @returns {Promise<object>} 已装载插件句柄 { pathfinder, collectBlock, autoEat, armorManager, follow }
 */
export async function loadMineflayerPlugins (bot, cfg, logger) {
  const enabled = cfg.mineflayerPlugins ?? {}
  const loaded = {}

  // 顺序: pathfinder → tool(collectblock 传递依赖自动装载) → collectBlock → autoEat → armorManager
  if (enabled.pathfinder !== false) {
    const { pathfinder } = await import('mineflayer-pathfinder')
    bot.loadPlugin(pathfinder)
    loaded.pathfinder = bot.pathfinder
    logger.debug('plugin loaded: pathfinder')
  }

  if (enabled.collectBlock !== false) {
    const { plugin } = await import('mineflayer-collectblock')
    bot.loadPlugin(plugin)
    loaded.collectBlock = bot.collectBlock
    logger.debug('plugin loaded: collectBlock')
  }

  if (enabled.autoEat !== false) {
    const { loader } = await import('mineflayer-auto-eat')
    bot.loadPlugin(loader)
    loaded.autoEat = bot.autoEat
    logger.debug('plugin loaded: autoEat')
  }

  if (enabled.armorManager !== false) {
    const mod = await import('mineflayer-armor-manager')
    bot.loadPlugin(mod.default)
    loaded.armorManager = bot.armorManager
    logger.debug('plugin loaded: armorManager')
  }

  if (enabled.follow === true) {
    const { followPlugin } = await import('./follow.js')
    bot.loadPlugin(followPlugin)
    loaded.follow = bot.follow
    logger.debug('plugin loaded: follow')
  }

  return loaded
}
