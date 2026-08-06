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
// 现状一致；谓词同时查 _stopRequested || _pauseRequested（顺带修复 breed 接近
// 不响应 pause 的既有缺陷）。
//
// 失败语义（reason）：
//   no-path      goto 拒绝 NoPath / approachEntity 收到 path_update noPath
//   timeout      墙钟超时（调用方 timeoutMs）或 goto 拒绝 Timeout（A* 预算）
//   interrupted  谓词为真 / PathStopped（他人 stop）
//   goal-changed 他人 setGoal 覆盖（任务互斥下不应发生，如实上报）
//   error        其他异常（位置不可用等）

import pathfinderPkg from 'mineflayer-pathfinder' // CJS 包：default 导入后解构（ESM named 互操作不可靠）
const { goals } = pathfinderPkg

// approachEntity：目标位移超过此距离视为"目标跑了"→ interrupted 让调用方重扫
// （goto 只 setGoal 一次，路径不随目标实时重算——目标静止时 A* 不被重置）
const RECALC_DIST = 2

/** 失败原因文案（move_to 技能/命令反馈用）。 */
export const REASON_TEXT = {
  'no-path': '无法到达（无路径）',
  timeout: '移动超时',
  interrupted: '移动被中断',
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
 * @param {Function} Movements pathfinder 的 Movements 类（DI 注入，测试友好）
 */
export function createMovements (bot, Movements) {
  return new Movements(bot)
}

/** 统一寻路清理（任务 _cancel 五处复用；插件可能已卸载时容错）。 */
export function stopPathfinding (bot) {
  try { bot.pathfinder?.stop() } catch { /* 插件可能已卸载 */ }
}

/** 统一清残留 goal（非移动时的状态清理：无目标分支/攻击前/低血前）。 */
export function clearGoal (bot) {
  try { bot.pathfinder?.setGoal(null) } catch { /* 插件可能已卸载 */ }
}

/**
 * 移动入口工厂。
 * @param {import('mineflayer').Bot} bot
 * @param {object} logger
 * @param {{ pollMs?: number, thinkTimeoutMs?: number, tickTimeoutMs?: number }} [opts]
 */
export function createMovement (bot, logger, { thinkTimeoutMs = null, tickTimeoutMs = null } = {}) {
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
    const first = await runOnce(goal, { isInterrupted, timeoutMs, pollMs })
    // 仅 goto 自身的 A* 预算 Timeout 重试一次——fresh A* 常因区块数据稳定后成功
    // （低配机大范围搜索的偶发 5s 预算超时是真实场景）。墙钟超时（我们主动 stop）
    // 与中断不重试：重试会吃到陈旧的 path_stop，且超时重试无意义
    if (first.retryable && !isInterrupted?.()) {
      log?.warn('寻路超时，重试一次')
      return runOnce(goal, { isInterrupted, timeoutMs, pollMs })
    }
    return first
  }

  /** goto 单次执行（含中断/超时守卫与失败清理）。 */
  async function runOnce (goal, { isInterrupted, timeoutMs, pollMs }) {
    const started = Date.now()
    let succeeded = false
    let stoppedByUs = false
    const p = bot.pathfinder.goto(goal)
    const timer = setInterval(() => {
      if (isInterrupted?.()) {
        stoppedByUs = true
        stopPathfinding(bot) // 下一 tick 触发 PathStopped 拒绝
      } else if (Date.now() - started > timeoutMs) {
        stoppedByUs = true
        stopPathfinding(bot)
      }
    }, pollMs)
    timer.unref?.()
    try {
      await p
      succeeded = true
      return { ok: true }
    } catch (err) {
      let reason = 'error'
      if (err?.name === 'NoPath') reason = 'no-path'
      else if (err?.name === 'GoalChanged') reason = 'goal-changed'
      else if (err?.name === 'Timeout') reason = 'timeout'
      else if (err?.name === 'PathStopped') {
        // 墙钟超时优先于 err.name 分类（我们主动 stop 触发的 PathStopped）
        reason = stoppedByUs ? (isInterrupted?.() ? 'interrupted' : 'timeout') : 'interrupted'
      }
      // 兜底：谓词转真优先（竞态窗口内 PathStopped 可能先于谓词检查到达）
      if (isInterrupted?.() && reason !== 'no-path') reason = 'interrupted'
      return { ok: false, reason, err, retryable: err?.name === 'Timeout' }
    } finally {
      clearInterval(timer)
      // 失败路径清理残留 stateGoal（NoPath 后 stateGoal 挂着，等区块更新会重新 A*，
      // 必须清）。用 setGoal(null) 而非 stopPathfinding——stop 的 path_stop 异步触发，
      // 会毒害紧随其后的重试 goto（实测：陈旧 path_stop 打断新 goto → 误判 interrupted）
      if (!succeeded) {
        try { bot.pathfinder?.setGoal(null) } catch { /* 插件可能已卸载 */ }
      }
    }
  }

  /**
   * 走到指定坐标。range 缺省 → GoalBlock（精确站格）；提供 → GoalNear（范围内即可）。
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
    const any = new goals.GoalCompositeAny(
      points.map(p => new goals.GoalNear(p.x, p.y, p.z, range))
    )
    return goto(any, opts)
  }

  /**
   * 接近实体（goto 封装，combat/breed 用）。范围内 → 清残留 goal + ok。
   * 实现要点：goto(GoalNear 快照) 只 setGoal 一次——此前每 500ms 重建 goal 会触发
   * pathfinder 的 resetPath（清已算路径 + 丢进行中 A* + clearControlStates）→
   * 复杂地形 A* 永远算不完 → Bot 原地不动（实测回归）。
   * 目标位移超 RECALC_DIST 视为"目标跑了"→ interrupted → 调用方重扫（保持追逐，
   * 且不打断 A* 计算）；不可达由 goto 的 NoPath/Timeout 拒绝。
   * @param {{ position?: { x, y, z } }} entity
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
    // A* 行为异常（follow 实测回归同款，此处全库排查发现）
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
