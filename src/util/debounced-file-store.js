// 防抖落盘存储（第 11 轮 F3）：sessions/experience/state 三处同款
// "dirty + 防抖定时器 + tmp+rename 原子写 + exit flush" 提取。
//
// 语义与既有实现逐条等价：
// - schedule()：标记脏 + 首次防抖（timer 单例，unref 不阻塞退出）
// - persist()：非脏直接返回；tmp+rename 原子写（Windows EPERM/EBUSY 防御）；
//   失败清理半写 tmp + warn
// - exit flush：进程级单次注册，所有实例共享（每实例各注册一个 'exit' 监听会
//   在测试多实例场景累积，且重复 flush 已清理的实例）
// - flush()：清 timer + 立即落盘（!agent reset / 优雅退出用）

import { writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

const exitFlushers = new Set()
let exitRegistered = false

function registerExitFlush (flush) {
  exitFlushers.add(flush)
  if (exitRegistered) return
  exitRegistered = true
  // 全 exit 路径同步落盘（C2/M 修复）：fatal exit(2)/优雅退出/裸崩溃都触发 'exit'——
  // 防抖窗口内未 flush 的变更在进程消亡前落盘。同步 writeFileSync 在 exit 处理器
  // 中安全（不允许调度异步工作）。
  process.on('exit', () => {
    for (const f of exitFlushers) {
      try { f() } catch { /* 单个实例失败不影响其他 */ }
    }
  })
}

/**
 * @param {{ file: string, debounceMs: number, logger?: object, encode: () => string }} opts
 *        encode：返回落盘 JSON 字符串（调用方负责形状/LRU 裁剪与 schemaVersion）
 * @returns {{ persist(): void, schedule(): void, flush(): void }}
 */
export function createDebouncedFileStore ({ file, debounceMs, logger = null, encode }) {
  let dirty = false
  let timer = null

  function persist () {
    if (!dirty) return
    dirty = false
    // 原子写（tmp + rename）——Windows 下直接 writeFileSync 遇文件被占用
    // （编辑器/杀软扫描）抛 EPERM/EBUSY → 数据静默丢弃；rename 覆盖是原子操作。
    // 同步 API 在 exit 处理器中安全（不允许调度异步工作）。同目录保证同卷 rename。
    const tmp = file + '.tmp'
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(tmp, encode())
      renameSync(tmp, file)
    } catch (err) {
      rmSync(tmp, { force: true }) // 清理半写 tmp（写成功但 rename 失败场景）
      logger?.warn?.({ err: err.message }, `${path.basename(file)} save failed`)
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

  function flush () {
    if (timer) { clearTimeout(timer); timer = null }
    dirty = true // 强制落盘（!agent reset 语义：即使无 schedule 也写）
    persist()
  }

  registerExitFlush(flush)
  return { persist, schedule, flush }
}
