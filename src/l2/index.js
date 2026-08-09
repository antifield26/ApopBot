import { AgentInterface } from './agent-interface.js'
import { createProvider } from './provider.js'
import { createActionExecutor } from '../core/executor.js'
import { createSessionStore } from './sessions.js'

/**
 * L2 层入口。l2.enabled=false 时返回 null（零额外依赖，不加载任何 LLM 相关代码路径）。
 * 启用时组装：单 Provider（v1.0.0 C2：仅云端 non-reasoning）+ 动作执行器
 * （v1.0.0 C3/C4：act 动作数组 + 观察原语统一执行层）+ 会话落盘（C5）+ Agent 接口。
 */
export function createL2 (cfg, ctx) {
  if (!cfg.l2?.enabled) return null
  const logger = ctx.logger.child({ module: 'l2' })
  const provider = createProvider(cfg, logger)
  const executor = createActionExecutor(ctx)
  // v1.0.0 C5：会话持久化（data/sessions.json；测试/无日志目录场景容错）
  let sessionStore = null
  try {
    sessionStore = createSessionStore({ logger })
  } catch (err) {
    logger.warn({ err: err.message }, '会话落盘初始化失败，降级为内存会话')
  }
  return new AgentInterface(ctx, { provider, executor, sessionStore, config: cfg.l2 })
}
