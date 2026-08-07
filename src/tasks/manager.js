import { MineTask } from './mine.js'
import { FishTask } from './fish.js'
import { AfkTask } from './afk.js'
import { FarmTask } from './farm.js'
import { ChopTask } from './chop.js'
import { CombatTask } from './combat.js'
import { BreedTask } from './breed.js'
import { ExploreTask } from './explore.js'
import { createTaskSchedule } from './scheduled.js'
import { withTimeout } from '../util/promise-timeout.js'
import { sendChat } from '../core/chat.js'
import { setExclusiveOwner, getExclusiveOwner } from '../core/arbiter.js'
import { createNotifier } from '../core/notify.js'

// U7：任务终态 LLM 总结的全局冷却（防多任务同时完成时刷屏）
const SUMMARY_COOLDOWN_MS = 60000

/** 递归按键名排序（热重载 diff 不因用户重排键序而误判变更）。 */
function sortKeys (v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]))
  }
  return v
}

// 任务类型工厂表（与 src/core/config.js 的 KNOWN_TASK_TYPES 同步维护；tests 有一致性断言）
export const TASK_TYPES = {
  mine: (id, options, ctx) => new MineTask(id, 'mine', options, ctx),
  fish: (id, options, ctx) => new FishTask(id, 'fish', options, ctx),
  afk: (id, options, ctx) => new AfkTask(id, 'afk', options, ctx),
  farm: (id, options, ctx) => new FarmTask(id, 'farm', options, ctx),
  chop: (id, options, ctx) => new ChopTask(id, 'chop', options, ctx),
  combat: (id, options, ctx) => new CombatTask(id, 'combat', options, ctx),
  breed: (id, options, ctx) => new BreedTask(id, 'breed', options, ctx),
  explore: (id, options, ctx) => new ExploreTask(id, 'explore', options, ctx) // L2 进化 C2：螺旋探索
}

const RUNNING_STATES = ['init', 'running', 'paused']

/**
 * 任务管理器：装载/启动/停止/热重载/cron 调度/临时任务。
 *
 * 调度语义（B2）：startTask 返回 run 完成 Promise；runScheduled 处理 cron 触发
 * （防重叠 + 时长上限 + 完成通知）。!task stop 只停当前运行，cron 调度保持。
 */
export class TaskManager {
  /**
   * @param {object} cfg
   * @param {import('pino').Logger} logger
   * @param {{ bot: import('mineflayer').Bot }} ctx 运行上下文
   * @param {object} [stateStore] 运行状态快照（U1）：ad-hoc 条目 + 计数器持久化
   */
  constructor (cfg, logger, ctx, stateStore = null, getAgent = null) {
    this.cfg = cfg
    this.log = logger.child({ module: 'tasks' })
    this.ctx = ctx
    this.tasks = new Map() // id → { entry, task, cron }
    this._pendingExclusive = [] // 被 exclusive 互斥拒绝的任务（冲突任务终态后按序补启动）
    this._stateStore = stateStore
    // U7：LLM 主动播报的 agent 获取器（feature-layer 传 () => ctx.agent——
    // agent 随重建变化，不能构造时固化）
    this._getAgent = getAgent ?? null
    this._lastSummaryAt = 0
    this._notifier = createNotifier(cfg, this.log) // U10：webhook 通知（cfg 变化时重建）
  }

  _makeTaskCtx () {
    return { bot: this.ctx.bot, logger: this.log, config: this.cfg }
  }

  _createEntry (entry) {
    const factory = TASK_TYPES[entry.type]
    if (!factory) throw new Error(`未知任务类型: ${entry.type}`)
    const task = factory(entry.id, entry.options ?? {}, this._makeTaskCtx())
    return { entry, task, cron: null }
  }

  _createSchedule (rec) {
    const entry = rec.entry
    rec.cron = createTaskSchedule(entry, {
      onTrigger: () => this.runScheduled(entry.id, entry.durationMinutes ?? entry.options?.durationMinutes)
    }, this.log, this.cfg.scheduleTimezone)
  }

  /**
   * 按配置装载全部任务。调度语义：有 schedule → cron 触发；否则 enabled 立即启动。
   */
  async load (cfg) {
    this.cfg = cfg
    this._notifier = createNotifier(cfg, this.log) // U10：webhook 配置随 reload 更新
    await this.stopAll()
    const seen = new Set()
    for (const entry of cfg.tasks ?? []) {
      if (!entry.id || !entry.type) {
        this.log.warn('忽略无效任务条目（缺 id/type）: %o', entry)
        continue
      }
      if (seen.has(entry.id)) { // F6：同 cfg 内重复 id 直接拒绝（validateConfig 兜底）
        this.log.warn({ task: entry.id }, '任务 id 重复，忽略后续条目')
        continue
      }
      seen.add(entry.id)
      try {
        const rec = this._createEntry(entry)
        // 必须先入表再启动：exclusive 互斥判定遍历 this.tasks.values()，
        // 批次内尚未登记的任务不参与判定 → 两个常驻 exclusive 任务会同时启动（P1-3 实测）
        this.tasks.set(entry.id, rec)
        if (entry.schedule) {
          this._createSchedule(rec)
        } else if (entry.enabled !== false) {
          // 常驻任务 fire-and-forget：startTask 返回 run 完成 promise，不能 await（任务常驻）
          this.startTask(entry.id, rec).catch(err => this.log.error({ task: entry.id, err: err.message }, '任务启动失败'))
        }
      } catch (err) {
        this.log.error({ task: entry.id, err: err.message }, '任务装载失败')
      }
    }
  }

  /**
   * 热重载：与旧配置 diff，stop 移除的、start 新增的、restart 变化的。
   */
  async reload (cfg) {
    this.log.info('reloading tasks')
    const oldIds = new Set(this.tasks.keys())
    const newIds = new Set((cfg.tasks ?? []).map(e => e.id))
    const newMap = new Map((cfg.tasks ?? []).map(e => [e.id, e]))

    // 移除的
    for (const id of oldIds) {
      if (!newIds.has(id)) {
        await this.stopTask(id)
        this.tasks.get(id)?.cron?.stop() // F5：cron 定时器必须随任务移除而停止
        this.tasks.delete(id)
        this._stateStore?.deleteCounter?.(id) // C6/N：reload 移除同样清理计数器
      }
    }
    // 新增或变化的
    for (const id of newIds) {
      const entry = newMap.get(id)
      const old = this.tasks.get(id)
      if (!old || JSON.stringify(sortKeys(old.entry)) !== JSON.stringify(sortKeys(entry))) {
        await this.stopTask(id)
        this.tasks.get(id)?.cron?.stop() // F5
        try {
          const rec = this._createEntry(entry)
          this.tasks.set(id, rec) // 同 load：先入表再启动（exclusive 互斥判定依赖登记）
          // A5（第四轮）：reload 变更后计数器回灌（doRebuild 同款——此前重建/重载
          // 后 config 任务计数归零且快照覆写旧值，F5）
          this.restoreCounters(id, this._stateStore?.counters?.[id])
          if (entry.schedule) {
            this._createSchedule(rec)
          } else if (entry.enabled !== false) {
            this.startTask(id, rec).catch(err => this.log.error({ task: id, err: err.message }, '任务启动失败'))
          }
        } catch (err) {
          this.log.error({ task: id, err: err.message }, '任务装载失败')
        }
      }
    }
    // 移除/变更的任务其排队 rec 已陈旧——过滤（removeTask 有此清理，reload 漏了，
    // 否则队列项泄漏且 reload 后排队任务永不重新入队，永久停在 created）（P1-6）
    this._pendingExclusive = this._pendingExclusive.filter(r => this.tasks.get(r.entry.id) === r)
    this._syncStateTasks() // U1：reload 后 ad-hoc 条目集合可能变化
    this._snapshotCounters()
    this.cfg = cfg
    this._notifier = createNotifier(cfg, this.log) // U10：webhook 配置随 reload 更新
  }

  /**
   * 启动任务，返回 run 完成 Promise（B2）。
   * 已在运行/挂起 → 返回当前 run promise；终态 → 自动重置重启（F4）。
   * exclusive 互斥：其他 exclusive 任务运行中时拒绝启动（返回 null）。
   * @param {number} [maxMinutes] 时长上限（scheduled 触发直传；排队路径记录到
   *   rec.pendingMaxMinutes，drain 启动时补挂——E 修复：排队不再丢上限）
   * @returns {Promise<void>|null}
   */
  async startTask (id, rec, maxMinutes) {
    rec = rec ?? this.tasks.get(id)
    if (!rec) return null
    if (RUNNING_STATES.includes(rec.task.state)) return rec.task._runPromise ?? null

    if (rec.task.exclusive) {
      const busy = [...this.tasks.values()].find(r =>
        r !== rec && r.task.exclusive && RUNNING_STATES.includes(r.task.state))
      if (busy) {
        // 排队而非静默拒绝：冲突任务终态后自动补启动（此前被拒任务永远停在 created）
        this.log.warn({ task: id, conflict: busy.entry.id }, 'exclusive 任务运行中，排队等待')
        // E 修复：时长上限随排队记录保存——runScheduled 的 withTimeout 在排队时
        // 随函数栈丢弃（`if (!p) return`），巡逻类 scheduled 任务排队后永久运行
        rec.pendingMaxMinutes = maxMinutes ?? rec.pendingMaxMinutes ?? null
        this._pendingExclusive.push(rec)
        return null
      }
    }

    this.log.info({ task: id, type: rec.entry.type }, 'starting task')
    // C8/S：exclusive 任务启动时登记移动仲裁器（!follow 据此拒绝冲突跟随）
    if (rec.task.exclusive) setExclusiveOwner(rec.entry.id)
    const p = rec.task.start()
    // A1 代际捕获：start() 同步段已 _runGen++（async 函数首个 await 之前）——
    // releaseArbiter 需要比对"仍是本代"才清（防同 id 重启后旧代 run 晚 settle
    // 误清新一代的登记；第四轮验证确认的竞态）
    const startedGen = rec.task._runGen
    // 排队时保存的时长上限：drain 启动后补挂（与 runScheduled 直启路径同款到期语义）
    const pendingMinutes = rec.pendingMaxMinutes
    rec.pendingMaxMinutes = null
    if (pendingMinutes) {
      withTimeout(p, pendingMinutes * 60 * 1000, 'scheduled duration reached').then(
        () => { this._notify(rec, rec.task.state) }, // 自然完成（直启路径由 runScheduled 通知）
        () => this._expireQueuedScheduled(id, rec, pendingMinutes)
      )
    }
    // 任务终态（完成/失败/停止）时快照计数器（U1：遥测跨重启保留）；
    // 常驻任务完成/失败发聊天通知（scheduled 由 runScheduled 通知，跳过）
    const releaseArbiter = () => {
      // C8/S + A1：终态清除仲裁器登记。owner 匹配防"A 停→B 启"竞态误清 B；
      // 代际比对防同 id 重启后旧代 run 晚 settle 误清新一代登记（stop 超时强制
      // 结束路径下 run promise 可滞后新代数秒乃至永不 settle）
      if (rec.task.exclusive && rec.task._runGen === startedGen && getExclusiveOwner() === rec.entry.id) {
        setExclusiveOwner(null)
      }
    }
    Promise.resolve(p).then(
      () => { releaseArbiter(); this._drainExclusive(); this._snapshotCounters(); this._notifyCompletion(rec) },
      () => { releaseArbiter(); this._drainExclusive(); this._snapshotCounters(); this._notifyCompletion(rec) }
    )
    return p
  }

  /** 常驻任务终态通知：秒完成/失败不再静默（用户可感知"指令已生效/已结束"）。 */
  _notifyCompletion (rec) {
    if (rec.cron) return // scheduled 任务由 runScheduled 通知
    if (rec.entry.notifyChat === false) return
    if (rec.task.state === 'completed') {
      this._notify(rec, 'completed')
    } else if (rec.task.state === 'failed') {
      this._notify(rec, `failed: ${rec.task.lastError ?? '未知原因'}`)
    }
  }

  /** 指定任务是否在 exclusive 排队中（命令反馈用）。 */
  isPendingExclusive (id) {
    return this._pendingExclusive.some(r => r.entry.id === id)
  }

  /**
   * 排队启动的 scheduled 任务到期/失败处理（E：与 runScheduled 直启路径一致）。
   * withTimeout 对 p 自身 rejection 也 reject——按任务终态区分"到时"与"运行失败"，
   * 失败不再误报"时长到点"。
   */
  async _expireQueuedScheduled (id, rec, maxMinutes) {
    if (rec.task.state === 'failed') {
      this.log.warn({ task: id, err: rec.task.lastError }, 'scheduled 任务（排队启动）运行失败')
      this._notify(rec, `failed: ${rec.task.lastError ?? '未知原因'}`)
      return
    }
    try { await this.stopTask(id) } catch { /* 已停止 */ }
    this.log.info({ task: id, maxMinutes }, 'scheduled 任务（排队启动）到时停止')
    this._notify(rec, `stopped (duration ${maxMinutes}m)`)
  }

  /** 冲突任务终态后补启动排队的 exclusive 任务（FIFO，一次放行一个）。 */
  _drainExclusive () {
    while (this._pendingExclusive.length > 0) {
      const rec = this._pendingExclusive.shift()
      if (rec.task.state === 'created') {
        this.startTask(rec.entry.id, rec).catch(err =>
          this.log.error({ task: rec.entry.id, err: err.message }, '排队的 exclusive 任务启动失败'))
        return // 若仍冲突，startTask 会重新排队
      }
    }
  }

  /**
   * 调度触发入口（cron onTrigger）：防重叠 → 启动 → 时长上限 → 完成/失败通知。
   * @param {string} id
   * @param {number} [maxMinutes] 时长上限（到时强制停止；afk 等无自然完成类型必须配）
   */
  async runScheduled (id, maxMinutes) {
    const rec = this.tasks.get(id)
    if (!rec) return
    if (RUNNING_STATES.includes(rec.task.state)) {
      this.log.warn({ task: id }, 'scheduled 触发跳过：任务仍在运行（防重叠）')
      return
    }
    this.log.info({ task: id, maxMinutes }, 'scheduled trigger fired')
    // maxMinutes 透传 startTask：排队路径把上限记录到 rec.pendingMaxMinutes（E）
    const p = this.startTask(id, undefined, maxMinutes)
    if (!p) return // 排队：到期处理由 startTask 的 pendingMaxMinutes 路径完成

    if (maxMinutes) {
      try {
        await withTimeout(p, maxMinutes * 60 * 1000, 'scheduled duration reached')
      } catch {
        // withTimeout 对 p 自身 rejection 也会 reject——按任务终态区分：
        // 运行失败不再误报"时长到点"；失败也不得向上抛（croner 漂浮 rejection → fatal exit）
        if (rec.task.state === 'failed') {
          this.log.warn({ task: id, err: rec.task.lastError }, 'scheduled 任务运行失败')
          this._notify(rec, `failed: ${rec.task.lastError ?? '未知原因'}`)
          return
        }
        await this.stopTask(id)
        this.log.info({ task: id, maxMinutes }, 'scheduled 任务到时停止')
        this._notify(rec, `stopped (duration ${maxMinutes}m)`)
        return
      }
    } else {
      try {
        await p
      } catch (err) {
        // F 修复：run 协程 reject（base.js 失败路径返回已 reject 的 promise）不得上抛——
        // croner onTrigger 是 fire-and-forget（catch 选项默认 false）→ unhandledRejection
        // → fatalExit exit(2) 停服（NSSM 停止等人工）
        this.log.warn({ task: id, err: err.message }, 'scheduled 任务运行失败')
        this._notify(rec, `failed: ${rec.task.lastError ?? err.message}`)
        return
      }
    }
    this._notify(rec, rec.task.state)
  }

  /** 完成/失败通知（scheduled 运行；notifyChat:false 关闭聊天；webhook 独立于 notifyChat——运维通道）。 */
  _notify (rec, state) {
    if (rec.entry.notifyChat === false) return
    const counters = Object.keys(rec.task.counters).length
      ? ` ${JSON.stringify(rec.task.counters)}`
      : ''
    // 统一走 sendChat：剥 § 颜色码 + 256 分片（裸 bot.chat 超长会被服务端截断/拒绝）
    sendChat(this.ctx.bot, `[任务 ${rec.entry.id}] ${state}${counters}`, this.cfg.chat?.maxLength)
      .catch(err => this.log.warn({ err: err.message }, '完成通知发送失败'))
    // U10：webhook 推送（失败静默——不阻塞任务流程；不含聊天内容，只含任务摘要）
    this._notifier.send('task', `任务 ${rec.entry.id} (${rec.entry.type}) ${state}`, counters.trim())
    // U7：终态经 LLM 一句话总结（附加层——固定模板之后；全局 1 分钟冷却防刷屏；
    // 无 agent/失败/冷却中静默跳过，绝不阻塞任务流程）
    this._broadcastSummary(rec, state)
  }

  /** U7：任务终态 LLM 一句话总结。 */
  _broadcastSummary (rec, state) {
    if (!state || (!state.includes('completed') && !state.includes('failed'))) return
    const agent = this._getAgent?.()
    if (!agent?.summarize) return
    const now = Date.now()
    if (now - this._lastSummaryAt < SUMMARY_COOLDOWN_MS) return
    this._lastSummaryAt = now
    const counters = Object.keys(rec.task.counters).length ? JSON.stringify(rec.task.counters) : ''
    agent.summarize(
      `任务 ${rec.entry.id} (${rec.entry.type}) ${state}${counters ? `，计数 ${counters}` : ''}。用一句话向服务器玩家总结（成果或原因），简洁。`
    ).then((s) => {
      if (s) {
        sendChat(this.ctx.bot, `[任务 ${rec.entry.id}] ${s}`, this.cfg.chat?.maxLength)
          .catch(() => {})
      }
    }).catch(() => { /* 附加层：失败静默，模板已发 */ })
  }

  /**
   * 任务停止/终态时释放移动仲裁器（A1 根治：释放不得只依赖 run promise settle——
   * stop() 超时强制结束后 run 永不 settle → 释放点永不触发 → owner 泄漏 →
   * !follow 永久被拒（跨重连不愈）。owner 匹配守卫：只清自己的登记（防
   * "A 停→B 启"竞态误清 B；startTask 的 releaseArbiter 另有代际比对）。
   */
  _releaseArbiter (rec) {
    if (rec.task.exclusive && getExclusiveOwner() === rec.entry.id) setExclusiveOwner(null)
  }

  /**
   * 停止任务。注：!task stop 只停当前运行，cron 调度保持（下次触发重新启动）。
   * @returns {Promise<boolean>} 任务是否存在（命令层反馈用）
   */
  async stopTask (id) {
    const rec = this.tasks.get(id)
    if (!rec) return false
    this.log.info({ task: id }, 'stopping task')
    await rec.task.stop()
    this._releaseArbiter(rec) // A1：run 挂死（stop 超时）也不得泄漏 owner
    // A5（第四轮）：!task stop 排队中的 exclusive 任务（created 状态）——rec 留在
    // _pendingExclusive 会让 !task list 误报"排队中"、getStatus.queuePosition 误报
    // 位置（removeTask/reload 有此清理，stopTask 此前漏了，F4）
    this._pendingExclusive = this._pendingExclusive.filter(r => r !== rec)
    return true
  }

  /**
   * 暂停全部运行中任务（死亡处理器用）；返回被暂停的任务 id 列表。
   * 已暂停的跳过——death 处理器的恢复语义只恢复本次暂停的任务。
   */
  async pauseAll () {
    const paused = []
    for (const [id, rec] of this.tasks) {
      if (rec.task.state === 'init' || rec.task.state === 'running') {
        paused.push(id)
        await rec.task.pause()
      }
    }
    return paused
  }

  /** @returns {Promise<boolean>} 任务是否存在 */
  async pauseTask (id) {
    const rec = this.tasks.get(id)
    if (!rec) return false
    await rec.task.pause()
    return true
  }

  /** @returns {Promise<boolean>} 任务是否存在 */
  async resumeTask (id) {
    const rec = this.tasks.get(id)
    if (!rec) return false
    await rec.task.resume()
    return true
  }

  async stopAll () {
    // 并行停止（各任务 stop 上限 10s——串行 N×10s 会让重连后功能层空窗过长）
    await Promise.all([...this.tasks.values()].map(async (rec) => {
      rec.cron?.stop()
      await rec.task.stop()
      this._releaseArbiter(rec) // A1：teardown 路径同款释放（stop 超时也不泄漏）
    }))
    this._snapshotCounters() // U1：停止前快照终态计数（tasks 随后清空）
    this.tasks.clear()
    this._pendingExclusive = []
  }

  /** 快照持久化：ad-hoc 条目 + 全量计数器（U1）。 */
  _syncStateTasks () {
    // 可选调用：stateStore 可能为 null 或缺方法（测试/降级路径）——不得抛错打断任务流程
    this._stateStore?.setTasks?.(
      [...this.tasks.values()].filter(r => r.entry.adHoc === true).map(r => r.entry)
    )
  }

  /** 快照全量计数器（任务数少，全量写即可）。 */
  _snapshotCounters () {
    if (!this._stateStore) return
    for (const [id, rec] of this.tasks) {
      this._stateStore.setCounter?.(id, rec.task.counters)
    }
  }

  /**
   * 运行时新增任务（!task new；不持久化到配置，U1 起写入状态快照跨重启保留）。
   * @returns {{ entry, task, cron }} 新条目
   */
  addTask (entry) {
    if (this.tasks.has(entry.id)) throw new Error(`任务 id 已存在: ${entry.id}`)
    const rec = this._createEntry(entry)
    rec.entry.adHoc = true // U1：标记运行时新增（快照持久化用；配置条目不标记）
    this.tasks.set(entry.id, rec)
    if (entry.schedule) {
      this._createSchedule(rec)
    } else if (entry.enabled !== false) {
      this.startTask(entry.id, rec).catch(err => this.log.error({ task: entry.id, err: err.message }, '任务启动失败'))
    }
    this.log.info({ task: entry.id, type: entry.type }, 'ad-hoc task added')
    this._syncStateTasks()
    return rec
  }

  /** 运行时移除任务（!task remove；cron 一并停止）。 */
  async removeTask (id) {
    const rec = this.tasks.get(id)
    if (!rec) throw new Error(`任务不存在: ${id}`)
    rec.cron?.stop()
    await rec.task.stop()
    this._releaseArbiter(rec) // A1：移除路径同款释放
    this.tasks.delete(id)
    this._pendingExclusive = this._pendingExclusive.filter(r => r !== rec)
    // C6/N：计数器随任务移除清理（此前快照只写不删 → state.json 垃圾数据无限增长）
    this._stateStore?.deleteCounter?.(id)
    this.log.info({ task: id }, 'ad-hoc task removed')
    this._syncStateTasks()
  }

  /** 快照计数器回灌（C6/N：重建后 ad-hoc 任务的遥测跨重启保留——此前只写不读）。 */
  restoreCounters (id, counters) {
    const rec = this.tasks.get(id)
    if (rec && counters && typeof counters === 'object') {
      rec.task.counters = { ...counters }
    }
  }

  getStatus () {
    const now = Date.now()
    return [...this.tasks.values()].map((rec) => {
      const st = rec.task.getStatus()
      // U8：调度增强字段（!task list 展示）——排队位置/时长剩余/下次 cron 触发
      const queuePos = this._pendingExclusive.indexOf(rec)
      st.queuePosition = queuePos >= 0 ? queuePos + 1 : null // 1-based
      const maxMinutes = rec.entry.durationMinutes ?? rec.entry.options?.durationMinutes
      if (maxMinutes && st.startedAt && ['init', 'running', 'paused'].includes(st.state)) {
        const elapsedMs = now - st.startedAt
        st.remainingMinutes = Math.max(0, Math.round((maxMinutes * 60 * 1000 - elapsedMs) / 60000 * 10) / 10)
      }
      st.nextRunAt = rec.cron?.nextRun ? (rec.cron.nextRun() ?? null) : null
      return st
    })
  }
}
