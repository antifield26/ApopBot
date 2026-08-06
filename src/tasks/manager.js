import { MineTask } from './mine.js'
import { FishTask } from './fish.js'
import { AfkTask } from './afk.js'
import { FarmTask } from './farm.js'
import { ChopTask } from './chop.js'
import { CombatTask } from './combat.js'
import { BreedTask } from './breed.js'
import { createTaskSchedule } from './scheduled.js'
import { withTimeout } from '../util/promise-timeout.js'
import { sendChat } from '../core/chat.js'

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
  breed: (id, options, ctx) => new BreedTask(id, 'breed', options, ctx)
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
  constructor (cfg, logger, ctx, stateStore = null) {
    this.cfg = cfg
    this.log = logger.child({ module: 'tasks' })
    this.ctx = ctx
    this.tasks = new Map() // id → { entry, task, cron }
    this._pendingExclusive = [] // 被 exclusive 互斥拒绝的任务（冲突任务终态后按序补启动）
    this._stateStore = stateStore
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
  }

  /**
   * 启动任务，返回 run 完成 Promise（B2）。
   * 已在运行/挂起 → 返回当前 run promise；终态 → 自动重置重启（F4）。
   * exclusive 互斥：其他 exclusive 任务运行中时拒绝启动（返回 null）。
   * @returns {Promise<void>|null}
   */
  async startTask (id, rec) {
    rec = rec ?? this.tasks.get(id)
    if (!rec) return null
    if (RUNNING_STATES.includes(rec.task.state)) return rec.task._runPromise ?? null

    if (rec.task.exclusive) {
      const busy = [...this.tasks.values()].find(r =>
        r !== rec && r.task.exclusive && RUNNING_STATES.includes(r.task.state))
      if (busy) {
        // 排队而非静默拒绝：冲突任务终态后自动补启动（此前被拒任务永远停在 created）
        this.log.warn({ task: id, conflict: busy.entry.id }, 'exclusive 任务运行中，排队等待')
        this._pendingExclusive.push(rec)
        return null
      }
    }

    this.log.info({ task: id, type: rec.entry.type }, 'starting task')
    const p = rec.task.start()
    // 任务终态（完成/失败/停止）时快照计数器（U1：遥测跨重启保留）
    Promise.resolve(p).then(
      () => { this._drainExclusive(); this._snapshotCounters() },
      () => { this._drainExclusive(); this._snapshotCounters() }
    )
    return p
  }

  /** 指定任务是否在 exclusive 排队中（命令反馈用）。 */
  isPendingExclusive (id) {
    return this._pendingExclusive.some(r => r.entry.id === id)
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
    const p = this.startTask(id)
    if (!p) return

    if (maxMinutes) {
      try {
        await withTimeout(p, maxMinutes * 60 * 1000, 'scheduled duration reached')
      } catch {
        await this.stopTask(id)
        this.log.info({ task: id, maxMinutes }, 'scheduled 任务到时停止')
        this._notify(rec, `stopped (duration ${maxMinutes}m)`)
        return
      }
    } else {
      await p
    }
    this._notify(rec, rec.task.state)
  }

  /** 完成/失败通知（scheduled 运行；notifyChat:false 关闭）。 */
  _notify (rec, state) {
    if (rec.entry.notifyChat === false) return
    const counters = Object.keys(rec.task.counters).length
      ? ` ${JSON.stringify(rec.task.counters)}`
      : ''
    // 统一走 sendChat：剥 § 颜色码 + 256 分片（裸 bot.chat 超长会被服务端截断/拒绝）
    sendChat(this.ctx.bot, `[任务 ${rec.entry.id}] ${state}${counters}`, this.cfg.chat?.maxLength)
      .catch(err => this.log.warn({ err: err.message }, '完成通知发送失败'))
  }

  /**
   * 停止任务。注：!task stop 只停当前运行，cron 调度保持（下次触发重新启动）。
   */
  async stopTask (id) {
    const rec = this.tasks.get(id)
    if (!rec) return
    this.log.info({ task: id }, 'stopping task')
    await rec.task.stop()
  }

  async pauseTask (id) {
    const rec = this.tasks.get(id)
    await rec?.task.pause()
  }

  async resumeTask (id) {
    const rec = this.tasks.get(id)
    await rec?.task.resume()
  }

  async stopAll () {
    // 并行停止（各任务 stop 上限 10s——串行 N×10s 会让重连后功能层空窗过长）
    await Promise.all([...this.tasks.values()].map(async (rec) => {
      rec.cron?.stop()
      await rec.task.stop()
    }))
    this._snapshotCounters() // U1：停止前快照终态计数（tasks 随后清空）
    this.tasks.clear()
    this._pendingExclusive = []
  }

  /** 快照持久化：ad-hoc 条目 + 全量计数器（U1）。 */
  _syncStateTasks () {
    this._stateStore?.setTasks(
      [...this.tasks.values()].filter(r => r.entry.adHoc === true).map(r => r.entry)
    )
  }

  /** 快照全量计数器（任务数少，全量写即可）。 */
  _snapshotCounters () {
    if (!this._stateStore) return
    for (const [id, rec] of this.tasks) {
      this._stateStore.setCounter(id, rec.task.counters)
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
    this.tasks.delete(id)
    this._pendingExclusive = this._pendingExclusive.filter(r => r !== rec)
    this.log.info({ task: id }, 'ad-hoc task removed')
    this._syncStateTasks()
  }

  getStatus () {
    return [...this.tasks.values()].map(rec => rec.task.getStatus())
  }
}
