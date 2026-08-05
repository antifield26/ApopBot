import { MineTask } from './mine.js'
import { FishTask } from './fish.js'
import { AfkTask } from './afk.js'
import { FarmTask } from './farm.js'
import { ChopTask } from './chop.js'
import { CombatTask } from './combat.js'
import { BreedTask } from './breed.js'
import { createTaskSchedule } from './scheduled.js'
import { withTimeout } from '../util/promise-timeout.js'

const TASK_TYPES = {
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
   */
  constructor (cfg, logger, ctx) {
    this.cfg = cfg
    this.log = logger.child({ module: 'tasks' })
    this.ctx = ctx
    this.tasks = new Map() // id → { entry, task, cron }
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
        if (entry.schedule) {
          this._createSchedule(rec)
        } else if (entry.enabled !== false) {
          // 常驻任务 fire-and-forget：startTask 返回 run 完成 promise，不能 await（任务常驻）
          this.startTask(entry.id, rec).catch(err => this.log.error({ task: entry.id, err: err.message }, '任务启动失败'))
        }
        this.tasks.set(entry.id, rec)
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
      if (!old || JSON.stringify(old.entry) !== JSON.stringify(entry)) {
        await this.stopTask(id)
        this.tasks.get(id)?.cron?.stop() // F5
        try {
          const rec = this._createEntry(entry)
          if (entry.schedule) {
            this._createSchedule(rec)
          } else if (entry.enabled !== false) {
            this.startTask(id, rec).catch(err => this.log.error({ task: id, err: err.message }, '任务启动失败'))
          }
          this.tasks.set(id, rec)
        } catch (err) {
          this.log.error({ task: id, err: err.message }, '任务装载失败')
        }
      }
    }
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
        this.log.warn({ task: id, conflict: busy.entry.id }, 'exclusive 任务运行中，拒绝启动')
        return null
      }
    }

    this.log.info({ task: id, type: rec.entry.type }, 'starting task')
    const p = rec.task.start()
    return p
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
    try {
      this.ctx.bot?.chat(`[任务 ${rec.entry.id}] ${state}${counters}`)
    } catch (err) {
      this.log.warn({ err: err.message }, '完成通知发送失败')
    }
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
    for (const rec of this.tasks.values()) {
      rec.cron?.stop()
      await rec.task.stop()
    }
    this.tasks.clear()
  }

  /**
   * 运行时新增任务（!task new；不持久化到配置）。
   * @returns {{ entry, task, cron }} 新条目
   */
  addTask (entry) {
    if (this.tasks.has(entry.id)) throw new Error(`任务 id 已存在: ${entry.id}`)
    const rec = this._createEntry(entry)
    this.tasks.set(entry.id, rec)
    if (entry.schedule) {
      this._createSchedule(rec)
    } else if (entry.enabled !== false) {
      this.startTask(entry.id, rec).catch(err => this.log.error({ task: entry.id, err: err.message }, '任务启动失败'))
    }
    this.log.info({ task: entry.id, type: entry.type }, 'ad-hoc task added')
    return rec
  }

  /** 运行时移除任务（!task remove；cron 一并停止）。 */
  async removeTask (id) {
    const rec = this.tasks.get(id)
    if (!rec) throw new Error(`任务不存在: ${id}`)
    rec.cron?.stop()
    await rec.task.stop()
    this.tasks.delete(id)
    this.log.info({ task: id }, 'ad-hoc task removed')
  }

  getStatus () {
    return [...this.tasks.values()].map(rec => rec.task.getStatus())
  }
}
