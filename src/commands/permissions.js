// @ts-check
// 命令权限：offline 模式下服务端无法可靠判定 OP，一律使用配置白名单（config.ops）。
// 大小写不敏感（Paper offline 模式下玩家可能以任意大小写加入，白名单须匹配）。

/**
 * @param {string} username
 * @param {{ ops?: string[] }} cfg
 * @returns {boolean}
 */
export function isOp (username, cfg) {
  if (!Array.isArray(cfg?.ops)) return false
  if (typeof username !== 'string' || !username) return false
  // trim 归一：配置条目带首尾空格时永不匹配（如 "steve, alex" 环境变量拆分残留）
  const name = username.trim().toLowerCase()
  return cfg.ops.some(op => typeof op === 'string' && op.trim().toLowerCase() === name)
}
