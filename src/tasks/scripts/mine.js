// 挖矿任务脚本：collectblock + pathfinder 在限定区域内挖掘指定方块。
// 语义说明：
// - init 校验（blockTypes 非空/插件/未知方块类型）→ scriptDef.init
// - 区域扫描中心告警 → observe_blocks 原语内部（bot 距中心 > 扫描半径时 warn）
// - 无目标：stopWhenDone → 完成；否则 5min no-target 内部等待
// - collect 分批 4（批间 pause/stop 响应）→ collect_blocks 原语内部
// - NoChests → 5min inventory-full；其他 collect 错误 → 30s collect-retry
// - 默认 radius 32 / maxBlocks 64

export default {
  id: 'mine',
  exclusive: false,
  naturalCompletion: true,
  maxActions: 100000, // 死循环兜底
  defaultOptions: { radius: 32, maxBlocks: 64 },
  /** init 校验。 */
  async init (task) {
    const o = task.options
    if (!Array.isArray(o.blockTypes) || o.blockTypes.length === 0) {
      throw new Error('mine 任务需要 options.blockTypes（方块名数组，无命名空间前缀）')
    }
    if (!task.bot.collectBlock || !task.bot.pathfinder) {
      throw new Error('mine 任务需要 collectBlock/pathfinder 插件')
    }
    // 解析方块 ID（未知方块类型在 init 期报错——而非脚本空转）
    const registry = task.bot.registry
    for (const name of o.blockTypes) {
      const block = registry?.blocksByName?.[name]
      if (!block) throw new Error(`未知方块类型: ${name}`)
    }
  },
  script: {
    steps: [
      { ctrl: 'loop', max: 'infinite', body: [
        // 区域内扫描（radius 钳制 + 区域过滤 + 中心告警在 observe_blocks 内部）
        { op: 'observe_blocks', args: { blockNames: '${blockTypes}', maxDistance: '${radius}', area: '${area}' }, as: 'targets' },
        { ctrl: 'if', cond: { type: 'result', ref: 'targets', field: 'candidates.length', equals: 0 }, then: [
          // 无目标：stopWhenDone → 完成；否则 5min no-target 内部等待
          { ctrl: 'if', cond: { type: 'config', key: 'stopWhenDone', equals: true }, then: [
            { ctrl: 'return', value: 'completed' }
          ], else: [
            { ctrl: 'wait', ms: 300000 }
          ] }
        ], else: [
          // 批量采集（分批 4 + NoChests→inventoryFull 由原语内部处理）
          { op: 'collect_blocks', args: { positions: '$targets.candidates', maxBlocks: '${maxBlocks}', chestLocations: '${chestLocations}' }, count: { name: 'mined', field: 'collected' } },
          // 背包满（无箱子可存）→ 5min 等待清空；其他失败 → 30s 重试
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
