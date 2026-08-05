import { Cron } from 'croner'

/**
 * 为带 schedule 的任务创建 croner 调度（B2 修复：单一 onTrigger 回调）。
 *
 * 背景：早期实现让 cron 回调依次 await onStart/onStop，而 onStart 是 fire-and-forget
 * 的 startTask —— onStop 在 run 协程恢复前就设置了 _stopRequested，任务从未真正运行。
 * 修复：cron 只调用 onTrigger（manager.runScheduled），由它负责启动、时长上限与
 * 完成通知；run 完成语义由 BaseTask.start() 的返回 Promise 保证。
 *
 * @param {{ schedule: string, id: string }} taskEntry
 * @param {{ onTrigger: () => Promise<void> }} handlers
 * @param {object} logger
 * @param {string} timezone 调度时区（默认 Asia/Shanghai）
 * @returns {import('croner').Cron|null} 无 schedule 时返回 null
 */
export function createTaskSchedule (taskEntry, { onTrigger }, logger, timezone = 'Asia/Shanghai') {
  if (!taskEntry.schedule) return null
  try {
    return new Cron(taskEntry.schedule, { timezone }, async () => {
      logger.info({ task: taskEntry.id, schedule: taskEntry.schedule }, 'cron fired')
      await onTrigger()
    })
  } catch (err) {
    logger.error({ task: taskEntry.id, schedule: taskEntry.schedule, err: err.message }, 'invalid cron expression')
    return null
  }
}
