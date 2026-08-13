// @ts-check
// 热重载处理器（从 index.js 抽取——入口 import 即连接无法单测，此处依赖注入后
// 可行为测试）：重载配置并热更新——校验 → 更新 ctx.cfg/conn.cfg → 日志配置变化
// 重建 logger → L2 变化重建 agent → HTTP 变化重启监听 → 任务 diff 重载。
// SIGHUP / 配置变化 / !reload 均走此路径（调用方经 layer.queue 串行化）。

/**
 * @param {{
 *   ctx: any,
 *   getLogger: () => any,
 *   setLogger: (logger: any) => void,
 *   conn: any,
 *   statusServer: { stop: () => Promise<void>, start: () => void },
 *   loadConfig: () => any,
 *   validateConfig: (cfg: any) => { ok: boolean, errors?: string[] },
 *   createLogger: (cfg: any) => any,
 *   createNotifier: (cfg: any, logger: any) => any,
 *   createL2: (cfg: any, ctx: any) => any
 * }} deps 依赖注入（index.js 传模块级闭包；测试传假实现）
 * @returns {{ reload: () => Promise<boolean>}}
 */
export function createReloadHandler (deps) {
  const {
    ctx,
    getLogger,
    setLogger,
    conn,
    statusServer,
    loadConfig,
    validateConfig,
    createLogger,
    createNotifier,
    createL2
  } = deps

  async function reload () {
    let newCfg
    try {
      newCfg = loadConfig()
    } catch (err) {
      getLogger().warn({ err: err.message }, 'reload 配置读取失败，保留旧配置')
      return false
    }
    const { ok: valid, errors: errs } = validateConfig(newCfg)
    if (!valid) {
      getLogger().warn({ errors: errs }, 'reload 配置校验失败，保留旧配置')
      return false
    }

    const logChanged = JSON.stringify(newCfg.log) !== JSON.stringify(ctx.cfg.log)
    const l2Changed = JSON.stringify(newCfg.l2) !== JSON.stringify(ctx.cfg.l2)
    // 变更检测必须在赋值前计算——赋值后两侧恒等，判定永不成立（此前 log 重建
    // 分支是死代码：dir/pretty/rotate 变更静默失效；http 已按此修复）
    const httpChanged = JSON.stringify(newCfg.http) !== JSON.stringify(ctx.cfg.http)
    const logRebuild = logChanged && (
      JSON.stringify(newCfg.log.rotate) !== JSON.stringify(ctx.cfg.log.rotate) ||
      newCfg.log.pretty !== ctx.cfg.log.pretty ||
      newCfg.log.dir !== ctx.cfg.log.dir)
    ctx.cfg = newCfg
    conn.updateCfg(newCfg)
    ctx.notifier = createNotifier(newCfg, getLogger()) // webhook 配置随 reload 更新（fatalExit 使用）

    if (logRebuild) {
      getLogger().info({ level: newCfg.log.level }, '日志配置变化，重建 logger')
      // 注：pino v9 transport worker 无法主动拆除，反复改日志配置会累积文件句柄（接受，文档化）
      const newLogger = createLogger(newCfg)
      setLogger(newLogger)
      ctx.logger = newLogger
      conn.log = newLogger
    } else if (logChanged) {
      // 仅 level 变化 → 只调 level 不重建 transport——重建后新旧两个 pino-roll
      // 指向同一 bot.log，轮转 rename 时旧 fd 写被改名文件（丢行/坏 JSONL）
      const cur = getLogger()
      cur.level = newCfg.log.level
      ctx.logger.level = newCfg.log.level
      cur.info({ level: newCfg.log.level }, '日志级别变更（transport 复用）')
    }

    // L2 配置变化 → 重建 agent（createL2 构造时持有冻结的 cfg.l2 引用；
    // enabled=false→true 时 ctx.agent 为 null 也必须生效）
    if (l2Changed || Boolean(newCfg.l2?.enabled) !== Boolean(ctx.agent)) {
      await ctx.agent?.stop()
      ctx.agent = createL2(newCfg, ctx)
      getLogger().info('L2 配置变化，重建 agent')
    }

    // HTTP 状态端点配置变化 → 重启监听（getCfg 闭包取最新配置）
    if (httpChanged) {
      await statusServer.stop() // await close 完成再 listen——同端口重启不 EADDRINUSE
      statusServer.start()
    }

    if (ctx.tasks) await ctx.tasks.reload(newCfg)
    getLogger().info('config reloaded')
    return true // 成功标志（!reload 命令反馈用）
  }

  return { reload }
}
