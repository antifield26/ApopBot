import { createMovements } from '../core/movement.js'

// mineflayer 生态插件装载器：按配置条件装载，顺序敏感（collectblock 依赖 pathfinder 实例化）。
// 插件均为 registry 驱动、不解析协议字节，与 775 兼容（其传递依赖被 overrides 覆盖）。
//
// 重要：mineflayer 4.x 的 bot.loadPlugin 只把插件加入队列，实际注入发生在
// `inject_allowed` 事件（连接握手、registry 就绪之后）。因此：
//   - 插件句柄（bot.pathfinder 等）在 loadMineflayerPlugins 返回时可能还未存在，
//     必须通过包装函数在注入时记录到 loaded（直接读 bot.X 会得到 undefined）
//   - pathfinder 2.x 必需 setMovements（不设置时寻路不可靠），注入时立即设置
//   - Movements 统一由 src/core/movement.js 的 createMovements 创建，并同时喂给
//     collectBlock（其 collect() 自建 Movements 覆盖全局配置——同一实例后仅 resetPath）

/**
 * @param {import('mineflayer').Bot} bot
 * @param {object} cfg  完整配置对象
 * @param {object} logger
 * @param {{ imports?: object }} [deps] 测试注入：deps.imports[key] 覆写动态 import（默认真实包）
 * @returns {Promise<object>} 已装载插件句柄 { pathfinder, collectBlock, autoEat, armorManager, follow }
 */
export async function loadMineflayerPlugins (bot, cfg, logger, deps = {}) {
  const enabled = cfg.mineflayerPlugins ?? {}
  const loaded = {}
  // 动态 import 覆写点（测试注入 fake 插件；生产默认真实包）
  const imp = (key, fallback) => deps.imports?.[key] ?? fallback

  // 包装器：注入时执行插件本体 + 记录句柄
  const wrap = (plugin, name, getHandle) => {
    bot.loadPlugin((b, o) => {
      plugin(b, o)
      loaded[name] = getHandle ? getHandle(b) : b[name]
      logger.debug(`plugin injected: ${name}`)
    })
  }

  // 依赖校验：collectBlock 强依赖 pathfinder（运行期寻路静默失效会误导任务）——
  // 配置层错误在装载期显式抛出
  if (enabled.collectBlock !== false && enabled.pathfinder === false) {
    throw new Error('mineflayerPlugins.collectBlock 依赖 pathfinder——不能关闭 pathfinder 而保留 collectBlock')
  }

  // 顺序: pathfinder → tool(collectblock 传递依赖自动装载) → collectBlock → autoEat → armorManager
  if (enabled.pathfinder !== false) {
    const { pathfinder, Movements } = await imp('pathfinder', () => import('mineflayer-pathfinder'))()
    wrap(pathfinder, 'pathfinder', (b) => {
      b.pathfinder.setMovements(createMovements(b, Movements)) // 2.x 必需 + 统一配置（movement.js）
      return b.pathfinder
    })
  }

  if (enabled.collectBlock !== false) {
    const { plugin } = await imp('collectblock', () => import('mineflayer-collectblock'))()
    wrap(plugin, 'collectBlock', (b) => {
      // 修 Movements 覆盖：collect() 自建 Movements 并 setMovements（CollectBlock.js:192-196，
      // 任务结束后不恢复）——注入同一实例后其 setMovements(this.movements) 仅 resetPath，
      // 不再覆盖统一配置。collect() 置 dontMineUnderFallingBlock/dontCreateFlow=false 的
      // 副作用仍残留（更宽松配置），接受并注释。
      if (b.pathfinder?.movements) b.collectBlock.movements = b.pathfinder.movements
      return b.collectBlock
    })
  }

  if (enabled.autoEat !== false) {
    const { loader } = await imp('autoeat', () => import('mineflayer-auto-eat'))()
    wrap(loader, 'autoEat')
  }

  if (enabled.armorManager !== false) {
    const mod = await imp('armor', () => import('mineflayer-armor-manager'))()
    wrap(mod.default, 'armorManager')
  }

  if (enabled.follow === true) {
    const { followPlugin } = await imp('follow', () => import('./follow.js'))()
    wrap(followPlugin, 'follow')
  }

  return loaded
}
