// 运行状态持久化（U1）：ad-hoc 任务条目（!task new 添加）+ 任务遥测计数器的 JSON 快照。
// 目标：NSSM restart 后人工加的任务与计数不丢（此前全内存态，重启即失）。
// 明确不做运行时现场恢复：运行中任务重启后按 cron/enabled 语义重新调度（配置即真相），
// 配置文件中已有的任务以配置文件为准（快照只补配置里没有的 ad-hoc 条目）。
//
// 写入策略：5s 防抖（任务变更频繁时不刷盘），优雅退出 flush 立即落盘；损坏/不存在回退空态。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_FILE = path.join(ROOT, 'data', 'state.json')

/** 读取快照（不存在/损坏 → 空态，不抛错）。 */
export function loadState (file = DEFAULT_FILE) {
  try {
    return normalize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { tasks: [], counters: {} }
  }
}

/** 形状防御：坏数据按空处理（旧版本/手改损坏）。 */
function normalize (data) {
  return {
    tasks: Array.isArray(data?.tasks) ? data.tasks.filter(t => t && typeof t === 'object' && t.id && t.type) : [],
    counters: data?.counters && typeof data.counters === 'object' && !Array.isArray(data.counters) ? data.counters : {},
    // B1（L2 进化）：探索记忆（discovery.js 快照）——非对象/坏形状按空处理
    memory: data?.memory && typeof data.memory === 'object' && !Array.isArray(data.memory) ? data.memory : {}
  }
}

/**
 * 防抖写快照。setTasks/setCounter 只改内存 + 标记脏；flush 立即落盘。
 * @param {{ file?: string, debounceMs?: number, logger?: object }} opts
 */
export function createStateStore ({ file = DEFAULT_FILE, debounceMs = 5000, logger = null } = {}) {
  let last = loadState(file)
  let dirty = false
  let timer = null

  function persist () {
    if (!dirty) return
    dirty = false
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(last, null, 2))
    } catch (err) {
      logger?.warn?.({ err: err.message }, 'state save failed')
    }
  }

  function schedule () {
    dirty = true
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      persist()
    }, debounceMs)
    timer.unref?.()
  }

  // 全 exit 路径同步落盘（C2/M 修复）：fatal exit(2)/优雅退出/裸崩溃都触发 'exit'——
  // 一处覆盖所有调用方，防抖窗口内未 flush 的变更（ad-hoc 任务/计数）在进程消亡前落盘。
  // 同步 writeFileSync 在 exit 处理器中安全（不允许调度异步工作）。
  process.on('exit', () => {
    if (timer) { clearTimeout(timer); timer = null }
    persist()
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
      return JSON.parse(JSON.stringify(last.memory))
    },
    /** 全量更新探索记忆（discovery 修改后调用；5s 防抖合并落盘） */
    setMemory (memory) {
      last.memory = memory && typeof memory === 'object' ? JSON.parse(JSON.stringify(memory)) : {}
      schedule()
    },
    /** 全量更新 ad-hoc 任务列表（manager 变更后调用）。 */
    setTasks (tasks) {
      last.tasks = tasks.map(t => ({ ...t, options: { ...(t.options ?? {}) } }))
      schedule()
    },
    /** 更新单任务计数器（任务终态时调用）。 */
    setCounter (id, counters) {
      last.counters = { ...last.counters, [id]: { ...counters } }
      schedule()
    },
    /** 删除单任务计数器（任务移除时清理，防快照无限增长——C6/N）。 */
    deleteCounter (id) {
      if (!(id in last.counters)) return
      const next = { ...last.counters }
      delete next[id]
      last.counters = next
      schedule()
    },
    /** 立即落盘（优雅退出/测试）。 */
    flush () {
      if (timer) { clearTimeout(timer); timer = null }
      persist()
    }
  }
}
