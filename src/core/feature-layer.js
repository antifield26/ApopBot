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
import { sendChat } from './chat.js'

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

    ctx.tasks = new TaskManager(ctx.cfg, log(), { bot }, ctx.stateStore, () => ctx.agent)
    await ctx.tasks.load(ctx.cfg) // load 内部按条目容错，不抛

    // A5（第四轮）：config 任务计数器回灌——_snapshotCounters 全量写（含 config 任务），
    // 但 restoreCounters 此前只在下方 ad-hoc 恢复循环调用 → 重建后 config 任务计数归零，
    // 且下一次快照即覆写 state.json 旧值（写了不读 = 数据丢失，F5）
    for (const e of ctx.cfg.tasks ?? []) {
      ctx.tasks.restoreCounters(e.id, ctx.stateStore?.counters?.[e.id])
    }

    // U1 恢复：快照中的 ad-hoc 任务（配置里已存在的以配置文件为准，不重复添加）
    const configIds = new Set((ctx.cfg.tasks ?? []).map(e => e.id))
    for (const entry of ctx.stateStore?.tasks ?? []) {
      if (configIds.has(entry.id)) continue
      try {
        ctx.tasks.addTask(entry)
        // C6/N：计数器回灌——快照此前只写不读（重启后遥测归零，U1 承诺未兑现）
        ctx.tasks.restoreCounters(entry.id, ctx.stateStore?.counters?.[entry.id])
        log().info({ task: entry.id }, 'restored ad-hoc task from state snapshot')
      } catch (err) {
        log().warn({ task: entry.id, err: err.message }, 'ad-hoc 任务恢复失败')
      }
    }

    // 命令处理器闭包读取可变 ctx，dispatch 时总能拿到当前 bot
    ctx.commands = createCommandRegistry(ctx)

    ctx.agent = createL2(ctx.cfg, ctx)

    // chat 监听挂在当前 bot 上；旧 bot 的监听随旧对象消亡
    ctx.chatHandler = async (sender, msg) => {
      if (!msg || !msg.startsWith('!')) return
      const hit = await ctx.commands?.dispatch(msg, { sender, ctx }).catch((err) => {
        log().error({ err: err.message }, 'dispatch error')
        return true // 出错不算未知命令
      })
      // 未知命令静默是"指令无效"体验的一部分——明确反馈（含可用命令提示）。
      // 统一走 sendChat：剥 § 颜色码 + 分片（Paper 26.1.2 含 § 被踢 → fatal 停服，
      // 裸 bot.chat 的 § 前缀是 53d3352 引入的 P0 回归——C1 修复）
      if (hit === false) {
        const names = (ctx.commands?.list() ?? []).map(c => `!${c.name}`).join(' ')
        try { await sendChat(bot, `§c未知命令（可用: ${names}）`, ctx.cfg.chat?.maxLength) } catch { /* 聊天通道可能未就绪 */ }
      }
    }
    bot.on('chat', ctx.chatHandler)

    // 死亡处理（C2/D 修复 + U6 深化）：mineflayer 不自动 respawn（createBot 未传
    // respawn:true），死亡后 bot 停在死亡界面——任务在死尸上空转、进行中的 goto
    // 拖尸体直到超时，之后永久停摆到进程重启。
    // C2：死亡 → 通知 + 暂停全部任务 + 停止跟随 + 请求重生。
    // U6：L2 可用时经 LLM 一句话播报死因；重生后自动恢复暂停的任务 + 播报重生位置。
    let deathPaused = [] // 本次死亡暂停的任务 id（重生时恢复；不触碰手动暂停的）
    bot.on('death', () => {
      ctx.tasks?.pauseAll().then((ids) => {
        deathPaused = ids
        if (ids.length) log().info({ tasks: ids }, 'death: tasks paused')
      }).catch((err) => log().warn({ err: err.message }, 'death: pause tasks failed'))
      ctx.plugins?.follow?.stop?.()
      const pos = bot.entity?.position
      const loc = pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '未知位置'
      sendChat(bot, `§c[bot] 已死亡（${loc}）——任务已暂停，自动重生中`).catch(() => { /* 聊天通道未就绪 */ })
      // U6：LLM 一句话播报（附加层——任何失败回退模板，不得阻塞重生）
      if (ctx.agent?.summarize) {
        ctx.agent.summarize(`Bot 在 Minecraft 服务器死亡（坐标 ${loc}）。用一句话向服务器玩家播报（如可能的死因），简洁。`)
          .then((s) => { if (s) sendChat(bot, `§c[bot] ${s}`).catch(() => {}) })
          .catch(() => {})
      }
      try { bot.respawn() } catch { /* 重生通道未就绪 */ }
    })
    bot.on('respawn', () => {
      // U6：恢复本次死亡暂停的任务（手动暂停的保持暂停）
      const ids = deathPaused
      deathPaused = []
      for (const id of ids) {
        ctx.tasks?.resumeTask(id).catch(() => { /* 任务可能已结束 */ })
      }
      const pos = bot.entity?.position
      const loc = pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '未知位置'
      sendChat(bot, `§a[bot] 已重生（${loc}），任务已恢复`).catch(() => { /* 聊天通道未就绪 */ })
    })

    log().info({ bot: ctx.cfg.username }, 'feature layer ready')

    // 重连恢复通知：玩家可感知 Bot 已回来（首连安静上线，仅重连提示）。
    // 同上：裸 § 会触发服务端踢出（P0），走 sendChat 剥离
    const s = ctx.conn?.getStatus?.()
    if (s && s.reconnectCount > 0) {
      try { await sendChat(bot, `§a[bot] 已重新连接（累计重连 ${s.reconnectCount} 次）`, ctx.cfg.chat?.maxLength) } catch { /* 聊天通道可能未就绪 */ }
    }
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
   * 失败语义（L 修复）：队列链本身吸收错误（单次失败不毒化后续调用），
   * 但返回值把错误上抛给调用方——!reload 据此反馈"运行时错误"而非假成功。
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
