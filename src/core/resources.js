// @ts-check
// 资源白名单（探索采样/重要资源推送共用；26.1.2 已核实存在，注意 sugar_cane 非 sugarcane）。
// 领域概念归 core——core/explore.js 的采样与推送依赖它们，放 l2 会造成 core→l2 上向引用。

/** 资源白名单（explore 技能/任务采样用；26.1.2 已核实存在，注意 sugar_cane 非 sugarcane）。 */
export const RESOURCE_WHITELIST = [
  'iron_ore', 'deepslate_iron_ore', 'coal_ore', 'deepslate_coal_ore',
  'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore',
  'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
  'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
  'nether_gold_ore', 'nether_quartz_ore', 'ancient_debris',
  'bamboo', 'sugar_cane', 'cactus', 'sweet_berry_bush'
]

/** 重要资源（webhook 推送用）：钻石/绿宝石/远古残骸。 */
export const VALUABLE_RESOURCES = ['diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'ancient_debris']
