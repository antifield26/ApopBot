// 功能层生命周期：每次 spawn 全量重建 tasks/commands/agent 并重挂 chat 监听。
//
// ConnectionManager.onSpawn 在每次 spawn 时触发（含重连后的再次 spawn），ctx.bot
// 每次都是新实例——任务/命令/chat 监听若绑定旧 bot 会全部失效。
// 不做局部重绑定（BaseTask 构造时缓存 this.bot、插件注册 bot.on 监听，
// 重绑定成本高且不可测），而是每次 spawn 全量重建，天然无状态泄漏。
//
// 重建经内部 promise 链串行化：重叠的 spawn/reload 不会并发初始化。
//
// 职责拆分：事件监听类（聊天/玩家/死亡/世界感知/idle 播报）在 fl-*.js /
// idle-watcher.js，本文件只保留装配编排（生命周期 + 组装 + 恢复）。

import { TaskManager } from '../tasks/manager.js'
import { createCommandRegistry } from '../commands/commands.js'
import { createL2 } from '../l2/index.js'
import { sendChat } from './chat.js'
import { createNotifier } from './notify.js'
import * as discovery from './discovery.js'
import { installChatListener } from './fl-chat.js'
import { installDeathHandling } from './fl-death.js'
import { installPlayerTracking } from './fl-players.js'
import { installMemoryInvalidation, installWorldSensing } from './fl-world.js'
import { bindIdleWatcher } from './idle-watcher.js'

// 测试钩子 re-export（动态 import 路径不变——测试零改动）
export { _resetGreetState } from './fl-players.js'
export { _resetIdleWatcher } from './idle-watcher.js'

export function createFeatureLayerManager (ctx, logger) {
  let pending = Promise.resolve()
  // 热重载会重建 logger——所有日志/组件构造一律运行时取 ctx.logger
  //（构造时捕获的初始 logger 会在重连后把任务日志写旧 transport）
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

    ctx.tasks = new TaskManager(ctx.cfg, log(), { bot }, ctx.stateStore, () => ctx.agent)
    await ctx.tasks.load(ctx.cfg) // load 内部按条目容错，不抛
    // webhook 通知：必须实时取 ctx.notifier——reload 只更新 ctx.notifier（index.js），
    // 不重建 feature layer；按值捕获一次会让闭包引用旧句柄——reload 改 webhook 后
    // 死亡/重生/重连推送仍走旧 URL。事件发生时实时取值（此处永不缓存）。
    const notifier = () => ctx.notifier ?? createNotifier(ctx.cfg, log())

    // config 任务计数器回灌——快照全量写计数（含 config 任务），重建后不恢复则
    // config 任务计数归零，且下一次快照即覆写 state.json 旧值（写了不读 = 数据丢失）
    for (const e of ctx.cfg.tasks ?? []) {
      ctx.tasks.restoreCounters(e.id, ctx.stateStore?.counters?.[e.id])
    }

    // 探索记忆回灌（模块级单例——跨重建/重连保留；容量与形状防御
    // 在 importSnapshot 内部，坏数据按空处理）
    discovery.importSnapshot(ctx.stateStore?.memory)

    // 快照中的 ad-hoc 任务恢复（配置里已存在的以配置文件为准，不重复添加）
    const configIds = new Set((ctx.cfg.tasks ?? []).map(e => e.id))
    for (const entry of ctx.stateStore?.tasks ?? []) {
      if (configIds.has(entry.id)) continue
      try {
        ctx.tasks.addTask(entry)
        // 计数器回灌——快照里 ad-hoc 任务的计数恢复（否则重启后遥测归零）
        ctx.tasks.restoreCounters(entry.id, ctx.stateStore?.counters?.[entry.id])
        log().info({ task: entry.id }, 'restored ad-hoc task from state snapshot')
      } catch (err) {
        log().warn({ task: entry.id, err: err.message }, 'ad-hoc 任务恢复失败')
      }
    }

    // 命令处理器闭包读取可变 ctx，dispatch 时总能拿到当前 bot
    ctx.commands = createCommandRegistry(ctx)

    ctx.agent = createL2(ctx.cfg, ctx)

    // 事件监听挂当前 bot 实例上（随重建/断线自然释放，无需 teardown 清理）。
    // 依赖序：commands 先于 chat（handler 分发读 ctx.commands）；
    // agent 先于 world（health 回调用 ctx.agent.notifyEvent）
    installChatListener(ctx, bot, log)
    installDeathHandling(ctx, bot, log, notifier)
    installPlayerTracking(ctx, bot)
    installMemoryInvalidation(ctx, bot)
    installWorldSensing(ctx, bot)

    log().info({ bot: ctx.cfg.username }, 'feature layer ready')

    // 重连恢复通知：玩家可感知 Bot 已回来（首连安静上线，仅重连提示）。
    // 同上：裸 § 会触发服务端踢出，走 sendChat 剥离
    const s = ctx.conn?.getStatus?.()
    if (s && s.reconnectCount > 0) {
      try { await sendChat(bot, `§a[bot] 已重新连接（累计重连 ${s.reconnectCount} 次）`, ctx.cfg.chat?.maxLength) } catch { /* 聊天通道可能未就绪 */ }
      notifier().send('reconnect', `Bot 已重新连接（累计重连 ${s.reconnectCount} 次）`)
      // 连续重连告警——无人值守时 webhook 是唯一感知通道
      //（重连本身已推送，但高频重连=服务端/网络异常，需运维介入的更强信号）
      if (s.reconnectCount >= 3) {
        notifier().send('reconnect-alert', `Bot 已连续重连 ${s.reconnectCount} 次——请检查服务端状态`)
      }
    }
    // idle 播报 watcher 引用随重建更新（模块级 interval 跨重建保留）
    bindIdleWatcher(ctx, bot)
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
   * 队列链本身吸收错误（单次失败不毒化后续调用），但返回值把错误上抛给
   * 调用方——!reload 据此反馈"运行时错误"而非假成功。
   * @param {() => Promise<void>} fn
   * @returns {Promise<void>}
   */
  function queue (fn) {
    const run = pending.then(fn)
    pending = run.catch((err) => log().error({ err: err.message }, 'queued task failed'))
    return run
  }

  return { rebuild, teardown, queue }
}
