import { parseCommand } from './parser.ts'
import { isOp } from './permissions.ts'
import { sendChat } from '../core/chat.ts'

/**
 * 命令注册与分发。
 */
export class CommandRegistry {
  log

  commands

  _lastDispatch

  constructor (logger) {
    this.log = logger.child({ module: 'commands' })
    this.commands = new Map()
    this._lastDispatch = new Map() // sender → 上次 op 命令时间戳（速率限制）
  }

  /**
   * @param {{ name: string, usage?: string, description?: string, permission?: 'op'|'all', handler: (ctx, args, sender) => Promise<void>|void }} def
   */
  register (def) {
    if (this.commands.has(def.name)) throw new Error(`命令重复注册: ${def.name}`)
    this.commands.set(def.name, {
      usage: def.usage ?? '',
      description: def.description ?? '',
      permission: def.permission ?? 'op',
      handler: def.handler
    })
  }

  list () {
    return [...this.commands.entries()].map(([name, def]) => ({
      name,
      usage: def.usage,
      description: def.description,
      permission: def.permission
    }))
  }

  /**
   * op 级操作冷却检查（混合权限命令在 handler 内 op 门后调用——def.permission
   * 'all' 的命令不受 dispatch 冷却约束，此前 !home set/!agent act 等可绕过防刷屏）。
   * @param {string} sender
   * @param {Record<string, any>} cfg
   * @returns {{ limited: boolean, remain: number }}
   */
  checkOpCooldown (sender, cfg) {
    const cooldownMs = cfg?.chat?.commandCooldownMs ?? 750
    const now = Date.now()
    const last = this._lastDispatch.get(sender) ?? 0
    if (now - last < cooldownMs) {
      return { limited: true, remain: Math.ceil((cooldownMs - (now - last)) / 1000) }
    }
    return { limited: false, remain: 0 }
  }

  /** 记录 op 级操作分发时间（checkOpCooldown 的配套写入；与 dispatch 共用 Map）。 */
  markOpDispatch (sender) {
    this._lastDispatch.set(sender, Date.now())
    // 上限 64：以 sender 为键的 Map 长期运行无限增长是微内存泄漏
    if (this._lastDispatch.size > 64) {
      this._lastDispatch.delete(this._lastDispatch.keys().next().value) // Map 插入序：删最旧
    }
  }

  /**
   * 分发一条聊天消息。
   * @param {string} line 完整消息（含 ! 前缀）
   * @param {{ sender: string, ctx: Record<string, any> }} dispatchCtx 命令上下文 { bot, cfg, logger, tasks, conn, agent, plugins }
   * @returns {Promise<boolean>} 是否命中命令
   */
  async dispatch (line, { sender, ctx }) {
    const parsed = parseCommand(line)
    if (!parsed.name) return false
    const { name, args, error } = parsed
    const def = this.commands.get(name)
    if (!def) return false
    if (error) {
      // 未闭合引号：命令实际整条未执行（解析失败不分发 handler）——文案如实
      await sendChat(ctx.bot, `§c${error}，命令未执行`, ctx.cfg.chat?.maxLength)
      return true
    }

    if (def.permission === 'op') {
      if (!isOp(sender, ctx.cfg)) {
        await sendChat(ctx.bot, `§c权限不足：${sender} 不在 ops 白名单`, ctx.cfg.chat?.maxLength)
        this.log.warn({ sender, cmd: name }, 'permission denied')
        return true
      }
      // op 命令速率限制（防刷屏；all 命令不限制——混合权限子命令在 handler 内
      // 经 checkOpCooldown/markOpDispatch 自检）
      const cd = this.checkOpCooldown(sender, ctx.cfg)
      if (cd.limited) {
        this.log.warn({ sender, cmd: name }, 'command rate limited')
        await sendChat(ctx.bot, `§c命令冷却中（${cd.remain}s 后可再试）`, ctx.cfg.chat?.maxLength)
        return true
      }
      this.markOpDispatch(sender)
    }

    this.log.debug({ sender, cmd: name, args }, 'command dispatched')
    try {
      await def.handler(ctx, args, sender)
    } catch (err) {
      this.log.error({ cmd: name, err: err.message }, 'command handler error')
      await sendChat(ctx.bot, `§c命令执行出错: ${err.message}`, ctx.cfg.chat?.maxLength)
    }
    return true
  }
}
