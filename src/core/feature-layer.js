// 功能层生命周期（B1 修复）：每次 spawn 全量重建 tasks/commands/agent 并重挂 chat 监听。
//
// 背景：ConnectionManager.onSpawn 在每次 spawn 时触发（含重连后的再次 spawn）。
// 早期实现只在首次 spawn 初始化功能层，重连后 ctx.bot 换了新实例，但任务/命令/
// chat 监听仍绑定旧 bot → 一次重连后 !命令 全失效、任务读死 bot 状态。
// 修复方案：不做局部重绑定（BaseTask 构造时缓存 this.bot、插件注册 bot.on 监听，
// 重绑定成本高且不可测），而是每次 spawn 全量重建，天然无状态泄漏。
//
// 重建经内部 promise 链串行化：重叠的 spawn/reload 不会并发初始化。

import { TaskManager } from '../tasks/manager.js'
import { createCommandRegistry } from '../commands/commands.js'
import { createL2 } from '../l2/index.js'

export function createFeatureLayerManager (ctx, logger) {
  let pending = Promise.resolve()
  // 热重载会重建 logger——所有日志/组件构造一律运行时取 ctx.logger（P1-5：
  // 构造时捕获的初始 logger 会在重连后把任务日志写旧 transport）
  const log = () => ctx.logger ?? logger

  /** 拆除当前功能层（幂等，逐项容错：旧 bot 可能已死）。 */
  async function teardown () {
    if (ctx.tasks) {
      try {
        await ctx.tasks.stopAll() // 含 cron.stop + task.stop
      } catch (err) {
        log().warn({ err: err.message }, 'teardown: tasks 停止失败')
      }
      ctx.tasks = null
    }
    if (ctx.agent) {
      try {
        await ctx.agent.stop()
      } catch (err) {
        log().warn({ err: err.message }, 'teardown: agent 停止失败')
      }
      ctx.agent = null
    }
    ctx.commands = null
  }

  async function doRebuild (bot) {
    await teardown()

    // 必须先更新 ctx.bot，再构建任何消费 bot 的组件
    ctx.bot = bot
    // 兜底同步插件句柄（正常路径 index.js onSpawn 已赋值；重建路径也保持可用）
    if (!ctx.plugins) ctx.plugins = ctx.conn?.plugins ?? null
    log().info('rebuilding feature layer (tasks/commands/agent)')

    ctx.tasks = new TaskManager(ctx.cfg, log(), { bot })
    await ctx.tasks.load(ctx.cfg) // load 内部按条目容错，不抛

    // 命令处理器闭包读取可变 ctx，dispatch 时总能拿到当前 bot
    ctx.commands = createCommandRegistry(ctx)

    ctx.agent = createL2(ctx.cfg, ctx)

    // chat 监听挂在当前 bot 上；旧 bot 的监听随旧对象消亡
    ctx.chatHandler = (sender, msg) => {
      if (!msg || !msg.startsWith('!')) return
      ctx.commands?.dispatch(msg, { sender, ctx }).catch((err) => {
        log().error({ err: err.message }, 'dispatch error')
      })
    }
    bot.on('chat', ctx.chatHandler)
    log().info({ bot: ctx.cfg.username }, 'feature layer ready')
  }

  /**
   * 在队列中重建功能层（onSpawn 调用）。
   * @param {import('mineflayer').Bot} bot
   * @returns {Promise<void>}
   */
  function rebuild (bot) {
    pending = pending
      .then(() => doRebuild(bot))
      .catch((err) => log().error({ err: err.message }, 'feature layer rebuild failed'))
    return pending
  }

  /**
   * 将任意异步操作放入同一串行队列（reload 等，避免与 rebuild 交错）。
   * @param {() => Promise<void>} fn
   * @returns {Promise<void>}
   */
  function queue (fn) {
    pending = pending.then(fn).catch((err) => log().error({ err: err.message }, 'queued task failed'))
    return pending
  }

  return { rebuild, teardown, queue }
}
