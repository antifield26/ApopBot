// @ts-check
// 运行状态持久化：ad-hoc 任务条目（!task new 添加）+ 任务遥测计数器的 JSON 快照。
// 目标：NSSM restart 后人工加的任务与计数不丢。
// 明确不做运行时现场恢复：运行中任务重启后按 cron/enabled 语义重新调度（配置即真相），
// 配置文件中已有的任务以配置文件为准（快照只补配置里没有的 ad-hoc 条目）。
//
// 写入策略：5s 防抖（任务变更频繁时不刷盘），优雅退出 flush 立即落盘；损坏/不存在回退空态。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDebouncedFileStore } from '../util/debounced-file-store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_FILE = path.join(ROOT, 'data', 'state.json')

// 快照 schema 版本——当前 2（v1 无版本号，结构相同仅补标记）。
// 未来版本（> 当前）拒绝加载并明确报错（升级 Bot 而非静默降级/损坏）。
export const STATE_SCHEMA_VERSION = 2

/** 读取快照（不存在/损坏 → 空态，不抛错；未来版本 → 抛错）。 */
export function loadState (file = DEFAULT_FILE) {
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // 损坏/缺 memory 键时回退空态——否则 createStateStore 的 memory getter
    // JSON.parse(JSON.stringify(undefined)) 抛 '"undefined" is not valid JSON' →
    // feature layer rebuild 失败
    return { schemaVersion: STATE_SCHEMA_VERSION, tasks: [], counters: {}, memory: {} }
  }
  return migrateState(data)
}

/**
 * 版本迁移链：旧版本快照按序迁移到当前 schemaVersion。
 * 缺 schemaVersion 视为 v1（结构相同，仅补版本号）；未来版本拒绝。
 * @throws {Error} 快照版本高于当前（需升级 Bot）
 */
export function migrateState (data) {
  const raw = data?.schemaVersion
  const v = (raw === undefined || raw === null) ? 1 : raw
  // 版本号非法（0/负数/小数/非数字）：按 v1 形状防御处理（normalize 兜底坏形状，
  // 输出 schemaVersion 2）——坏版本号进迁移循环会抛裸 TypeError → 启动崩溃
  if (!Number.isInteger(v) || v < 1) {
    return normalize({ ...(data ?? {}), schemaVersion: 1 })
  }
  if (v > STATE_SCHEMA_VERSION) {
    throw new Error(`state.json schemaVersion=${v} 高于 Bot 支持的 ${STATE_SCHEMA_VERSION}——请升级 Bot 后再启动（勿手改版本号，数据可能不兼容）`)
  }
  let cur = data ?? {}
  for (let target = v; target < STATE_SCHEMA_VERSION; target++) {
    cur = MIGRATIONS[target](cur)
  }
  return normalize(cur)
}

/** 迁移器表：key = 源版本，产出目标版本（当前 v1→v2 结构不变仅补版本号）。 */
const MIGRATIONS = {
  1: (d) => ({ ...d, schemaVersion: 2 })
}

/** 形状防御：坏数据按空处理（旧版本/手改损坏）。 */
function normalize (data) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    tasks: Array.isArray(data?.tasks) ? data.tasks.filter(t => t && typeof t === 'object' && t.id && t.type) : [],
    counters: data?.counters && typeof data.counters === 'object' && !Array.isArray(data.counters) ? data.counters : {},
    // 探索记忆（discovery.js 快照）——非对象/坏形状按空处理
    memory: data?.memory && typeof data.memory === 'object' && !Array.isArray(data.memory) ? data.memory : {}
  }
}

/**
 * 防抖写快照。setTasks/setCounter 只改内存 + 标记脏；flush 立即落盘。
 * @param {{ file?: string, debounceMs?: number, logger?: object }} opts
 */
export function createStateStore ({ file = DEFAULT_FILE, debounceMs = 5000, logger = null } = {}) {
  let last = loadState(file)
  // 落盘由共享模块承接：dirty/防抖/tmp+rename 原子写（Windows EPERM/EBUSY 防御）
  // 与优雅退出 flush 均在 debounced-file-store 内
  const store = createDebouncedFileStore({
    file,
    debounceMs,
    logger,
    encode: () => JSON.stringify({ ...last, schemaVersion: STATE_SCHEMA_VERSION }, null, 2)
  })

  return {
    /** ad-hoc 任务条目（快照恢复用；读副本防外部修改污染内存态） */
    get tasks () {
      return last.tasks.map(t => ({ ...t, options: { ...(t.options ?? {}) } }))
    },
    /** 任务计数器表 { taskId: counters } */
    get counters () {
      return { ...last.counters }
    },
    /** 探索记忆快照（B1：discovery.js 用；深拷贝防外部修改污染内存态） */
    get memory () {
      return JSON.parse(JSON.stringify(last.memory ?? {})) // ?? {} 防御：历史快照/异常态缺 memory 键
    },
    /** 全量更新探索记忆（discovery 修改后调用；5s 防抖合并落盘） */
    setMemory (memory) {
      last.memory = memory && typeof memory === 'object' ? JSON.parse(JSON.stringify(memory)) : {}
      store.schedule()
    },
    /** 全量更新 ad-hoc 任务列表（manager 变更后调用）。 */
    setTasks (tasks) {
      last.tasks = tasks.map(t => ({ ...t, options: { ...(t.options ?? {}) } }))
      store.schedule()
    },
    /** 更新单任务计数器（任务终态时调用）。 */
    setCounter (id, counters) {
      last.counters = { ...last.counters, [id]: { ...counters } }
      store.schedule()
    },
    /** 删除单任务计数器（任务移除时清理，防快照无限增长）。 */
    deleteCounter (id) {
      if (!(id in last.counters)) return
      const next = { ...last.counters }
      delete next[id]
      last.counters = next
      store.schedule()
    },
    /** 立即落盘（优雅退出/测试）。 */
    flush () {
      store.flush()
    }
  }
}
