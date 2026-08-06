import { readFileSync, mkdirSync, accessSync, constants as FS_CONST } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// 内置默认值（合并基准：offline、localhost、26.1.2；生产部署经 config.json 覆盖 host 等）
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
  // L2 LLM 层：provider = auto（云端优先，失败回退 Ollama）| cloud | ollama。
  // 所有密钥只从环境变量读取（l2.cloudApiKeyEnv 指定变量名），绝不进配置文件。
  l2: {
    enabled: false,
    provider: 'auto',
    model: 'claude-sonnet-5',
    cloudBaseUrl: 'https://api.anthropic.com/v1/messages',
    cloudApiKeyEnv: 'ANTHROPIC_API_KEY',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen3.5:4b',
    maxSteps: 5,
    cooldownMs: 5000,
    // 生成超时/长度可配置（低配机 Ollama 仅 10-30 tok/s，默认 60s 防长回复误超时）
    cloudTimeoutMs: 60000,
    ollamaTimeoutMs: 60000,
    maxTokens: 1024
  },
  // 聊天安全层：服务端单条消息上限 256 字符，Bot 分片发送时留冗余
  chat: {
    maxLength: 250,
    commandCooldownMs: 750
  },
  scheduleTimezone: 'Asia/Shanghai'
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
  MCBOT_L2_PROVIDER: ['l2', 'provider'],
  MCBOT_L2_MODEL: ['l2', 'model'],
  MCBOT_L2_CLOUD_BASE_URL: ['l2', 'cloudBaseUrl'],
  MCBOT_L2_CLOUD_API_KEY_ENV: ['l2', 'cloudApiKeyEnv'],
  MCBOT_L2_OLLAMA_URL: ['l2', 'ollamaUrl'],
  MCBOT_L2_OLLAMA_MODEL: ['l2', 'ollamaModel'],
  MCBOT_L2_MAX_STEPS: ['l2', 'maxSteps'],
  MCBOT_L2_COOLDOWN_MS: ['l2', 'cooldownMs'],
  MCBOT_CHAT_MAX_LENGTH: ['chat', 'maxLength'],
  MCBOT_CHAT_COMMAND_COOLDOWN_MS: ['chat', 'commandCooldownMs'],
  MCBOT_SCHEDULE_TIMEZONE: ['scheduleTimezone'],
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
    } else if (!Number.isNaN(Number(raw)) && /^-?\d+$/.test(raw) && ['keepDays', 'port', 'maxSteps', 'maxLength'].includes(pathArr[pathArr.length - 1])) {
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

  // 相对路径基于项目根解析（跨平台：不用 process.cwd()）；log 被显式置 null/错型时不炸
  if (typeof cfg.log?.dir === 'string') {
    cfg.log.dir = path.isAbsolute(cfg.log.dir) ? cfg.log.dir : path.join(ROOT, cfg.log.dir)
  }

  return deepFreeze(cfg)
}

function deepFreeze (obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj)
    for (const v of Object.values(obj)) deepFreeze(v)
  }
  return obj
}

/**
 * 启动前检查日志目录可写（创建 + 写权限探测）。
 * 目录只读/不可访问时给出明确错误而非 pino-roll 静默失败（原 ProtectSystem=strict 场景，Windows 同理适用）。
 * @param {object} cfg
 * @throws {Error} 目录不可写时抛出
 */
export function assertLogDirWritable (cfg) {
  try {
    mkdirSync(cfg.log.dir, { recursive: true })
    accessSync(cfg.log.dir, FS_CONST.W_OK)
  } catch (err) {
    throw new Error(`日志目录不可写: ${cfg.log.dir}（${err.message}）。` +
      '请将 log.dir 配置到可写路径（如项目内 ./logs），' +
      '并确认运行账户对该路径有写权限')
  }
}

// 任务类型表（与 src/tasks/manager.js 的 TASK_TYPES 同步维护）
const KNOWN_TASK_TYPES = ['mine', 'fish', 'afk', 'farm', 'chop', 'combat', 'breed']
// 有自然完成语义的任务类型（scheduled 时无需 durationMinutes；afk 必须配）
const NATURAL_COMPLETION_TYPES = ['mine', 'fish', 'farm', 'chop', 'combat', 'breed']
const ROTATE_FREQUENCIES = ['hourly', 'daily', 'weekly', 'monthly', 'custom']
const AREA_KEYS = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2']

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
  for (const k of ['baseMs', 'maxMs', 'factor', 'jitter', 'minGapMs']) {
    const v = cfg.reconnect?.[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errors.push(`reconnect.${k} 必须为非负数: ${v}`)
  }
  if (cfg.reconnect?.maxMs != null && cfg.reconnect.maxMs < cfg.reconnect.baseMs) {
    errors.push('reconnect.maxMs 不能小于 baseMs')
  }
  if (typeof cfg.reconnect?.jitter === 'number' && (cfg.reconnect.jitter < 0 || cfg.reconnect.jitter > 1)) {
    errors.push(`reconnect.jitter 必须在 0-1 之间，当前: ${cfg.reconnect.jitter}`)
  }
  if (!Array.isArray(cfg.ops)) errors.push('ops 必须是数组')
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(cfg.log?.level)) {
    errors.push(`log.level 非法: ${cfg.log?.level}`)
  }
  if (typeof cfg.log?.dir !== 'string' || !cfg.log.dir) errors.push('log.dir 必须是非空字符串（可写路径）')
  if (typeof cfg.log?.pretty !== 'boolean') errors.push('log.pretty 必须是布尔值（MCBOT_LOG_PRETTY 只接受 true/false）')
  if (!ROTATE_FREQUENCIES.includes(cfg.log?.rotate?.frequency)) {
    errors.push(`log.rotate.frequency 必须是 ${ROTATE_FREQUENCIES.join('/')}，当前: ${cfg.log?.rotate?.frequency}`)
  }
  if (cfg.mineflayerPlugins && typeof cfg.mineflayerPlugins === 'object') {
    for (const [k, v] of Object.entries(cfg.mineflayerPlugins)) {
      if (k === '_comment') continue // JSON 注释惯例（config.example.json 使用）
      if (typeof v !== 'boolean') errors.push(`mineflayerPlugins.${k} 必须是布尔值（"${v}" 是字符串会被视为真）`)
    }
  }
  if (cfg.scheduleTimezone !== undefined && (typeof cfg.scheduleTimezone !== 'string' || !cfg.scheduleTimezone)) {
    errors.push('scheduleTimezone 必须是非空字符串')
  }
  if (!cfg.l2 || typeof cfg.l2.enabled !== 'boolean') errors.push('l2.enabled 必须是布尔值')
  if (cfg.l2?.enabled) {
    if (!['auto', 'cloud', 'ollama'].includes(cfg.l2.provider)) {
      errors.push(`l2.provider 必须是 auto/cloud/ollama，当前: ${cfg.l2.provider}`)
    }
    if (typeof cfg.l2.model !== 'string' || !cfg.l2.model) errors.push('l2.model 必须是非空字符串（启用 L2 时）')
    if (!Number.isInteger(cfg.l2.maxSteps) || cfg.l2.maxSteps < 1) errors.push('l2.maxSteps 必须为正整数')
    if (typeof cfg.l2.cooldownMs !== 'number' || cfg.l2.cooldownMs < 0) errors.push('l2.cooldownMs 必须为非负数')
    for (const k of ['cloudTimeoutMs', 'ollamaTimeoutMs']) {
      if (typeof cfg.l2[k] !== 'number' || cfg.l2[k] <= 0) errors.push(`l2.${k} 必须为正数（毫秒）`)
    }
    if (typeof cfg.l2.maxTokens !== 'number' || cfg.l2.maxTokens <= 0) errors.push('l2.maxTokens 必须为正数')
    if (typeof cfg.l2.ollamaModel !== 'string' || !cfg.l2.ollamaModel) errors.push('l2.ollamaModel 必须是非空字符串')
  }
  if (!Number.isInteger(cfg.chat?.maxLength) || cfg.chat?.maxLength < 32 || cfg.chat?.maxLength > 256) {
    errors.push(`chat.maxLength 必须是 32-256 的整数，当前: ${cfg.chat?.maxLength}`)
  }
  if (!Number.isInteger(cfg.chat?.commandCooldownMs) || cfg.chat.commandCooldownMs < 0) {
    errors.push(`chat.commandCooldownMs 必须是非负整数，当前: ${cfg.chat?.commandCooldownMs}`)
  }
  if (!Array.isArray(cfg.tasks)) errors.push('tasks 必须是数组')

  // 任务条目校验：id 非空且唯一、类型已知、scheduled 完成语义、options 形状
  const seenIds = new Set()
  for (const [i, t] of (cfg.tasks ?? []).entries()) {
    const label = `tasks[${i}]`
    if (!t || typeof t !== 'object') { errors.push(`${label} 必须是对象`); continue }
    if (typeof t.id !== 'string' || !t.id) { errors.push(`${label} 缺少非空 id`); continue }
    if (seenIds.has(t.id)) errors.push(`${label} id 重复: ${t.id}`)
    seenIds.add(t.id)
    if (!KNOWN_TASK_TYPES.includes(t.type)) {
      errors.push(`${label} 未知类型: ${t.type}（已知: ${KNOWN_TASK_TYPES.join(', ')}）`)
      continue
    }
    if (t.schedule && !NATURAL_COMPLETION_TYPES.includes(t.type) && !t.options?.durationMinutes) {
      errors.push(`${label} 类型 ${t.type} 无自然完成，scheduled 时必须配 options.durationMinutes`)
    }
    const opts = t.options ?? {}
    if (opts.blockTypes !== undefined) {
      if (!Array.isArray(opts.blockTypes) || opts.blockTypes.length === 0) {
        errors.push(`${label} blockTypes 必须是非空数组`)
      } else {
        for (const b of opts.blockTypes) {
          if (typeof b !== 'string' || !b) errors.push(`${label} blockTypes 条目必须是非空字符串`)
          else if (b.startsWith('minecraft:')) errors.push(`${label} blockTypes 不能带命名空间前缀: ${b}（用无前缀名如 iron_ore）`)
        }
      }
    }
    if (opts.area !== undefined) {
      const a = opts.area
      for (const c of AREA_KEYS) {
        if (!Number.isInteger(a?.[c])) errors.push(`${label} area.${c} 必须是整数`)
      }
      if (Number.isInteger(a?.x1) && Number.isInteger(a?.x2) && a.x1 > a.x2) errors.push(`${label} area.x1 不能大于 x2`)
      if (Number.isInteger(a?.y1) && Number.isInteger(a?.y2) && a.y1 > a.y2) errors.push(`${label} area.y1 不能大于 y2`)
      if (Number.isInteger(a?.z1) && Number.isInteger(a?.z2) && a.z1 > a.z2) errors.push(`${label} area.z1 不能大于 z2`)
    }
  }
  // 未知顶层键（拼写错误会被静默忽略——明确报出）
  const KNOWN_TOP_KEYS = new Set([
    'mcVersion', 'host', 'port', 'username', 'auth', 'spawnTimeoutMs',
    'reconnect', 'ops', 'log', 'tasks', 'mineflayerPlugins', 'l2', 'chat', 'scheduleTimezone',
    '_comment' // JSON 注释惯例（config.example.json 顶层使用；复制为 config.json 必须放行）
  ])
  for (const k of Object.keys(cfg)) {
    if (!KNOWN_TOP_KEYS.has(k)) errors.push(`未知配置键: ${k}（拼写错误会被静默忽略，请检查）`)
  }
  return { ok: errors.length === 0, errors }
}
