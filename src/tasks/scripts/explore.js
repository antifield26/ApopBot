// 探索任务脚本（v1.0.0 C10）：后台持续探索——方形螺旋向外游荡，每站采样记录
// 资源与实体（发现写入 DiscoveryMap，LLM 经 query_map 查询）。exclusive 互斥。
//
// 螺旋是**有状态算法**（环推进/中心重启/连续裁剪计数）——用"任务局部 op"
//（spiral_step，runner 的 scriptDef.ops）承载：closure 状态存 WeakMap（按任务
// 实例隔离——同 id 重启/多实例不串扰），经同一 executor 执行（权限/审计一致）。
//
// 语义与原 ExploreTask 逐条对应：
// - maxDistance 环半径上限（默认 256；超限后 stopWhenDone 完成/换中心重启）
// - area 站点裁剪到盒内，连续 16 站被裁 + stopWhenDone → 覆盖完成
// - 一站：groundY 采样（P2-4）→ gotoPoint（45s/range 3）→ 采样资源（webhook 推送）
//   → 实体扫描（只记录不接触）→ 锚点登记 → ≤500ms 节奏等待
// - 站点不可达跳过（unreachable 计数）不中断
// - 低血靠 autoEat（死亡由 feature-layer 管道处理；waypoint 绝对坐标重生后有效）

import { Vec3 } from 'vec3'
import { spiralWaypoints, sampleResources, scanEntities, SPIRAL_STEP, notifyValuableFound } from '../../core/explore.js'
import { createMovement } from '../../core/movement.js'
import * as discovery from '../../core/discovery.js'

/** 任务实例状态（WeakMap keyed by task——隔离/重启重建）。 */
const stateMap = new WeakMap()

function initState (task) {
  const o = task.options
  return {
    area: o.area ?? null,
    maxDistance: Math.min(256, o.maxDistance ?? 256),
    stopWhenDone: o.stopWhenDone === true,
    checkIntervalMs: (o.checkIntervalSeconds ?? 3) * 1000,
    consecutiveTrimmed: 0, // 连续被 area 裁剪的站点数（覆盖完成判定）
    center: task.bot.entity?.position
      ? { x: Math.floor(task.bot.entity.position.x), z: Math.floor(task.bot.entity.position.z) }
      : { x: 0, z: 0 },
    ringIndex: 0, // 当前环内站点游标
    waypoints: null // 当前环站点列表
  }
}

function inArea (wp, a) {
  return wp.x >= a.x1 && wp.x <= a.x2 && wp.z >= a.z1 && wp.z <= a.z2
}

/** 站点地面 y 采样（P2-4：悬崖/峡谷壁高差 >3 大量 NoPath 的修复）。 */
function groundY (bot, x, z) {
  try {
    const start = Math.floor(bot.entity?.position?.y ?? 64)
    for (let y = start; y > start - 48; y--) {
      const b = bot.blockAt(new Vec3(x, y, z)) // 26.1 blockAt 必须 Vec3 实例
      if (b && b.boundingBox !== 'empty') return y + 1
    }
  } catch { /* 区块未加载——回落当前 y */ }
  return Math.floor(bot.entity?.position?.y ?? 64)
}

export default {
  id: 'explore',
  exclusive: true, // 与 farm/chop/combat/breed 互斥（动 pathfinder）
  naturalCompletion: false, // 螺旋持续；stopWhenDone 环满/覆盖完成才自然结束
  maxActions: 100000,
  defaultOptions: { maxDistance: 256, checkIntervalSeconds: 3 },
  /** init 校验（原 ExploreTask.init 等价迁移）。 */
  async init (task) {
    const o = task.options
    const isArea = (a) => a && ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].every(k => Number.isInteger(a[k]))
    if (o.area !== undefined && !isArea(o.area)) {
      throw new Error('explore 任务 options.area 不完整（可省略或给全 x1..z2）')
    }
    if (!task.bot.pathfinder) throw new Error('explore 任务需要 pathfinder 插件')
  },
  ops: {
    /** 螺旋一站：推进环/裁剪判定/访问站点。返回 {done} 表示任务应完成。 */
    spiral_step: {
      // 外层超时必须 ≥ 内部 gotoPoint 45s（外层先触发 → 幽灵移动 + setGoal(null)
      // 竞态：脚本进下一站覆盖旧 goal，旧 runOnce finally 清掉新 goal）
      timeoutMs: 50000,
      handler: async (ctx, args, runtime, task) => {
        void args
        let st = stateMap.get(task)
        // 代际守卫：同实例重启（scheduled 再次触发）后 _runGen 已递增——旧 st 的
        // waypoints 已耗尽 → stopWhenDone 时立即"完成"（零工作量秒完成）。按代际
        // 重建状态，与 WeakMap 隔离语义一致
        if (!st || st.gen !== task._runGen) {
          st = initState(task)
          st.gen = task._runGen
          stateMap.set(task, st)
        }
        if (!task._alive(task._runGen)) return { done: true, reason: 'stopped' }

        // spiralWaypoints 一次生成全部环（1..maxRing）——列表耗尽 = 本轮螺旋完成：
        // stopWhenDone → 完成；否则以当前位置为新中心重启（有界漫游，永不"走丢"）
        if (!st.waypoints || st.ringIndex >= st.waypoints.length) {
          if (st.stopWhenDone) return { done: true, reason: 'spiral-complete' }
          task.incr('rings')
          const p = task.bot.entity?.position
          if (p) st.center = { x: Math.floor(p.x), z: Math.floor(p.z) }
          st.waypoints = spiralWaypoints(st.center.x, st.center.z, st.maxDistance, SPIRAL_STEP)
          st.ringIndex = 0
        }

        const wp = st.waypoints[st.ringIndex++]
        // area 裁剪：站点在盒外 → 跳过（连续 16 站被裁 = 覆盖完成）
        if (st.area && !inArea(wp, st.area)) {
          st.consecutiveTrimmed++
          if (st.consecutiveTrimmed >= 16 && st.stopWhenDone) {
            return { done: true, reason: 'area-covered' }
          }
          return { done: false, trimmed: true }
        }
        st.consecutiveTrimmed = 0

        // 一站：寻路到达 → 采样 → 实体扫描 → 锚点（原 _visitStation）
        const move = createMovement(task.bot, task.log)
        const r = await move.gotoPoint({ x: wp.x, y: groundY(task.bot, wp.x, wp.z), z: wp.z }, {
          range: 3,
          timeoutMs: 45000,
          isInterrupted: () => task._stopRequested || task._pauseRequested
        })
        if (!r.ok && r.reason !== 'interrupted') {
          task.log.warn({ reason: r.reason, wp }, '站点不可达，跳过')
          task.incr('unreachable')
        } else if (r.ok) {
          task.incr('waypoints')
          const found = sampleResources(task.bot)
          if (found.length) {
            task.incr('discovered', found.length)
            for (const f of found) task.incr(`res:${f.name}`)
            // D：重要资源 webhook 推送（节流；P2-2 实时配置）
            notifyValuableFound(task.ctx.getConfig?.() ?? task.ctx.config, task.log, found)
          }
          const ents = scanEntities(task.bot)
          if (ents.counts.hostile > 0) task.log.info({ hostile: ents.hostile }, '站点附近有敌对实体（只记录不接触）')
          discovery.recordAnchor(task.bot.entity?.position)
        }
        // 节奏等待（可被打断）
        await task._internalWait(Math.min(st.checkIntervalMs, 500), 'explore-station')
        return { done: false }
      }
    }
  },
  script: {
    steps: [
      { ctrl: 'loop', max: 'infinite', body: [
        { op: 'spiral_step', args: {}, as: 'step' },
        // 覆盖完成/螺旋完成（stopWhenDone）→ 自然完成
        { ctrl: 'if', cond: { type: 'result', ref: 'step', field: 'done', equals: true }, then: [
          { ctrl: 'return', value: 'completed' }
        ] }
      ] }
    ]
  }
}
