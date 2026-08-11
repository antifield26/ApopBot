// 功能层生命周期：每次 spawn 全量重建 tasks/commands/agent 并重挂 chat 监听。
//
// ConnectionManager.onSpawn 在每次 spawn 时触发（含重连后的再次 spawn），ctx.bot
// 每次都是新实例——任务/命令/chat 监听若绑定旧 bot 会全部失效。
// 不做局部重绑定（BaseTask 构造时缓存 this.bot、插件注册 bot.on 监听，
// 重绑定成本高且不可测），而是每次 spawn 全量重建，天然无状态泄漏。
//
// 重建经内部 promise 链串行化：重叠的 spawn/reload 不会并发初始化。

import { TaskManager } from '../tasks/manager.js'
import { createCommandRegistry } from '../commands/commands.js'
import { createL2 } from '../l2/index.js'
import { sendChat } from './chat.js'
import { createNotifier } from './notify.js'
import * as discovery from './discovery.js'

// 玩家上线问候——模块级已知玩家 Set 与按玩家冷却。
// 模块级而非 doRebuild 闭包：player_info 首包会把登录时已在线的玩家全部触发
// playerJoined（重连后闭包重建会把在线玩家当新人问候全服）；跨重建保留。
// 只做上线问候且只走固定模板（LLM 不参与）：下线告别对离场玩家不可见，
// 模板成本为零且永不阻塞/刷屏；knownPlayers 在 playerLeft 时删除，
// 使"离开后重新加入"的玩家能再次被问候
const knownPlayers = new Set()
const lastGreetAt = new Map()
const GREET_COOLDOWN_MS = 60000

/** 测试钩子：重置上线问候状态（模块级 knownPlayers/冷却跨用例共享）。 */
export function _resetGreetState () {
  knownPlayers.clear()
  lastGreetAt.clear()
}

// 任务长 idle LLM 播报——waitingReason 持续超过
// IDLE_THRESHOLD_MS 时经 LLM 一句话解释（玩家/运维感知"卡在哪"）。模块级
// interval（跨重建保留——doRebuild 每重建新建 interval 会累积泄漏），重建时
// 只更新引用；已播报按 `任务id:原因` 去重 + 冷却。summarize 自带 60s 全局冷却。
const IDLE_POLL_MS = 60000 // 每分钟检查一次
const IDLE_THRESHOLD_MS = 10 * 60000 // waitingReason 持续 10 分钟才播报
const IDLE_REANNOUNCE_MS = 60 * 60000 // 同一任务同原因至少 1 小时才再播报
const idleWatcher = { bot: null, ctx: null, announced: new Map() }
setInterval(() => {
  const { bot, ctx } = idleWatcher
  if (!bot || !ctx?.tasks || !ctx.agent?.summarize) return
  const now = Date.now()
  for (const t of ctx.tasks.getStatus()) {
    if (t.state !== 'running' || !t.waitingReason || !t.waitingSince) continue
    const key = `${t.id}:${t.waitingReason}`
    const last = idleWatcher.announced.get(key) ?? 0
    if (now - t.waitingSince > IDLE_THRESHOLD_MS && now - last > IDLE_REANNOUNCE_MS) {
      idleWatcher.announced.set(key, now)
      // 上限 64：防 announced 无限增长（长期运行的等待组合有限）
      if (idleWatcher.announced.size > 64) {
        idleWatcher.announced.delete(idleWatcher.announced.keys().next().value)
      }
      const mins = Math.round((now - t.waitingSince) / 60000)
      ctx.agent.summarize(`任务 ${t.id}（${t.type}）已等待 ${mins} 分钟（原因：${t.waitingReason}）。用一句话向服务器玩家播报任务当前状态。`)
        .then((s) => { if (s) sendChat(bot, `§e[任务 ${t.id}] ${s}`).catch(() => {}) })
        .catch(() => {})
    }
  }
}, IDLE_POLL_MS).unref?.()

/** 测试钩子：清空 idle 播报去重表（跨用例共享）。 */
export function _resetIdleWatcher () {
  idleWatcher.bot = null
  idleWatcher.ctx = null
  idleWatcher.announced.clear()
}

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

    // chat 监听挂在当前 bot 上；旧 bot 的监听随旧对象消亡
    ctx.chatHandler = async (sender, msg) => {
      if (!msg || !msg.startsWith('!')) return
      const hit = await ctx.commands?.dispatch(msg, { sender, ctx }).catch((err) => {
        log().error({ err: err.message }, 'dispatch error')
        return true // 出错不算未知命令
      })
      // 未知命令静默是"指令无效"体验的一部分——明确反馈（含可用命令提示）。
      // 统一走 sendChat：剥 § 颜色码 + 分片（服务端对含 § 消息直接踢出 → fatal 停服，
      // 裸 bot.chat 发 § 前缀会触发）
      if (hit === false) {
        const names = (ctx.commands?.list() ?? []).map(c => `!${c.name}`).join(' ')
        try { await sendChat(bot, `§c未知命令（可用: ${names}）`, ctx.cfg.chat?.maxLength) } catch { /* 聊天通道可能未就绪 */ }
      }
    }
    bot.on('chat', ctx.chatHandler)

    // 死亡处理：createBot 显式 respawn:false → 死亡后 bot 停在死亡界面，
    // 重生时序完全可控：任务在死尸上空转前先暂停。
    // 死亡 → 通知 + 暂停全部任务 + 停止跟随 + 请求重生。
    // L2 可用时经 LLM 一句话播报死因；重生后自动恢复暂停的任务 + 播报重生位置。
    // deathPaused 是 promise：respawn 侧 await 保证"先暂停完、再恢复"——
    // 快速重生服 respawn 可能先于 pauseAll 完成到达，同步读取会漏掉暂停名单
    let deathPaused = Promise.resolve([]) // 本次死亡暂停任务 id 的 promise（重生时恢复）
    bot.on('death', () => {
      const p = ctx.tasks?.pauseAll() ?? Promise.resolve([])
      deathPaused = p.then((ids) => {
        if (ids.length) log().info({ tasks: ids }, 'death: tasks paused')
        return ids
      }).catch((err) => {
        log().warn({ err: err.message }, 'death: pause tasks failed')
        return []
      })
      ctx.plugins?.follow?.stop?.()
      const pos = bot.entity?.position
      const loc = pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '未知位置'
      sendChat(bot, `§c[bot] 已死亡（${loc}）——任务已暂停，自动重生中`).catch(() => { /* 聊天通道未就绪 */ })
      // 死亡推送（webhook 独立于游戏聊天——无人值守时玩家可能不在线）
      notifier().send('death', `Bot 死亡（${loc}）`, '任务已暂停，自动重生中')
      // LLM 一句话播报（附加层——任何失败回退模板，不得阻塞重生）
      if (ctx.agent?.summarize) {
        ctx.agent.summarize(`Bot 在 Minecraft 服务器死亡（坐标 ${loc}）。用一句话向服务器玩家播报（如可能的死因），简洁。`)
          .then((s) => {
            if (s) {
              sendChat(bot, `§c[bot] ${s}`).catch(() => {})
              // LLM 文案进 webhook（无人值守时唯一感知通道；固定模板推送已有）
              notifier().send('death', `Bot 死亡（${loc}）`, `LLM 死因播报: ${s}`)
            }
          })
          .catch(() => {})
      }
      try { bot.respawn() } catch { /* 重生通道未就绪 */ }
    })
    // 玩家上线问候（entities.js 发射 playerJoined/playerLeft 事件驱动）。
    // 只问候不告别（下线告别对离场玩家不可见）、只走固定模板（LLM 不参与）、
    // 独立 60s 按玩家冷却防刷屏——问候永不阻塞/不刷屏，也不占 summarize 全局冷却
    bot.on('playerJoined', (p) => {
      const name = p?.username
      if (!name || name === ctx.cfg.username) return
      if (knownPlayers.has(name)) return // 首包洪峰去重：在线玩家不算新人
      knownPlayers.add(name)
      const now = Date.now()
      if (now - (lastGreetAt.get(name) ?? 0) < GREET_COOLDOWN_MS) return
      lastGreetAt.set(name, now)
      sendChat(bot, `§a[bot] 欢迎回来，${name}`).catch(() => {})
    })
    // 只做记账：离开玩家移出已知集合——重新加入时才会再次触发问候
    bot.on('playerLeft', (p) => {
      const name = p?.username
      if (!name || name === ctx.cfg.username) return
      knownPlayers.delete(name)
    })

    // 地形记忆失效：方块变化（被挖/被放/火烧/水冲等）→ 该坐标的探索记忆删除——
    // 记忆只增不减会让 query_map 长期返回过期坐标。只覆盖已加载区块
    //（mineflayer blockUpdate 的感知范围）——远处记忆变化由 query_map 查询验证兜底。
    // 事件挂在 bot 实例上随重建/断线自然释放，无需 teardown 清理。
    bot.on('blockUpdate', (oldBlock) => {
      const p = oldBlock?.position
      if (p) discovery.removeResourceAt(p.x, p.y, p.z)
    })

    // 世界事件被动感知：事件写入 agent.pendingEvents，玩家下次对话时 LLM 注入
    // 感知（不做主动唤醒——busy 门/玩家冷却/权限语义约束）。监听挂 bot 实例随
    // 重建释放；高频事件由 notifyEvent 按类型去重合并只保最新状态
    bot.on('health', () => {
      const hp = bot.health
      const food = bot.food
      if (typeof hp === 'number' && hp > 0 && hp < 10) {
        ctx.agent?.notifyEvent?.('low', `血量低 ${Math.round(hp)}`)
      } else if (typeof food === 'number' && food > 0 && food < 6) {
        ctx.agent?.notifyEvent?.('low', `饥饿 ${Math.round(food)}`)
      }
    })
    bot.on('entityHurt', (entity, source) => {
      if (entity !== bot.entity) return
      const who = source?.username ?? source?.name ?? source?.type ?? 'unknown'
      ctx.agent?.notifyEvent?.('attacked', `被 ${who} 攻击`)
    })
    // 重要资源收集（钻石/绿宝石/远古残骸/铁/金/红石/青金石——高频杂物不记）
    bot.on('playerCollect', (collector, collected) => {
      if (collector !== bot.entity) return
      const name = collected?.name ?? collected?.type ?? ''
      if (/diamond|emerald|ancient_debris|iron|gold|redstone|lapis/.test(name)) {
        ctx.agent?.notifyEvent?.('collect', `获得 ${name}`)
      }
    })

    bot.on('respawn', async () => {
      // 恢复本次死亡暂停的任务（手动暂停的保持暂停）；await 暂停 promise 确保
      // pauseAll 完成后再恢复（快速重生服 respawn 先到的竞态）
      const ids = await deathPaused
      deathPaused = Promise.resolve([])
      for (const id of ids) {
        ctx.tasks?.resumeTask(id).catch(() => { /* 任务可能已结束 */ })
      }
      const pos = bot.entity?.position
      const loc = pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : '未知位置'
      sendChat(bot, `§a[bot] 已重生（${loc}），任务已恢复`).catch(() => { /* 聊天通道未就绪 */ })
      notifier().send('respawn', `Bot 已重生（${loc}）`, '任务已恢复')
    })

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
    idleWatcher.bot = bot
    idleWatcher.ctx = ctx
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
