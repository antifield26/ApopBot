import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// 内置默认值（合并基准，面向 Pi 5 生产：offline、localhost、26.1.2）
const BUILTIN_DEFAULTS = {
  mcVersion: '26.1.2',
  host: 'localhost',
  port: 25565,
  username: 'mcbot',
  auth: 'offline',
  spawnTimeoutMs: 60000,
  reconnect: {
    baseMs: 5000,
    maxMs: 300000,
    factor: 2,
    jitter: 0.2,
    resetAfterSpawnMs: 60000,
    minGapMs: 10000
  },
  ops: [],
  log: {
    dir: path.join(ROOT, 'logs'),
    level: 'info',
    pretty: false,
    rotate: { frequency: 'daily', keepDays: 14 }
  },
  tasks: [],
  mineflayerPlugins: {
    pathfinder: true,
    collectBlock: true,
    autoEat: true,
    armorManager: true
  },
  l2: { enabled: false, provider: null, model: null }
}

// 环境变量映射：MCBOT_<KEY>，下划线命名 → 嵌套路径
const ENV_MAP = {
  MCBOT_MC_VERSION: ['mcVersion'],
  MCBOT_HOST: ['host'],
  MCBOT_PORT: ['port'],
  MCBOT_USERNAME: ['username'],
  MCBOT_AUTH: ['auth'],
  MCBOT_SPAWN_TIMEOUT_MS: ['spawnTimeoutMs'],
  MCBOT_LOG_DIR: ['log', 'dir'],
  MCBOT_LOG_LEVEL: ['log', 'level'],
  MCBOT_LOG_PRETTY: ['log', 'pretty'],
  MCBOT_LOG_KEEP_DAYS: ['log', 'rotate', 'keepDays'],
  MCBOT_OP_WHITELIST: ['ops'], // 逗号分隔
  MCBOT_TASKS_FILE: ['tasksFile'], // 任务 JSON 路径，合并入 tasks
  MCBOT_L2_ENABLED: ['l2', 'enabled'],
  MCBOT_RECONNECT_MAX_MS: ['reconnect', 'maxMs']
}

const CLI_KEYS = {
  '--config': { path: ['configPath'], type: 'string' },
  '--mc-version': { path: ['mcVersion'], type: 'string' },
  '--host': { path: ['host'], type: 'string' },
  '--port': { path: ['port'], type: 'number' },
  '--username': { path: ['username'], type: 'string' },
  '--auth': { path: ['auth'], type: 'string' },
  '--log-level': { path: ['log', 'level'], type: 'string' },
  '--dry-run': { path: ['dryRun'], type: 'boolean' }
}

function deepMerge (base, override) {
  if (override === undefined) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override
  if (typeof override !== 'object' || override === null) return override
  const out = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = deepMerge(base[k], v)
  }
  return out
}

function setPath (obj, pathArr, value) {
  let cur = obj
  for (let i = 0; i < pathArr.length - 1; i++) {
    if (typeof cur[pathArr[i]] !== 'object' || cur[pathArr[i]] === null) cur[pathArr[i]] = {}
    cur = cur[pathArr[i]]
  }
  cur[pathArr[pathArr.length - 1]] = value
}

function parseCli (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const spec = CLI_KEYS[key]
    if (!spec) continue
    if (spec.type === 'boolean') {
      setPath(out, spec.path, true)
      continue
    }
    const raw = argv[++i]
    if (raw === undefined) continue
    setPath(out, spec.path, spec.type === 'number' ? Number(raw) : raw)
  }
  return out
}

function parseEnv (env) {
  const out = {}
  for (const [key, pathArr] of Object.entries(ENV_MAP)) {
    const raw = env[key]
    if (raw === undefined || raw === '') continue
    let value
    if (pathArr[0] === 'ops') {
      value = raw.split(',').map(s => s.trim()).filter(Boolean)
    } else if (raw === 'true' || raw === 'false') {
      value = raw === 'true'
    } else if (!Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw) && pathArr[pathArr.length - 1].toLowerCase().includes('ms')) {
      value = Number(raw)
    } else if (!Number.isNaN(Number(raw)) && /^-?\d+$/.test(raw) && (pathArr[pathArr.length - 1] === 'keepDays' || pathArr[pathArr.length - 1] === 'port')) {
      value = Number(raw)
    } else {
      value = raw
    }
    setPath(out, pathArr, value)
  }
  return out
}

function readJson (file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new Error(`无法读取配置文件 ${file}: ${err.message}`)
  }
}

/**
 * 加载并合并配置。优先级：内置默认 < default.json < --config 文件 < MCBOT_* 环境变量 < CLI 参数
 * @returns {object} 冻结的配置对象
 */
export function loadConfig ({ argv = process.argv.slice(2), env = process.env } = {}) {
  const cli = parseCli(argv)
  const envCfg = parseEnv(env)

  let cfg = deepMerge(BUILTIN_DEFAULTS, readJson(path.join(ROOT, 'config', 'default.json')))
  const explicit = cli.configPath ?? envCfg.configPath
  if (explicit) {
    const fileCfg = readJson(explicit)
    if (fileCfg === null) throw new Error(`指定的配置文件不存在: ${explicit}`)
    cfg = deepMerge(cfg, fileCfg)
  }
  cfg = deepMerge(cfg, envCfg)
  cfg = deepMerge(cfg, cli)

  // 任务文件合并（MCBOT_TASKS_FILE 指定的任务列表覆盖内置 tasks）
  if (cfg.tasksFile) {
    const tasks = readJson(cfg.tasksFile)
    if (tasks === null) throw new Error(`任务文件不存在: ${cfg.tasksFile}`)
    cfg.tasks = Array.isArray(tasks) ? tasks : tasks.tasks
  }
  delete cfg.tasksFile
  delete cfg.configPath
  delete cfg.dryRun

  // 相对路径基于项目根解析（跨平台：不用 process.cwd()）
  cfg.log.dir = path.isAbsolute(cfg.log.dir) ? cfg.log.dir : path.join(ROOT, cfg.log.dir)

  return Object.freeze(cfg)
}

/**
 * 配置校验。返回 { ok, errors }。
 */
export function validateConfig (cfg) {
  const errors = []
  if (typeof cfg.mcVersion !== 'string' || !cfg.mcVersion) errors.push('mcVersion 必须是非空字符串')
  if (typeof cfg.host !== 'string' || !cfg.host) errors.push('host 必须是非空字符串')
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) errors.push(`port 必须是 1-65535 的整数，当前: ${cfg.port}`)
  if (typeof cfg.username !== 'string' || !cfg.username) errors.push('username 必须是非空字符串')
  if (cfg.username.length > 16) errors.push(`username 不能超过 16 字符: ${cfg.username}`)
  if (!['offline', 'microsoft'].includes(cfg.auth)) errors.push(`auth 必须是 offline 或 microsoft，当前: ${cfg.auth}`)
  if (!Number.isInteger(cfg.spawnTimeoutMs) || cfg.spawnTimeoutMs <= 0) errors.push('spawnTimeoutMs 必须为正整数')
  for (const k of ['baseMs', 'maxMs', 'factor', 'jitter', 'resetAfterSpawnMs', 'minGapMs']) {
    const v = cfg.reconnect?.[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errors.push(`reconnect.${k} 必须为非负数: ${v}`)
  }
  if (cfg.reconnect.maxMs < cfg.reconnect.baseMs) errors.push('reconnect.maxMs 不能小于 baseMs')
  if (!Array.isArray(cfg.ops)) errors.push('ops 必须是数组')
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(cfg.log?.level)) {
    errors.push(`log.level 非法: ${cfg.log?.level}`)
  }
  if (!Array.isArray(cfg.tasks)) errors.push('tasks 必须是数组')
  if (!cfg.l2 || typeof cfg.l2.enabled !== 'boolean') errors.push('l2.enabled 必须是布尔值')
  return { ok: errors.length === 0, errors }
}
