// L2 技能注册表：LLM 可调用的原子技能（Voyager control_primitives 思想）。
// 技能 = L1 能力的安全封装：权限（op 命令只对 ops 白名单开放）+ 极简 JSONSchema 参数校验。
// execute() 永不抛出——错误以 { ok: false, result: 原因 } 返回，供 LLM 继续决策。

import { isOp } from '../commands/permissions.js'
import { validateTaskOptions } from '../core/task-schemas.js'
import { hasExclusiveActive, getExclusiveOwner } from '../core/arbiter.js'
import { environmentSnapshot, nearbyEntities } from './environment.js'
import * as discovery from '../core/discovery.js'
import { exploreStep, notifyValuableFound } from '../core/explore.js'

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
        type: { type: 'string', description: 'mine/fish/afk/farm/chop/combat/breed/explore' },
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
    description: '找到指定方块的地表暴露位置（上方 2 格为天空，排除洞穴/地下/液体上方）并走过去（3 格内）。适合找露头矿、竹子、甘蔗（sugar_cane）等。',
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

  // ---- L2 进化（B2/C1）：探索记忆查询 + 单步探索 ----

  register({
    name: 'query_map',
    description: '查询探索记忆中已知的资源坐标（不重新扫描——省算力省 token）。探索过的区域可用 explore 技能或 explore 任务积累。',
    parameters: {
      type: 'object',
      required: ['blockName'],
      properties: {
        blockName: { type: 'string', description: '方块名（如 iron_ore/diamond_ore/bamboo）' },
        maxCount: { type: 'integer', min: 1, max: 20, description: '最多返回条数，默认 5' }
      }
    },
    permission: 'all',
    handler: async (c, { blockName, maxCount }) => {
      const me = c.bot?.entity?.position
      const hits = discovery.query(blockName, me, maxCount ?? 5)
      if (hits.length === 0) return `地图上还没有 ${blockName} 的记录（可用 explore 技能或 explore 任务探索，或 !agent act query_map <方块> 复查）`
      return hits.map(h => `${blockName} @ ${h.x},${h.y},${h.z}（${formatTs(h.ts)}）`).join('\n')
    }
  })

  register({
    name: 'map_status',
    description: '探索记忆统计：已访问锚点数、覆盖范围、各资源记录数。',
    permission: 'all',
    handler: async () => {
      const s = discovery.stats()
      if (s.anchors === 0 && s.resources === 0) return '地图还是空的——用 explore 技能或 explore 任务开始探索'
      const top = s.topResources.map(t => `${t.name}:${t.count}`).join(' ')
      return `已访问 ${s.anchors} 站，覆盖 ${s.covered}，资源记录 ${s.resources} 条${top ? `，最多: ${top}` : ''}`
    }
  })

  register({
    name: 'explore',
    description: '单步探索（op）：向指定方向游走一段距离，记录途中发现的资源与实体。重复调用逐步推进；探索记忆用 query_map 查询。',
    parameters: {
      type: 'object',
      properties: {
        maxDistance: { type: 'number', min: 16, max: 256, description: '探索距离 16-256，默认 48' },
        direction: { type: 'string', description: 'n/s/e/w/ne/nw/se/sw/random，默认 random' }
      }
    },
    handler: async (c, { maxDistance, direction }) => {
      // C1：exclusive 任务运行中拒绝（移动互斥——与 !follow/find_block 同款仲裁器防线）
      if (hasExclusiveActive()) {
        throw new Error(`exclusive 任务 ${getExclusiveOwner()} 运行中，无法探索（任务结束后可试，或先 !task stop）`)
      }
      const r = await exploreStep(c.bot, c.logger, { maxDistance, direction })
      if (!r.ok) return `探索失败: ${r.reason}`
      // D：重要资源 webhook 推送（节流 10 分钟/类型；失败静默）
      notifyValuableFound(c.cfg, c.logger, r.found)
      const found = r.found.length ? `，发现: ${r.found.map(f => `${f.name}@${f.x},${f.y},${f.z}`).slice(0, 5).join(' ')}` : ''
      const hostile = r.entities.hostile?.length ? `，敌对: ${r.entities.hostile.join(' ')}` : ''
      return `探索完成 ${r.from.x},${r.from.y},${r.from.z} → ${r.to.x},${r.to.y},${r.to.z}${found}${hostile}`
    }
  })

  // ---- L2 进化（A3）：环境感知 ----

  register({
    name: 'environment',
    description: '获取 Bot 当前位置的环境快照（时间/昼夜/天气/维度/生物群系/朝向/附近玩家与实体）。',
    permission: 'all',
    handler: async (c) => environmentSnapshot(c.bot)
  })

  register({
    name: 'nearby_entities',
    description: '列出附近实体（按距离升序，可过滤名称/类型）。',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '实体名子串或 kind：hostile/passive/neutral/player/projectile/animal' },
        maxDistance: { type: 'number', min: 1, max: 64, description: '搜索半径 1-64，默认 32' }
      }
    },
    permission: 'all',
    handler: async (c, { filter, maxDistance }) => {
      const ents = nearbyEntities(c.bot, { name: filter, kind: filter, maxDistance: maxDistance ?? 32, limit: 10 })
      if (ents.length === 0) return `附近（${maxDistance ?? 32} 格）没有${filter ? `符合条件的（${filter}）` : ''}实体`
      return ents.map(e => `${e.name}/${e.kind} 距离${e.dist}m 坐标(${e.pos})`).join('\n')
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

/** 相对时间（query_map 用：发现时间戳 → 人类可读）。 */
function formatTs (ts) {
  if (!ts) return '未知时间'
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s 前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
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
