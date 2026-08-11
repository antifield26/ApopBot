// @ts-check
import { isArea } from '../util.js'
// 养殖任务脚本：区域内对白名单动物喂食繁殖。
// 语义说明：
// - init 校验（area 完整/pathfinder 插件）；animalTypes 默认 4 种常见家畜
// - 无动物：stopWhenNoAnimals → 完成；否则 30s no-animal 等待
// - 喂食（interact_entity count 2 + useCooldownMs 间隔 + 目标存在检查由原语处理）
// - 无食物/目标消失（last ok:false）→ 30s 等待（no-food 语义）
// - 繁殖成功判定：targetGone（成年个体被幼崽替换）→ breedings 计数
// - maxBreedings 上限（默认 4）；等待幼崽生成 5s
// - entityGone 由 interact_entity 的 targetGone 返回判定

export default {
  id: 'breed',
  exclusive: true, // 与 farm/chop/combat/explore 互斥
  naturalCompletion: true,
  maxActions: 100000,
  defaultOptions: {
    animalTypes: ['cow', 'sheep', 'pig', 'chicken'],
    foodItem: 'wheat', maxBreedings: 4, useCooldownMs: 3000
  },
  /** init 校验。 */
  async init (task) {
    const o = task.options

    if (o.area !== undefined && !isArea(o.area)) {
      throw new Error('breed 任务 options.area 不完整（可省略或给全 x1..z2）')
    }
    if (!task.bot.pathfinder) throw new Error('breed 任务需要 pathfinder 插件')
  },
  script: {
    steps: [
      { ctrl: 'loop', max: 'infinite', body: [
        // maxBreedings 上限（0 = 不限）
        { ctrl: 'if', cond: { type: 'not', cond: { type: 'config', key: 'maxBreedings', equals: 0 } }, then: [
          { ctrl: 'if', cond: { type: 'counter', name: 'breedings', gte: '${maxBreedings}' }, then: [
            { ctrl: 'return', value: 'completed' }
          ] }
        ] },
        // 扫描动物（名称数组 filter + 区域过滤）
        { op: 'observe_entities', args: { filter: '${animalTypes}', maxDistance: 64, area: '${area}' }, as: 'animals' },
        { ctrl: 'if', cond: { type: 'result', ref: 'animals', field: 'length', equals: 0 }, then: [
          // 无动物：stopWhenNoAnimals → 完成；否则 30s 等待（动物可能未加载/刷新）
          { ctrl: 'if', cond: { type: 'config', key: 'stopWhenNoAnimals', equals: true }, then: [
            { ctrl: 'return', value: 'completed' }
          ], else: [
            { ctrl: 'wait', ms: 30000 }
          ] }
        ], else: [
          // 喂食最近动物（count 2 次 + useCooldownMs 间隔 + 目标存在检查由原语处理）
          { op: 'interact_entity', args: { filter: '${animalTypes}', foodName: '${foodItem}', count: 2, useCooldownMs: '${useCooldownMs}' }, as: 'feed' },
          // 无食物时原语返回 ok:true + fed:0（"无事可做"是有效执行——约定不能改）——
          // 脚本必须显式判 fed===0 才走 30s no-food 等待；last.ok:false 只覆盖
          // 异常失败（equip 超时/位置失效）。只看 ok 会导致无食物时 5s 紧循环
          { ctrl: 'if', cond: { type: 'not', cond: { type: 'last', ok: true } }, then: [
            { ctrl: 'wait', ms: 30000 }
          ], else: [
            { ctrl: 'if', cond: { type: 'result', ref: 'feed', field: 'fed', equals: 0 }, then: [
              { ctrl: 'wait', ms: 30000 } // 无食物（no-food 语义）
            ], else: [
              // 繁殖成功（成年个体被幼崽替换）→ breedings 计数
              { ctrl: 'if', cond: { type: 'result', ref: 'feed', field: 'targetGone', equals: true }, then: [
                { ctrl: 'count', name: 'breedings', by: 1 }
              ] },
              { ctrl: 'wait', ms: 5000 } // 等待幼崽生成/替换
            ] }
          ] }
        ] }
      ] }
    ]
  }
}
