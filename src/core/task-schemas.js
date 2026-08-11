// @ts-check
// 任务 options JSONSchema：类型/必填/范围集中在一处——入口零校验会让负
// durationMinutes（fish 立即假完成）、intervalMinutes 0（1ms 忙循环）、负数
// attackRange 等全部放行；config.js validateConfig 只查 scheduled 场景的
// durationMinutes。
// schema 与各任务 init 校验并存：init 是最终防线（构造期防御），schema 是入口拦截
//（早失败、文案统一）。
//
// 字段约定（与 skills.js validateParams 同风格的极简 JSONSchema 子集）：
//   type: number/integer/string/boolean/object/array
//   required: true → 缺失即错（默认 false）
//   min/max: 数值下限/上限（含边界）
//   minItems: 数组最少元素数

export const TASK_OPTION_SCHEMAS = {
  mine: {
    type: 'object',
    properties: {
      blockTypes: { type: 'array', items: { type: 'string' }, required: true, minItems: 1 },
      // mine 的 area 为可选（run 内做区域过滤）
      area: { type: 'object' },
      maxBlocks: { type: 'integer', min: 1 },
      // radius 上限 256——bot.findBlocks 是同步八面体枚举（OctahedronIterator），
      // 无界 radius 在稀疏区域冻结主线程（与 findSurfaceBlocks 的 16-256 限幅一致；
      // 客户端区块加载上限本就框死可见范围）
      // 下限 16：脚本经 observe_blocks 扫描（maxDistance 最小 16）——radius 1-15 过
      // schema 但每轮参数校验失败 → 任务静默空转永不工作
      radius: { type: 'integer', min: 16, max: 256 },
      chestLocations: { type: 'array' },
      stopWhenDone: { type: 'boolean' }
    }
  },
  fish: {
    type: 'object',
    properties: {
      durationMinutes: { type: 'number', required: true, min: 0.01 },
      stopWhenInventoryFull: { type: 'boolean' }
    }
  },
  afk: {
    type: 'object',
    properties: {
      intervalMinutes: { type: 'number', required: true, min: 1 }
    }
  },
  farm: {
    type: 'object',
    properties: {
      area: { type: 'object', required: true },
      cropTypes: { type: 'array', items: { type: 'string' }, required: true, minItems: 1 },
      replant: { type: 'boolean' },
      maxCycles: { type: 'integer', min: 0 },
      growthCheckSeconds: { type: 'number', min: 1 },
      stopWhenIdle: { type: 'boolean' },
      seedOverrides: { type: 'object' }
    }
  },
  chop: {
    type: 'object',
    properties: {
      area: { type: 'object', required: true },
      // chop 实际读取 logTypes（chop.js:25，缺省正则匹配全部原木/木头），
      // 从不读 blockTypes——blockTypes 不设必填，否则 `!task new chop {"area":…}`
      // 会被拒而 config 同配置照跑
      logTypes: { type: 'array', items: { type: 'string' }, minItems: 1 },
      maxBlocks: { type: 'integer', min: 1 },
      radius: { type: 'integer', min: 16, max: 256 }, // 同步枚举限幅（同 mine；下限 16 同 observe_blocks）
      stopWhenDone: { type: 'boolean' }
    }
  },
  combat: {
    type: 'object',
    properties: {
      area: { type: 'object' },
      maxTargets: { type: 'integer', min: 0 },
      stopWhenNoTargets: { type: 'boolean' },
      aggroRange: { type: 'number', min: 1 },
      minHealth: { type: 'number', min: 1 },
      eatWhenLowHealth: { type: 'boolean' },
      attackRange: { type: 'number', min: 0.5 },
      attackCooldownMs: { type: 'integer', min: 0 },
      checkIntervalSeconds: { type: 'number', min: 0.1 },
      weapon: { type: 'string' }
    }
  },
  breed: {
    type: 'object',
    properties: {
      area: { type: 'object' },
      animalTypes: { type: 'array', items: { type: 'string' }, minItems: 1 },
      foodItem: { type: 'string' },
      maxBreedings: { type: 'integer', min: 1 },
      useCooldownMs: { type: 'integer', min: 0 },
      stopWhenNoAnimals: { type: 'boolean' }
    }
  },
  explore: {
    type: 'object',
    properties: {
      // 螺旋探索——maxDistance 站点半径上限（同步枚举防线同款 16-256）
      area: { type: 'object' },
      maxDistance: { type: 'integer', min: 16, max: 256 },
      stopWhenDone: { type: 'boolean' },
      checkIntervalSeconds: { type: 'number', min: 0.1 }
    }
  }
}

/** 任务通用 options（!task new / run_task 可配，非任务专属）。 */
export const COMMON_OPTION_SCHEMA = {
  durationMinutes: { type: 'number', min: 0.01 },
  notifyChat: { type: 'boolean' },
  enabled: { type: 'boolean' },
  schedule: { type: 'string' }
}

/**
 * 校验任务 options（入口拦截；未知键放行——向前兼容）。
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateTaskOptions (type, options) {
  const schema = TASK_OPTION_SCHEMAS[type]
  if (!schema) return { ok: true } // 未知类型由 addTask/TASK_TYPES 拦截
  const params = options ?? {}
  // 任务专属定义优先（fish 的 durationMinutes 带 required，通用版只是可选）
  for (const [k, def] of Object.entries({ ...COMMON_OPTION_SCHEMA, ...schema.properties })) {
    if (params[k] === undefined) {
      if (def.required) return { ok: false, error: `缺少参数: ${k}` }
      continue
    }
    const v = params[k]
    const ok = {
      number: typeof v === 'number',
      integer: Number.isInteger(v),
      string: typeof v === 'string',
      boolean: typeof v === 'boolean',
      object: typeof v === 'object' && v !== null && !Array.isArray(v),
      array: Array.isArray(v)
    }[def.type]
    if (!ok) return { ok: false, error: `${k} 必须是 ${def.type}` }
    if ((def.type === 'number' || def.type === 'integer') && typeof v === 'number') {
      if (def.min !== undefined && v < def.min) return { ok: false, error: `${k} 不能小于 ${def.min}` }
      if (def.max !== undefined && v > def.max) return { ok: false, error: `${k} 不能大于 ${def.max}` }
    }
    if (def.type === 'array' && def.minItems !== undefined && v.length < def.minItems) {
      return { ok: false, error: `${k} 至少需要 ${def.minItems} 项` }
    }
  }
  return { ok: true }
}
