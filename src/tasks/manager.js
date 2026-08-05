import fs from 'node:fs'
import { MineTask } from './mine.js'
import { FishTask } from './fish.js'
import { AfkTask } from './afk.js'
import { createTaskSchedule } from './scheduled.js'

const TASK_TYPES = {
  mine: (id, options, ctx) => new MineTask(id, 'mine', options, ctx),
  fish: (id, options, ctx) => new FishTask(id, 'fish', options, ctx),
  afk: (id, options, ctx) => new AfkTask(id, 'afk', options, ctx)
}

/**
 * 任务管理器：装载/启动/停止/热重载/cron 调度。
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
    this._watcher = null
    this._reloadTimer = null
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

  /**
   * 按配置装载全部任务。调度语义：有 schedule → cron 触发；否则 enabled 立即启动。
   */
  async load (cfg) {
    this.cfg = cfg
    await this.stopAll()
    for (const entry of cfg.tasks ?? []) {
      if (!entry.id || !entry.type) {
        this.log.warn('忽略无效任务条目（缺 id/type）: %o', entry)
        continue
      }
      try {
        const rec = this._createEntry(entry)
        if (entry.schedule) {
          rec.cron = createTaskSchedule(entry, {
            onStart: () => this.startTask(entry.id),
            onStop: () => this.stopTask(entry.id)
          }, this.log)
        } else if (entry.enabled !== false) {
          await this.startTask(entry.id, rec)
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
        this.tasks.delete(id)
      }
    }
    // 新增或变化的
    for (const id of newIds) {
      const entry = newMap.get(id)
      const old = this.tasks.get(id)
      if (!old || JSON.stringify(old.entry) !== JSON.stringify(entry)) {
        await this.stopTask(id)
        try {
          const rec = this._createEntry(entry)
          if (entry.schedule) {
            rec.cron = createTaskSchedule(entry, {
              onStart: () => this.startTask(entry.id),
              onStop: () => this.stopTask(entry.id)
            }, this.log)
          } else if (entry.enabled !== false) {
            await this.startTask(entry.id, rec)
          }
          this.tasks.set(id, rec)
        } catch (err) {
          this.log.error({ task: id, err: err.message }, '任务装载失败')
        }
      }
    }
    this.cfg = cfg
  }

  /** 监视配置文件变化（防抖 500ms），触发 reload。返回取消函数。 */
  startHotReload (file, reloadFn) {
    if (this._watcher) return
    this._watcher = fs.watch(file, () => {
      clearTimeout(this._reloadTimer)
      this._reloadTimer = setTimeout(() => {
        this.log.info('config file changed, hot reloading')
        reloadFn().catch((err) => this.log.error({ err: err.message }, 'hot reload failed'))
      }, 500)
    })
    return () => {
      this._watcher?.close()
      this._watcher = null
    }
  }

  async startTask (id, rec) {
    rec = rec ?? this.tasks.get(id)
    if (!rec) return
    if (rec.task.state !== 'created') return
    this.log.info({ task: id, type: rec.entry.type }, 'starting task')
    rec.task.start() // 不 await：任务常驻运行
  }

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

  getStatus () {
    return [...this.tasks.values()].map(rec => rec.task.getStatus())
  }
}
