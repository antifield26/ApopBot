// L2 技能注册表：LLM 可调用的原子技能（Voyager control_primitives 思想）。
// 技能 = L1 能力的安全封装：权限（op 命令只对 ops 白名单开放）+ 极简 JSONSchema 参数校验。
// execute() 永不抛出——错误以 { ok: false, result: 原因 } 返回，供 LLM 继续决策。

import { isOp } from '../commands/permissions.js'
import { validateTaskOptions } from '../core/task-schemas.js'
import { hasExclusiveActive, getExclusiveOwner } from '../core/arbiter.js'
import { environmentSnapshot, nearbyEntities } from './environment.js'
import * as discovery from '../core/discovery.js'
import { exploreStep, notifyValuableFound } from '../core/explore.js'
import { withTimeout } from '../util/promise-timeout.js'

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
    // 调用者注入（follow_player 的"跟随我"指代消解用）——ctx 单例共享但 execute
    // 串行（busy 门 + cooldown），临时注入 + finally 还原，防跨调用污染
    const prevCaller = ctx._caller
    ctx._caller = user
    try {
      const result = await skill.handler(ctx, params ?? {})
      return { ok: true, result }
    } catch (err) {
      return { ok: false, result: err.message }
    } finally {
      ctx._caller = prevCaller
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
    description: '获取 Bot 状态（连接/位置/血量/食物）。',
    permission: 'all',
    handler: async (c) => {
      // U14（第五轮）：精简输出——memMb/reconnectCount 是运维指标，LLM 决策用不上
      //（固定 prompt 已占预算 54%，查询结果 token 浪费是最大单点）
      const s = c.conn.getStatus()
      const e = c.bot?.entity
      return {
        state: s.state,
        position: e ? [Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)] : null,
        health: c.bot?.health ?? null, // update_health 包（26.1 实体元数据不解析 health）
        food: c.bot?.food ?? null
      }
    }
  })

  register({
    name: 'task_status',
    description: '获取全部任务的运行状态与等待原因。',
    permission: 'all',
    handler: async (c) => {
      // U14：LLM 通道精简为 id: state (waitingReason) 行——counters/queuePosition/
      // nextRunAt 等全字段对决策是噪声且撑爆 2000 字符截断（人类看 !task list）
      const lines = c.tasks.getStatus().map(t =>
        `${t.id}: ${t.state}${t.waitingReason ? ` (${t.waitingReason})` : ''}${t.lastError ? ` 错误:${t.lastError}` : ''}`)
      return lines.length ? lines.join('；') : '当前无任务'
    }
  })

  register({
    name: 'inventory_summary',
    description: '获取背包物品摘要（名称与数量，按数量降序 Top-N）。',
    parameters: {
      type: 'object',
      properties: { maxItems: { type: 'integer', min: 1, max: 50, description: '最多返回条数，默认 10', example: 10 } }
    },
    permission: 'all',
    handler: async (c, { maxItems }) => {
      // U14：top-N 截取（50+ 物品时此前撑满 2000 字符截断，LLM 通常只需几样）
      const counts = {}
      for (const it of c.bot?.inventory?.items() ?? []) {
        counts[it.name] = (counts[it.name] ?? 0) + (it.count ?? 1)
      }
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, maxItems ?? 10)
      return entries.length ? entries.map(([n, c]) => `${n}:${c}`).join(' ') : '背包为空'
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
      // P2-3（第五轮）：move_to 是唯一动 pathfinder 却无仲裁器防线的危险技能——
      // exclusive 任务运行中 setGoal 覆盖任务 goal → GoalChanged → 任务误计
      // unreachable 走回头路（find_block/explore/follow_player 均有防线）
      if (hasExclusiveActive()) {
        throw new Error(`exclusive 任务 ${getExclusiveOwner()} 运行中，无法移动（任务结束后可试）`)
      }
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

  // ---- L2 进化（U13）：动作技能组（LLM 完全控制）----
  // 26.1 包安全性实测（第五轮）：dig（block_dig 缺 sequence 补 0 序列化 OK）、
  // place（block_place 全字段匹配）、use_item（rotation 必填）均可高层 API；
  // 只有实体右键/攻击必须走 entity-actions 原始包（门控 bug）。动作技能统一守卫：
  // exclusive 拒绝（动方块/实体与任务冲突）+ 前置检查 + 冷却防刷。

  /** 动作技能冷却（dig/place/attack 防刷；equip/use_item 不拦）。 */
  const ACTION_COOLDOWN_MS = 500
  const lastActionAt = new Map()
  function checkActionCooldown (name) {
    const now = Date.now()
    const last = lastActionAt.get(name) ?? 0
    if (now - last < ACTION_COOLDOWN_MS) {
      throw new Error(`${name} 冷却中（${Math.ceil((ACTION_COOLDOWN_MS - (now - last)) / 1000)}s 后重试）`)
    }
    lastActionAt.set(name, now)
  }

  register({
    name: 'dig',
    description: '挖掘指定坐标的方块（自动校验可挖性与距离；挖完立即返回，不收集掉落）。玩家说"挖这块"时用。',
    parameters: {
      type: 'object',
      required: ['x', 'y', 'z'],
      properties: {
        x: { type: 'integer', description: '方块 X 坐标', example: 10 },
        y: { type: 'integer', description: '方块 Y 坐标', example: 63 },
        z: { type: 'integer', description: '方块 Z 坐标', example: -5 }
      }
    },
    handler: async (c, { x, y, z }) => {
      if (hasExclusiveActive()) {
        throw new Error(`exclusive 任务 ${getExclusiveOwner()} 运行中，无法挖掘（任务结束后可试）`)
      }
      if (!c.bot?.dig || !c.bot.canDigBlock) throw new Error('dig 能力不可用（插件缺失）')
      const { Vec3 } = await import('vec3')
      const block = c.bot.blockAt(new Vec3(x, y, z))
      if (!block) return `坐标 (${x},${y},${z}) 没有方块（区块未加载？）`
      if (!c.bot.canDigBlock(block)) {
        return `方块 ${block.name} 不可挖掘（距离过远或不可挖掘）——先 move_to 靠近到 5 格内`
      }
      // 冷却只对实际执行生效（提示/校验类不占——LLM 连续尝试不同方块时不误伤）
      checkActionCooldown('dig')
      await withTimeout(c.bot.dig(block), 30000, 'dig timeout') // 断线保护（A4 同款）
      return `已挖掘 ${block.name} @ ${x},${y},${z}`
    }
  })

  register({
    name: 'place',
    description: '在指定位置放置手持物品（目标位必须为空；reference 取 face 反向相邻方块）。玩家说"放一块石头/种棵树"时用。',
    parameters: {
      type: 'object',
      required: ['x', 'y', 'z', 'face'],
      properties: {
        x: { type: 'integer', description: '目标 X 坐标', example: 10 },
        y: { type: 'integer', description: '目标 Y 坐标', example: 64 },
        z: { type: 'integer', description: '目标 Z 坐标', example: -5 },
        face: { type: 'string', description: '放置方向：up/down/north/south/east/west（默认 up）', example: 'up' }
      }
    },
    handler: async (c, { x, y, z, face = 'up' }) => {
      if (hasExclusiveActive()) {
        throw new Error(`exclusive 任务 ${getExclusiveOwner()} 运行中，无法放置（任务结束后可试）`)
      }
      if (!c.bot?.placeBlock) throw new Error('place 能力不可用（插件缺失）')
      const { Vec3 } = await import('vec3')
      const off = { up: [0, -1, 0], down: [0, 1, 0], north: [0, 0, 1], south: [0, 0, -1], east: [-1, 0, 0], west: [1, 0, 0] }[face]
      if (!off) return `无效的 face: ${face}（up/down/north/south/east/west）`
      const refBlock = c.bot.blockAt(new Vec3(x + off[0], y + off[1], z + off[2]))
      if (!refBlock || refBlock.boundingBox === 'empty') return '参考方块不存在（目标位置悬空？）'
      const dest = c.bot.blockAt(new Vec3(x, y, z))
      if (dest && dest.boundingBox !== 'empty') return `目标位置被 ${dest.name} 占用`
      if (!c.bot.heldItem) return '手里没有物品——先 equip <物品名>'
      // 冷却只对实际执行生效（校验类不占）
      checkActionCooldown('place')
      const itemName = c.bot.heldItem.name
      await withTimeout(c.bot.placeBlock(refBlock, face), 30000, 'place timeout')
      return `已放置 ${itemName} @ ${x},${y},${z}`
    }
  })

  register({
    name: 'equip',
    description: '装备背包中的物品到手持（挖矿放镐/战斗放剑/放置前取方块）。玩家说"拿出..."时用。',
    parameters: {
      type: 'object',
      required: ['itemName'],
      properties: { itemName: { type: 'string', description: '物品名（如 iron_pickaxe/diamond_sword/stone）', example: 'iron_pickaxe' } }
    },
    handler: async (c, { itemName }) => {
      const item = c.bot.inventory?.items()?.find(it => it.name === itemName)
      if (!item) return `背包里没有 ${itemName}（用 inventory_summary 查看）`
      await withTimeout(c.bot.equip(item, 'hand'), 10000, 'equip timeout') // 断线保护（A4）
      return `已装备 ${itemName}`
    }
  })

  register({
    name: 'use_item',
    description: '使用手持物品（吃食物/喝药水等）。低血时进食用。',
    handler: async (c) => {
      if (!c.bot?.activateItem) throw new Error('use_item 能力不可用（插件缺失）')
      const held = c.bot.heldItem?.name ?? '手持物品'
      await withTimeout(c.bot.activateItem(), 5000, 'use_item timeout')
      return `已使用 ${held}`
    }
  })

  register({
    name: 'attack',
    description: '攻击指定名称/类型的实体：自动接近到攻击距离后攻击，目标存活会继续连击（至多 5 次；击杀/走失/上限即止）。玩家说"打那个僵尸"时用。',
    parameters: {
      type: 'object',
      required: ['filter'],
      properties: { filter: { type: 'string', description: '实体名子串或类型（hostile/zombie...）', example: 'zombie' } }
    },
    handler: async (c, { filter }) => {
      if (hasExclusiveActive()) {
        throw new Error(`exclusive 任务 ${getExclusiveOwner()} 运行中，无法攻击（任务结束后可试）`)
      }
      checkActionCooldown('attack')
      if (!c.bot?.entities || !c.bot.entity?.position) throw new Error('实体表/位置不可用')
      const { attackEntity } = await import('../core/entity-actions.js')
      const { createMovement, REASON_TEXT } = await import('../core/movement.js')
      const me = c.bot.entity
      const f = filter?.toLowerCase()
      const matches = []
      for (const e of c.bot.entities instanceof Map ? c.bot.entities.values() : Object.values(c.bot.entities)) {
        if (!e || e === me || !e.position) continue
        if (f && !String(e.name ?? '').toLowerCase().includes(f) && e.type !== f) continue
        matches.push(e)
      }
      if (matches.length === 0) return `附近没有匹配 ${filter} 的实体（nearby_entities 查看）`
      matches.sort((a, b) => a.position.distanceTo(me.position) - b.position.distanceTo(me.position))
      const target = matches[0]
      // 战斗循环（combat 任务同款三件套：存在检查 + 接近 + 攻击）：
      // 修复①（原地不动根因一）：bot.entities 是 Map——`entities[id]` 下标恒
      //   undefined → 存在检查恒 false → attack 从未真正发出（P1 Map bug 同根漏网）
      // 修复②（原地不动根因二）：无接近逻辑——5 格外攻击包被服务端 reach 校验
      //   拒绝（无效攻击），Bot 原地不动。approachEntity 接近后攻击，目标移动
      //   触发 RECALC interrupted → 重扫重接近（追逐语义，同 combat 循环）
      const move = createMovement(c.bot, c.logger)
      const ATTACK_RANGE = 3.5 // 原版近战攻击距离（combat 任务同款）
      let hits = 0
      for (let i = 0; i < 5; i++) {
        const alive = c.bot.entities instanceof Map
          ? c.bot.entities.has(target.id)
          : !!c.bot.entities?.[target.id]
        if (!alive || !target.position) {
          return hits > 0
            ? `已攻击 ${target.name} ${hits} 次，目标已消失（可能已击杀）`
            : '目标已消失，可重试'
        }
        const dist = me.position.distanceTo(target.position)
        if (dist > ATTACK_RANGE) {
          const r = await move.approachEntity(target, {
            range: 2, // 停点保证能攻击到
            timeoutMs: 15000,
            isInterrupted: () => !target?.position || me.position.distanceTo(target.position) > 64 // 追出 64 格放弃
          })
          if (r.ok) continue // 接近后重查距离（目标可能在动）
          if (r.reason === 'interrupted') continue // 目标位移触发重算——重扫重接近
          return `无法接近 ${target.name}: ${REASON_TEXT[r.reason] ?? r.err?.message}`
        }
        try { c.bot.lookAt(target.position.offset(0, (target.height ?? 1.8) / 2, 0), true) } catch { /* 位置可能失效 */ }
        attackEntity(c.bot, target) // 26.1 门控 bug 绕过（项目层原始包）
        hits++
        await new Promise(r => setTimeout(r, 600)) // 攻击冷却（反作弊：1.9+ 攻击速度检测，combat 同款）
      }
      return `已攻击 ${target.name} ${hits} 次，目标仍存活——可再次调用 attack 继续`
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
    description: '让 Bot 跟随（或停止跟随，参数 off）指定玩家。玩家说"跟随我/跟着我"时 name 填当前会话的玩家名（或省略/用 me）——绝不能填 Bot 自己的名字。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '玩家名（大小写不敏感），off 停止跟随；"跟随我"时可不填或填 me', example: 'Antifield' }
      }
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
      // "跟随我"指代消解（本地测试实测：9B 模型常把"我"误解为 Bot 自己 →
      // follow_player(name=mcbot-test) → 跟随自己原地打转 = 目标选择错误）。
      // 空/me/self/我 → 映射 execute 注入的调用者（当前对话玩家）
      let targetName = name
      if (!name || ['me', 'self', '我', '自己'].includes(String(name).toLowerCase())) {
        targetName = c._caller
        if (!targetName) return '无法确定要跟随谁（对话上下文缺失）'
      }
      const lower = targetName.toLowerCase()
      const player = Object.values(c.bot.players ?? {}).find(p => p.username.toLowerCase() === lower)
      if (!player) return `找不到玩家 ${targetName}`
      // 目标防御：bot.players 含 Bot 自己——跟随自己 = 原地打转（"目标选择错误"根因）
      if (targetName.toLowerCase() === String(c.bot.username ?? '').toLowerCase()) {
        return `不能跟随 Bot 自己——请指定其他玩家（如"跟随我"）`
      }
      if (!player?.entity || player.entity === c.bot.entity) {
        return `玩家 ${targetName} 不可跟随（实体未加载或指向 Bot 自己）`
      }
      c.plugins.follow.setTarget(player.entity)
      return `开始跟随 ${targetName}`
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
