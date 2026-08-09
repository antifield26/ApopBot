// 会话记忆落盘（v1.0.0 C5）：LLM 会话（按玩家多轮历史 + 跨对话工具记录）从进程内存
// 升级为持久化——重启/重连后玩家多轮上下文不丢。
//
// 结构：{ schemaVersion: 1, sessions: { [user]: { history: [], calls: [] } } }
// 写入策略与 state.js 同款：tmp+rename 原子写 + 2s 防抖 + process 'exit' flush。
// 内存 Map 仍是主存储（agent 实例随重连/热重载重建，模块级 Map 保跨代际）；
// 磁盘为启动真相（加载时回填 Map），运行中以内存为准（防旧文件覆盖新会话）。
// LRU 上限与内存一致（MAX_SESSIONS=32，超限按最近访问裁剪落盘）。

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_FILE = path.join(ROOT, 'data', 'sessions.json')
const SESSION_SCHEMA_VERSION = 1
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
  for (const [user, v] of Object.entries(data?.sessions ?? {})) {
    if (!v || typeof v !== 'object') continue
    sessions[user] = {
      history: Array.isArray(v.history) ? v.history.slice(-20) : [],
      calls: Array.isArray(v.calls) ? v.calls.slice(-50) : []
    }
  }
  return { schemaVersion: SESSION_SCHEMA_VERSION, sessions }
}

/**
 * 创建会话存储。
 * @param {{ file?: string, debounceMs?: number, logger?: object, maxSessions?: number }} opts
 * @returns {{ get(user), set(user, value), reset(user), snapshot(), flush() }}
 *          get 返回 { history, calls } 副本或 null；set 更新内存 + 调度落盘
 */
export function createSessionStore ({ file = DEFAULT_FILE, debounceMs = 2000, logger = null, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
  let last = loadSessions(file)
  let dirty = false
  let timer = null

  function persist () {
    if (!dirty) return
    dirty = false
    // LRU 裁剪：只落最近 maxSessions 个会话（按 Object 插入序近似 LRU——读时刷新）
    const entries = Object.entries(last.sessions)
    if (entries.length > maxSessions) {
      last.sessions = Object.fromEntries(entries.slice(-maxSessions))
    }
    const tmp = file + '.tmp'
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(last, null, 2))
      renameSync(tmp, file)
    } catch (err) {
      rmSync(tmp, { force: true })
      logger?.warn?.({ err: err.message }, 'sessions save failed')
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
    /** 读取会话（副本；刷新 LRU 序——存在则重插到末尾）。 */
    get (user) {
      const v = last.sessions[user]
      if (v === undefined) return null
      delete last.sessions[user]
      last.sessions[user] = v
      return { history: [...v.history], calls: [...v.calls] }
    },
    /** 写入会话（内存为主存储；调度落盘）。 */
    set (user, value) {
      // 第 8 轮：delete+set 刷新插入序——否则活跃玩家（内存命中从不触发 get 的
      // 磁盘刷新）插入序停留在首次落盘位置，persist 的 LRU 裁尾会误裁活跃会话
      delete last.sessions[user]
      last.sessions[user] = {
        history: Array.isArray(value?.history) ? value.history.slice(-20) : [],
        calls: Array.isArray(value?.calls) ? value.calls.slice(-50) : []
      }
      schedule()
    },
    /** 删除会话并立即落盘。 */
    reset (user) {
      if (!(user in last.sessions)) return
      delete last.sessions[user]
      // 立即落盘（第 8 轮）：!agent reset 语义要求崩溃窗口内不"复活"——
      // 此前走 2s 防抖，SIGKILL/断电窗口内会话残留磁盘，重启后私密上下文恢复
      dirty = true
      persist()
    },
    /** 立即落盘（测试/优雅退出）。 */
    flush () {
      if (timer) { clearTimeout(timer); timer = null }
      persist()
    },
    /** 会话数（测试）。 */
    size () {
      return Object.keys(last.sessions).length
    }
  }
}
