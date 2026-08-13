// @ts-check
// 技能库：成功任务实践 → LLM 提炼 → 跨会话技能注入（LLM 自主学习循环）。
// 与经验库互补：经验 = 失败教训（op 键控、count 合并）；技能 = 成功实践
// （taskType 键控、steps 结构化）——skill 是提示性知识（怎么做更好），
// 不是替代原语组合的固定动作序列（项目哲学：无固定技能映射）。
//
// 存储：data/skills.json，{ schemaVersion: 1, items: [{id, name, taskType, summary,
// steps[], pitfalls[], usage, ts, sourceTask}] }
// 写入策略与 experience.js 同款：tmp+rename 原子写 + 2s 防抖 + exit flush。
// 容量上限（默认 50）：超限按最旧淘汰（FIFO——"最近实践"语义）。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDebouncedFileStore } from '../util/debounced-file-store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_FILE = path.join(ROOT, 'data', 'skills.json')
const SKILL_SCHEMA_VERSION = 1

/** 加载技能库（不存在/损坏 → 空；形状防御）。 */
export function loadSkills (file = DEFAULT_FILE) {
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { schemaVersion: SKILL_SCHEMA_VERSION, items: [] }
  }
  if (data?.schemaVersion > SKILL_SCHEMA_VERSION) {
    throw new Error(`skills.json schemaVersion=${data.schemaVersion} 高于 Bot 支持的 ${SKILL_SCHEMA_VERSION}——请升级 Bot 后再启动`)
  }
  const items = Array.isArray(data?.items)
    ? data.items
      .filter(i => i && typeof i === 'object' && typeof i.taskType === 'string' && typeof i.name === 'string')
      .map(i => ({
        ...i,
        // id 归一化（与 add 同款派生 ${taskType}:${name}）：旧文件/手改条目缺 id
        // 时永远无法被覆盖刷新（add 按 id 查找）——重复实践会堆积到 FIFO 容量
        // 挤掉有效技能
        id: typeof i.id === 'string' ? i.id : `${i.taskType}:${i.name}`,
        steps: Array.isArray(i.steps) ? i.steps.filter(x => typeof x === 'string') : [],
        pitfalls: Array.isArray(i.pitfalls) ? i.pitfalls.filter(x => typeof x === 'string') : [],
        usage: Number.isInteger(i.usage) && i.usage > 0 ? i.usage : 1
      }))
    : []
  return { schemaVersion: SKILL_SCHEMA_VERSION, items }
}

/**
 * 创建技能库。
 * @param {{ file?: string, debounceMs?: number, logger?: object, capacity?: number }} opts
 * @returns {{ add(entry): void, match(taskTypes: Array<string>, n?: number): Array<object>, recent(n): Array<object>, flush(): void, size(): number }}
 */
export function createSkillsStore ({ file = DEFAULT_FILE, debounceMs = 2000, logger = null, capacity = 50 } = {}) {
  let last = loadSkills(file)
  // 落盘样板共享（dirty/防抖/tmp+rename/exit flush）；容量 FIFO 裁剪在 encode 内
  const store = createDebouncedFileStore({
    file,
    debounceMs,
    logger,
    encode: () => {
      if (last.items.length > capacity) {
        last.items = last.items.slice(-capacity)
      }
      return JSON.stringify(last, null, 2)
    }
  })

  return {
    /** 追加技能（{taskType, name, summary, steps, pitfalls, sourceTask?, ts?}）。
     * 同 taskType+同 name 视为同一技能——覆盖刷新 + usage++（重复实践强化而非堆积）。 */
    add (entry) {
      const taskType = String(entry?.taskType ?? 'unknown').slice(0, 30)
      const name = String(entry?.name ?? '').slice(0, 40)
      if (!name) return
      const steps = (entry?.steps ?? []).filter(x => typeof x === 'string').slice(0, 6).map(x => x.slice(0, 80))
      const pitfalls = (entry?.pitfalls ?? []).filter(x => typeof x === 'string').slice(0, 3).map(x => x.slice(0, 80))
      const summary = String(entry?.summary ?? '').slice(0, 120)
      const sourceTask = String(entry?.sourceTask ?? '').slice(0, 40)
      const id = `${taskType}:${name}`
      const existing = last.items.find(i => i.id === id)
      if (existing) {
        existing.name = name
        existing.summary = summary
        existing.steps = steps
        existing.pitfalls = pitfalls
        existing.sourceTask = sourceTask
        existing.usage = (existing.usage ?? 1) + 1
        existing.ts = Date.now()
      } else {
        last.items.push({ id, taskType, name, summary, steps, pitfalls, usage: 1, ts: entry?.ts ?? Date.now(), sourceTask })
      }
      store.schedule()
    },
    /** 最近 n 条（新→旧排序）。 */
    recent (n = 8) {
      return [...last.items].reverse().slice(0, n)
    },
    /** 按任务类型检索（检索式技能注入）——taskType 精确匹配；无匹配返回空（调用方回退最近）。 */
    match (taskTypes, n = 2) {
      const typeSet = new Set((taskTypes ?? []).map(String))
      const hit = last.items.filter(i => typeSet.has(i.taskType))
      return hit.length ? [...hit].reverse().slice(0, n) : []
    },
    /** 立即落盘（测试/优雅退出）。 */
    flush () {
      store.flush()
    },
    size () {
      return last.items.length
    }
  }
}
