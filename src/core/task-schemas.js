// 任务 options JSONSchema（重构档 R3 根治版）：类型/必填/范围集中在一处——
// 此前 ad-hoc 路径（!task new / LLM run_task）的 options 零校验（负 durationMinutes
// → fish 立即假完成、intervalMinutes 0 → 1ms 忙循环、负数 attackRange 等全部放行），
// 配置文件的校验（config.js validateConfig）只查 scheduled 场景的 durationMinutes。
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
      maxBlocks: { type: 'integer', min: 1 },
      radius: { type: 'integer', min: 1 },
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
      blockTypes: { type: 'array', items: { type: 'string' }, required: true, minItems: 1 },
      maxBlocks: { type: 'integer', min: 1 },
      radius: { type: 'integer', min: 1 },
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
