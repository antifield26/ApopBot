// 经验记忆库（v1.0.0 C11）：动作失败 → 反思总结 → 跨会话经验注入。
// LLM 自主能力持续进化：失败教训沉淀为"经验教训"注入后续对话 system——
// 下次遇到同类场景直接知道正确做法（对齐 Voyager/Reflexion 思想）。
//
// 存储：data/experience.json，{ schemaVersion: 1, items: [{op, error, lesson, ts}] }
// 写入策略与 sessions.js 同款：tmp+rename 原子写 + 2s 防抖 + exit flush。
// 容量上限（默认 100）：超限按最旧淘汰（FIFO——"最近经验"语义）。

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_FILE = path.join(ROOT, 'data', 'experience.json')
const EXPERIENCE_SCHEMA_VERSION = 1

/** 加载经验（不存在/损坏 → 空；形状防御）。 */
export function loadExperience (file = DEFAULT_FILE) {
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { schemaVersion: EXPERIENCE_SCHEMA_VERSION, items: [] }
  }
  if (data?.schemaVersion > EXPERIENCE_SCHEMA_VERSION) {
    throw new Error(`experience.json schemaVersion=${data.schemaVersion} 高于 Bot 支持的 ${EXPERIENCE_SCHEMA_VERSION}——请升级 Bot 后再启动`)
  }
  const items = Array.isArray(data?.items)
    ? data.items.filter(i => i && typeof i === 'object' && typeof i.lesson === 'string')
    : []
  return { schemaVersion: EXPERIENCE_SCHEMA_VERSION, items }
}

/**
 * 创建经验库。
 * @param {{ file?: string, debounceMs?: number, logger?: object, capacity?: number }} opts
 * @returns {{ add(entry), recent(n), flush(), size() }}
 */
export function createExperienceStore ({ file = DEFAULT_FILE, debounceMs = 2000, logger = null, capacity = 100 } = {}) {
  let last = loadExperience(file)
  let dirty = false
  let timer = null

  function persist () {
    if (!dirty) return
    dirty = false
    // 容量裁剪（FIFO 淘汰最旧）
    if (last.items.length > capacity) {
      last.items = last.items.slice(-capacity)
    }
    const tmp = file + '.tmp'
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(last, null, 2))
      renameSync(tmp, file)
    } catch (err) {
      rmSync(tmp, { force: true })
      logger?.warn?.({ err: err.message }, 'experience save failed')
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

  process.on('exit', () => {
    if (timer) { clearTimeout(timer); timer = null }
    persist()
  })

  return {
    /** 追加经验（{op, error, lesson, ts?}）。 */
    add (entry) {
      last.items.push({
        op: String(entry?.op ?? 'unknown').slice(0, 30),
        error: String(entry?.error ?? '').slice(0, 200),
        lesson: String(entry?.lesson ?? '').slice(0, 200),
        ts: entry?.ts ?? Date.now()
      })
      schedule()
    },
    /** 最近 n 条（新→旧排序）。 */
    recent (n = 8) {
      return [...last.items].reverse().slice(0, n)
    },
    /** 立即落盘（测试/优雅退出）。 */
    flush () {
      if (timer) { clearTimeout(timer); timer = null }
      persist()
    },
    size () {
      return last.items.length
    }
  }
}
