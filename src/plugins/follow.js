// 自定义插件：跟随指定玩家（供 !follow 命令使用）。依赖 pathfinder。

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
      const { goals } = bot.pathfinder
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
