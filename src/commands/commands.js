import { CommandRegistry } from './registry.js'
import { isOp } from './permissions.js'
import { sendChat } from '../core/chat.js'
import { findSurfaceBlocks, createMovement, REASON_TEXT } from '../core/movement.js'
import { validateTaskOptions } from '../core/task-schemas.js'
import { hasExclusiveActive, getExclusiveOwner } from '../core/arbiter.js'

// !find 防重入：行走期间重复 find 拒绝（单 bot 架构，模块级标志）。
// 重连重建功能层时若残留 true，由 120s 墙钟超时自愈（goto 必然结束）
let findBusy = false

/** 命令层动作审计（!find/!follow 走 executor 的审计通道——L2 关闭时静默）。 */
function auditCommand (c, op, args, ok, result, durationMs = 0) {
  try {
    c.agent?.executor?.audit?.append({ op, args, ok, result, durationMs, source: 'command' })
  } catch { /* 审计失败静默 */ }
}

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
      // health/food 走 update_health 包（bot.health/bot.food）：26.1 下实体元数据不含 health
      await sendChat(c.bot, `§a[status] pos=${pos} hp=${c.bot.health?.toFixed(0) ?? 'n/a'} food=${c.bot.food ?? 'n/a'} state=${s.state} reconnects=${s.reconnectCount} mem=${mem} tasks=[${taskSummary}]`, c.cfg.chat?.maxLength)
    }
  })

  registry.register({
    name: 'task',
    usage: '!task list|new|remove|start <id>|stop <id>|pause <id>|resume <id>',
    description: '任务控制',
    handler: async (c, args) => {
      const [action, id] = args
      if (!action) { // 无参数：渲染完整用法（否则输出 "用法: !task undefined <id>"）
        await sendChat(c.bot, '§a用法: !task list | !task new <type> <id> [jsonOptions] | !task remove <id> | !task start|stop|pause|resume <id>', c.cfg.chat?.maxLength)
        return
      }
      if (action === 'list') {
        const status = c.tasks.getStatus()
        // 排队位置/时长剩余/下次 cron 触发（调度可见性）
        // nextRunAt 按 scheduleTimezone 渲染——机器本地时区与调度时区不一致时，
        // 本地时区渲染的"下次触发"与实际触发时间不符
        const tz = c.cfg?.scheduleTimezone ?? 'Asia/Shanghai'
        const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
        await sendChat(c.bot, status.length
          ? status.map(t => {
            const parts = [`${t.id}:${t.state}`]
            if (t.waitingReason) parts.push(`(${t.waitingReason})`)
            if (t.lastError) parts.push(`(err:${t.lastError})`)
            if (t.queuePosition) parts.push(`[排队#${t.queuePosition}]`)
            if (t.remainingMinutes !== undefined) parts.push(`[余${t.remainingMinutes}m]`)
            if (t.nextRunAt) parts.push(`[下次${fmt.format(t.nextRunAt)}]`)
            if (Object.keys(t.counters).length) parts.push(`[${JSON.stringify(t.counters)}]`)
            return parts.join('')
          }).join('; ')
          : 'no tasks configured', c.cfg.chat?.maxLength)
        return
      }
      if (action === 'new') {
        const [type, newId, ...rest] = args.slice(1)
        if (!type || !newId) {
          await sendChat(c.bot, '§c用法: !task new <type> <id> [jsonOptions]（type 与 id 不能为空）', c.cfg.chat?.maxLength)
          return
        }
        const optionsJson = rest.join(' ')
        let options = {}
        if (optionsJson) {
          try { options = JSON.parse(optionsJson) } catch { await sendChat(c.bot, '§c参数必须是 JSON 对象', c.cfg.chat?.maxLength); return }
        }
        // ad-hoc options 过 schema 校验：零校验会放行负 durationMinutes /
        // intervalMinutes 0（忙循环）等非法值；未知键放行向前兼容
        const v = validateTaskOptions(type, options)
        if (!v.ok) {
          await sendChat(c.bot, `§c参数校验失败: ${v.error}`, c.cfg.chat?.maxLength)
          return
        }
        try {
          c.tasks.addTask({ id: newId, type, options, notifyChat: true })
          await sendChat(c.bot, `§a已创建任务 ${newId} (${type})`, c.cfg.chat?.maxLength)
          // 等一个事件循环轮：init 抛错在 fire-and-forget 微任务内置 failed——立即查会误判
          //（skills.js run_task 同款模式）
          await new Promise(r => setImmediate(r))
          // failed 状态如实反馈：init 抛错（非法 options/缺插件）时任务已失败但
          // 玩家收到"已创建"会误导排障
          const st = c.tasks.getStatus().find(t => t.id === newId)
          if (st?.state === 'failed') {
            await sendChat(c.bot, `§c任务 ${newId} (${type}) 启动失败: ${st.lastError ?? '未知原因'}`, c.cfg.chat?.maxLength)
          } else if (st && st.state === 'created' && c.tasks.isPendingExclusive?.(newId)) {
            await sendChat(c.bot, `§e注意: 任务 ${newId} 已排队（exclusive 任务冲突，等待中）`, c.cfg.chat?.maxLength)
          }
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
        case 'start': {
          // startTask 返回 run 完成 promise——await 会让常驻任务的回复挂到任务结束
          //（数小时无响应）。fire-and-forget + setImmediate 后查状态反馈
          //（skills.js run_task 同款模式：failed/已排队/已启动如实告知）
          c.tasks.startTask(id).catch(err => c.logger?.warn?.({ err: err.message }, 'task start failed'))
          await new Promise(r => setImmediate(r))
          const st = c.tasks.getStatus().find(t => t.id === id)
          if (!st) {
            await sendChat(c.bot, `§c任务不存在: ${id}（!task list 查看）`, c.cfg.chat?.maxLength)
          } else if (st.state === 'failed') {
            await sendChat(c.bot, `§c任务 ${id} 启动失败: ${st.lastError ?? '未知原因'}`, c.cfg.chat?.maxLength)
          } else if (st.state === 'completed') {
            await sendChat(c.bot, `§c任务 ${id} 已自然完成（无事可做）`, c.cfg.chat?.maxLength)
          } else if (st.state === 'created') {
            await sendChat(c.bot, `§a任务 ${id} 已排队（等待冲突的 exclusive 任务结束）`, c.cfg.chat?.maxLength)
          } else {
            await sendChat(c.bot, `§a任务 ${id} 已启动`, c.cfg.chat?.maxLength)
          }
          break
        }
        case 'stop': {
          const ok = await c.tasks.stopTask(id)
          await sendChat(c.bot, ok ? `§a已停止任务 ${id}` : `§c任务不存在: ${id}`, c.cfg.chat?.maxLength)
          break
        }
        case 'pause': {
          // 状态校验：created（exclusive 排队）/已停/已完任务 pause 是静默 no-op——明确反馈
          const st = c.tasks.getStatus().find(t => t.id === id)
          if (!st) { await sendChat(c.bot, `§c任务不存在: ${id}`, c.cfg.chat?.maxLength); break }
          if (!['init', 'running'].includes(st.state)) {
            await sendChat(c.bot, `§e任务 ${id} 未在运行（${st.state}），无法暂停`, c.cfg.chat?.maxLength)
            break
          }
          await c.tasks.pauseTask(id)
          await sendChat(c.bot, `§a已暂停任务 ${id}`, c.cfg.chat?.maxLength)
          break
        }
        case 'resume': {
          const st = c.tasks.getStatus().find(t => t.id === id)
          if (!st) { await sendChat(c.bot, `§c任务不存在: ${id}`, c.cfg.chat?.maxLength); break }
          if (st.state !== 'paused') {
            await sendChat(c.bot, `§e任务 ${id} 未在暂停状态（${st.state}），无法恢复`, c.cfg.chat?.maxLength)
            break
          }
          await c.tasks.resumeTask(id)
          await sendChat(c.bot, `§a已恢复任务 ${id}`, c.cfg.chat?.maxLength)
          break
        }
        default: await sendChat(c.bot, `§c未知操作: ${action}（可用 list/new/remove/start/stop/pause/resume）`, c.cfg.chat?.maxLength)
      }
    }
  })

  registry.register({
    name: 'reload',
    description: '热重载配置与任务（与改配置文件等效）',
    handler: async (c) => {
      // 与 SIGHUP/配置监视走同一条队列（校验 → updateCfg → tasks diff 重载）。
      // 读取/校验失败 → reload 返回 false；运行时异常 → queue 上抛——
      // 两者都如实反馈，配置写坏/代码异常时不会假成功"配置已重载"
      let result
      try {
        result = await c.onReload?.()
      } catch {
        result = 'error'
      }
      if (result === false) {
        await sendChat(c.bot, '§c重载失败（配置无效，保留旧配置，详见日志）', c.cfg.chat?.maxLength)
      } else if (result === 'error') {
        await sendChat(c.bot, '§c重载失败（运行时错误，保留旧配置，详见日志）', c.cfg.chat?.maxLength)
      } else {
        await sendChat(c.bot, '§a配置已重载', c.cfg.chat?.maxLength)
      }
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
        auditCommand(c, 'follow_player', { name: 'off' }, true, '已停止跟随')
        await sendChat(c.bot, '§a已停止跟随', c.cfg.chat?.maxLength)
        return
      }
      // exclusive 任务运行中拒绝跟随——follow 直接控制层与任务 pathfinder 双
      // 控制器冲突（!find 仅警告，follow 直接拒绝）
      if (hasExclusiveActive()) {
        const owner = getExclusiveOwner()
        await sendChat(c.bot, `§c无法跟随：exclusive 任务 ${owner} 运行中（移动互斥，先 !task stop ${owner}）`, c.cfg.chat?.maxLength)
        return
      }
      const lower = name.toLowerCase()
      const player = Object.values(c.bot.players).find(p => p.username.toLowerCase() === lower)
      if (!player?.entity) { await sendChat(c.bot, `§c找不到玩家 ${name}`, c.cfg.chat?.maxLength); return }
      c.plugins.follow.setTarget(player.entity)
      auditCommand(c, 'follow_player', { name }, true, '开始跟随')
      await sendChat(c.bot, `§a开始跟随 ${name}`, c.cfg.chat?.maxLength)
    }
  })

  registry.register({
    name: 'home',
    usage: '!home set <name> | !home remove <name> | !home list',
    description: '命名地点（家/矿场/基地；set/remove 需 op，list 全员）——LLM 经 query_map place 查询',
    permission: 'all', // set/remove 在 handler 内 op 门（与 !agent 同款混合权限）
    handler: async (c, args, sender) => {
      const { setPlace, removePlace, listPlaces } = await import('../core/discovery.js')
      const [action, name] = args
      if (action === 'set') {
        if (!isOp(sender, c.cfg)) {
          await sendChat(c.bot, '§c权限不足：!home set 需要 op', c.cfg.chat?.maxLength)
          return
        }
        const p = c.bot?.entity?.position
        if (!name || !p) {
          await sendChat(c.bot, '§c用法: !home set <name>（当前位置命名）', c.cfg.chat?.maxLength)
          return
        }
        const dim = c.bot?.game?.dimension?.replace(/^minecraft:/, '') ?? null
        setPlace(name, p, dim)
        await sendChat(c.bot, `§a地点 ${name} 已记录（${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}${dim ? ` ${dim}` : ''}）`, c.cfg.chat?.maxLength)
        return
      }
      if (action === 'remove') {
        if (!isOp(sender, c.cfg)) {
          await sendChat(c.bot, '§c权限不足：!home remove 需要 op', c.cfg.chat?.maxLength)
          return
        }
        if (!name) { await sendChat(c.bot, '§c用法: !home remove <name>', c.cfg.chat?.maxLength); return }
        await sendChat(c.bot, removePlace(name) ? `§a地点 ${name} 已删除` : `§c地点 ${name} 不存在`, c.cfg.chat?.maxLength)
        return
      }
      const places = listPlaces()
      await sendChat(c.bot, places.length
        ? `§a命名地点: ${places.map(p => `${p.name}(${p.x},${p.y},${p.z}${p.dimension ? ` ${p.dimension}` : ''})`).join('; ')}`
        : '§e暂无命名地点（!home set <name> 登记）', c.cfg.chat?.maxLength)
    }
  })

  registry.register({
    name: 'find',
    usage: '!find <方块名> [maxDistance]',
    description: '找到指定方块的地表暴露位置（上方 2 格为天空）并走过去（3 格内）',
    handler: async (c, args) => {
      const [blockName, maxDistanceStr] = args
      if (!blockName) {
        await sendChat(c.bot, '§c用法: !find <方块名> [maxDistance]（如 !find iron_ore）', c.cfg.chat?.maxLength)
        return
      }
      let maxDistance = 64
      if (maxDistanceStr !== undefined) {
        maxDistance = Number(maxDistanceStr)
        if (!Number.isInteger(maxDistance) || maxDistance < 16 || maxDistance > 256) {
          await sendChat(c.bot, '§cmaxDistance 须为 16-256 的整数（受客户端 viewDistance 限制）', c.cfg.chat?.maxLength)
          return
        }
      }
      if (findBusy) {
        await sendChat(c.bot, '§e上一个 find 仍在进行中，请稍候', c.cfg.chat?.maxLength)
        return
      }
      findBusy = true
      try {
        // 地表候选查询（palette 快路径 + 上方 2 格空/透明验证）
        let result
        try {
          result = findSurfaceBlocks(c.bot, blockName, { maxDistance })
        } catch (err) {
          await sendChat(c.bot, `§c未知方块类型: ${blockName}（!find 帮助查看示例）`, c.cfg.chat?.maxLength)
          return
        }
        const { candidates } = result
        if (candidates.length === 0) {
          auditCommand(c, 'find_block', { blockName, maxDistance }, false, '无候选')
          await sendChat(c.bot, `§c范围内（${maxDistance} 格）没有暴露在地表的 ${blockName}`, c.cfg.chat?.maxLength)
          return
        }
        // exclusive 任务运行中（仲裁器登记）：collect 会收到 GoalChanged 中断——
        // 警告后放行（玩家自行权衡）
        if (hasExclusiveActive()) {
          const owner = getExclusiveOwner()
          const entry = (c.tasks?.getStatus?.() ?? []).find(t => t.id === owner)
          const label = entry ? `任务 ${owner} (${entry.type})` : `exclusive 任务 ${owner}`
          await sendChat(c.bot, `§e注意: ${label} 运行中——寻路会与其移动冲突`, c.cfg.chat?.maxLength)
        }
        // 走到最近地表候选 3 格内（GoalCompositeAny 多候选点选最近可达）
        const t0 = Date.now()
        const r = await createMovement(c.bot, c.logger).gotoNearest(candidates, 3, { timeoutMs: 120000 })
        const nearest = candidates.reduce((a, b) =>
          (a.x - c.bot.entity.position.x) ** 2 + (a.z - c.bot.entity.position.z) ** 2 <=
          (b.x - c.bot.entity.position.x) ** 2 + (b.z - c.bot.entity.position.z) ** 2 ? a : b)
        const dist = Math.round(Math.hypot(nearest.x - c.bot.entity.position.x, nearest.z - c.bot.entity.position.z))
        if (r.ok) {
          const el = Math.round((Date.now() - t0) / 1000)
          // 汇报实际到达点：GoalCompositeAny 在最近候选不可达时会到达更远候选，
          // 报"最近候选"坐标与实际位置不符（误导玩家）
          const p = c.bot.entity.position
          auditCommand(c, 'find_block', { blockName, maxDistance }, true, `已到达 ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`, Date.now() - t0)
          await sendChat(c.bot, `§a找到 ${blockName}，已到达 ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}（水平距离 ${dist}m，耗时 ${el}s）`, c.cfg.chat?.maxLength)
        } else {
          auditCommand(c, 'find_block', { blockName, maxDistance }, false, REASON_TEXT[r.reason] ?? '移动失败', Date.now() - t0)
          await sendChat(c.bot, `§e找到 ${blockName} 但${REASON_TEXT[r.reason] ?? '移动失败'}：最近候选 ${Math.floor(nearest.x)},${Math.floor(nearest.y)},${Math.floor(nearest.z)}（水平距离 ${dist}m）`, c.cfg.chat?.maxLength)
        }
      } finally {
        findBusy = false
      }
    }
  })

  registry.register({
    name: 'agent',
    usage: '!agent chat <text> | !agent act <name> [json] | !agent doctor | !agent reset',
    description: 'L2 LLM 层（需配置 l2.enabled=true；chat 全员可用，act 需 op）',
    // permission all：默认 op 会使 buildSystem 的"普通玩家"分支成为死代码
    //（!agent chat 在权限门就被拒）；技能层 isOp 仍是危险操作最终防线
    permission: 'all',
    handler: async (c, args, sender) => {
      if (!c.agent) { await sendChat(c.bot, '§cL2 未启用（配置 l2.enabled=true 后重启）', c.cfg.chat?.maxLength); return }
      const [action, ...rest] = args
      if (action === 'chat') {
        // 空文本进 LLM 消耗一轮生成与调用者冷却——入口拦截
        if (!rest.join(' ').trim()) {
          await sendChat(c.bot, '§c用法: !agent chat <text>（消息不能为空）', c.cfg.chat?.maxLength)
          return
        }
        const { reply } = await c.agent.chat(sender, rest.join(' '))
        await sendChat(c.bot, reply, c.cfg.chat?.maxLength)
      } else if (action === 'reset') {
        // 清空调用者会话记忆（多轮上下文误入歧途时重置）
        c.agent.reset(sender)
        await sendChat(c.bot, '§a已清空会话记忆', c.cfg.chat?.maxLength)
      } else if (action === 'goal') {
        // 长期目标记忆（!agent goal 查看全员 / set/clear 需 op——目标会注入 LLM
        // 提示词并驱动其行为，非 op 玩家不得设置）
        if (rest[0] === 'set') {
          if (!isOp(sender, c.cfg)) {
            await sendChat(c.bot, '§c权限不足：!agent goal set 需要 op', c.cfg.chat?.maxLength)
            return
          }
          const text = rest.slice(1).join(' ').trim()
          if (!text) { await sendChat(c.bot, '§c用法: !agent goal set <目标文本>', c.cfg.chat?.maxLength); return }
          c.agent.setGoal(sender, text)
          await sendChat(c.bot, `§a长期目标已设置: ${text.slice(0, 80)}`, c.cfg.chat?.maxLength)
          return
        }
        if (rest[0] === 'clear') {
          if (!isOp(sender, c.cfg)) {
            await sendChat(c.bot, '§c权限不足：!agent goal clear 需要 op', c.cfg.chat?.maxLength)
            return
          }
          c.agent.clearGoal(sender)
          await sendChat(c.bot, '§a长期目标已清除', c.cfg.chat?.maxLength)
          return
        }
        const g = c.agent.getGoal(sender)
        await sendChat(c.bot, g
          ? `§a当前目标: ${g.text}${g.plan?.length ? `（计划: ${g.plan.join('→')}）` : ''}（由 ${g.setBy} 设置）`
          : '§e暂无长期目标（!agent goal set <文本> 设置）', c.cfg.chat?.maxLength)
      } else if (action === 'doctor') {
        // provider 连通性诊断（只读，全员可用）
        try {
          const results = await c.agent.diagnose()
          const mode = c.agent.provider?.mode ?? '?'
          const latency = c.agent.usage?.latencyMs
          const lines = results.map(r =>
            `${r.label}: ${r.ok ? `连通${r.status ? ` (${r.status})` : ''}` : `不可达（${r.error}）`}`)
          await sendChat(c.bot, `§a[doctor] 模式=${mode} 最近延迟=${latency ?? 'n/a'}ms；${lines.join('；')}`, c.cfg.chat?.maxLength)
        } catch (err) {
          await sendChat(c.bot, `§c诊断失败: ${err.message}`, c.cfg.chat?.maxLength)
        }
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
        await sendChat(c.bot, '§c用法: !agent chat <text> | !agent act <name> [json] | !agent doctor | !agent reset', c.cfg.chat?.maxLength)
      }
    }
  })

  return registry
}

export function createCommandRegistry (ctx) {
  const registry = new CommandRegistry(ctx.logger)
  return registerBuiltinCommands(registry, ctx)
}
