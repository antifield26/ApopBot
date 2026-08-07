// L2 技能注册表：LLM 可调用的原子技能（Voyager control_primitives 思想）。
// 技能 = L1 能力的安全封装：权限（op 命令只对 ops 白名单开放）+ 极简 JSONSchema 参数校验。
// execute() 永不抛出——错误以 { ok: false, result: 原因 } 返回，供 LLM 继续决策。

import { isOp } from '../commands/permissions.js'
import { validateTaskOptions } from '../core/task-schemas.js'
import { hasExclusiveActive, getExclusiveOwner } from '../core/arbiter.js'

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
        health: c.bot?.health ?? null, // update_health 包（26.1 实体元数据不解析 health）
        food: c.bot?.food ?? null,
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
        // A3（第四轮）：世界边界 ±30000000——LLM 幻觉传 1e18 会直进 GoalBlock
        //（界外坐标寻路行为异常）；validateParams 另有 isFinite 兜底
        x: { type: 'number', min: -30000000, max: 30000000 },
        y: { type: 'number', min: -30000000, max: 30000000 },
        z: { type: 'number', min: -30000000, max: 30000000 }
      }
    },
    handler: async (c, { x, y, z }) => {
      // 统一移动层阻塞式移动（C2）：到达/失败如实反馈，LLM 不再收到 fire-and-forget 假成功
      const { Vec3 } = await import('vec3')
      const { createMovement, REASON_TEXT } = await import('../core/movement.js')
      const r = await createMovement(c.bot, c.logger).gotoPoint(new Vec3(x, y, z), { timeoutMs: 60000 })
      if (r.ok) return `已到达 ${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
      return `移动失败: ${REASON_TEXT[r.reason] ?? r.err?.message}`
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
      // C5（R3 根治版）：LLM 生成的 ad-hoc options 过 schema（与 !task new 同款入口拦截）
      const v = validateTaskOptions(type, options)
      if (!v.ok) throw new Error(`参数校验失败: ${v.error}`)
      c.tasks.addTask({ id, type, options: options ?? {}, notifyChat: true })
      // 等一个事件循环轮：init 抛错在 fire-and-forget 微任务内置 failed——立即查会误判
      await new Promise(r => setImmediate(r))
      const st = c.tasks.getStatus().find(t => t.id === id)
      if (!st) return `任务 ${id} 创建失败`
      if (st.state === 'failed') return `任务 ${id} (${type}) 启动失败: ${st.lastError ?? '未知原因'}`
      if (st.state === 'completed') return `任务 ${id} (${type}) 已自然完成（无事可做）`
      if (st.state === 'created' && c.tasks.isPendingExclusive?.(id)) {
        return `任务 ${id} (${type}) 已创建但排队中（exclusive 任务冲突，等待自动启动）`
      }
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
    name: 'find_block',
    description: '找到指定方块的地表暴露位置（上方 2 格为天空，排除洞穴/地下/液体上方）并走过去（3 格内）。适合找露头矿、竹子、甘蔗等。',
    parameters: {
      type: 'object',
      required: ['blockName'],
      properties: {
        blockName: { type: 'string', description: '方块名（无命名空间前缀，如 iron_ore/bamboo/sugarcane）' },
        // C5/G：16-256 限幅（与 !find 一致）——LLM 幻觉传超大值会触发 findBlocks
        // 同步无界枚举冻结主线程（OctahedronIterator 不因区块未加载而停止）
        maxDistance: { type: 'number', min: 16, max: 256, description: '搜索半径 16-256，默认 64' }
      }
    },
    handler: async (c, { blockName, maxDistance }) => {
      // 与 !find 命令共享 findSurfaceBlocks + gotoNearest（移动层）；LLM 可感知失败原因
      const { findSurfaceBlocks, createMovement, REASON_TEXT } = await import('../core/movement.js')
      let result
      try {
        result = findSurfaceBlocks(c.bot, blockName, { maxDistance: maxDistance ?? 64 })
      } catch {
        throw new Error(`未知方块类型: ${blockName}`)
      }
      if (result.candidates.length === 0) {
        return `范围内（${maxDistance ?? 64} 格）没有暴露在地表的 ${blockName}`
      }
      const nearest = result.candidates.reduce((a, b) =>
        (a.x - c.bot.entity.position.x) ** 2 + (a.z - c.bot.entity.position.z) ** 2 <=
        (b.x - c.bot.entity.position.x) ** 2 + (b.z - c.bot.entity.position.z) ** 2 ? a : b)
      const r = await createMovement(c.bot, c.logger).gotoNearest(result.candidates, 3, { timeoutMs: 120000 })
      if (r.ok) {
        // C8/W 修复：汇报实际到达点（GoalCompositeAny 可达最近 ≠ 欧氏最近）
        const p = c.bot.entity.position
        // A3：exclusive 任务运行中附加告警（与 !find 命令同款语义——寻路会与其移动冲突）
        const warn = hasExclusiveActive() ? `（注意: exclusive 任务 ${getExclusiveOwner()} 运行中，移动可能冲突）` : ''
        return `已到达 ${blockName}: ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}${warn}`
      }
      return `找到 ${blockName} 但${REASON_TEXT[r.reason] ?? '移动失败'}：最近候选 ${Math.floor(nearest.x)},${Math.floor(nearest.y)},${Math.floor(nearest.z)}`
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
      // 插件未启用时不得静默吞掉返回假成功——LLM 会据此继续编造跟随行为（P1-7）。
      // execute 约定：handler 抛错 = 失败（catch → { ok:false }），返回值 = 成功结果
      if (!c.plugins?.follow) throw new Error('follow 插件未启用（配置 mineflayerPlugins.follow=true 并重启）')
      if (name === 'off') {
        c.plugins.follow.stop()
        return '已停止跟随'
      }
      // A3（第四轮）：技能层与命令层同款仲裁器防线——!follow 命令有拒绝而
      // follow_player 技能绕过命令层直调插件（op 玩家/LLM 工具循环可在 exclusive
      // 任务运行期开启跟随 = 双控制器冲突，R2 根治目标复活）
      if (hasExclusiveActive()) {
        throw new Error(`exclusive 任务 ${getExclusiveOwner()} 运行中，无法跟随（任务结束后可试）`)
      }
      const lower = name.toLowerCase()
      const player = Object.values(c.bot.players ?? {}).find(p => p.username.toLowerCase() === lower)
      if (!player?.entity) return `找不到玩家 ${name}`
      c.plugins.follow.setTarget(player.entity)
      return `开始跟随 ${name}`
    }
  })

  return { register, list, listForTools, execute }
}

/** 极简 JSONSchema 校验（type + required + min/max）。 */
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
    if ((def.type === 'number' || def.type === 'integer') && typeof v === 'number') {
      // A3：NaN/Infinity 兜底（JSON 无法携带但防御直传/未来入口）
      if (!Number.isFinite(v)) return { ok: false, error: `${k} 必须是有限数值` }
      if (def.min !== undefined && v < def.min) return { ok: false, error: `${k} 不能小于 ${def.min}` }
      if (def.max !== undefined && v > def.max) return { ok: false, error: `${k} 不能大于 ${def.max}` }
    }
  }
  return { ok: true }
}
