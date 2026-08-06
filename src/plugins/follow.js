// 自定义插件：跟随指定玩家（供 !follow 命令使用）。
//
// 实现：混合跟随。pathfinder 的 GoalFollow 基于 A*，其动作集不含跳跃——目标跳过
// 障碍/跳上台阶后 Bot 无法到达（实测丢失跟随）。故近距离用 setControlState 直接
// 控制（前进 + 爬升跳跃 sticky jump），卡住（原地无位移）/目标远离/前方虚空时切
// pathfinder 寻路绕行，接近后回到直接控制。
// sticky jump：目标高于阈值（0.6 格）时持续按住跳跃键直到高度差修正（≤0.3 格），
// 而不是每 tick 用瞬时差判断——跟随延迟下目标 y 数据滞后，瞬时差波动会导致跳跃
// 被错误松开、只跳一次且跳在滞后位置（实测反馈）。
//
// 分层说明：本插件是独立于任务/命令体系的 setInterval 直接控制层（近距离
// setControlState，远距才借用 pathfinder）。统一移动层（src/core/movement.js）
// 服务于任务/命令体系（goto/approachEntity）。二者经"任务 exclusive 互斥 +
// follow 手动开关"隔离，互不调用——follow 的实时性要求不适合任务体系的可取消
// 移动封装。

import pathfinderPkg from 'mineflayer-pathfinder' // CJS 包：default 导入后解构（ESM named 互操作不可靠）
const { goals } = pathfinderPkg

const TICK_MS = 500 // 控制周期
const REACH = 2.5 // 与目标距离小于此视为已跟上（停下）
const DIRECT_RANGE = 6 // 此距离内用直接控制（跳跃可用）；更远走寻路
const JUMP_Y_DIFF = 0.6 // 目标高于 Bot 超过此值 → 持续跳跃（跳上台阶/矮墙）
const STUCK_TICKS = 6 // 直接控制 N 轮（3s）无位移 → 切寻路绕行
const PATH_UPDATE_DIST = 2 // 寻路模式下目标位移超过此值才重建 goal（低配机避免每 tick 重算 A*）

/**
 * mineflayer 插件工厂。装载后产生 bot.follow = { setTarget(player|null), stop(), getTarget() }。
 */
export function followPlugin (bot) {
  let target = null
  let timer = null
  let lastPos = null
  let stuckCount = 0
  let pathing = false
  let lastGoalPos = null
  let jumpHeld = false // 爬升模式（sticky jump）：目标高于阈值时持续按住跳跃键

  function stopMoving () {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }

  function clearGoal () {
    try { bot.pathfinder?.setGoal(null) } catch { /* 插件可能已卸载 */ }
  }

  function tick () {
    if (!target?.position || !bot.entity?.position) { stopMoving(); return }
    const p = bot.entity.position
    const tp = target.position
    const dist = p.distanceTo(tp)
    const yDiff = tp.y - p.y

    if (dist <= REACH) {
      // 已跟上：停下；目标在 Bot 上方（高台上）时补一次跳跃对齐
      stopMoving()
      pathing = false
      lastPos = p.clone()
      stuckCount = 0
      jumpHeld = false
      bot.setControlState('jump', yDiff > 1.1)
      return
    }

    try { bot.lookAt(tp.offset(0, 0.5, 0)) } catch { /* 位置可能失效 */ }

    if (dist < DIRECT_RANGE && !pathing) {
      // 直接控制：前进 + 爬升跳跃（解决 GoalFollow 不跳导致丢失跟随的问题）。
      // sticky jump：目标高于阈值 → 持续按住跳跃键直到高度差修正（≤0.3）。
      // 此前每 tick 用瞬时差判断——跟随延迟下目标 y 数据滞后，瞬时差波动导致
      // 跳跃被错误松开，Bot 只跳一次且跳在滞后位置（实测反馈）
      bot.setControlState('forward', true)
      if (yDiff > JUMP_Y_DIFF) {
        jumpHeld = true
      } else if (yDiff <= 0.3) {
        jumpHeld = false // 高度已修正，停止跳跃（缓坡 0.3-0.6 不跳）
      }
      bot.setControlState('jump', jumpHeld)
      // 前方 2 格是虚空/未加载（直走会掉落）→ 切寻路（无条件，爬升中也防跳崖）
      const dx = (tp.x - p.x) / dist
      const dz = (tp.z - p.z) / dist
      const ahead = bot.blockAt(p.offset(dx * 2, -1, dz * 2))
      // 卡住检测：爬升中看 y 位移（贴墙跳时水平位移小会被误判卡住）；否则看水平位移
      const movedY = jumpHeld && lastPos ? Math.abs(p.y - lastPos.y) > 0.15 : false
      const moved = !jumpHeld && lastPos && p.distanceTo(lastPos) > 0.2
      lastPos = p.clone()
      stuckCount = moved || movedY ? 0 : stuckCount + 1
      if (stuckCount >= STUCK_TICKS || !ahead) {
        stopMoving()
        pathing = true
        lastGoalPos = null
        jumpHeld = false
      }
    } else {
      // 寻路绕行：目标位移超阈值才重建 goal
      stopMoving()
      pathing = true
      jumpHeld = false
      const moved = lastGoalPos && tp.distanceTo(lastGoalPos) > PATH_UPDATE_DIST
      if (!lastGoalPos || moved) {
        try { bot.pathfinder.setGoal(new goals.GoalNear(tp, 1)) } catch { /* 未在移动 */ }
        lastGoalPos = tp.clone()
      }
      if (dist < DIRECT_RANGE * 0.5) pathing = false // 足够近后回到直接控制
    }
  }

  const follow = {
    /** @param {import('mineflayer').Entity|null} player */
    setTarget (player) {
      target = player
      if (!player) {
        follow.stop()
        return
      }
      if (!bot.pathfinder) throw new Error('follow 插件需要 pathfinder')
      stopMoving()
      clearGoal()
      lastPos = null
      stuckCount = 0
      pathing = false
      lastGoalPos = null
      if (!timer) {
        timer = setInterval(tick, TICK_MS)
        timer.unref?.()
      }
    },

    getTarget () {
      return target
    },

    stop () {
      target = null
      jumpHeld = false
      if (timer) { clearInterval(timer); timer = null }
      stopMoving()
      clearGoal()
    }
  }

  bot.follow = follow

  bot.on('entityGone', (entity) => {
    if (target && entity.id === target.id) {
      const name = target.username ?? target.name ?? `实体#${target.id}`
      follow.stop()
      // 目标掉线/死亡/传送——静默停止会让玩家以为还在跟随，聊天提示（P3）
      try { bot.chat(`§e已停止跟随 ${name}（目标消失）`) } catch { /* 聊天通道未就绪 */ }
    }
  })

  bot.on('end', () => {
    target = null
    jumpHeld = false
    if (timer) { clearInterval(timer); timer = null }
  })
}
