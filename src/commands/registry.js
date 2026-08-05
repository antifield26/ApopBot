import { parseCommand } from './parser.js'
import { isOp } from './permissions.js'

/**
 * 命令注册与分发。
 */
export class CommandRegistry {
  constructor (logger) {
    this.log = logger.child({ module: 'commands' })
    this.commands = new Map()
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
    const { name, args } = parseCommand(line)
    if (!name) return false
    const def = this.commands.get(name)
    if (!def) return false

    if (def.permission === 'op' && !isOp(sender, ctx.cfg)) {
      ctx.bot.chat(`§c权限不足：${sender} 不在 ops 白名单`)
      this.log.warn({ sender, cmd: name }, 'permission denied')
      return true
    }

    this.log.debug({ sender, cmd: name, args }, 'command dispatched')
    try {
      await def.handler(ctx, args, sender)
    } catch (err) {
      this.log.error({ cmd: name, err: err.message }, 'command handler error')
      ctx.bot.chat(`§c命令执行出错: ${err.message}`)
    }
    return true
  }
}
