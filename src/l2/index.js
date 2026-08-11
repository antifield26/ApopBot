import { AgentInterface } from './agent-interface.js'
import { createProvider } from './provider.js'
import { createActionExecutor } from '../core/executor.js'
import { createSessionStore } from './sessions.js'
import { createExperienceStore } from './experience.js'

/**
 * L2 层入口。l2.enabled=false 时返回 null（零额外依赖，不加载任何 LLM 相关代码路径）。
 * 启用时组装：单 Provider（仅云端 non-reasoning）+ 动作执行器（act 动作数组 +
 * 观察原语统一执行层）+ 会话落盘 + Agent 接口。
 */
export function createL2 (cfg, ctx) {
  if (!cfg.l2?.enabled) return null
  const logger = ctx.logger.child({ module: 'l2' })
  const provider = createProvider(cfg, logger)
  const executor = createActionExecutor(ctx)
  // 会话持久化（data/sessions.json；测试/无日志目录场景容错）
  let sessionStore = null
  try {
    sessionStore = createSessionStore({ logger })
  } catch (err) {
    logger.warn({ err: err.message }, '会话落盘初始化失败，降级为内存会话')
  }
  // 经验记忆库（动作失败反思沉淀；失败降级为不反思）
  let experience = null
  try {
    experience = createExperienceStore({ logger })
  } catch (err) {
    logger.warn({ err: err.message }, '经验库初始化失败，降级为不反思')
  }
  return new AgentInterface(ctx, { provider, executor, sessionStore, experience, config: cfg.l2 })
}
