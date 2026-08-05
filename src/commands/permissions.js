// 命令权限：offline 模式下服务端无法可靠判定 OP，一律使用配置白名单（config.ops）。

/**
 * @param {string} username
 * @param {{ ops: string[] }} cfg
 * @returns {boolean}
 */
export function isOp (username, cfg) {
  if (!Array.isArray(cfg?.ops)) return false
  return cfg.ops.includes(username)
}
