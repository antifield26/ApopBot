import { CommandRegistry } from './registry.js'
import { isOp } from './permissions.js'
import { sendChat } from '../core/chat.js'

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
      await sendChat(c.bot, `pong (uptime=${uptime}s)`, c.cfg.chat?.maxLength)
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
      const taskSummary = c.tasks.getStatus().map(t => `${t.id}:${t.state}${t.waitingReason ? `(${t.waitingReason})` : ''}`).join(' ') || 'none'
      // health/food 走 update_health 包（bot.health/bot.food）：26.1 下实体元数据不解析 health（实测 undefined）
      await sendChat(c.bot, `§a[status] pos=${pos} hp=${c.bot.health?.toFixed(0) ?? 'n/a'} food=${c.bot.food ?? 'n/a'} state=${s.state} reconnects=${s.reconnectCount} mem=${mem} tasks=[${taskSummary}]`, c.cfg.chat?.maxLength)
    }
  })

  registry.register({
    name: 'task',
    usage: '!task list|new|remove|start <id>|stop <id>|pause <id>|resume <id>',
    description: '任务控制',
    handler: async (c, args) => {
      const [action, id] = args
      if (!action) { // 无参数：渲染完整用法（不再出现 "用法: !task undefined <id>"）
        await sendChat(c.bot, '§a用法: !task list | !task new <type> <id> [jsonOptions] | !task remove <id> | !task start|stop|pause|resume <id>', c.cfg.chat?.maxLength)
        return
      }
      if (action === 'list') {
        const status = c.tasks.getStatus()
        await sendChat(c.bot, status.length
          ? status.map(t => `${t.id}:${t.state}${t.waitingReason ? `(${t.waitingReason})` : ''}${t.lastError ? `(err:${t.lastError})` : ''}${Object.keys(t.counters).length ? `[${JSON.stringify(t.counters)}]` : ''}`).join('; ')
          : 'no tasks configured', c.cfg.chat?.maxLength)
        return
      }
      if (action === 'new') {
        const [type, newId, ...rest] = args.slice(1)
        const optionsJson = rest.join(' ')
        let options = {}
        if (optionsJson) {
          try { options = JSON.parse(optionsJson) } catch { await sendChat(c.bot, '§c参数必须是 JSON 对象', c.cfg.chat?.maxLength); return }
        }
        try {
          c.tasks.addTask({ id: newId, type, options, notifyChat: true })
          await sendChat(c.bot, `§a已创建任务 ${newId} (${type})`, c.cfg.chat?.maxLength)
        } catch (err) {
          await sendChat(c.bot, `§c创建失败: ${err.message}`, c.cfg.chat?.maxLength)
        }
        return
      }
      if (action === 'remove') {
        if (!id) { await sendChat(c.bot, '§c用法: !task remove <id>', c.cfg.chat?.maxLength); return }
        try {
          await c.tasks.removeTask(id)
          await sendChat(c.bot, `§a已移除任务 ${id}`, c.cfg.chat?.maxLength)
        } catch (err) {
          await sendChat(c.bot, `§c移除失败: ${err.message}`, c.cfg.chat?.maxLength)
        }
        return
      }
      if (!id) { await sendChat(c.bot, `§c用法: !task ${action} <id>`, c.cfg.chat?.maxLength); return }
      switch (action) {
        case 'start': await c.tasks.startTask(id); break
        case 'stop': await c.tasks.stopTask(id); break
        case 'pause': await c.tasks.pauseTask(id); break
        case 'resume': await c.tasks.resumeTask(id); break
        default: await sendChat(c.bot, `§c未知操作: ${action}（可用 list/new/remove/start/stop/pause/resume）`, c.cfg.chat?.maxLength)
      }
    }
  })

  registry.register({
    name: 'reload',
    description: '热重载配置与任务（等价于 systemctl reload）',
    handler: async (c) => {
      // 与 SIGHUP/配置监视走同一条队列（校验 → updateCfg → tasks diff 重载）
      await c.onReload?.()
      await sendChat(c.bot, '§a配置已重载', c.cfg.chat?.maxLength)
    }
  })

  registry.register({
    name: 'say',
    usage: '!say <text>',
    description: '以 Bot 身份说话（超长自动分片）',
    handler: async (c, args) => {
      await sendChat(c.bot, args.join(' '), c.cfg.chat?.maxLength)
    }
  })

  registry.register({
    name: 'pos',
    description: '当前坐标（调试）',
    handler: async (c) => {
      const p = c.bot.entity.position
      await sendChat(c.bot, `pos=${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} yaw=${c.bot.entity.yaw.toFixed(1)}`, c.cfg.chat?.maxLength)
    }
  })

  registry.register({
    name: 'follow',
    usage: '!follow <player>|off',
    description: '跟随指定玩家（需配置 mineflayerPlugins.follow=true）',
    handler: async (c, args) => {
      const [name] = args
      if (!name) { await sendChat(c.bot, '§c用法: !follow <player>|off', c.cfg.chat?.maxLength); return }
      if (!c.plugins?.follow) { await sendChat(c.bot, '§c未启用 follow 插件', c.cfg.chat?.maxLength); return }
      if (name === 'off') {
        c.plugins.follow.stop()
        await sendChat(c.bot, '§a已停止跟随', c.cfg.chat?.maxLength)
        return
      }
      const player = Object.values(c.bot.players).find(p => p.username === name)
      if (!player?.entity) { await sendChat(c.bot, `§c找不到玩家 ${name}`, c.cfg.chat?.maxLength); return }
      c.plugins.follow.setTarget(player.entity)
      await sendChat(c.bot, `§a开始跟随 ${name}`, c.cfg.chat?.maxLength)
    }
  })

  registry.register({
    name: 'agent',
    usage: '!agent chat <text> | !agent act <name> [json]',
    description: 'L2 LLM 层（需配置 l2.enabled=true；act 需 op）',
    handler: async (c, args, sender) => {
      if (!c.agent) { await sendChat(c.bot, '§cL2 未启用（配置 l2.enabled=true 后重启）', c.cfg.chat?.maxLength); return }
      const [action, ...rest] = args
      if (action === 'chat') {
        const { reply } = await c.agent.chat(sender, rest.join(' '))
        await sendChat(c.bot, reply, c.cfg.chat?.maxLength)
      } else if (action === 'act') {
        // act 直调技能（可移动/控制任务），入口即做 op 校验
        if (!isOp(sender, c.cfg)) {
          await sendChat(c.bot, '§c权限不足：!agent act 需要 op', c.cfg.chat?.maxLength)
          return
        }
        const name = rest[0]
        if (!name) { await sendChat(c.bot, '§c用法: !agent act <name> [json]', c.cfg.chat?.maxLength); return }
        let params = {}
        try { params = rest[1] ? JSON.parse(rest[1]) : {} } catch { await sendChat(c.bot, '§c参数必须是 JSON', c.cfg.chat?.maxLength); return }
        const { ok, result } = await c.agent.act(sender, name, params)
        const out = typeof result === 'string' ? result : JSON.stringify(result)
        await sendChat(c.bot, ok ? `§a${name}: ${out}` : `§c${name} 执行失败: ${out}`, c.cfg.chat?.maxLength)
      } else {
        await sendChat(c.bot, '§c用法: !agent chat <text> | !agent act <name> [json]', c.cfg.chat?.maxLength)
      }
    }
  })

  return registry
}

export function createCommandRegistry (ctx) {
  const registry = new CommandRegistry(ctx.logger)
  return registerBuiltinCommands(registry, ctx)
}
