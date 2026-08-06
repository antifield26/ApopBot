// 自定义插件：跟随指定玩家（供 !follow 命令使用）。依赖 pathfinder。

import pathfinderPkg from 'mineflayer-pathfinder' // CJS 包：default 导入后解构（ESM named 互操作不可靠）
const { goals } = pathfinderPkg

/**
 * mineflayer 插件工厂。装载后产生 bot.follow = { setTarget(player|null), stop() }。
 */
export function followPlugin (bot) {
  let target = null
  let goalHandle = null

  function stopGoal () {
    if (goalHandle) {
      bot.pathfinder.setGoal(null)
      goalHandle = null
    }
  }

  const follow = {
    /** @param {import('mineflayer').Entity|null} player */
    setTarget (player) {
      target = player
      if (!player) {
        stopGoal()
        return
      }
      if (!bot.pathfinder) throw new Error('follow 插件需要 pathfinder')
      // 注意：goals 类从包导出获取——bot.pathfinder 是插件注入的普通对象，其上无 goals
      goalHandle = new goals.GoalFollow(player, 3)
      bot.pathfinder.setGoal(goalHandle, true)
    },

    getTarget () {
      return target
    },

    stop () {
      target = null
      stopGoal()
    }
  }

  bot.follow = follow

  bot.on('entityGone', (entity) => {
    if (target && entity.id === target.id) follow.stop()
  })

  bot.on('end', () => {
    target = null
    goalHandle = null
  })
}
