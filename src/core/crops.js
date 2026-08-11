// @ts-check
// 作物数据（core 常量——primitives 的 observe_crops/plant_crops 原语与任务
// 共享，避免 core→tasks 上向引用）。
//
// 作物族三类成熟判定：
// - age 型（wheat/carrots/potatoes/beetroots/nether_wart/sweet_berries/cocoa）：
//   age 属性 ≥ maturityAge 即成熟
// - 高度型（sugarcane）：≥2 格高视为可收（收割顶部块，保留根部继续长）
// - 果实型（pumpkin/melon）：果实方块存在即成熟（dig 果实块）

/** 成熟度对照表：age 型作物 → 成熟所需 age 属性值。 */
export const CROP_MATURITY = {
  wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, nether_wart: 3,
  sweet_berries: 2, cocoa: 2
}

/** 果实型/高度型：方块名 → 作物名（observe_crops 用方块扫描判定）。 */
export const CROP_BY_BLOCK = {
  sugar_cane: 'sugarcane',
  pumpkin: 'pumpkin',
  melon: 'melon'
}

/** 作物名 → 种子物品名（库存查询/种植用）。 */
export const SEED_BY_CROP = {
  wheat: 'wheat_seeds',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroots: 'beetroot_seeds',
  nether_wart: 'nether_wart',
  sugarcane: 'sugarcane',
  pumpkin: 'pumpkin_seeds',
  melon: 'melon_seeds',
  sweet_berries: 'sweet_berries',
  cocoa: 'cocoa_beans'
}

/** 种植方式：farmland = 种耕地（原逻辑）；waterside = 水旁沙/土/草；soil = 土/草（非耕地）。 */
export const CROP_PLANT_MODE = {
  wheat: 'farmland', carrots: 'farmland', potatoes: 'farmland',
  beetroots: 'farmland', nether_wart: 'farmland',
  pumpkin: 'farmland', melon: 'farmland', // 南瓜/西瓜种子同小麦种耕地（茎自动长果实）
  sugarcane: 'waterside',
  sweet_berries: 'soil'
  // cocoa：种植需丛林原木侧面定向（face 复杂）——只收不种（玩家预种）
}
