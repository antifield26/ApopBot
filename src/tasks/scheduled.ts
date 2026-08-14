import { Cron } from 'croner'

/**
 * 为带 schedule 的任务创建 croner 调度（单一 onTrigger 回调）。
 *
 * cron 只调用 onTrigger（manager.runScheduled），由它负责启动、时长上限与完成
 * 通知；run 完成语义由 BaseTask.start() 的返回 Promise 保证。回调不得拆成
 * onStart/onStop 两步依次 await——onStart 是 fire-and-forget，onStop 会在 run
 * 协程恢复前设置 _stopRequested，任务将从未真正运行。
 *
 * @param {{ schedule: string, id: string }} taskEntry
 * @param {{ onTrigger: () => Promise<void> }} handlers
 * @param {import('pino').Logger} logger
 * @param {string} timezone 调度时区（默认 Asia/Shanghai）
 * @returns {import('croner').Cron|null} 无 schedule 时返回 null
 */
export function createTaskSchedule (taskEntry, { onTrigger }, logger, timezone = 'Asia/Shanghai') {
  if (!taskEntry.schedule) return null
  try {
    return new Cron(taskEntry.schedule, { timezone }, async () => {
      logger.info({ task: taskEntry.id, schedule: taskEntry.schedule }, 'cron fired')
      try {
        await onTrigger()
      } catch (err) {
        // croner 9.1.0 的 catch 选项默认 false——async onTrigger 抛错即
        // unhandledRejection → fatalExit exit(2) 停服。当前不变量（runScheduled
        // 永不 reject）依赖"每次改动都不经 catch 的 await"，任一回归即整机停服——
        // 此处显式承错作为纵深防线（log + 不抛），防的是不变量被破坏的回归面
        logger.error({ task: taskEntry.id, err: err.message }, 'scheduled 触发异常（已承接，防止漂浮 rejection 停服）')
      }
    })
  } catch (err) {
    logger.error({ task: taskEntry.id, schedule: taskEntry.schedule, err: err.message }, 'invalid cron expression')
    return null
  }
}
