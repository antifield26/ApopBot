// L2 Agent 接口：进程内 LLM 工具循环（不引入子进程/IPC——单 bot、maxSteps 有界，
// Node 22 全局 fetch 零新依赖；mindcraft 的 AgentProcess 模式在此规模无收益，见 docs/l2.md）。
//
// chat(user, text)：cooldown 门 + busy 拒并发 → 循环 ≤maxSteps：provider.chat →
//   执行 toolCalls（act 动作数组走执行器；观察/回复单动作）→ 续；无工具调用即回复。
// act(user, name, params)：直调动作原语（!agent act，不经 LLM）。
// stop()：AbortController 中止进行中的请求。
//
// v1.0.0 C4：动作协议——工具集 = act（动作数组 ≤maxActionsPerCall）+ 观察/回复；
// 动作原语见 src/core/primitives.js（权限/exclusive/校验/冷却/审计由 executor 统一）。
// 错误永不向上抛——以友好回复返回（配合 logger.error 留痕）。

import { isOp } from '../commands/permissions.js'
import { environmentLine } from '../core/environment.js'

// 文本长度上限（低配 4B 模型上下文与聊天消息长度双重约束；B6 从硬编码提为常量）
const INPUT_MAX_CHARS = 1000 // 用户消息截断
const REPLY_MAX_CHARS = 250 // 回复截断（与 chat.maxLength 默认一致）
const TOOL_RESULT_MAX_CHARS = 2000 // 工具结果回填截断上限（预算裁剪的硬上限）
// A2：工具结果回填的下限——预算裁剪时也不得低于此（低于则整条丢弃更有意义）
const TOOL_RESULT_MIN_CHARS = 200
// A2：上下文预算的尾差缓冲（工具定义 schema/系统提示的估算误差 + 回复预留）
const BUDGET_RESERVE_TOKENS = 384

// 会话记忆（U2）：按玩家名的多轮上下文，模块级 Map——agent 实例在重连/热重载时
// 被 feature-layer 重建，模块级存储保证记忆跨代际保留（会话是玩家维度的，不是 bot 维度的）。
// 上限 MAX_HISTORY_MESSAGES 条（含本轮），先出后入裁剪；只存 user/assistant 纯文本轮，
// 不存工具调用中间轮（长且不必要）。act 直调不污染会话。
// 会话数上限 MAX_SESSIONS（C7/T）：Map 迭代序 = 插入序，访问时 delete+set 刷新为
// 最新（LRU），超上限驱逐最久未访问的会话——此前每说过一句话的玩家永久驻留一条。
const MAX_HISTORY_MESSAGES = 10
const MAX_SESSIONS = 32
const SESSIONS = new Map()
// A5（第四轮）：summarize 全局冷却——模块级（agent 随重连/热重载重建，实例级会复位）。
// 覆盖死亡播报（feature-layer）与任务终态播报（manager）全部组合：低配 PC + Ollama
// 单请求队列下并发两条 LLM 请求会让 10s 超时静默触发或拖慢主对话（第四轮验证确认）
const SUMMARY_COOLDOWN_MS = 60000
let lastSummarizeAt = 0

/** 测试钩子：重置 summarize 全局冷却（生产不调用；tests 需要独立验证冷却语义）。 */
export function _resetSummarizeCooldown () {
  lastSummarizeAt = 0
}

/**
 * A2：token 估算（qwen3 BPE 近似，确定性可测，偏保守）——
 * CJK ×1.0 + ASCII ×0.25 + 其他 ×0.5。字符级截断 ≠ token 级截断的工程折中：
 * 超窗时宁可多裁一点（历史轮/工具结果），也不让 Ollama 静默截断（信息丢失不可控）。
 */
export function estimateTokens (text) {
  let t = 0
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0)
    if (c >= 0x4e00 && c <= 0x9fff) t += 1 // CJK 统一表意
    else if (c < 0x80) t += 0.25 // ASCII
    else t += 0.5
  }
  return Math.ceil(t)
}

/** 消息 token 估算（预算裁剪用；导出供测试验证工具参数计入）。 */
export function messageTokens (m) {
  if (m.toolResults?.length) {
    return m.toolResults.reduce((s, r) => s + estimateTokens(r.output), 0)
  }
  if (m.toolCalls?.length) {
    // P2-5（第五轮）：工具参数 JSON 计入估算——此前只计名字，参数大的调用
    //（run_task 的 options）真实用量被低估 → 预算裁剪误判不裁
    return estimateTokens(m.content ?? '') +
      estimateTokens(JSON.stringify(m.toolCalls.map(t => ({ name: t.name, arguments: t.arguments }))))
  }
  return estimateTokens(m.content ?? '')
}

/**
 * A2：上下文预算裁剪——消息序列（fixedTokens + Σ消息）超预算时按序裁剪：
 * ① 丢最旧的纯文本历史轮（工具轮必须保留配对）→ ② 工具结果统一截短（不低于
 * TOOL_RESULT_MIN_CHARS，由剩余预算分摊）→ ③ 当前用户消息截到剩余。
 * 原地修改传入数组（调用方持有副本）；返回是否发生裁剪。
 */
export function applyTokenBudget (messages, fixedTokens, budget) {
  let over = fixedTokens + messages.reduce((s, m) => s + messageTokens(m), 0) - budget
  if (over <= 0) return false
  // ① 丢最旧纯文本轮（保留最后一条——当前用户消息留给 ③ 按剩余预算截断）
  let i = 0
  while (over > 0 && i < messages.length - 1) {
    const m = messages[i]
    if (m.toolCalls || m.toolResults) { i++; continue } // 工具轮不动（配对语义）
    over -= messageTokens(m)
    messages.splice(i, 1)
  }
  // ② 工具结果统一截短（targetPer 由"除纯文本外"的预算分摊）
  if (over > 0) {
    const results = messages.flatMap(m => m.toolResults ?? [])
    if (results.length > 0) {
      const textBudget = Math.max(TOOL_RESULT_MIN_CHARS * results.length,
        budget - fixedTokens - messages.reduce((s, m) => s + (m.toolResults ? 0 : messageTokens(m)), 0))
      const targetPer = Math.max(TOOL_RESULT_MIN_CHARS, Math.floor(textBudget / results.length))
      for (const r of results) {
        if (r.output.length > targetPer) {
          over -= estimateTokens(r.output) - estimateTokens(r.output.slice(0, targetPer))
          r.output = r.output.slice(0, targetPer) + '…(截断)'
        }
      }
    }
  }
  // ③ 当前用户消息截到剩余（按比例近似，保守多裁）
  if (over > 0 && messages.length > 0) {
    const last = messages[messages.length - 1]
    if (last && !last.toolCalls && !last.toolResults && last.content) {
      const cur = estimateTokens(last.content)
      const keep = Math.max(TOOL_RESULT_MIN_CHARS, Math.floor(last.content.length * (1 - over / Math.max(1, cur))))
      last.content = last.content.slice(0, keep)
    }
  }
  return true
}

/**
 * 读取会话并刷新 LRU 序（delete+set 移到迭代末尾）。
 * U15（第五轮）：会话值从纯数组升级为 { history, calls }——calls 记录最近工具操作
 * （跨对话注入，LLM 知道上次实际执行了什么）。兼容旧结构（纯数组 → 转 history）。
 */
function getSession (user) {
  const v = SESSIONS.get(user)
  if (v !== undefined) {
    SESSIONS.delete(user)
    SESSIONS.set(user, v)
    return Array.isArray(v) ? { history: v, calls: [] } : v
  }
  return null
}

/** 写入会话（LRU 上限驱逐最久未访问者——统一走 putBounded，第六轮 C11 去重）。 */
function setSession (user, value) {
  putBounded(SESSIONS, user, Array.isArray(value) ? { history: value, calls: [] } : value)
}

/** 有界 Map（LRU 上限驱逐最久未访问者；cooldowns 与 SESSIONS 共用）。 */
function putBounded (map, key, value, max = MAX_SESSIONS) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value)
}

// v1.0.0 C4：动作协议提示词（替代"意图→固定技能"映射）——教 LLM 用 act 动作数组
// + 观察原语直接操作 Bot。op 清单与工具 schema 对应 src/core/primitives.js。
const CORE_SYSTEM_PROMPT = `你是运行在 Minecraft 服务器上的 Bot 助手（minecraft-bot）。你可以通过工具直接操控 Bot 在世界中的行动。

【行动协议】
1. 用 act 工具执行动作数组 {actions:[{op,args},...]}，一次最多 8 个、按序执行；每个动作的结果按序返回，必须读取。动作原语（op）：
   观察：observe_status（连接/位置/血量/饥饿）、observe_inventory（背包）、observe_environment（时间/天气/维度/群系/朝向/附近）、observe_entities（附近实体）、observe_blocks（找方块位置）、observe_block（单方块详情）、observe_crops（作物成熟度）、query_map（探索记忆中的资源坐标）、map_status（探索统计）
   移动：goto{x,y,z,range?,timeoutMs?} 寻路移动；explore_step{direction?,maxDistance?} 单步探索
   建造：dig{x,y,z} 挖方块（不捡掉落物）；place{x,y,z,face?} 放手持物品；collect_blocks{blockNames|positions,area?,maxBlocks?,chestLocations?} 批量采集（自动捡掉落）；plant_crops{area,cropTypes?} 种作物
   战斗：attack{filter,maxHits?} 攻击实体（自动接近连击）
   交互：interact_entity{filter,foodName?,count?} 右键实体（喂食繁殖）
   物品：equip{itemName}；drop{itemName?,count?}；use_item 用手持物；eat 自动进食
   流程：wait{ms} 等待（≤5 分钟）；look{x,y,z|yaw,pitch} 转向；reply{text} 说话；fish{timeoutMs?} 钓鱼
   任务：start_task{type,id,options?} 启动任务；stop_task{id} 停止任务；follow_player{name|off} 跟随玩家
2. 观测优先：行动前先观察（observe_*），不凭猜测行动、不编造世界状态。单步行动后读结果再决定下一步。
3. 异常恢复：失败先读懂原因（如"移动失败: 无法到达"、"exclusive 任务 X 运行中"、"权限不足"、"先 goto 靠近"），同一失败操作不要盲目重试超过 2 次；需要等待用 wait{ms}。
4. 预算：每次 act ≤8 动作、每轮对话 ≤8 次工具调用。移动/采集耗时长，拆小步执行。
5. 安全：移动/建造/战斗/交互/物品/任务管理只有 op 玩家可用（系统强制校验，身份见"当前会话"）；exclusive 任务运行期间相关动作会被拒绝——这是任务保护机制不是故障，可等任务结束或用 start_task 排队。任务 = 长循环（挖矿/砍树/农场/战斗/繁殖/探索/钓鱼/AFK），单次操作用原语直接做，批量持续型需求用 start_task。
6. 多步意图示例："帮我建个树屋"→ observe_inventory 确认木材 → equip 木材 → goto 目标 → place×N 逐层 → reply 汇报；"挖点铁"→ observe_blocks(iron_ore) 或 query_map → goto 靠近 → dig×N 或 collect_blocks → reply 汇报数量；"采 20 个木头"→ start_task(chop, area)（任务自动往返避障）→ observe_inventory 核对；"附近有危险吗"→ observe_entities(hostile) → attack 或如实汇报；"跟着我/跟随我"→ follow_player（name=当前会话玩家名——"我"指说话玩家，绝不是 Bot 自己）。
7. 不要角色扮演，不要输出 Markdown，不要虚构玩家或世界状态。感知以"环境:"行与观察结果为准——没感知到的信息（如天气/生物群系/附近实体）如实说不知道。`

/**
 * 每次对话注入调用者身份：LLM 必须知道"谁在说话、是否有 op 权限"，
 * 否则面对危险操作请求只会回复"需要验证 op 身份"（实测反馈——身份此前未进上下文）。
 * @param {string} user 消息来源玩家
 * @param {object} cfg
 */
function buildSystem (user, cfg) {
  const auth = isOp(user, cfg)
    ? `${user} 是 op 白名单成员——危险操作可直接执行，无需再要求验证`
    : `${user} 是普通玩家——危险操作（goto/dig/place/attack 等动作）必须拒绝并说明权限不足`
  return `${CORE_SYSTEM_PROMPT}\n\n当前会话：${auth}`
}

// ---- 工具集（v1.0.0 C4）：act（动作数组）+ 观察/回复工具 ----
// 观察类（readonly）与 reply 作为独立工具（单次查询/说话便宜、LLM 常用）；
// 其余动作（goto/dig/...）只经 act 数组——动作是"一次一串"，观察是"单次一问"。

/** act 工具描述（动作通道）。 */
function actTool (maxActionsPerCall) {
  return {
    name: 'act',
    description: '执行一串动作（动作数组，按序执行）。op 为动作原语（goto/dig/place/collect_blocks/plant_crops/attack/interact_entity/equip/drop/use_item/eat/wait/look/fish/explore_step/start_task/stop_task/follow_player），args 为对应参数对象；结果数组按序对应每个动作。',
    parameters: {
      type: 'object',
      required: ['actions'],
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: maxActionsPerCall,
          items: {
            type: 'object',
            required: ['op', 'args'],
            properties: { op: { type: 'string' }, args: { type: 'object' } }
          }
        }
      }
    }
  }
}

/** 从原语注册表生成工具集（act + 观察类 + reply；wait/look/fish 只经 act）。 */
function buildTools (executor, maxActionsPerCall) {
  const tools = [actTool(maxActionsPerCall)]
  for (const [op, p] of executor.primitives) {
    if (p.permission !== 'all') continue
    if (['wait', 'look', 'fish'].includes(op)) continue // 流程原语经 act
    if (op === 'reply' || p.exclusiveClass === 'readonly') {
      tools.push({ name: op, description: p.description ?? op, parameters: p.schema ?? { type: 'object', properties: {} } })
    }
  }
  return tools
}

export class AgentInterface {
  /**
   * @param {{ bot, cfg, logger, tasks, conn, plugins }} ctx
   * @param {{ provider: object, executor: object, config: object }} deps
   */
  constructor (ctx, deps) {
    this.ctx = ctx
    this.provider = deps.provider
    this.executor = deps.executor
    this.cfg = deps.config ?? {}
    // v1.0.0 C5：会话落盘通道（缺省 null = 不落盘——测试/无持久化场景）
    this.sessionStore = deps.sessionStore ?? null
    this.log = ctx.logger.child({ module: 'l2' })
    this.busy = false
    // 按玩家冷却（C7/T）：此前全局单值——一个 op 的请求冷却挡住所有玩家的 !agent chat
    this.cooldowns = new Map()
    this._abort = null
    // LLM 计量（U5）：本次对话累计 tokens + 最近一次请求耗时（/metrics 用）
    this.usage = { inputTokens: 0, outputTokens: 0, latencyMs: null }
  }

  static isAvailable () {
    return true
  }

  /**
   * 对话入口（LLM 工具循环）。
   * @param {string} user 消息来源玩家
   * @param {string} text 用户消息
   * @returns {Promise<{ reply: string }>}
   */
  async chat (user, text) {
    const now = Date.now()
    const cooldownMs = this.cfg.cooldownMs ?? 5000
    const until = this.cooldowns.get(user) ?? 0
    if (now < until) {
      return { reply: `请求冷却中（${Math.ceil((until - now) / 1000)}s 后重试）` }
    }
    if (this.busy) {
      // F1-b（第五轮）：busy 阻塞可长达 60-120s（move_to/find_block 工具执行）——
      // 附带已进行秒数让玩家知道不是卡死
      const elapsed = this._busySince ? Math.round((now - this._busySince) / 1000) : 0
      return { reply: `上一个请求仍在处理中（已进行 ${elapsed}s），请稍候` }
    }
    this.busy = true
    this._busySince = now
    putBounded(this.cooldowns, user, now + cooldownMs)
    const ac = new AbortController()
    this._abort = ac
    try {
      // 会话注入：历史（裁剪后）+ 本轮用户消息（history 是副本，工具循环内 push 不污染存储）。
      // U15：session.calls 是跨对话工具操作记录（最近 20 条，注入用）
      // v1.0.0 C5：内存优先，miss 时从磁盘回填（重启后恢复多轮上下文）
      let session = getSession(user)
      if (session === null && this.sessionStore) {
        const disk = this.sessionStore.get(user)
        if (disk) {
          putBounded(SESSIONS, user, disk)
          session = disk
        }
      }
      const history = (session?.history ?? []).slice(-MAX_HISTORY_MESSAGES)
      const toolCalls = session?.calls ?? []
      const userMsg = String(text).slice(0, INPUT_MAX_CHARS)
      const messages = [...history, { role: 'user', content: userMsg }]
      const maxSteps = this.cfg.maxSteps ?? 5
      let finished = false
      let reply = '（无回复）'
      for (let step = 0; step < maxSteps && !finished; step++) {
        // v1.0.0 C4：固定工具集 = act + 观察/回复（从原语注册表生成）
        const tools = buildTools(this.executor, this.cfg.maxActionsPerCall ?? 8)
        // A3：环境自动注入——每次工具轮重新生成（bot 移动后数据新鲜）；开关可关；
        // 缺失字段 environmentLine 内部兜底（返回空串）
        // U15：最近工具操作注入（≤3 条 × ≤60 字符摘要）——跨对话规划连续性的核心：
        // 会话刻意不存工具轮，第二次 chat 时 LLM 不知道上次实际执行了什么
        let toolLog = ''
        if (toolCalls.length) {
          toolLog = `\n最近工具操作: ${toolCalls.slice(-3).map(c => `${c.name}${c.result ? `→${c.result}` : ''}`).join('；')}`
        }
        // v1.0.0 C2：单 provider（云端）——恒拼接完整提示词（分层分支已移除）
        const system = buildSystem(user, this.ctx.cfg) +
          (this.cfg.envInjection === false ? '' : `\n${environmentLine(this.ctx.bot)}`) + toolLog
        // A2：上下文预算裁剪（provider 有窗口时）——fixed = system + 工具定义；
        // 超预算按序裁剪历史/工具结果/用户消息。窗口 null（云端/测试）→ 不裁剪
        const window = this.provider.contextWindow?.()
        if (window) {
          const budget = window - (this.cfg.maxTokens ?? 1024) - BUDGET_RESERVE_TOKENS
          const fixedTokens = estimateTokens(system) + estimateTokens(JSON.stringify(tools))
          if (fixedTokens > budget && !this._budgetWarned) {
            this._budgetWarned = true
            // P2-5（第五轮）：warn 带具体数字——2048 窗口下 fixed > budget 是结构性
            // 不可收敛（裁剪三步后仍超窗，依赖 Ollama 静默截断）：提示调参方向
            this.log.warn({ fixedTokens, budget, window }, `L2 固定 prompt（system+技能定义）超出上下文预算（window ${window}）——历史/工具结果将被全部裁剪后仍可能超窗。建议调高 l2.cloudMaxContextWindow 或减少 maxTokens/工具数`)
          }
          applyTokenBudget(messages, fixedTokens, budget)
        }
        const res = await this.provider.chat(messages, {
          tools,
          system,
          signal: ac.signal
        })
        // token/耗时计量（U5）：累计本轮全部 provider 调用
        if (res.usage) {
          this.usage.inputTokens += res.usage.inputTokens ?? 0
          this.usage.outputTokens += res.usage.outputTokens ?? 0
        }
        this.usage.latencyMs = res.latencyMs ?? null
        const calls = res.toolCalls?.slice(0, 4) ?? []
        if (calls.length === 0) {
          reply = res.text ?? '（无回复）'
          finished = true
          break
        }
        // v1.0.0 C4：执行工具调用（act → 动作数组走执行器；观察/回复 → 单动作）
        const results = []
        for (const tc of calls) {
          let r
          if (tc.name === 'act') {
            r = await this.executor.executeBatch(tc.arguments?.actions ?? [], { user, source: 'llm' })
          } else {
            r = await this.executor.executeOne(tc.name, tc.arguments, { user, source: 'llm' })
          }
          // 工具结果截断：maxSteps×多动作的大 JSON（observe_* 结构化结果）
          // 会撑爆上下文或放大云端成本
          let output
          if (tc.name === 'act') {
            output = r.rejected ? r.rejected : JSON.stringify(r.results)
          } else {
            output = r.ok ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result)) : r.result
          }
          if (typeof output !== 'string') output = JSON.stringify(output)
          if (output.length > TOOL_RESULT_MAX_CHARS) output = output.slice(0, TOOL_RESULT_MAX_CHARS) + '…(截断)'
          results.push({ id: tc.id, name: tc.name, output })
          // U15：跨对话工具操作记录（摘要 ≤120 字符；失败也记录——LLM 下次知道上次错在哪）
          const failed = tc.name === 'act' ? r.rejected : !r.ok
          const summary = failed
            ? `失败:${tc.name === 'act' ? r.rejected : r.result}`
            : (tc.name === 'act'
                ? r.results.map(x => `${x.op}${x.ok ? '' : '✗'}`).join(' ')
                : (typeof r.result === 'string' ? r.result : JSON.stringify(r.result)))
          toolCalls.push({ name: tc.name, result: summary.slice(0, 120) })
          if (toolCalls.length > 20) toolCalls.shift()
        }
        messages.push({ role: 'assistant', content: res.text ?? '', toolCalls: calls })
        messages.push({ role: 'user', content: '', toolResults: results })
      }
      if (!finished) {
        // C7/U 修复：maxSteps 耗尽——此前返回"（无回复）"占位且写入会话污染下一轮；
        // 显式文案提示重试
        reply = `已达最大工具步数（${maxSteps}），请重试`
      }
      // 回写会话：本轮 user 轮 + 最终 assistant 轮（纯文本，裁剪到上限）+ 工具操作记录
      history.push({ role: 'user', content: userMsg })
      history.push({ role: 'assistant', content: reply.slice(0, REPLY_MAX_CHARS) })
      const sessionValue = { history: history.slice(-MAX_HISTORY_MESSAGES), calls: toolCalls.slice(-20) }
      setSession(user, sessionValue)
      // v1.0.0 C5：落盘（2s 防抖 + exit flush）——重启/重连后多轮上下文不丢
      this.sessionStore?.set(user, sessionValue)
      return { reply: reply.slice(0, REPLY_MAX_CHARS) }
    } catch (err) {
      if (err.name === 'AbortError') return { reply: '请求已中止' }
      this.log.error({ err: err.message }, 'agent chat failed')
      return { reply: `处理出错：${err.message}` }
    } finally {
      this.busy = false
      this._abort = null
    }
  }

  /**
   * 直调技能（!agent act，不经 LLM）。
   * @returns {Promise<{ ok: boolean, result: unknown }>}
   */
  async act (user, name, params) {
    // P2-3（第五轮）：act 直调不经 busy 门——!agent act goto 可打进进行中的
    // chat 工具循环（两个控制流并发改 pathfinder/装备状态）。busy 时拒绝
    if (this.busy) return { ok: false, result: '上一个请求仍在处理中，请稍候' }
    // v1.0.0 C4：直调动作原语（走执行器统一管线——权限/校验/守卫/审计）
    return this.executor.executeOne(name, params, { user, source: 'act' })
  }

  /**
   * 单次 LLM 一句话总结（U6/U7：死亡播报/任务终态播报）——无会话、无工具循环、
   * 不占用 busy/冷却状态。任何失败/超时返回 null（调用方回退固定模板），
   * 绝不阻塞调用方（10s 短超时）。
   * @param {string} prompt
   * @returns {Promise<string|null>}
   */
  async summarize (prompt) {
    if (!this.provider?.chat) return null
    // A5：全局冷却（60s）——死亡与任务终态并发时只发一条 LLM 请求
    const now = Date.now()
    if (now - lastSummarizeAt < SUMMARY_COOLDOWN_MS) return null
    lastSummarizeAt = now
    try {
      const res = await this.provider.chat(
        [{ role: 'user', content: String(prompt).slice(0, 500) }],
        {
          system: '你是 Minecraft 服务器上的 Bot 播报员。用一句话（≤100 字符）概括，不要 Markdown，不要角色扮演。',
          signal: AbortSignal.timeout(10000)
        }
      )
      const text = (res?.text ?? '').trim()
      return text ? text.slice(0, 120) : null
    } catch {
      return null
    }
  }

  /** 中止进行中的请求。 */
  stop () {
    this._abort?.abort()
  }

  /** U9：provider 连通性诊断（!agent doctor，只读）。 */
  async diagnose () {
    if (!this.provider?.diagnose) {
      return [{ ok: false, label: 'provider', error: 'provider 不支持诊断' }]
    }
    const r = await this.provider.diagnose()
    return Array.isArray(r) ? r : [r]
  }

  /** 清空指定玩家的会话记忆（!agent reset；v1.0.0 C5 同步清磁盘）。 */
  reset (user) {
    SESSIONS.delete(user)
    this.sessionStore?.reset(user)
  }

  /** 当前会话数（U3 /metrics 用）。 */
  sessionCount () {
    return SESSIONS.size
  }
}
