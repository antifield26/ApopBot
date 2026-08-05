// L2 技能注册表：LLM 可调用的原子技能（Voyager control_primitives 思想）。
// 技能 = L1 能力的安全封装：权限（op 命令只对 ops 白名单开放）+ 极简 JSONSchema 参数校验。
// execute() 永不抛出——错误以 { ok: false, result: 原因 } 返回，供 LLM 继续决策。

import { isOp } from '../commands/permissions.js'

export function createSkillRegistry (ctx) {
  const skills = new Map()

  function register ({ name, description, parameters = null, permission = 'op', handler }) {
    if (skills.has(name)) throw new Error(`技能重复注册: ${name}`)
    skills.set(name, { name, description, parameters, permission, handler })
  }

  function list () {
    return [...skills.values()].map(({ name, description, parameters, permission }) => ({ name, description, parameters, permission }))
  }

  /** 提供给 LLM 的 tool 定义列表（OpenAI/Anthropic 兼容 schema）。 */
  function listForTools () {
    return [...skills.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters: parameters ?? { type: 'object', properties: {} }
    }))
  }

  /**
   * 执行技能（权限 + 参数校验 + 异常兜底）。
   * @returns {Promise<{ ok: boolean, result: unknown }>}
   */
  async function execute (name, params, user) {
    const skill = skills.get(name)
    if (!skill) return { ok: false, result: `未知技能: ${name}` }
    if (skill.permission === 'op' && !isOp(user, ctx.cfg)) {
      return { ok: false, result: `权限不足：${user} 不在 ops 白名单` }
    }
    const v = validateParams(skill.parameters, params)
    if (!v.ok) return { ok: false, result: v.error }
    try {
      const result = await skill.handler(ctx, params ?? {})
      return { ok: true, result }
    } catch (err) {
      return { ok: false, result: err.message }
    }
  }

  // ---- 内置技能 ----
  // 危险技能（会移动/创建任务）一律 op；只读/对话技能 all。

  register({
    name: 'reply',
    description: '以 Bot 身份向当前对话的玩家发送一句话（聊天）。用于回答玩家或汇报状态。',
    parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: '要发送的消息内容，不超过 250 字符' } } },
    permission: 'all',
    handler: async (c, { text }) => {
      const { sendChat } = await import('../core/chat.js')
      await sendChat(c.bot, String(text).slice(0, 250), c.cfg.chat?.maxLength)
      return '已发送'
    }
  })

  register({
    name: 'status',
    description: '获取 Bot 状态摘要（连接状态/位置/内存/重连次数）。',
    permission: 'all',
    handler: async (c) => {
      const s = c.conn.getStatus()
      const e = c.bot?.entity
      return {
        state: s.state,
        reconnectCount: s.reconnectCount,
        position: e ? [Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)] : null,
        health: e?.health ?? null,
        food: e?.food ?? null,
        memMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
      }
    }
  })

  register({
    name: 'task_status',
    description: '获取全部任务的运行状态与计数。',
    permission: 'all',
    handler: async (c) => c.tasks.getStatus()
  })

  register({
    name: 'inventory_summary',
    description: '获取背包物品摘要（名称与数量）。',
    permission: 'all',
    handler: async (c) => {
      const counts = {}
      for (const it of c.bot?.inventory?.items() ?? []) {
        counts[it.name] = (counts[it.name] ?? 0) + (it.count ?? 1)
      }
      return counts
    }
  })

  register({
    name: 'list_skills',
    description: '列出所有可用技能及说明。',
    permission: 'all',
    handler: async () => list().map(s => `${s.name}: ${s.description}`)
  })

  register({
    name: 'move_to',
    description: '让 Bot 寻路移动到指定坐标。',
    parameters: {
      type: 'object',
      required: ['x', 'y', 'z'],
      properties: {
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }
      }
    },
    handler: async (c, { x, y, z }) => {
      const mod = await import('mineflayer-pathfinder') // 动态导入：CJS default 为完整 exports
      const { goals: g } = mod.default ?? mod
      c.bot.pathfinder.setGoal(new g.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z)))
      return `开始移动到 ${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
    }
  })

  register({
    name: 'run_task',
    description: '运行时创建并启动一个任务（不持久化）。type 见任务列表。',
    parameters: {
      type: 'object',
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', description: 'mine/fish/afk/farm/chop/combat/breed' },
        id: { type: 'string', description: '任务唯一 id' },
        options: { type: 'object', description: '任务 options（如 area/blockTypes/durationMinutes）' }
      }
    },
    handler: async (c, { type, id, options }) => {
      c.tasks.addTask({ id, type, options: options ?? {}, notifyChat: true })
      return `任务 ${id} (${type}) 已启动`
    }
  })

  register({
    name: 'stop_task',
    description: '停止并移除一个运行中/已配置的任务。',
    parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    handler: async (c, { id }) => {
      await c.tasks.removeTask(id)
      return `任务 ${id} 已移除`
    }
  })

  register({
    name: 'follow_player',
    description: '让 Bot 跟随（或停止跟随，参数 off）指定玩家。',
    parameters: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', description: '玩家名，或 off 停止跟随' } }
    },
    handler: async (c, { name }) => {
      if (name === 'off') {
        c.plugins?.follow?.stop()
        return '已停止跟随'
      }
      const player = Object.values(c.bot.players ?? {}).find(p => p.username === name)
      if (!player?.entity) return `找不到玩家 ${name}`
      c.plugins?.follow?.setTarget(player.entity)
      return `开始跟随 ${name}`
    }
  })

  return { register, list, listForTools, execute }
}

/** 极简 JSONSchema 校验（type + required）。 */
function validateParams (schema, params) {
  if (!schema) return { ok: true }
  params = params ?? {}
  for (const k of schema.required ?? []) {
    if (params[k] === undefined) return { ok: false, error: `缺少参数: ${k}` }
  }
  for (const [k, def] of Object.entries(schema.properties ?? {})) {
    if (params[k] === undefined) continue
    const v = params[k]
    const ok = {
      number: typeof v === 'number',
      integer: Number.isInteger(v),
      string: typeof v === 'string',
      boolean: typeof v === 'boolean',
      object: typeof v === 'object' && v !== null && !Array.isArray(v),
      array: Array.isArray(v)
    }[def.type]
    if (!ok) return { ok: false, error: `${k} 必须是 ${def.type}` }
  }
  return { ok: true }
}
