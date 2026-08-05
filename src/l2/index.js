import { AgentInterface } from './agent-interface.js'

/**
 * L2 层入口。l2.enabled=false 时返回 null（不加载任何 LLM 相关依赖）。
 */
export function createL2 (cfg, ctx) {
  if (!cfg.l2?.enabled) return null
  return new AgentInterface(ctx)
}
