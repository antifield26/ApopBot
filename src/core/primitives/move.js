// @ts-check
// 动作原语注册表（按族拆分）：LLM act 动作数组与任务脚本共用的原子动作层。
// 每个原语 { schema, permission, exclusiveClass, guardText, timeoutMs, cooldownMs?, handler }。
// 约定（与 skills.execute 同源，由 executor 统一执行管线保证）：
// - handler(ctx, args, runtime) 返回 result（成功）；业务性"无事可做"（无目标/
//   无物品/冷却）也返回文案（ok:true——动作已有效执行）；真正的异常 throw
//   （executor 转 { ok:false, result: err.message }）
// - runtime = { signal: AbortSignal|null, user, taskId }——signal 贯通长时等待
//   （fish/eat/wait 的 race；movement 的 isInterrupted 组合谓词）
// - exclusive 守卫统一上提 executor（按 exclusiveClass），handler 不再自查
// 权限分级：观察/流程类 all；会改变世界状态（移动/构建/战斗/交互/物品/任务）op。
// 观察类返回结构化对象（LLM 收到 JSON、脚本读字段）；动作类返回简短中文文案。
// 移动（op / movement / 60s，exclusive 拒绝）
import { Vec3 } from 'vec3'
import { withTimeout } from '../../util/promise-timeout.js'
import { exploreStep, notifyValuableFound } from '../explore.js'
import { createMovement, REASON_TEXT } from '../movement.js'

/**
 * 注册move族原语。register = index.js 工厂注入的注册函数（含重复注册检查）；
 * _ctx 保留供族文件间约定签名（handler 经 c 首参取 ctx，不经此参数）。
 */
export function registerMove (register, _ctx) {
  // ============ 移动（op / movement / 60s，exclusive 拒绝） ============
  register('goto', {
    schema: {
      type: 'object',
      required: ['x', 'y', 'z'],
      properties: {
        // 世界边界 ±30000000——LLM 幻觉传超大值会进 GoalBlock 界外寻路异常
        x: { type: 'number', min: -30000000, max: 30000000 },
        y: { type: 'number', min: -30000000, max: 30000000 },
        z: { type: 'number', min: -30000000, max: 30000000 },
        range: { type: 'number', min: 0, max: 64, description: '到达判定距离（默认精确站格）' },
        timeoutMs: { type: 'number', min: 10000, max: 120000, description: '寻路超时 10-120s，默认 60s' }
      }
    },
    permission: 'op',
    exclusiveClass: 'movement',
    guardText: '移动',
    timeoutMs: 120000,
    handler: async (c, { x, y, z, range, timeoutMs }, runtime) => {
      // signal 贯通——goto 长时阻塞必须响应 stop()/断线中止，否则跑满 120s、
      // busy 全程占用（executor 超时拦不住原语内部的长等待）
      const r = await createMovement(c.bot, c.logger).gotoPoint(new Vec3(x, y, z), {
        range,
        timeoutMs: timeoutMs ?? 60000,
        isInterrupted: () => runtime?.signal?.aborted === true
      })
      if (r.ok) return { reached: [Math.floor(x), Math.floor(y), Math.floor(z)] }
      throw new Error(`移动失败: ${REASON_TEXT[r.reason] ?? r.err?.message}`)
    }
  })
  register('explore_step', {
    schema: {
      type: 'object',
      properties: {
        maxDistance: { type: 'number', min: 16, max: 256, description: '探索距离 16-256，默认 48' },
        direction: { type: 'string', description: 'n/s/e/w/ne/nw/se/sw/random，默认 random' }
      }
    },
    permission: 'op',
    exclusiveClass: 'movement',
    guardText: '探索',
    timeoutMs: 45000,
    handler: async (c, { maxDistance, direction }, runtime) => {
      // signal 贯通（同 goto——stop()/断线中止时探索步立即退出）
      const r = await exploreStep(c.bot, c.logger, { maxDistance, direction, signal: runtime?.signal ?? null })
      if (!r.ok) throw new Error(`探索失败: ${r.reason}`)
      notifyValuableFound(c.cfg, c.logger, r.found) // 重要资源 webhook 推送（节流，失败静默）
      return { from: [r.from.x, r.from.y, r.from.z], to: [r.to.x, r.to.y, r.to.z], found: r.found.map(f => ({ name: f.name, x: f.x, y: f.y, z: f.z })), hostile: r.entities.hostile ?? [] }
    }
  })
  // ============ 跟随（op / movement，exclusive 拒绝） ============
  register('sleep', {
    schema: {
      type: 'object',
      properties: {
        timeoutMs: { type: 'integer', min: 30000, max: 600000, description: '等天亮超时（默认 5 分钟）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'movement', // 走动+交互——与移动/任务互斥
    guardText: '睡觉',
    timeoutMs: 305000,
    handler: async (c, { timeoutMs }, runtime) => {
      if (!c.bot?.sleep) throw new Error('sleep 能力不可用（插件缺失）')
      // 白天不睡（sleepAtNight 语义——脚本只管调，昼夜判定在此）
      if (c.bot.time?.isDay) return { slept: false, reason: '白天不需要睡觉' }
      // 找附近床（32 格内；_bed 后缀覆盖全部颜色变体）
      let beds
      try {
        beds = c.bot.findBlocks({ matching: (b) => /_bed$/.test(b.name), maxDistance: 32, count: 4 })
      } catch { beds = [] }
      if (beds.length === 0) return { slept: false, reason: '附近没有床' }
      const bed = c.bot.blockAt(beds[0])
      if (!bed) return { slept: false, reason: '床位置不可用' }
      const move = await createMovement(c.bot, c.logger).gotoPoint(beds[0], { range: 2, timeoutMs: 30000 })
      if (!move.ok) return { slept: false, reason: `到床边失败: ${REASON_TEXT[move.reason] ?? move.err?.message}` }
      let onWake = null
      try {
        await withTimeout(c.bot.sleep(bed), 15000, 'sleep timeout')
        // 等天亮（wake 事件——白天自动唤醒/被吵醒提前返回）；listener 配对移除
        /** @type {(() => void)|null} */
        let onAbort = null
        /** @type {Promise<void>} */
        const wake = new Promise((resolve, reject) => {
          const t = setTimeout(() => { if (onWake) c.bot.removeListener('wake', onWake); resolve() }, timeoutMs ?? 300000)
          onWake = () => { clearTimeout(t); resolve() }
          c.bot.once('wake', onWake)
          // abort 监听必须 finally 配对移除（flow.js wait/fish 同款纪律）——
          // 任务级 signal 生命周期数天（farm 每晚睡觉），正常 wake/超时路径
          // 不移除会每晚泄漏一个监听器，数周后 abort 时一次性触发几十个无意义回调
          if (!runtime?.signal) return
          if (runtime.signal.aborted) {
            clearTimeout(t); c.bot.removeListener('wake', onWake); reject(new Error('等待被中断'))
            return
          }
          onAbort = () => {
            clearTimeout(t); c.bot.removeListener('wake', onWake); reject(new Error('等待被中断'))
          }
          runtime.signal.addEventListener('abort', onAbort, { once: true })
        })
        try {
          await wake
        } finally {
          if (onAbort) runtime?.signal?.removeEventListener('abort', onAbort)
        }
        return { slept: true }
      } catch (err) {
        if (err?.message?.includes('中断')) throw err
        return { slept: false, reason: err.message }
      }
    }
  })

}
