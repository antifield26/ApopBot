// 动作审计日志（v1.0.0 C3）：所有 LLM/脚本/命令发起的动作全量记录到
// logs/audit.log（JSONL，按天轮转，保留天数与主日志一致）——自主行为可追溯、
// 可复盘（谁在什么时间对世界做了什么、结果如何）。
//
// 独立 pino 实例（复用 logger.js 已验证的 pino-roll 轮转机制）；append 是同步
// fire-and-forget（pino 内部异步写，失败仅 warn）——绝不阻塞动作执行。
//
// 行结构：{ ts, op, args, ok, result, durationMs, source: llm|script|act|command,
//           user?, taskId? }；args/result 各 ≤500 字符截断（防超大对象撑爆文件）。
// 安全：args 可能含坐标/物品等世界数据，不含任何凭据（API key 从不经过 executor）。

import pino from 'pino'
import path from 'node:path'

const TRUNCATE = 500

function trunc (v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (!s) return null
  return s.length > TRUNCATE ? s.slice(0, TRUNCATE) + '…(截断)' : s
}

/**
 * 创建审计日志器。
 * @param {{ dir?: string, keepDays?: number, logger: object }} cfg
 *        dir 缺省不写文件（内存 noop——测试/无日志目录场景）
 * @returns {{ append(entry): void, path: string|null }}
 */
export function createAuditLogger ({ dir, keepDays = 14, logger } = {}) {
  let auditLog = null
  let filePath = null
  if (dir) {
    filePath = path.join(dir, 'audit.log')
    auditLog = pino({
      level: 'info',
      base: { service: 'minecraft-bot-audit' },
      transport: {
        targets: [{
          target: 'pino-roll',
          options: { file: filePath, frequency: 'daily', mkdir: true, limit: { count: keepDays } }
        }]
      }
    })
  }

  function append (entry) {
    if (!auditLog) return
    auditLog.info({
      ts: new Date().toISOString(),
      op: entry.op,
      args: trunc(entry.args),
      ok: entry.ok === true,
      result: trunc(entry.result),
      durationMs: Math.round(entry.durationMs ?? 0),
      source: entry.source ?? 'unknown',
      user: entry.user ?? null,
      taskId: entry.taskId ?? null
    })
  }

  return { append, path: filePath }
}
