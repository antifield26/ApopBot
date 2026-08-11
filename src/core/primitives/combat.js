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
// 战斗（op / combat / 冷却 500ms，exclusive 拒绝）
import { createMovement, REASON_TEXT } from '../movement.js'
import { attackEntity } from '../entity-actions.js'
import { ACTION_COOLDOWN_MS, checkActionCooldown } from './common.js'

/**
 * 注册combat族原语。register = index.js 工厂注入的注册函数（含重复注册检查）；
 * _ctx 保留供族文件间约定签名（handler 经 c 首参取 ctx，不经此参数）。
 */
export function registerCombat (register, _ctx) {
  // ============ 战斗（op / combat / 冷却 500ms，exclusive 拒绝） ============
  register('attack', {
    schema: {
      type: 'object',
      required: ['filter'],
      properties: {
        filter: { type: 'string', description: '实体名子串或类型（hostile/zombie...）' },
        maxHits: { type: 'integer', min: 1, max: 20, description: '单次最多连击数（默认 5）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'combat',
    guardText: '攻击',
    timeoutMs: 60000,
    cooldownMs: ACTION_COOLDOWN_MS,
    handler: async (c, { filter, maxHits }, runtime) => {
      // 冷却在实体扫描前（与原技能层一致：无目标也占冷却——防止"打不到"刷调用）
      checkActionCooldown('attack')
      if (!c.bot?.entities || !c.bot.entity?.position) throw new Error('实体表/位置不可用')
      const me = c.bot.entity
      const f = filter?.toLowerCase()
      const matches = []
      for (const e of c.bot.entities instanceof Map ? c.bot.entities.values() : Object.values(c.bot.entities)) {
        if (!e || e === me || !e.position) continue
        if (f && !String(e.name ?? '').toLowerCase().includes(f) && e.type !== f) continue
        matches.push(e)
      }
      if (matches.length === 0) return { hits: 0, targetGone: false, targetName: null, reason: `附近没有匹配 ${filter} 的实体（observe_entities 查看）` }
      matches.sort((a, b) => a.position.distanceTo(me.position) - b.position.distanceTo(me.position))
      const target = matches[0]
      // 战斗循环（combat 任务同款：存在检查 + 接近 + 攻击）——攻击走
      // entity-actions 原始包；targetGone 供脚本数击杀（entityGone 监听等价语义）
      const move = createMovement(c.bot, c.logger)
      const ATTACK_RANGE = 3.5
      const alive = () => (c.bot.entities instanceof Map ? c.bot.entities.has(target.id) : !!c.bot.entities?.[target.id])
      let hits = 0
      let interruptedStreak = 0 // 连续被走位打断次数（目标持续移动时放弃追击，防无限重试）
      for (let i = 0; i < (maxHits ?? 5); i++) {
        // 取消/断线信号贯通——executor 超时拦不住 approach 循环，handler 必须
        // 自查 signal 才能在 stop/断线时停止追击
        if (runtime?.signal?.aborted) return { hits, targetGone: false, targetName: target.name, reason: '动作被中断' }
        if (!alive() || !target.position) return { hits, targetGone: true, targetName: target.name }
        const dist = me.position.distanceTo(target.position)
        if (dist > ATTACK_RANGE) {
          const r = await move.approachEntity(target, {
            range: 2,
            timeoutMs: 15000,
            isInterrupted: () => !target?.position || me.position.distanceTo(target.position) > 64
          })
          if (r.ok) continue
          if (r.reason === 'interrupted') {
            if (++interruptedStreak >= 2) {
              return { hits, targetGone: false, targetName: target.name, reason: '目标持续移动，追击中断（稍后可重试）' }
            }
            continue
          }
          return { hits, targetGone: false, targetName: target.name, reason: `无法接近: ${REASON_TEXT[r.reason] ?? r.err?.message}` }
        }
        try { c.bot.lookAt(target.position.offset(0, (target.height ?? 1.8) / 2, 0), true) } catch { /* 位置可能失效 */ }
        attackEntity(c.bot, target)
        hits++
        await new Promise(r => setTimeout(r, 600)) // 攻击冷却（1.9+ 攻击速度检测）
      }
      return { hits, targetGone: !alive(), targetName: target.name }
    }
  })

}
