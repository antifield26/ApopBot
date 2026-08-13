// @ts-check
// 动作原语注册表（按族拆分）：LLM act 动作数组与任务脚本共用的原子动作层。
// 每个原语 { schema, permission, exclusiveClass, guardText, timeoutMs, cooldownMs?, handler }。
// 约定（与 skills.execute 同源，由 executor 统一执行管线保证）：
// - handler(ctx, args, runtime) 返回 result（成功）；业务性"无事可做"（无目标/
//   无物品/冷却）也返回文案（ok:true——动作已有效执行）；真正的异常 throw
//   （executor 转 { ok:false, result: err.message }）
// - runtime = { signal: AbortSignal|null, user, taskId }——signal 贯通长时等待
//   （fish/eat/wait 的 race；movement 的 isInterrupted 组合谓词）
// - exclusive 守卫统一上提 executor（按 exclusiveClass），handler 不再自查
// 权限分级：观察/流程类 all；会改变世界状态（移动/构建/战斗/交互/物品/任务）op。
// 观察类返回结构化对象（LLM 收到 JSON、脚本读字段）；动作类返回简短中文文案。
// 任务管理（op / flow——任务互斥由 manager 排队，不拦）
import * as discovery from '../discovery.js'
import { validateTaskOptions, validateNextOptions, validateCron } from '../task-schemas.js'
import { TASK_TYPES } from '../../tasks/types.js'
import { hasExclusiveActive, getExclusiveOwner } from '../arbiter.js'

/**
 * 注册task族原语。register = index.js 工厂注入的注册函数（含重复注册检查）；
 * _ctx 保留供族文件间约定签名（handler 经 c 首参取 ctx，不经此参数）。
 */
export function registerTask (register, _ctx) {
  // ============ 任务管理（op / flow——任务互斥由 manager 排队，不拦） ============
  register('start_task', {
    schema: {
      type: 'object',
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', description: Object.keys(TASK_TYPES).join('/') },
        id: { type: 'string', description: '任务唯一 id' },
        options: { type: 'object', description: '任务 options（如 area/blockTypes/durationMinutes）' },
        next: { type: 'object', description: '任务链：本任务自然完成后启动 {type,id,options?,schedule?}' },
        schedule: { type: 'string', description: 'cron 表达式——定时触发而非立即启动' }
      }
    },
    permission: 'op',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 10000,
    handler: async (c, { type, id, options, next, schedule }) => {
      // LLM 生成的 ad-hoc options/next/schedule 过 schema（与 !task new 同款入口拦截；
      // next/schedule 是任务链与定时表达——config 与 start_task 共用同一校验口径）
      const v = validateTaskOptions(type, options)
      if (!v.ok) throw new Error(`参数校验失败: ${v.error}`)
      if (next !== undefined) {
        const vn = validateNextOptions(next)
        if (!vn.ok) throw new Error(`参数校验失败: ${vn.error}`)
      }
      // schedule 顶层优先，兼容旧 options.schedule 路径（config 校验已报迁移指引）
      const cron = schedule ?? options?.schedule
      if (cron !== undefined) {
        const vc = validateCron(cron)
        if (!vc.ok) throw new Error(`参数校验失败: ${vc.error}`)
      }
      c.tasks.addTask({
        id,
        type,
        options: options ?? {},
        notifyChat: true,
        ...(next !== undefined ? { next } : {}),
        ...(cron !== undefined ? { schedule: cron } : {})
      })
      // cron 任务注册即返回（到点触发，无 init/启动流程可等）
      if (cron !== undefined) return `任务 ${id} (${type}) 已注册（cron ${cron} 定时触发）`
      // 等 init 完成：同步 init 在一个事件循环轮内 settle；异步 init 轮询至多
      // 500ms——状态离开 created/init 即知结果（failed/completed/running/排队）
      let st = null
      const deadline = Date.now() + 500
      while (Date.now() < deadline) {
        st = c.tasks.getStatus().find(t => t.id === id)
        if (st && !['created', 'init'].includes(st.state)) break
        await new Promise(r => setTimeout(r, 25))
      }
      st = st ?? c.tasks.getStatus().find(t => t.id === id)
      if (!st) return `任务 ${id} 创建失败`
      if (st.state === 'failed') return `任务 ${id} (${type}) 启动失败: ${st.lastError ?? '未知原因'}`
      if (st.state === 'completed') return `任务 ${id} (${type}) 已自然完成（无事可做）`
      if (st.state === 'created' && c.tasks.isPendingExclusive?.(id)) {
        return `任务 ${id} (${type}) 已创建但排队中（exclusive 任务冲突，等待自动启动）`
      }
      return `任务 ${id} (${type}) 已启动`
    }
  })
  register('stop_task', {
    schema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } }
    },
    permission: 'op',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 15000,
    handler: async (c, { id }) => {
      await c.tasks.removeTask(id)
      return `任务 ${id} 已移除`
    }
  })
  register('set_place', {
    schema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', description: '地点名（如 home/矿场/基地）——记录当前位置' } }
    },
    permission: 'op',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { name }) => {
      const p = c.bot?.entity?.position
      if (!p) throw new Error('当前位置不可用')
      const dim = c.bot?.game?.dimension?.replace(/^minecraft:/, '') ?? null
      discovery.setPlace(name, p, dim)
      return `地点 ${name} 已记录（${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}${dim ? ` ${dim}` : ''}）`
    }
  })
  register('remove_place', {
    schema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } }
    },
    permission: 'op',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { name }) => {
      return discovery.removePlace(name) ? `地点 ${name} 已删除` : `地点 ${name} 不存在`
    }
  })
  register('set_goal', {
    schema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: '长期目标（玩家交代的任务），空文本 = 清除' },
        plan: { type: 'array', items: { type: 'string' }, description: '计划步骤（≤5 条，可选）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { text, plan }, runtime) => {
      const user = runtime?.user ?? c._caller ?? null
      if (!user || !c.agent?.setGoal) throw new Error('目标记忆不可用（L2 未启用或会话缺失）')
      if (!text || !String(text).trim()) {
        c.agent.clearGoal(user)
        return '长期目标已清除'
      }
      c.agent.setGoal(user, String(text).trim(), plan)
      return `长期目标已设置: ${String(text).trim().slice(0, 80)}`
    }
  })
  register('follow_player', {
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '玩家名（大小写不敏感），off 停止跟随；"跟随我"时可不填或填 me' }
      }
    },
    permission: 'op',
    // off（停止跟随）不冲突移动权——守卫放 handler 内（executor 统一守卫拦不到 off）
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 10000,
    handler: async (c, { name }, runtime) => {
      if (!c.plugins?.follow) throw new Error('follow 插件未启用（配置 mineflayerPlugins.follow=true 并重启）')
      if (name === 'off') {
        c.plugins.follow.stop()
        return '已停止跟随'
      }
      // 启动跟随与 exclusive 任务互斥（双控制器冲突防线）
      if (hasExclusiveActive()) {
        throw new Error(`exclusive 任务 ${getExclusiveOwner()} 运行中，无法跟随（任务结束后可试）`)
      }
      // "跟随我"指代消解：优先 per-action 不可变的 runtime.user（多角色共享
      // executor 时 ctx._caller 会被其他角色的 act 在 await 中途覆盖——角色 A
      // 的"跟随我"解析到角色 B 的调用者）；_caller 仅作无 runtime 的兼容兜底
      let targetName = name
      if (!name || ['me', 'self', '我', '自己'].includes(String(name).toLowerCase())) {
        targetName = runtime?.user ?? c._caller ?? null
        if (!targetName) return '无法确定要跟随谁（对话上下文缺失）'
      }
      const lower = targetName.toLowerCase()
      const player = Object.values(c.bot.players ?? {}).find(p => p.username.toLowerCase() === lower)
      if (!player) return `找不到玩家 ${targetName}`
      // 目标防御：bot.players 含 Bot 自己——跟随自己 = 原地打转
      if (targetName.toLowerCase() === String(c.bot.username ?? '').toLowerCase()) {
        return '不能跟随 Bot 自己——请指定其他玩家（如"跟随我"）'
      }
      if (!player?.entity || player.entity === c.bot.entity) {
        return `玩家 ${targetName} 不可跟随（实体未加载或指向 Bot 自己）`
      }
      c.plugins.follow.setTarget(player.entity)
      return `开始跟随 ${targetName}`
    }
  })

}
