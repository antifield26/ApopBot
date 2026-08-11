// @ts-check
import { isArea } from '../util.js'
// 战斗任务脚本：区域内对敌对实体巡逻战斗。
// 语义说明：
// - init 校验（area 完整/aggroRange<attackRange 陷阱/pathfinder 插件）
// - 武器：显式 weapon 或背包第一把剑（init 钩子解析进 options.weaponName；
//   null = 空手跳过装备）
// - 低血优先：health < minHealth（默认 8）→ eat（eatWhenLowHealth 默认 true，
//   进食成功 continue）；失败/禁用 → 等待 10s（等待重扫——攻击循环本身会重扫）
// - 扫描敌对：observe_entities filter hostile + aggroRange + 区域过滤
// - 无目标：stopWhenNoTargets → 完成；否则 checkInterval 等待（默认 3s 巡逻）
// - 攻击：attack 原语 maxHits 1（每轮一击 + 600ms 冷却）——
//   接近/连击/targetGone 由原语内部处理
// - 击杀（targetGone）→ kills 计数；maxTargets 上限（0 = 不限）
// - 攻击失败 → checkInterval 重扫；每轮尾部 500ms combat-scan 等待
// - entityGone 由 attack 原语的 targetGone 返回判定；低血处理为等待而非远离敌人
//   （不追出区域的语义由 observe_entities 的 aggroRange 过滤 + 每轮重扫保证）

export default {
  id: 'combat',
  exclusive: true, // 与 farm/chop/breed/explore 互斥
  naturalCompletion: true,
  maxActions: 100000,
  defaultOptions: {
    maxTargets: 0, aggroRange: 12, minHealth: 8, attackRange: 3.5,
    checkIntervalSeconds: 3, eatWhenLowHealth: true, attackCooldownMs: 600
  },
  /** init 校验 + 武器解析。 */
  async init (task) {
    const o = task.options

    if (o.area !== undefined && !isArea(o.area)) {
      throw new Error('combat 任务 options.area 不完整（可省略或给全 x1..z2）')
    }
    if (!task.bot.pathfinder) throw new Error('combat 任务需要 pathfinder 插件')
    // 配置陷阱：aggroRange < attackRange 时中间距离的怪既找不到也不打
    const aggroRange = o.aggroRange ?? 12
    const attackRange = o.attackRange ?? 3.5
    if (o.aggroRange !== undefined && o.attackRange !== undefined && aggroRange < attackRange) {
      throw new Error('combat 任务 options.aggroRange 不能小于 attackRange（中间距离的怪将永不攻击）')
    }
    // 武器解析：显式 weapon 或背包第一把剑（模板 ${weaponName} 读取；null = 空手）
    if (typeof o.weapon === 'string') {
      task.options.weaponName = o.weapon
    } else {
      const sword = task.bot.inventory?.items?.()?.find(it => /sword$/.test(it.name))
      task.options.weaponName = sword?.name ?? null
    }
    // 护甲自动装备（armorManager 插件——防御式调用：插件未装/装备失败静默，
    // 有护甲大幅降低近战掉血，任务可连续作战更久）
    try {
      await task.bot.armorManager?.equipAll?.()
    } catch { /* 插件未启用/装备失败——不阻塞任务 */ }
  },
  script: {
    steps: [
      { ctrl: 'loop', max: 'infinite', body: [
        // 天黑睡觉（sleepAtNight 默认 false——黑夜巡逻危险，睡过夜晚更安全；
        // 昼夜判定在 sleep 原语内部）
        { ctrl: 'if', cond: { type: 'config', key: 'sleepAtNight', equals: true }, then: [
          { op: 'sleep', args: {} }
        ] },
        // 低血优先处理：进食或等待
        { op: 'observe_status', args: {}, as: 'st' },
        { ctrl: 'if', cond: { type: 'result', ref: 'st', field: 'health', gte: '${minHealth}' }, then: [], else: [
          { ctrl: 'if', cond: { type: 'config', key: 'eatWhenLowHealth', equals: false }, then: [], else: [
            { op: 'eat', args: {} },
            // 真正吃到才 continue（eat 返回 {ate:false} 也是 ok:true——没吃到继续
            // 会形成无等待死循环）
            { ctrl: 'if', cond: { type: 'result', ref: '$last', field: 'ate', equals: true }, then: [{ ctrl: 'continue' }] }
          ] },
          { ctrl: 'wait', ms: 10000 } // eat 失败/禁用 → 等待重扫
        ] },
        // 装备武器（weaponName null = 空手）
        { ctrl: 'if', cond: { type: 'config', key: 'weaponName', equals: null }, then: [], else: [
          { op: 'equip', args: { itemName: '${weaponName}' } }
        ] },
        // 扫描敌对目标（aggroRange + 区域过滤）
        { op: 'observe_entities', args: { filter: 'hostile', maxDistance: '${aggroRange}', area: '${area}' }, as: 'targets' },
        { ctrl: 'if', cond: { type: 'result', ref: 'targets', field: 'length', equals: 0 }, then: [
          // 无目标：stopWhenNoTargets → 完成；否则巡逻等待
          { ctrl: 'if', cond: { type: 'config', key: 'stopWhenNoTargets', equals: true }, then: [
            { ctrl: 'return', value: 'completed' }
          ], else: [
            { ctrl: 'wait', ms: { expr: '${checkIntervalSeconds} * 1000' } }
          ] }
        ], else: [
          // 攻击最近目标（maxHits 1：每轮一击 + 原语内 600ms 冷却）
          { op: 'attack', args: { filter: 'hostile', maxHits: 1 }, as: 'atk' },
          // 击杀（targetGone）→ kills 计数 + maxTargets 上限
          { ctrl: 'if', cond: { type: 'result', ref: 'atk', field: 'targetGone', equals: true }, then: [
            { ctrl: 'count', name: 'kills', by: 1 },
            { ctrl: 'if', cond: { type: 'not', cond: { type: 'config', key: 'maxTargets', equals: 0 } }, then: [
              { ctrl: 'if', cond: { type: 'counter', name: 'kills', gte: '${maxTargets}' }, then: [
                { ctrl: 'return', value: 'completed' }
              ] }
            ] }
          ] },
          // 攻击失败（接近失败/无路径）→ 重扫
          { ctrl: 'if', cond: { type: 'last', ok: false }, then: [
            { ctrl: 'wait', ms: { expr: '${checkIntervalSeconds} * 1000' } }
          ] }
        ] },
        // combat-scan 等待（min(checkInterval, 500)）
        { ctrl: 'wait', ms: 500 }
      ] }
    ]
  }
}
