import { CommandRegistry } from './registry.js'
import { loadConfig } from '../core/config.js'

/**
 * 注册内置命令。
 * ctx: { bot, cfg, logger, tasks, conn, agent, plugins, onReload }
 */
export function registerBuiltinCommands (registry, ctx) {
  registry.register({
    name: 'ping',
    description: '心跳检查',
    permission: 'all',
    handler: async (c) => {
      const uptime = Math.round(process.uptime())
      c.bot.chat(`pong (uptime=${uptime}s)`)
    }
  })

  registry.register({
    name: 'status',
    description: 'Bot 状态摘要',
    handler: async (c) => {
      const s = c.conn.getStatus()
      const e = c.bot.entity
      const pos = e ? `${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}` : 'n/a'
      const mem = `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`
      const taskSummary = c.tasks.getStatus().map(t => `${t.id}:${t.state}`).join(' ') || 'none'
      c.bot.chat(`§a[status] pos=${pos} hp=${e?.health?.toFixed(0) ?? 'n/a'} food=${e?.food ?? 'n/a'} state=${s.state} reconnects=${s.reconnectCount} mem=${mem} tasks=[${taskSummary}]`)
    }
  })

  registry.register({
    name: 'task',
    usage: '!task list|start <id>|stop <id>|pause <id>|resume <id>',
    description: '任务控制',
    handler: async (c, args) => {
      const [action, id] = args
      if (action === 'list') {
        const status = c.tasks.getStatus()
        c.bot.chat(status.length
          ? status.map(t => `${t.id}:${t.state}${t.lastError ? `(err:${t.lastError})` : ''}`).join(', ')
          : 'no tasks configured')
        return
      }
      if (!id) { c.bot.chat(`§c用法: !task ${action} <id>`); return }
      switch (action) {
        case 'start': await c.tasks.startTask(id); break
        case 'stop': await c.tasks.stopTask(id); break
        case 'pause': await c.tasks.pauseTask(id); break
        case 'resume': await c.tasks.resumeTask(id); break
        default: c.bot.chat(`§c未知操作: ${action}（可用 list/start/stop/pause/resume）`)
      }
    }
  })

  registry.register({
    name: 'reload',
    description: '热重载配置与任务（等价于 systemctl reload）',
    handler: async (c) => {
      const cfg = loadConfig()
      await c.tasks.reload(cfg)
      c.cfg = cfg
      c.bot.chat('§a配置已重载')
    }
  })

  registry.register({
    name: 'say',
    usage: '!say <text>',
    description: '以 Bot 身份说话',
    handler: async (c, args) => {
      c.bot.chat(args.join(' '))
    }
  })

  registry.register({
    name: 'pos',
    description: '当前坐标（调试）',
    handler: async (c) => {
      const p = c.bot.entity.position
      c.bot.chat(`pos=${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} yaw=${c.bot.entity.yaw.toFixed(1)}`)
    }
  })

  registry.register({
    name: 'follow',
    usage: '!follow <player>|off',
    description: '跟随指定玩家（需配置 mineflayerPlugins.follow=true）',
    handler: async (c, args) => {
      const [name] = args
      if (!name) { c.bot.chat('§c用法: !follow <player>|off'); return }
      if (!c.plugins?.follow) { c.bot.chat('§c未启用 follow 插件'); return }
      if (name === 'off') {
        c.plugins.follow.stop()
        c.bot.chat('§a已停止跟随')
        return
      }
      const player = Object.values(c.bot.players).find(p => p.username === name)
      if (!player?.entity) { c.bot.chat(`§c找不到玩家 ${name}`); return }
      c.plugins.follow.setTarget(player.entity)
      c.bot.chat(`§a开始跟随 ${name}`)
    }
  })

  registry.register({
    name: 'agent',
    usage: '!agent chat <text> | !agent act <name> [json]',
    description: 'L2 LLM 层（需配置 l2.enabled=true）',
    handler: async (c, args, sender) => {
      if (!c.agent) { c.bot.chat('§cL2 未启用（配置 l2.enabled=true 后重启）'); return }
      const [action, ...rest] = args
      if (action === 'chat') {
        const { reply } = await c.agent.chat(sender, rest.join(' '))
        c.bot.chat(reply)
      } else if (action === 'act') {
        const name = rest[0]
        let params = {}
        try { params = rest[1] ? JSON.parse(rest[1]) : {} } catch { c.bot.chat('§c参数必须是 JSON'); return }
        const { ok, result } = await c.agent.act(name, params)
        c.bot.chat(ok ? `§a${name}: ${JSON.stringify(result)}` : `§c${name} 执行失败: ${result}`)
      } else {
        c.bot.chat('§c用法: !agent chat <text> | !agent act <name> [json]')
      }
    }
  })

  return registry
}

export function createCommandRegistry (ctx) {
  const registry = new CommandRegistry(ctx.logger)
  return registerBuiltinCommands(registry, ctx)
}
