// @ts-check
// 任务 options JSONSchema：类型/必填/范围集中在一处——入口零校验会让负
// durationMinutes（fish 立即假完成）、intervalMinutes 0（1ms 忙循环）、负数
// attackRange 等全部放行；config.js validateConfig 只查 scheduled 场景的
// durationMinutes。
// schema 与各任务 init 校验并存：init 是最终防线（构造期防御），schema 是入口拦截
//（早失败、文案统一）。
// 任务链（next）与 cron 校验同在此处——config 条目、start_task 原语、规划器三条
// 入口共用同一口径（防 config 校验与 LLM 路径行为分叉）。
//
// 字段约定（与 skills.js validateParams 同风格的极简 JSONSchema 子集）：
//   type: number/integer/string/boolean/object/array
//   required: true → 缺失即错（默认 false）
//   min/max: 数值下限/上限（含边界）
//   minItems: 数组最少元素数

import { Cron } from 'croner'
// 延迟 import：types.js →(runner→executor→primitives→本文件)→ types.js 存在 ESM
// 循环依赖，顶层求值会读未初始化的 TASK_TYPES（TDZ）——函数体内访问延迟到调用时
import { TASK_TYPES } from '../tasks/types.js'
const knownTypes = () => Object.keys(TASK_TYPES)

/**
 * 校验 cron 表达式（croner 可解析即合法——非法表达式会被调度器静默吞掉，
 * 任务注册但永不触发）。
 * @param {unknown} expr
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateCron (expr) {
  if (typeof expr !== 'string' || !expr.trim()) return { ok: false, error: 'cron 表达式必须是非空字符串' }
  try {
    new Cron(expr)
    return { ok: true }
  } catch {
    return { ok: false, error: `非法 cron 表达式: ${expr}（任务将永不触发）` }
  }
}

/**
 * 校验任务链 next（{type, id, options?, schedule?}）——options 递归过该类型的
 * validateTaskOptions；schedule 过 validateCron。
 * @param {unknown} next
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateNextOptions (next) {
  if (typeof next !== 'object' || next === null || Array.isArray(next)) {
    return { ok: false, error: 'next 必须是对象（任务链 {type, id, options?, schedule?}）' }
  }
  /** @type {{ id?: string, type?: string, options?: unknown, schedule?: unknown }} */
  const n = next
  if (typeof n.id !== 'string' || !n.id) return { ok: false, error: 'next.id 必须是非空字符串' }
  const known = knownTypes()
  if (typeof n.type !== 'string' || !known.includes(n.type)) {
    return { ok: false, error: `next.type 未知: ${n.type}（已知: ${known.join(', ')}）` }
  }
  if (n.options !== undefined) {
    const v = validateTaskOptions(n.type, n.options)
    if (!v.ok) return { ok: false, error: `next.options 校验失败: ${v.error}` }
  }
  if (n.schedule !== undefined) {
    const v = validateCron(n.schedule)
    if (!v.ok) return { ok: false, error: `next.schedule ${v.error}` }
  }
  return { ok: true }
}

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
