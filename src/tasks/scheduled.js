import { Cron } from 'croner'

/**
 * 为带 schedule 的任务创建 croner 调度。
 * @param {{ schedule: string, id: string }} taskEntry
 * @param {{ onStart: () => Promise<void>, onStop: () => Promise<void> }} handlers
 * @param {object} logger
 * @returns {import('croner').Cron|null} 无 schedule 时返回 null
 */
export function createTaskSchedule (taskEntry, { onStart, onStop }, logger, timezone = 'Asia/Shanghai') {
  if (!taskEntry.schedule) return null
  try {
    return new Cron(taskEntry.schedule, { timezone }, async () => {
      logger.info({ task: taskEntry.id, schedule: taskEntry.schedule }, 'cron fired')
      await onStart()
      // 简单语义：调度触发启动后，任务 run 结束（到时/完成）即自然停止
      await onStop()
    })
  } catch (err) {
    logger.error({ task: taskEntry.id, schedule: taskEntry.schedule, err: err.message }, 'invalid cron expression')
    return null
  }
}
