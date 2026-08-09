// 作物数据（v1.0.0 C3：从 FarmTask 类静态属性提为 core 常量——primitives 的
// observe_crops/plant_crops 原语与任务共享，避免 core→tasks 上向引用）。

/** 成熟度对照表：作物名 → 成熟所需 age 属性值。 */
export const CROP_MATURITY = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3 }

/** 作物名 → 种子物品名（库存查询用）。 */
export const SEED_BY_CROP = {
  wheat: 'wheat_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
  nether_wart: 'nether_wart'
}
