import { AgentInterface } from './agent-interface.js'
import { createProvider } from './provider.js'
import { createSkillRegistry } from './skills.js'

/**
 * L2 层入口。l2.enabled=false 时返回 null（零额外依赖，不加载任何 LLM 相关代码路径）。
 * 启用时组装：双 Provider（auto=cloud 优先回退 ollama）+ 技能注册表 + Agent 接口。
 */
export function createL2 (cfg, ctx) {
  if (!cfg.l2?.enabled) return null
  const logger = ctx.logger.child({ module: 'l2' })
  const provider = createProvider(cfg, logger)
  const skills = createSkillRegistry(ctx)
  return new AgentInterface(ctx, { provider, skills, config: cfg.l2 })
}
