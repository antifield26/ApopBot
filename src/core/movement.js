// @ts-check
// 统一移动/寻路层：任务与命令体系共用的寻路封装（follow 的近距离直接控制独立，
// 见 follow.js 文件头分层说明）。
//
// 职责：统一 Movements 配置（集中一处）、统一清理、goto 到达/失败语义、多候选点
// 寻路（GoalCompositeAny）、实体接近（approachEntity）、地表候选查询（!find）。
// 所有移动方法返回 { ok: true } | { ok: false, reason, err? }——不抛异常（与技能层
// execute 风格一致）。
//
// 可取消性：isInterrupted 谓词 + 轮询，不用 AbortSignal——中断动作统一
// stopPathfinding（pathfinder.stop → 下一 tick PathStopped 拒绝），与任务 _cancel
// 现状一致；谓词同时查 _stopRequested || _pauseRequested。
//
// 失败语义（reason）：
//   no-path      goto 拒绝 NoPath / approachEntity 收到 path_update noPath
//   timeout      墙钟超时（调用方 timeoutMs）或 goto 拒绝 Timeout（A* 预算）
//   interrupted  谓词为真 / PathStopped（他人 stop）
//   stuck        位置停滞（卡住自愈触发——goto 内部自动重试 ≤3 次后仍失败）
//   goal-changed 他人 setGoal 覆盖（任务互斥下不应发生，如实上报）
//   error        其他异常（位置不可用等）

import pathfinderPkg from 'mineflayer-pathfinder' // CJS 包：default 导入后解构（ESM named 互操作不可靠）
import { Vec3 } from 'vec3'
const { goals } = pathfinderPkg

// approachEntity：目标位移超过此距离视为"目标跑了"→ interrupted 让调用方重扫
// （goto 只 setGoal 一次，路径不随目标实时重算——目标静止时 A* 不被重置）
const RECALC_DIST = 2

// 卡住自愈：26.1 区块数据时序问题——A* 路径生成/直线合并的物理模拟可能用未加载
// 的区块数据（blockAt null → 模拟中障碍不存在 → 路径穿过实际墙）→ bot 撞墙停滞。
// 自愈：位置停滞 STUCK_DETECT_MS 后主动 stopPathfinding（触发 PathStopped →
// runOnce 失败标记 stuck）→ goto 重试全新 A*（区块加载后重试成功）。
const STUCK_DETECT_MS = 4000
// 卡住重试次数上限（每次全新 A*——区块通常 1-2 次重试内加载完成）
const STUCK_RETRY_LIMIT = 3
// A* 计算期免检窗口（goto 启动后 bot 不动是正常的——等 pathfinder 算完路径）
const STUCK_GRACE_MS = 5000

/** 失败原因文案（move_to 技能/命令反馈用）。 */
export const REASON_TEXT = {
  'no-path': '无法到达（无路径）',
  timeout: '移动超时',
  interrupted: '移动被中断',
  stuck: '移动卡住（已自动重试）',
  'goal-changed': '目标被其他移动覆盖',
  error: '移动出错'
}

/**
 * 统一 Movements 工厂（配置集中一处）。
 * 默认值已核实适合地表穿行（mineflayer-pathfinder 2.4.5）：
 *   canDig/allowParkour/allow1by1towers/allowSprinting=true——地表穿行需要攀爬/挖掘/冲刺；
 *   canOpenDoors=false（上游注释：非 paper 服务端有问题）；scafoldingBlocks=[dirt, cobblestone]；
 *   blocksToAvoid 含 lava（find 寻路不会走入岩浆）。
 * 真实可调项是 pathfinder 实例字段（thinkTimeout/tickTimeout，A* 分片预算），
 * 由 createMovement 可选参数暴露（默认不覆盖已验证值）。
 * @param {import('mineflayer').Bot} bot
 * @param {new (bot: import('mineflayer').Bot) => object} Movements pathfinder 的 Movements 类（DI 注入，测试友好）
 */
export function createMovements (bot, Movements) {
  return new Movements(bot)
}

/** 统一寻路清理（任务 _cancel 五处复用；插件可能已卸载时容错）。 */
export function stopPathfinding (bot) {
  try { bot.pathfinder?.stop() } catch { /* 插件可能已卸载 */ }
}

/**
 * 卡住自愈的横移步：向目标垂直方向移动 2 格，离开贴墙位置。
 * bot 贴墙时起跳有水平碰撞延迟 → canWalkJump 模拟闪烁 → 跳不过 1 格墙；
 * 横移离开贴墙位置后起跳无延迟即可通过。失败（侧向也是墙/超时）不阻塞——
 * 返回后由 goto 重试兜底。
 * @param {import('mineflayer').Bot} bot
 * @param {{ x?: number, z?: number }} goal 原目标（用于计算侧向方向）
 */
async function sidestep (bot, goal, timeoutMs = 8000) {
  try {
    const p = bot.entity?.position
    if (!p || !bot.pathfinder?.setGoal) return
    const dx = (goal.x ?? 0) - p.x
    const dz = (goal.z ?? 0) - p.z
    const len = Math.hypot(dx, dz)
    if (len < 0.5) return // 目标就在脚下，无侧向可言
    // 垂直向量（左右横移）：绕开贴墙方向
    const sx = -dz / len
    const sz = dx / len
    const side = new goals.GoalNear(p.x + sx * 2, Math.floor(p.y), p.z + sz * 2, 1.5)
    const g = bot.pathfinder.goto(side)
    const timer = setTimeout(() => { try { bot.pathfinder.stop() } catch { /* 插件可能已卸载 */ } }, timeoutMs)
    try {
      await g
    } catch { /* 横移失败：不阻塞，交给重试 */ }
    clearTimeout(timer)
  } catch { /* 任何异常不阻塞主流程 */ }
}

/**
 * 卡住自愈的跳跃试探：贴墙起跳时 canWalkJump 模拟误判失败（20 tick 不够——
 * 起跳前 2 tick 水平碰撞延迟），但真实物理贴墙跳可行（连续跳 y 升 2 格
 * 越过 1 格墙顶）。
 * 面向目标方向连续 forward+jump ~1.2s（25ms 重设——pathfinder 执行器
 * fullStop 每 tick 覆盖 controlState，重设频率必须高于 tick 频率）。
 * 失败无副作用（bot 原地跳几下），重试 goto 兜底。
 */
async function jumpProbe (bot, goal) {
  try {
    if (!bot.setControlState) return
    // 面向目标方向（墙在目标方向——跳越过墙；bot yaw 可能残留旧朝向，
    // forward 不朝墙则跳不过去）
    const p = bot.entity?.position
    if (p && goal && bot.look) {
      const dx = (goal.x ?? 0) - p.x
      const dz = (goal.z ?? 0) - p.z
      if (Math.hypot(dx, dz) > 0.5) {
        bot.look(Math.atan2(-dx, -dz), 0)
      }
    }
    // 先后退半步：bot 停在墙块重叠位（中心在块内、AABB 底与前方墙块垂直重叠）
    // 时起跳瞬间被碰撞解算 velY=0（跳不起来）——后退 ~0.4 格脱离重叠后起跳无碰撞
    try {
      bot.setControlState('back', true)
      await new Promise(r => setTimeout(r, 400))
      bot.setControlState('back', false)
    } catch { /* bot 可能已断开 */ }
    const interval = setInterval(() => {
      try {
        bot.setControlState('forward', true)
        bot.setControlState('jump', true)
      } catch { /* bot 可能已断开 */ }
    }, 25)
    await new Promise(r => setTimeout(r, 1200))
    clearInterval(interval)
    bot.setControlState('jump', false)
    bot.setControlState('forward', false)
  } catch { /* 任何异常不阻塞主流程 */ }
}

/** 统一清残留 goal（非移动时的状态清理：无目标分支/攻击前/低血前）。 */
export function clearGoal (bot) {
  try { bot.pathfinder?.setGoal(null) } catch { /* 插件可能已卸载 */ }
}

/**
 * 移动入口工厂。
 * @param {import('mineflayer').Bot} bot
 * @param {Record<string, any>} logger
 * @param {{ pollMs?: number, thinkTimeoutMs?: number, tickTimeoutMs?: number, stuckGraceMs?: number, stuckDetectMs?: number, sidestepTimeoutMs?: number }} [opts]
 */
export function createMovement (bot, logger, { thinkTimeoutMs = null, tickTimeoutMs = null, stuckGraceMs = STUCK_GRACE_MS, stuckDetectMs = STUCK_DETECT_MS, sidestepTimeoutMs = 8000 } = {}) {
  const log = logger?.child ? logger.child({ module: 'movement' }) : logger

  // 低配机调优：A* 分片预算（默认 40ms/tick 主线程分片 + 5s 总预算）——默认不覆盖
  if (thinkTimeoutMs) bot.pathfinder.thinkTimeout = thinkTimeoutMs
  if (tickTimeoutMs) bot.pathfinder.tickTimeout = tickTimeoutMs

  /**
   * 寻路到 goal（事件驱动到达）。goto resolve = goal_reached；可中断/墙钟超时。
   * @param {object} goal pathfinder Goals 实例
   * @param {{ isInterrupted?: (() => boolean)|null, timeoutMs?: number, pollMs?: number }} [opts]
   */
  async function goto (goal, { isInterrupted = null, timeoutMs = 60000, pollMs = 500 } = {}) {
    let result = await runOnce(goal, { isInterrupted, timeoutMs, pollMs })
    // 卡住自愈：位置停滞 → stuck 标记 → 横移避开贴墙 → 重试全新 A*（最多 3 次）。
    // 贴墙起跳有 2 tick 水平碰撞延迟 → canWalkJump 20 tick 模拟闪烁（跳 1 tick
    // 落下）→ 永远跳不过墙；横移 2 格离开贴墙位置后起跳无延迟。中断不重试
    let stuckRetries = 0
    while (result.stuck && stuckRetries < STUCK_RETRY_LIMIT && !isInterrupted?.()) {
      stuckRetries++
      // 卡住诊断（issue 排查用）：记录周围 3×3 方块/手持/落地态——离线不可复现的
      // 完全静止（疑似树叶碰撞数据不一致/半嵌过深）依赖现场数据定位
      try {
        const p = bot.entity?.position
        if (p) {
          const px = Math.floor(p.x); const py = Math.floor(p.y); const pz = Math.floor(p.z)
          const around = []
          for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
            const b = bot.blockAt(new Vec3(px + dx, py, pz + dz))
            around.push(`${dx},${dz}:${b?.name ?? 'null'}`)
          }
          log?.warn({
            retry: stuckRetries,
            pos: [px, py, pz],
            around: around.join(' '),
            held: bot.heldItem?.name ?? null,
            onGround: bot.entity.onGround
          }, '移动卡住诊断（周围方块/手持/落地态）')
        }
      } catch { /* 诊断失败不影响自愈 */ }
      log?.warn({ retry: stuckRetries }, '移动卡住，横移/跳跃试探后重新寻路')
      // 1) 横移 2 格：离开局部贴墙位置（侧向有空地时有效）
      await sidestep(bot, goal, sidestepTimeoutMs)
      // 2) 强制停执行器：pathfinder.stop() 只设 stopPathing（stop() 清 path 只在
      //    "到达节点"时触发——bot 卡住时执行器继续跑旧路径，每 tick 覆盖
      //    controlState 与跳跃试探竞争）。stop()+setGoal(null) → resetPath 见
      //    stopPathing → 立即 stop()（path=[] + stateGoal=null → 执行器 return）
      try { bot.pathfinder?.stop() } catch { /* 插件可能已卸载 */ }
      try { bot.pathfinder?.setGoal(null) } catch { /* 插件可能已卸载 */ }
      await new Promise(r => setTimeout(r, 200))
      // 3) 真实跳跃试探：canWalkJump 模拟对贴墙起跳误判失败（20 tick 不够），
      //    但真实物理贴墙跳可行（连续跳 y 升 2 格越过墙顶）——面向目标
      //    方向连续跳 ~1.2s 越过 1 格墙
      await jumpProbe(bot, goal)
      result = await runOnce(goal, { isInterrupted, timeoutMs, pollMs })
    }
    // 仅 goto 自身的 A* 预算 Timeout 重试一次——fresh A* 常因区块数据稳定后成功
    // （低配机大范围搜索的偶发 5s 预算超时是真实场景）。墙钟超时（我们主动 stop）
    // 与中断不重试：重试会吃到陈旧的 path_stop，且超时重试无意义
    if (result.retryable && !isInterrupted?.()) {
      log?.warn('寻路超时，重试一次')
      result = await runOnce(goal, { isInterrupted, timeoutMs, pollMs })
    }
    return result
  }

  /** goto 单次执行（含中断/超时/停滞守卫与失败清理）。 */
  async function runOnce (goal, { isInterrupted, timeoutMs, pollMs }) {
    const started = Date.now()
    let succeeded = false
    let stoppedByUs = false
    let stuckDetected = false
    const p = bot.pathfinder.goto(goal)
    // 断线一致性：断线后 physics tick 停止 → path_stop 永不到达 → goto promise
    // 永不 settle → runOnce 挂死（轮询器泄漏 + 任务 run 永不返回）。
    // 与 bot 'end' 事件 race：end 先到即以 interrupted 返回收尾；finally 清理监听。
    let disconnected = false
    let endResolve
    const ended = new Promise((resolve) => { endResolve = resolve })
    const onEnd = () => { disconnected = true; endResolve() }
    bot.once('end', onEnd)
    // 停滞检测（卡住自愈）：A* 计算期（STUCK_GRACE_MS）后位置连续
    // STUCK_DETECT_MS 不动 → 主动 stop → PathStopped → 标记 stuck 供 goto 重试
    let lastPos = null
    let stuckSince = null
    const timer = setInterval(() => {
      // 双保险：error 路径可能先于 end 到达——轮询器检测到断线立即收尾
      if (!disconnected && String(bot._client?.state) === 'disconnected') onEnd()
      else if (isInterrupted?.()) {
        stoppedByUs = true
        stopPathfinding(bot) // 下一 tick 触发 PathStopped 拒绝
      } else if (Date.now() - started > timeoutMs) {
        stoppedByUs = true
        stopPathfinding(bot)
      } else if (Date.now() - started > stuckGraceMs && bot.entity?.position) {
        const p = bot.entity.position
        const moved = lastPos !== null && p.distanceTo(lastPos) > 0.1
        if (!moved && lastPos !== null) {
          if (stuckSince === null) stuckSince = Date.now()
          else if (Date.now() - stuckSince > stuckDetectMs) {
            stuckSince = null
            stuckDetected = true
            stoppedByUs = true
            stopPathfinding(bot)
          }
        } else {
          stuckSince = null
        }
        lastPos = p.clone()
      }
    }, pollMs)
    timer.unref?.()
    try {
      await Promise.race([p, ended])
      if (disconnected) {
        // 断线而非到达：bot 已死无需清理，但统一走失败语义（任务由 teardown 兜底）
        return { ok: false, reason: 'interrupted', err: new Error('bot disconnected') }
      }
      succeeded = true
      return { ok: true }
    } catch (err) {
      let reason = 'error'
      if (err?.name === 'NoPath') reason = 'no-path'
      else if (err?.name === 'GoalChanged') reason = 'goal-changed'
      else if (err?.name === 'Timeout') reason = 'timeout'
      else if (err?.name === 'PathStopped') {
        // 卡住自愈优先（我们主动 stop 触发）：stuck 标记供 goto 重试
        if (stuckDetected) reason = 'stuck'
        // 墙钟超时优先于 err.name 分类（我们主动 stop 触发的 PathStopped）
        else reason = stoppedByUs ? (isInterrupted?.() ? 'interrupted' : 'timeout') : 'interrupted'
      }
      // 兜底：谓词转真优先（竞态窗口内 PathStopped 可能先于谓词检查到达）
      if (isInterrupted?.() && reason !== 'no-path') reason = 'interrupted'
      return { ok: false, reason, err, retryable: err?.name === 'Timeout', stuck: stuckDetected }
    } finally {
      clearInterval(timer)
      bot.removeListener('end', onEnd)
      // 失败路径清理残留 stateGoal（NoPath 后 stateGoal 挂着，等区块更新会重新 A*，
      // 必须清）。用 setGoal(null) 而非 stopPathfinding——stop 的 path_stop 异步触发，
      // 会打断紧随其后的重试 goto（陈旧 path_stop → 误判 interrupted）
      if (!succeeded) {
        try { bot.pathfinder?.setGoal(null) } catch { /* 插件可能已卸载 */ }
      }
    }
  }

  /**
   * 走到指定坐标。range 缺省 → GoalBlock（精确站格）；提供 → GoalNear（范围内即可）。
   * @param {{ x: number, y: number, z: number }} pos
   * @param {{ range?: number|null, timeoutMs?: number, pollMs?: number, isInterrupted?: (() => boolean)|null }} [opts]
   * @returns {Promise<{ ok: boolean, reason?: string, err?: Error }>}
   */
  async function gotoPoint (pos, { range = null, ...opts } = {}) {
    const goal = range == null
      ? new goals.GoalBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
      : new goals.GoalNear(pos.x, pos.y, pos.z, range)
    return goto(goal, opts)
  }

  /**
   * 多候选点选最近可达（GoalCompositeAny，heuristic=min）。!find 与多目标场景共用。
   * @param {Array<{x: number, y: number, z: number}>} points
   * @param {number} range 到达半径
   */
  async function gotoNearest (points, range = 3, opts = {}) {
    // 防御：GoalCompositeAny([]) heuristic=Infinity → A* 跑满 5s 预算再重试
    // 一次（~10s 后误报"移动超时"）。当前调用方（!find/find_block）已前置空检查，
    // 此守卫防未来调用方漏检
    if (!Array.isArray(points) || points.length === 0) {
      return { ok: false, reason: 'no-path', err: new Error('no candidate points') }
    }
    const any = new goals.GoalCompositeAny(
      points.map(p => new goals.GoalNear(p.x, p.y, p.z, range))
    )
    return goto(any, opts)
  }

  /**
   * 接近实体（goto 封装，combat/breed 用）。范围内 → 清残留 goal + ok。
   * 实现要点：goto(GoalNear 快照) 只 setGoal 一次——频繁重建 goal 会触发
   * pathfinder 的 resetPath（清已算路径 + 丢进行中 A* + clearControlStates）→
   * 复杂地形 A* 永远算不完 → Bot 原地不动。
   * 目标位移超 RECALC_DIST 视为"目标跑了"→ interrupted → 调用方重扫（保持追逐，
   * 且不打断 A* 计算）；不可达由 goto 的 NoPath/Timeout 拒绝。
   * @param {{ position?: import('vec3').Vec3, id?: number, height?: number }} entity
   * @param {{ range?: number, isInterrupted?: (() => boolean)|null, timeoutMs?: number, pollMs?: number }} [opts]
   */
  async function approachEntity (entity, { range = 2, isInterrupted = null, timeoutMs = 30000, pollMs = 500 } = {}) {
    if (!entity?.position || !bot.entity?.position) return { ok: false, reason: 'error' }
    if (bot.entity.position.distanceTo(entity.position) <= range) {
      clearGoal(bot) // 到达：清残留 goal（等价任务旧行为 setGoal(null)）
      return { ok: true }
    }
    const anchor = entity.position.clone()
    const guard = isInterrupted ?? (() => false)
    // 组合谓词：调用方中断（stop/pause/出范围）或目标大幅移动（需重扫换目标）
    const combined = () => guard() || (
      entity?.position && entity.position.distanceTo(anchor) > RECALC_DIST
    )
    // GoalNear 构造签名 (x, y, z, range)——传 Vec3 单参会 NaN（Math.floor(Vec3)），
    // A* 行为异常
    const r = await goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, range), {
      isInterrupted: combined,
      timeoutMs,
      pollMs
    })
    if (r.ok) return { ok: true }
    // interrupted 时若 goal 已设（目标移动触发），统一清理由 goto 失败路径完成
    return r
  }

  return { goto, gotoPoint, gotoNearest, approachEntity }
}

/**
 * 查找指定方块的地表暴露位置（!find 用）。纯查询，不移动。
 * 已知局限：pc 版 prismarine-chunk 不解析 heightmap——高洞顶洞穴的 cave_air 也是
 * boundingBox 'empty'，可能误判为地表；maxCandidates 截断最近 N 个候选（前 N 个
 * 都埋地下而更远有地表时会漏报）——均为已知取舍，README 注明。
 * @returns {{ block: object, candidates: Array<{x, y, z}> }} block + 地表候选（按距离升序）
 */
export function findSurfaceBlocks (bot, blockName, { maxDistance = 64, maxCandidates = 64 } = {}) {
  const block = bot.registry?.blocksByName?.[blockName]
  if (!block) throw new Error(`未知方块类型: ${blockName}`)
  // 纵深防御：命令层 16-256 已校验，但技能/未来调用方可能直传任意值——
  // findBlocks 同步无界枚举（OctahedronIterator），超大 maxDistance 冻结主线程分钟级
  maxDistance = Math.min(256, Math.max(16, Math.floor(maxDistance) || 16))
  maxCandidates = Math.min(64, Math.max(1, Math.floor(maxCandidates) || 1))
  const found = bot.findBlocks({
    matching: (b) => b.type === block.id, // palette 快路径 matcher 只有 type/name（无 position）
    maxDistance,
    count: maxCandidates
  }) // 结果按距离升序
  const candidates = []
  for (const p of found) {
    if (isSurfaceAt(bot, p)) candidates.push(p)
  }
  return { block, candidates }
}

/** 候选上方 2 格空/透明 → 地表暴露（排除洞穴内/埋地下/液体上方/未加载）。 */
function isSurfaceAt (bot, p) {
  for (let dy = 1; dy <= 2; dy++) {
    const above = bot.blockAt(p.offset(0, dy, 0), false)
    if (!above || above.boundingBox !== 'empty') return false
    if (above.name === 'water' || above.name === 'lava') return false // 液体上方不算地表暴露
  }
  return true
}
