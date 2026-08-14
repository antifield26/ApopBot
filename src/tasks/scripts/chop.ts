import { isArea } from '../util.ts'
// 伐木任务脚本：区域内批量砍伐原木/木头。
// 语义说明：
// - init 校验（logTypes 显式 → 逐名校验未知方块；缺省 → 全部 /_log$|_wood$/）
// - 无目标：stopWhenDone → 完成；否则 5min no-target 等待（树会重新长）
// - NoChests → 5min inventory-full；其他 collect 错误 → 30s 重试
// - 默认 radius 48 / maxBlocks 64

export default {
  id: 'chop',
  exclusive: true, // 与 farm/combat/breed/explore 互斥（都在动 pathfinder/collectBlock）
  naturalCompletion: true,
  maxActions: 100000,
  defaultOptions: { radius: 48, maxBlocks: 64, logRegex: '_log$|_wood$' },
  /** init 校验（显式 logTypes 校验未知方块）。 */
  async init (task) {
    const o = task.options
    if (o.area !== undefined && !isArea(o.area)) {
      throw new Error('chop 任务 options.area 不完整（可省略或给全 x1..z2）')
    }
    if (!task.bot.registry?.blocksByName) throw new Error('chop 任务需要 bot.registry（minecraft-data 数据）')
    if (Array.isArray(o.logTypes) && o.logTypes.length > 0) {
      for (const name of o.logTypes) {
        if (!task.bot.registry.blocksByName[name]) throw new Error(`未知方块类型: ${name}`)
      }
    }
  },
  script: {
    steps: [
      { ctrl: 'loop', max: 'infinite', body: [
        // 显式 logTypes → 按名扫描；缺省 → 默认正则（/_log$|_wood$/）
        { ctrl: 'if', cond: { type: 'config', key: 'logTypes', equals: undefined }, then: [
          { op: 'observe_blocks', args: { regex: '${logRegex}', maxDistance: '${radius}', area: '${area}' }, as: 'targets' }
        ], else: [
          { op: 'observe_blocks', args: { blockNames: '${logTypes}', maxDistance: '${radius}', area: '${area}' }, as: 'targets' }
        ] },
        { ctrl: 'if', cond: { type: 'result', ref: 'targets', field: 'candidates.length', equals: 0 }, then: [
          // 无目标：stopWhenDone → 完成；否则 5min no-target 等待（树会重新长）
          { ctrl: 'if', cond: { type: 'config', key: 'stopWhenDone', equals: true }, then: [
            { ctrl: 'return', value: 'completed' }
          ], else: [
            { ctrl: 'wait', ms: 300000 }
          ] }
        ], else: [
          { op: 'collect_blocks', args: { positions: '$targets.candidates', maxBlocks: '${maxBlocks}' }, count: { name: 'chopped', field: 'collected' } },
          { ctrl: 'if', cond: { type: 'result', ref: '$last', field: 'inventoryFull', equals: true }, then: [
            { ctrl: 'wait', ms: 300000 }
          ], else: [
            { ctrl: 'if', cond: { type: 'last', ok: false }, then: [
              { ctrl: 'wait', ms: 30000 }
            ] }
          ] }
        ] }
      ] }
    ]
  }
}
