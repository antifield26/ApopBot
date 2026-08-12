// @ts-check
import { isArea } from '../util.js'
import { CROP_MATURITY, CROP_BY_BLOCK } from '../../core/crops.js'
// 农场任务脚本：区域内 种植 → 等待成熟 → 收割 → 补种 的循环。
// 语义说明：
// - init 校验（area 六坐标/cropTypes 非空/未知作物与方块/插件）
// - 成熟收割（分批 4 + NoChests→5min 清空等待 + 其他失败→30s 重试）
// - 收割后 continue（不种植/不等待）
// - 种植（replant 默认 true；seedOverrides 透传；种植成功 continue）
// - 未成熟 → 等待生长（growthCheckSeconds 默认 30s，内部等待可打断）
// - 空闲：stopWhenIdle → 完成；否则巡逻等待（玩家放种子/成熟后继续）
// - maxCycles 默认 1（0 = 不限轮数）——loop max 语义

export default {
  id: 'farm',
  exclusive: true, // 与 chop/combat/breed/explore 互斥（都在动 pathfinder/collectBlock）
  naturalCompletion: true,
  maxActions: 100000,
  // maxCycles 默认 3：收割失败（寻路/挖掘超时）有重试空间——
  // 默认 1 轮时失败即结束 = "任务期间无动作后假 complete"（实测）
  defaultOptions: { growthCheckSeconds: 30, maxCycles: 3 },
  /** init 校验。 */
  async init (task) {
    const o = task.options

    if (!isArea(o.area)) throw new Error('farm 任务需要 options.area（完整 x1..z2 六坐标）')
    if (!Array.isArray(o.cropTypes) || o.cropTypes.length === 0) {
      throw new Error('farm 任务需要 options.cropTypes（如 ["wheat"]）')
    }
    if (!task.bot.collectBlock || !task.bot.pathfinder) {
      throw new Error('farm 任务需要 collectBlock/pathfinder 插件')
    }
    for (const crop of o.cropTypes) {
      if (!(crop in CROP_MATURITY) && !Object.values(CROP_BY_BLOCK).includes(crop)) {
        throw new Error(`未知作物: ${crop}（已知: ${[...Object.keys(CROP_MATURITY), ...Object.values(CROP_BY_BLOCK)].join(', ')}）`)
      }
      const block = task.bot.registry?.blocksByName?.[crop]
      if (!block) throw new Error(`未知方块类型: ${crop}`)
    }
  },
  script: {
    steps: [
      { ctrl: 'loop', max: '${maxCycles}', body: [
        // 天黑睡觉（sleepAtNight 默认 false；true 时天黑找床睡过夜晚——昼夜判定
        // 在 sleep 原语内部，白天直接返回不阻塞）
        { ctrl: 'if', cond: { type: 'config', key: 'sleepAtNight', equals: true }, then: [
          { op: 'sleep', args: {} }
        ] },
        // 区域扫描：成熟/未成熟/耕地分类（observe_crops 原语）
        { op: 'observe_crops', args: { area: '${area}', cropTypes: '${cropTypes}' }, as: 'crops' },
        // 有成熟作物 → 收割（分批 4 + NoChests 清空等待由原语/条件处理）
        { ctrl: 'if', cond: { type: 'result', ref: 'crops', field: 'mature.length', gte: 1 }, then: [
          { op: 'collect_blocks', args: { positions: '$crops.mature' }, count: { name: 'harvested', field: 'collected' } },
          { ctrl: 'if', cond: { type: 'result', ref: '$last', field: 'inventoryFull', equals: true }, then: [
            { ctrl: 'wait', ms: 300000 }
          ], else: [
            { ctrl: 'if', cond: { type: 'last', ok: false }, then: [{ ctrl: 'wait', ms: 30000 }] }
          ] },
          { ctrl: 'continue' } // 收获后跳过种植/等待
        ], else: [
          // 种植（replant 默认 true；false 跳过）
          { ctrl: 'if', cond: { type: 'config', key: 'replant', equals: false }, then: [], else: [
            { op: 'plant_crops', args: { area: '${area}', cropTypes: '${cropTypes}', seedOverrides: '${seedOverrides}' }, count: { name: 'planted', field: 'planted' } },
            // 种上了 → 本轮结束
            { ctrl: 'if', cond: { type: 'result', ref: '$last', field: 'planted', gte: 1 }, then: [
              { ctrl: 'continue' }
            ] }
          ] },
          // 未成熟 → 等待生长（内部等待可被 stop/pause 打断）
          { ctrl: 'if', cond: { type: 'result', ref: 'crops', field: 'immature.length', gte: 1 }, then: [
            { ctrl: 'wait', ms: { expr: '${growthCheckSeconds} * 1000' } }
          ], else: [
            // 空闲：stopWhenIdle → 完成；否则巡逻等待
            { ctrl: 'if', cond: { type: 'config', key: 'stopWhenIdle', equals: true }, then: [
              { ctrl: 'return', value: 'completed' }
            ], else: [
              { ctrl: 'wait', ms: { expr: '${growthCheckSeconds} * 1000' } }
            ] }
          ] }
        ] }
      ] }
    ]
  }
}
