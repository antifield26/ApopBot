// 会话记忆落盘：LLM 会话（按玩家多轮历史 + 跨对话工具记录）持久化——
// 重启/重连后玩家多轮上下文不丢。
//
// 结构：{ schemaVersion: 1, sessions: { [user]: { history: [], calls: [] } } }
// 写入策略与 state.js 同款：tmp+rename 原子写 + 2s 防抖 + process 'exit' flush。
// 内存 Map 仍是主存储（agent 实例随重连/热重载重建，模块级 Map 保跨代际）；
// 磁盘为启动真相（加载时回填 Map），运行中以内存为准（防旧文件覆盖新会话）。
// LRU 上限与内存一致（MAX_SESSIONS=32，超限按最近访问裁剪落盘）。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDebouncedFileStore } from '../util/debounced-file-store.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_FILE = path.join(ROOT, 'data', 'sessions.json')
// v2：会话值加 goal（长期目标+计划）与 summary（对话滚动摘要）——v1 文件缺省
// null 兼容读
const SESSION_SCHEMA_VERSION = 2
const DEFAULT_MAX_SESSIONS = 32

/** 加载会话（不存在/损坏 → 空；形状防御：history/calls 非数组按空）。 */
export function loadSessions (file = DEFAULT_FILE) {
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { schemaVersion: SESSION_SCHEMA_VERSION, sessions: {} }
  }
  if (data?.schemaVersion > SESSION_SCHEMA_VERSION) {
    throw new Error(`sessions.json schemaVersion=${data.schemaVersion} 高于 Bot 支持的 ${SESSION_SCHEMA_VERSION}——请升级 Bot 后再启动`)
  }
  const sessions = {}
  for (const [user, v] of Object.entries((data?.sessions ?? {}) as Record<string, any>)) {
    if (!v || typeof v !== 'object') continue
    sessions[user] = {
      history: Array.isArray(v.history) ? v.history.slice(-20) : [],
      calls: Array.isArray(v.calls) ? v.calls.slice(-50) : [],
      // v2：goal/summary 形状防御（v1 文件/手改损坏按 null）
      goal: v.goal && typeof v.goal === 'object' && typeof v.goal.text === 'string' && v.goal.text
        ? { text: String(v.goal.text).slice(0, 200), plan: Array.isArray(v.goal.plan) ? v.goal.plan.slice(0, 5).map(String) : [], setBy: String(v.goal.setBy ?? '').slice(0, 32), updatedAt: Number(v.goal.updatedAt) || 0 }
        : null,
      summary: typeof v.summary === 'string' && v.summary ? v.summary.slice(0, 500) : null
    }
  }
  return { schemaVersion: SESSION_SCHEMA_VERSION, sessions }
}

/**
 * 创建会话存储。
 * @param {{ file?: string, debounceMs?: number, logger?: object, maxSessions?: number }} opts
 * @returns {{ get(user): object|null, set(user, value): void, reset(user): void, snapshot(): object, flush(): void, size(): number }}
 *          get 返回 { history, calls } 副本或 null；set 更新内存 + 调度落盘
 */
export function createSessionStore ({ file = DEFAULT_FILE, debounceMs = 2000, logger = null, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
  let last = loadSessions(file)
  // 落盘样板共享（dirty/防抖/tmp+rename 原子写/exit flush）；LRU 裁剪在 encode 内
  //（persist 时执行）
  const store = createDebouncedFileStore({
    file,
    debounceMs,
    logger,
    encode: () => {
      const entries = Object.entries(last.sessions)
      if (entries.length > maxSessions) {
        last.sessions = Object.fromEntries(entries.slice(-maxSessions))
      }
      return JSON.stringify(last, null, 2)
    }
  })

  return {
    /** 快照（测试/优雅退出）。 */
    snapshot: () => JSON.parse(JSON.stringify(last)),
    /** 读取会话（副本；刷新 LRU 序——存在则重插到末尾）。 */
    get (user) {
      const v = last.sessions[user]
      if (v === undefined) return null
      delete last.sessions[user]
      last.sessions[user] = v
      return { history: [...v.history], calls: [...v.calls], goal: v.goal ?? null, summary: v.summary ?? null }
    },
    /** 写入会话（内存为主存储；调度落盘）。 */
    set (user, value) {
      // delete+set 刷新插入序——否则活跃玩家（内存命中从不触发 get 的磁盘刷新）
      // 插入序停留在首次落盘位置，persist 的 LRU 裁尾会误裁活跃会话
      delete last.sessions[user]
      last.sessions[user] = {
        history: Array.isArray(value?.history) ? value.history.slice(-20) : [],
        calls: Array.isArray(value?.calls) ? value.calls.slice(-50) : [],
        // v2：goal/summary 保留（不显式构造会落盘即丢）
        goal: value?.goal && typeof value.goal === 'object' && value.goal.text
          ? { text: String(value.goal.text).slice(0, 200), plan: Array.isArray(value.goal.plan) ? value.goal.plan.slice(0, 5).map(String) : [], setBy: String(value.goal.setBy ?? '').slice(0, 32), updatedAt: Number(value.goal.updatedAt) || 0 }
          : null,
        summary: typeof value?.summary === 'string' && value.summary ? value.summary.slice(0, 500) : null
      }
      store.schedule()
    },
    /** 删除会话并立即落盘。 */
    reset (user) {
      if (!(user in last.sessions)) return
      delete last.sessions[user]
      // 立即落盘：!agent reset 语义要求崩溃窗口内不"复活"——若走 2s 防抖，
      // SIGKILL/断电窗口内会话残留磁盘，重启后私密上下文恢复
      store.flush()
    },
    /** 立即落盘（测试/优雅退出）。 */
    flush () {
      store.flush()
    },
    /** 会话数（测试）。 */
    size () {
      return Object.keys(last.sessions).length
    }
  }
}
