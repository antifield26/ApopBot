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
import { sendChat } from '../core/chat.js'
const { goals } = pathfinderPkg

const TICK_MS = 500 // 控制周期
const REACH = 2.5 // 与目标距离小于此视为已跟上（停下）
const DIRECT_RANGE = 6 // 此距离内用直接控制（跳跃可用）；更远走寻路
const STUCK_TICKS = 6 // 直接控制 N 轮（3s）无位移 → 切寻路绕行
const PATH_UPDATE_DIST = 2 // 寻路模式下目标位移超过此值才重建 goal（低配机避免每 tick 重算 A*）
// 重建冷却：pathfinder 的 setGoal 会 resetPath（清路径 + 丢进行中 A* 分片 + 停控制）——
// 目标持续移动时每 2 格就重建会让 A* 永远算不完 → 原地不动（实测回归）。
// 位移 2 格 + 冷却 1.5s 双条件：A* 有 1.5s 计算窗口（40ms/tick ≈ 37 分片）
const GOAL_RECALC_COOLDOWN_MS = 1500
// 跳跃判定（用户反馈）：按移动方向前方的方块，而非目标高度差——
// 目标在平地上但 Bot 面前有 1 格台阶（y 差 < 0.6）时目标高度判定不触发跳跃 →
// 被挡停在方块前；目标远处在高处时又持续无效跳跃。改为前方 1 格（Bot 脚部同层）
// 实心 = 台阶/墙/坡 → 持续跳跃直到越过（连续 2 tick 前方空才松开，防跳跃中瞬时误判）
const JUMP_CLEAR_TICKS = 2

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
  let lastGoalTime = 0 // 上次重建寻路目标的时间戳（冷却防 A* 重置风暴）
  let jumpHeld = false // 跳跃按住状态（前方方块实心时持续跳，越过障碍后松开）
  let jumpClearTicks = 0 // 前方空连续 tick 计数（防跳跃过程中瞬时误判松开）

  function stopMoving () {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }

  function clearGoal () {
    try { bot.pathfinder?.setGoal(null) } catch { /* 插件可能已卸载 */ }
  }

  /** 移动方向前方 1 格（Bot 脚部同层）是实心障碍 → 需要跳跃（台阶/墙/坡）。
   * 注意用 sign 偏移：dx/dz 是方向余弦（<1），直接 offset 后 floor 会落在脚下格。 */
  function shouldJump (p, dx, dz) {
    const ahead = bot.blockAt(p.offset(Math.sign(dx), 0, Math.sign(dz)))
    if (!ahead || ahead.boundingBox === 'empty') return false
    return ahead.name !== 'water' && ahead.name !== 'lava'
  }

  /** 按前方方块检测更新跳跃按住状态（sticky：越过障碍连续 2 tick 前方空才松开）。 */
  function updateJump (p, dx, dz) {
    if (shouldJump(p, dx, dz)) {
      jumpHeld = true
      jumpClearTicks = 0
    } else if (jumpHeld) {
      jumpClearTicks++
      if (jumpClearTicks >= JUMP_CLEAR_TICKS) jumpHeld = false
    }
    bot.setControlState('jump', jumpHeld)
  }

  function tick () {
    if (!target?.position || !bot.entity?.position) { stopMoving(); return }
    const p = bot.entity.position
    const tp = target.position
    const dist = p.distanceTo(tp)
    const yDiff = tp.y - p.y

    if (dist <= REACH) {
      // 已跟上：停下；目标在 Bot 上方（高台上）时补跳对齐（按前方方块判定——
      // 台壁在前方即跳）。必须清残留寻路 goal——否则 pathfinder 的 monitorMovement
      // 每 physicsTick 覆盖控制状态继续走向旧目标（双控制器冲突 → 跟随失效/原地不动）
      stopMoving()
      pathing = false
      clearGoal()
      lastPos = p.clone()
      stuckCount = 0
      jumpHeld = false
      jumpClearTicks = 0
      const dx = dist > 0 ? (tp.x - p.x) / dist : 0
      const dz = dist > 0 ? (tp.z - p.z) / dist : 0
      bot.setControlState('jump', yDiff > 0.3 && shouldJump(p, dx, dz))
      return
    }

    try { bot.lookAt(tp.offset(0, 0.5, 0)) } catch { /* 位置可能失效 */ }

    if (dist < DIRECT_RANGE && !pathing) {
      // 直接控制：前进 + 前方方块检测跳跃（解决 GoalFollow 不跳导致丢失跟随的问题；
      // 用户反馈：跳跃触发应按移动方向前方的方块，而非目标高度差——目标平地上
      // 有 1 格台阶时 y 差判定不跳被挡住停下，目标远处高处又持续无效跳跃）
      bot.setControlState('forward', true)
      const dx = (tp.x - p.x) / dist
      const dz = (tp.z - p.z) / dist
      updateJump(p, dx, dz)
      // 前方 2 格是虚空/未加载（直走会掉落）→ 切寻路（无条件，跳跃中也防跳崖）；
      // 同 sign 偏移：余弦偏移 floor 会落在脚下格
      const ahead = bot.blockAt(p.offset(Math.sign(dx) * 2, -1, Math.sign(dz) * 2))
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
      // 寻路绕行：目标位移超阈值 + 冷却双条件才重建 goal——setGoal 会 resetPath
      //（清路径 + 丢进行中 A* 分片 + 停控制），目标持续移动时无冷却地重建会让
      // A* 永远算不完 → 原地不动（实测回归）
      stopMoving()
      pathing = true
      jumpHeld = false
      const moved = lastGoalPos && tp.distanceTo(lastGoalPos) > PATH_UPDATE_DIST
      const cooled = Date.now() - lastGoalTime > GOAL_RECALC_COOLDOWN_MS
      if (!lastGoalPos || (moved && cooled)) {
        // GoalNear 构造签名 (x, y, z, range)——传 Vec3 单参会得到 NaN goal
        //（Math.floor(Vec3)=NaN → A* 行为异常 → 原地不动，实测回归）
        try { bot.pathfinder.setGoal(new goals.GoalNear(tp.x, tp.y, tp.z, 1)) } catch { /* 未在移动 */ }
        lastGoalPos = tp.clone()
        lastGoalTime = Date.now()
      }
      if (dist < DIRECT_RANGE * 0.5) {
        // 回到直接控制前必须停 pathfinder——否则其 monitorMovement 每 physicsTick
        // 覆盖 setControlState（双控制器打架 → 跟随失效/原地不动）
        pathing = false
        clearGoal()
      }
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
      // 目标掉线/死亡/传送——静默停止会让玩家以为还在跟随，聊天提示（P3）。
      // 统一走 sendChat：剥 § 颜色码（裸 bot.chat 的 § 会被 Paper 踢出——P0 回归）
      sendChat(bot, `§e已停止跟随 ${name}（目标消失）`).catch(() => { /* 聊天通道未就绪 */ })
    }
  })

  bot.on('end', () => {
    target = null
    jumpHeld = false
    if (timer) { clearInterval(timer); timer = null }
  })
}
