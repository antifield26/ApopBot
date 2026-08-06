import { parseCommand } from './parser.js'
import { isOp } from './permissions.js'
import { sendChat } from '../core/chat.js'

/**
 * 命令注册与分发。
 */
export class CommandRegistry {
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
   * 分发一条聊天消息。
   * @param {string} line 完整消息（含 ! 前缀）
   * @param {{ sender: string, ctx: object }} dispatchCtx
   * @param {object} dispatchCtx.ctx 命令上下文 { bot, cfg, logger, tasks, conn, agent, plugins }
   * @returns {Promise<boolean>} 是否命中命令
   */
  async dispatch (line, { sender, ctx }) {
    const parsed = parseCommand(line)
    if (!parsed.name) return false
    const { name, args, error } = parsed
    const def = this.commands.get(name)
    if (!def) return false
    if (error) {
      // 未闭合引号：明确提示而非静默吞掉消息尾部
      await sendChat(ctx.bot, `§c${error}（消息尾部被忽略）`, ctx.cfg.chat?.maxLength)
      return true
    }

    if (def.permission === 'op') {
      if (!isOp(sender, ctx.cfg)) {
        await sendChat(ctx.bot, `§c权限不足：${sender} 不在 ops 白名单`, ctx.cfg.chat?.maxLength)
        this.log.warn({ sender, cmd: name }, 'permission denied')
        return true
      }
      // op 命令速率限制（防刷屏；all 命令不限制）
      const cooldownMs = ctx.cfg.chat?.commandCooldownMs ?? 750
      const now = Date.now()
      const last = this._lastDispatch.get(sender) ?? 0
      if (now - last < cooldownMs) {
        this.log.warn({ sender, cmd: name }, 'command rate limited')
        const remain = Math.ceil((cooldownMs - (now - last)) / 1000)
        await sendChat(ctx.bot, `§c命令冷却中（${remain}s 后可再试）`, ctx.cfg.chat?.maxLength)
        return true
      }
      this._lastDispatch.set(sender, now)
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
