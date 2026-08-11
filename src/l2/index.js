// @ts-check
import { AgentInterface, PLANNER_SYSTEM_PROMPT } from './agent-interface.js'
import { createProvider } from './provider.js'
import { createActionExecutor } from '../core/executor.js'
import { createSessionStore } from './sessions.js'
import { createExperienceStore } from './experience.js'
import { createSkillsStore } from './skills.js'

/**
 * 构建单角色实例（角色级配置覆盖顶层 l2 配置）。
 * @param {Record<string, any>} l2 顶层 l2 配置（含 roles 数组）
 * @param {{ bot, cfg, logger, tasks, conn, plugins }} ctx
 * @param {{ provider: { chat: Function, diagnose?: Function, contextWindow?: Function }, executor: { executeBatch: Function, executeOne: Function, primitives: Map<string, { permission: string, exclusiveClass: string, description?: string, schema?: object }> }, sessionStore: { get(user: string): object|null, set(user: string, value: object): void, reset(user: string): void }|null, experience: { add(entry: object): void, recent(n?: number): Array<object>, match(ops: Array<string>, n?: number): Array<object> }|null, skills: { add(entry: object): void, recent(n?: number): Array<object>, match(taskTypes: Array<string>, n?: number): Array<object> }|null }} shared 共享依赖
 * @param {string} name 角色名
 * @param {string|null} fallbackPrompt 缺省人设（planner 用规划器人设，其余 CORE）
 */
function buildRole (l2, ctx, shared, name, fallbackPrompt) {
  const r = (l2.roles ?? []).find(x => x.name === name) ?? {}
  const cfg = { ...l2 }
  delete cfg.roles // systemPrompt/tools 走 deps，不进 cfg（cfg 保持 l2 键集）
  cfg.planEnabled = r.planEnabled ?? l2.planEnabled
  return new AgentInterface(ctx, {
    ...shared,
    config: cfg,
    ...(r.systemPrompt ?? fallbackPrompt ? { systemPrompt: r.systemPrompt ?? fallbackPrompt } : {}),
    ...(r.tools ? { toolWhitelist: r.tools } : {})
  }, name)
}

/**
 * L2 层入口。l2.enabled=false 时返回 null（零额外依赖，不加载任何 LLM 相关代码路径）。
 * 启用时组装：单 Provider + 动作执行器 + 会话落盘 + 经验库（各角色共享一次），
 * 按角色实例化 AgentInterface——恒有 primary（对话助手，CORE 人设全工具）与
 * planner（无人值守规划器，受限工具集；恒创建——planEnabled 只门控 onTaskCompleted，
 * 保留 !agent role planner 手动对话通道）+ l2.roles 配置的自定义角色。
 * 返回角色注册表对象：显式委托 primary 全部消费面（ctx.agent 兼容零改动），
 * onTaskCompleted 专门路由 planner 角色（任务完成 → 自主推进）。
 * @param {{ provider?: { chat: Function, diagnose?: Function, contextWindow?: Function }, executor?: { executeBatch: Function, executeOne: Function, primitives: Map<string, { permission: string, exclusiveClass: string, description?: string, schema?: object }> }, sessionStore?: { get(user: string): object|null, set(user: string, value: object): void, reset(user: string): void }|null, experience?: { add(entry: object): void, recent(n?: number): Array<object>, match(ops: Array<string>, n?: number): Array<object> }|null, skills?: { add(entry: object): void, recent(n?: number): Array<object>, match(taskTypes: Array<string>, n?: number): Array<object> }|null }|null} [deps] 依赖注入（测试用；生产不传——ConnectionManager._deps 同款先例）
 */
export function createL2 (cfg, ctx, deps = null) {
  if (!cfg.l2?.enabled) return null
  const logger = ctx.logger.child({ module: 'l2' })
  const provider = deps?.provider ?? createProvider(cfg, logger)
  const executor = deps?.executor ?? createActionExecutor(ctx)
  // 会话持久化（data/sessions.json；测试/无日志目录场景容错）
  let sessionStore = null
  try {
    sessionStore = deps?.sessionStore ?? createSessionStore({ logger })
  } catch (err) {
    logger.warn({ err: err.message }, '会话落盘初始化失败，降级为内存会话')
  }
  // 经验记忆库（动作失败反思沉淀；失败降级为不反思）
  let experience = null
  try {
    experience = deps?.experience ?? createExperienceStore({ logger, capacity: cfg.l2?.experienceCapacity ?? 100 })
  } catch (err) {
    logger.warn({ err: err.message }, '经验库初始化失败，降级为不反思')
  }
  // 技能库（成功任务实践沉淀——LLM 自主学习；失败降级为不学习/不注入）
  let skills = null
  try {
    skills = deps?.skills ?? createSkillsStore({ logger })
  } catch (err) {
    logger.warn({ err: err.message }, '技能库初始化失败，降级为不学习')
  }
  const shared = { provider, executor, sessionStore, experience, skills }
  // 角色集合：恒有 primary + planner，用户自定义角色追加（enabled:false 跳过实例化）
  const names = ['primary', 'planner']
  for (const r of cfg.l2?.roles ?? []) {
    if (!names.includes(r.name)) names.push(r.name)
  }
  const roles = new Map()
  for (const name of names) {
    const r = (cfg.l2?.roles ?? []).find(x => x.name === name)
    if (r?.enabled === false) continue
    roles.set(name, buildRole(cfg.l2, ctx, shared, name, name === 'planner' ? PLANNER_SYSTEM_PROMPT : null))
  }
  const primary = roles.get('primary')
  return {
    // ---- 角色注册表 ----
    primary,
    planner: roles.get('planner') ?? null,
    roles,
    get: (name) => roles.get(name) ?? null,
    all: () => [...roles.values()],
    /** 各角色状态（!agent role list / /metrics 用）。 */
    roleStats: () => [...roles.values()].map(a => ({
      name: a.role,
      busy: a.busy,
      sessions: a.sessionCount(),
      planEnabled: a.cfg.planEnabled !== false
    })),
    // 共享依赖暴露（commands/HTTP 消费）
    executor,
    provider,
    cfg: cfg.l2,
    // ---- 显式委托 primary（ctx.agent 兼容面：feature-layer/manager/fl-*/commands/index.js 零改动）----
    chat: (user, text) => primary.chat(user, text),
    act: (user, name, params) => primary.act(user, name, params),
    diagnose: (user) => primary.diagnose(user),
    reset: (user) => primary.reset(user),
    getGoal: (user) => primary.getGoal(user),
    setGoal: (user, text, plan) => primary.setGoal(user, text, plan),
    clearGoal: (user) => primary.clearGoal(user),
    summarize: (prompt, maxLength) => primary.summarize(prompt, maxLength),
    notifyEvent: (type, text) => { for (const a of roles.values()) a.notifyEvent(type, text) },
    stop: () => { for (const a of roles.values()) a.stop?.() },
    sessionCount: () => [...roles.values()].reduce((s, a) => s + a.sessionCount(), 0),
    usage: primary.usage,
    cooldowns: primary.cooldowns,
    pendingEvents: primary.pendingEvents,
    // ---- 任务通道：planner 自主推进 + 技能学习并行（独立冷却互不阻塞）----
    onTaskCompleted: (rec) => {
      const p = (roles.get('planner')?.onTaskCompleted(rec) ?? Promise.resolve(false))
      // 技能学习 fire-and-forget（v1.5.0 自主学习循环）——失败静默，不阻塞规划通道
      const learner = roles.get('planner') ?? primary
      if (learner?.learnFromTask) void learner.learnFromTask(rec)
      return p
    },
    /** 技能学习（!agent 无入口；测试直接 await 用）。 */
    learnFromTask: (rec) => (roles.get('planner') ?? primary)?.learnFromTask(rec) ?? Promise.resolve(false)
  }
}
