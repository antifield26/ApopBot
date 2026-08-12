// @ts-check
import { readFileSync, mkdirSync, accessSync, constants as FS_CONST } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { validateTaskOptions, validateNextOptions, validateCron } from './task-schemas.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// 配置契约版本（冻结）——l2 子键白名单为契约的一部分，
// 未知键/已移除键（ollama 系）显式报错；升级大版本配置时同步提升
export const CONFIG_SCHEMA_VERSION = 2

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
  notify: { webhook: '' }, // 运维 webhook 通知（空 = 关闭；企业微信/Server酱自动识别）
  mineflayerPlugins: {
    pathfinder: true,
    collectBlock: true,
    autoEat: true,
    armorManager: true
  },
  // L2 LLM 层（单 Provider——仅云端 Anthropic 兼容 API；
  // 预设 DeepSeek：Anthropic 兼容端点 api.deepseek.com/anthropic（裸域名 + /v1/messages
  // 是 OpenAI 兼容路由，Anthropic 协议会 404）；本地 Ollama/auto 已移除，
  // l2 键白名单强制，残留旧键启动即报错）。
  // 所有密钥只从环境变量读取（l2.cloudApiKeyEnv 指定变量名），绝不进配置文件。
  l2: {
    enabled: false,
    model: 'deepseek-v4-flash',
    cloudBaseUrl: 'https://api.deepseek.com/anthropic',
    cloudApiKeyEnv: 'ANTHROPIC_API_KEY',
    // 默认 8——动作技能就位后真实链条（observe→act×3→reply）
    // 打满上限前留有工具步给观察/反思；act 单步含 ≤8 动作数组
    maxSteps: 8,
    cooldownMs: 5000,
    // 生成超时/长度（thinking 关闭：1024 tokens 足够动作数组+回复）
    cloudTimeoutMs: 60000,
    maxTokens: 1024,
    // 思考模式与推理强度（DeepSeek 预设：thinking=disabled + effort=low 低延迟快速输出）。
    // thinking=disabled 时 provider 显式发 thinking:{type:'disabled'} 且**不传**
    // reasoning_effort——DeepSeek Anthropic 兼容端点将两者视为互斥（400）；
    // thinking=enabled 时按 effort（low/medium/high/max）注入 reasoning_effort。
    thinking: 'disabled',
    effort: 'low',
    // 云端上下文窗口——云端同样走预算守卫（window − maxTokens − reserve），
    // 是动作数组/观察结果回填的容量基础；32k 上下文端点请调低
    cloudMaxContextWindow: 65536,
    // 单次 act 动作数组上限（LLM 每轮动作预算 = maxSteps × maxActionsPerCall）
    maxActionsPerCall: 8,
    // 环境感知自动注入：每次对话 system 尾部追加 ≤150 字符环境行
    envInjection: true,
    // 退化状态自动注入：低血/饥饿/背包满/工具将坏（正常时零成本空串）
    stateInjection: true,
    // 附近危险注入：新鲜窗口内的危险区域记忆（无记录时零成本空串）
    dangerInjection: true,
    // 自主推进（规划器）：任务自然完成且无配置链时，LLM 评估目标并生成下一个任务
    planEnabled: true,
    // 规划调用独立冷却（与 summarize 60s 分开——带工具的规划调用成本高）
    planCooldownMs: 120000,
    // 技能学习（v1.5.0）：任务完成后 LLM 把成功实践提炼为 skill 注入后续对话
    skillEnabled: true,
    // 技能学习独立冷却（不共享 summarize 60s——完成时刻播报与学习并发不互饿）
    skillLearnCooldownMs: 300000,
    // 技能注入：活跃任务类型的过往成功实践（无匹配回退最近 1 条）
    skillInjection: true,
    // 经验库容量（失败教训 FIFO 上限；缺省 100）
    experienceCapacity: 100
  },
  // 聊天安全层：服务端单条消息上限 256 字符，Bot 分片发送时留冗余
  chat: {
    maxLength: 250,
    commandCooldownMs: 750
  },
  // 只读 HTTP 状态端点：默认关闭；只绑 127.0.0.1（暴露到局域网需自行加防火墙）
  http: {
    enabled: false,
    port: 8123
  },
  scheduleTimezone: 'Asia/Shanghai',
  // 仓库（storage）：背包满自动存入/卸货的固定箱子坐标（collect_blocks 的
  // autoDeposit 优先使用；store_items/fetch_items 原语默认目标）
  storage: { chests: [] },
  // 受击响应（guard）：被怪物攻击 → 暂停任务 → combat 清理 → 范围清空后恢复
  guard: { enabled: true, radius: 32, cooldownMs: 30000 }
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
  MCBOT_L2_MODEL: ['l2', 'model'],
  MCBOT_L2_CLOUD_BASE_URL: ['l2', 'cloudBaseUrl'],
  MCBOT_L2_CLOUD_API_KEY_ENV: ['l2', 'cloudApiKeyEnv'],
  MCBOT_L2_MAX_STEPS: ['l2', 'maxSteps'],
  MCBOT_L2_COOLDOWN_MS: ['l2', 'cooldownMs'],
  MCBOT_L2_MAX_TOKENS: ['l2', 'maxTokens'],
  MCBOT_L2_CLOUD_TIMEOUT_MS: ['l2', 'cloudTimeoutMs'],
  MCBOT_L2_CLOUD_MAX_CONTEXT_WINDOW: ['l2', 'cloudMaxContextWindow'],
  MCBOT_L2_MAX_ACTIONS_PER_CALL: ['l2', 'maxActionsPerCall'],
  MCBOT_L2_THINKING: ['l2', 'thinking'],
  MCBOT_L2_EFFORT: ['l2', 'effort'],
  MCBOT_L2_ENV_INJECTION: ['l2', 'envInjection'],
  MCBOT_L2_STATE_INJECTION: ['l2', 'stateInjection'],
  MCBOT_L2_DANGER_INJECTION: ['l2', 'dangerInjection'],
  MCBOT_L2_PLAN_ENABLED: ['l2', 'planEnabled'],
  MCBOT_L2_PLAN_COOLDOWN_MS: ['l2', 'planCooldownMs'],
  MCBOT_L2_SKILL_ENABLED: ['l2', 'skillEnabled'],
  MCBOT_L2_SKILL_LEARN_COOLDOWN_MS: ['l2', 'skillLearnCooldownMs'],
  MCBOT_L2_SKILL_INJECTION: ['l2', 'skillInjection'],
  MCBOT_L2_EXPERIENCE_CAPACITY: ['l2', 'experienceCapacity'],
  MCBOT_CHAT_MAX_LENGTH: ['chat', 'maxLength'],
  MCBOT_CHAT_COMMAND_COOLDOWN_MS: ['chat', 'commandCooldownMs'],
  MCBOT_HTTP_ENABLED: ['http', 'enabled'],
  MCBOT_HTTP_PORT: ['http', 'port'],
  MCBOT_SCHEDULE_TIMEZONE: ['scheduleTimezone'],
  MCBOT_RECONNECT_MAX_MS: ['reconnect', 'maxMs']
}

// 布尔型环境变量键白名单：'true'/'false' 只对这些键转布尔——其他键收到
// 'true'/'false' 应保持字符串（如 MCBOT_L2_THINKING=false——thinking 的合法值是
// 'enabled'/'disabled' 字符串，转布尔后校验报"当前: false"误导）
const BOOLEAN_ENV_KEYS = new Set([
  'log.pretty', 'l2.enabled', 'l2.envInjection', 'l2.stateInjection', 'l2.dangerInjection', 'l2.planEnabled', 'l2.skillEnabled', 'l2.skillInjection', 'http.enabled'
])

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
    } else if ((raw === 'true' || raw === 'false') && BOOLEAN_ENV_KEYS.has(pathArr.join('.'))) {
      value = raw === 'true'
    } else if (!Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw) && pathArr[pathArr.length - 1].toLowerCase().includes('ms')) {
      value = Number(raw)
    } else if (!Number.isNaN(Number(raw)) && /^-?\d+$/.test(raw) && ['keepDays', 'port', 'maxSteps', 'maxLength', 'maxTokens', 'cloudMaxContextWindow', 'maxActionsPerCall', 'experienceCapacity'].includes(pathArr[pathArr.length - 1])) {
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
    throw new Error(`无法读取配置文件 ${file}: ${err.message}`, { cause: err })
  }
}

/**
 * 加载并合并配置。优先级：内置默认 < default.json < --config 文件 < MCBOT_* 环境变量 < CLI 参数
 * @param {{ argv?: string[], env?: object }} [opts] skipProdConfig 仅供测试：不合并
 *   工作区 config/config.json（测试必须独立于本地真实配置——本地测试会创建该文件）
 * @returns {Record<string, any>} 冻结的配置对象
 */
export function loadConfig ({ argv = process.argv.slice(2), env = process.env } = {}, { skipProdConfig = false } = {}) {
  const cli = parseCli(argv)
  const envCfg = parseEnv(env)

  let cfg = deepMerge(BUILTIN_DEFAULTS, readJson(path.join(ROOT, 'config', 'default.json')))
  const explicit = cli.configPath ?? envCfg.configPath
  if (explicit) {
    const fileCfg = readJson(explicit)
    if (fileCfg === null) throw new Error(`指定的配置文件不存在: ${explicit}`)
    cfg = deepMerge(cfg, fileCfg)
  } else if (!skipProdConfig) {
    // 无显式 --config：存在 config/config.json（按 README 复制示例的生产路径）则合并，
    // 未传 --config 且无该文件时仅 default.json 生效
    const prodFile = readJson(path.join(ROOT, 'config', 'config.json'))
    if (prodFile !== null) cfg = deepMerge(cfg, prodFile)
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
 * 目录只读/不可访问时给出明确错误而非 pino-roll 静默失败。
 * @param {Record<string, any>} cfg
 * @throws {Error} 目录不可写时抛出
 */
export function assertLogDirWritable (cfg) {
  try {
    mkdirSync(cfg.log.dir, { recursive: true })
    accessSync(cfg.log.dir, FS_CONST.W_OK)
  } catch (err) {
    throw new Error(`日志目录不可写: ${cfg.log.dir}（${err.message}）。` +
      '请将 log.dir 配置到可写路径（如项目内 ./logs），' +
      '并确认运行账户对该路径有写权限', { cause: err })
  }
}

// 任务类型表单一来源：由 src/tasks/types.js 注册表派生（避免多处手工同步漂移）
import { TASK_TYPES } from '../tasks/types.js'
export const KNOWN_TASK_TYPES = Object.keys(TASK_TYPES)
// 有自然完成语义的任务类型（scheduled 时无需 durationMinutes；afk/fish 必须配——
// fish 语义同 afk：到点停止，缺 durationMinutes 应在配置校验期报错而非运行时）
const NATURAL_COMPLETION_TYPES = Object.keys(TASK_TYPES).filter(k => TASK_TYPES[k].naturalCompletion)
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
  } else if (cfg.scheduleTimezone !== undefined &&
    cfg.scheduleTimezone !== 'UTC' && // UTC 是合法 IANA 名但 supportedValuesOf 排除（协调世界时非时区）
    !Intl.supportedValuesOf('timeZone').includes(cfg.scheduleTimezone)) {
    // croner 只接受 IANA 时区名——Windows 控制面板时区名（"China Standard
    // Time"）在此显式报错，避免任务静默永不调度
    errors.push(`scheduleTimezone 必须是 IANA 时区名（如 Asia/Shanghai/UTC），当前: ${cfg.scheduleTimezone}——` +
      'Windows 控制面板时区名（如 "China Standard Time"）不被支持，用 `tzutil /l` 对照或直接查 IANA 表')
  }
  if (!cfg.l2 || typeof cfg.l2.enabled !== 'boolean') errors.push('l2.enabled 必须是布尔值')
  if (cfg.l2?.enabled) {
    if (typeof cfg.l2.model !== 'string' || !cfg.l2.model) errors.push('l2.model 必须是非空字符串（启用 L2 时）')
    if (!Number.isInteger(cfg.l2.maxSteps) || cfg.l2.maxSteps < 1) errors.push('l2.maxSteps 必须为正整数')
    if (typeof cfg.l2.cooldownMs !== 'number' || cfg.l2.cooldownMs < 0) errors.push('l2.cooldownMs 必须为非负数')
    if (typeof cfg.l2.cloudTimeoutMs !== 'number' || cfg.l2.cloudTimeoutMs <= 0) errors.push('l2.cloudTimeoutMs 必须为正数（毫秒）')
    if (typeof cfg.l2.maxTokens !== 'number' || cfg.l2.maxTokens <= 0) errors.push('l2.maxTokens 必须为正数')
    // 云端上下文窗口 ≥4096（防误配——小于预算裁剪 reserve 就没有守卫意义）
    if (!Number.isInteger(cfg.l2.cloudMaxContextWindow) || cfg.l2.cloudMaxContextWindow < 4096) {
      errors.push(`l2.cloudMaxContextWindow 必须是 ≥4096 的整数，当前: ${cfg.l2.cloudMaxContextWindow}`)
    }
    // 单次 act 动作数组上限 ≥1（每轮动作预算 = maxSteps × maxActionsPerCall）
    if (!Number.isInteger(cfg.l2.maxActionsPerCall) || cfg.l2.maxActionsPerCall < 1) {
      errors.push(`l2.maxActionsPerCall 必须是 ≥1 的整数，当前: ${cfg.l2.maxActionsPerCall}`)
    }
    if (typeof cfg.l2.envInjection !== 'boolean') errors.push('l2.envInjection 必须是布尔值')
    if (typeof cfg.l2.stateInjection !== 'boolean') errors.push('l2.stateInjection 必须是布尔值')
    if (typeof cfg.l2.dangerInjection !== 'boolean') errors.push('l2.dangerInjection 必须是布尔值')
    if (typeof cfg.l2.planEnabled !== 'boolean') errors.push('l2.planEnabled 必须是布尔值')
    if (!Number.isInteger(cfg.l2.planCooldownMs) || cfg.l2.planCooldownMs < 1000) {
      errors.push('l2.planCooldownMs 必须是 ≥1000 的整数（毫秒）')
    }
    if (typeof cfg.l2.skillEnabled !== 'boolean') errors.push('l2.skillEnabled 必须是布尔值')
    if (typeof cfg.l2.skillInjection !== 'boolean') errors.push('l2.skillInjection 必须是布尔值')
    if (!Number.isInteger(cfg.l2.skillLearnCooldownMs) || cfg.l2.skillLearnCooldownMs < 1000) {
      errors.push('l2.skillLearnCooldownMs 必须是 ≥1000 的整数（毫秒）')
    }
    if (!Number.isInteger(cfg.l2.experienceCapacity) || cfg.l2.experienceCapacity < 1) {
      errors.push('l2.experienceCapacity 必须是 ≥1 的整数')
    }
    if (cfg.l2.thinking !== undefined && !['enabled', 'disabled'].includes(cfg.l2.thinking)) {
      errors.push(`l2.thinking 必须是 enabled 或 disabled，当前: ${cfg.l2.thinking}`)
    }
    if (cfg.l2.effort !== undefined && !['low', 'medium', 'high', 'max'].includes(cfg.l2.effort)) {
      errors.push(`l2.effort 必须是 low/medium/high/max，当前: ${cfg.l2.effort}`)
    }
    // 多角色（v1.4.0）：roles 数组——缺省/空 = 内置 primary+planner 两角色；
    // 显式提供时 name 唯一非空、字段集收敛（enabled/planEnabled/systemPrompt/tools）、
    // 必须含 primary（对话入口——自动补 primary 会静默改变行为，显式报错）
    if (cfg.l2.roles !== undefined) {
      if (!Array.isArray(cfg.l2.roles)) {
        errors.push('l2.roles 必须是数组（缺省 = 内置 primary+planner 两角色）')
      } else {
        const seen = new Set()
        for (const [i, r] of cfg.l2.roles.entries()) {
          const label = `l2.roles[${i}]`
          if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.name.trim()) {
            errors.push(`${label}.name 必须是非空字符串`)
            continue
          }
          if (seen.has(r.name)) errors.push(`${label}.name 重复: ${r.name}`)
          seen.add(r.name)
          if (r.enabled !== undefined && typeof r.enabled !== 'boolean') errors.push(`${label}.enabled 必须是布尔值`)
          if (r.planEnabled !== undefined && typeof r.planEnabled !== 'boolean') errors.push(`${label}.planEnabled 必须是布尔值`)
          if (r.systemPrompt !== undefined && typeof r.systemPrompt !== 'string') errors.push(`${label}.systemPrompt 必须是字符串`)
          if (r.tools !== undefined && (!Array.isArray(r.tools) || !r.tools.every(t => typeof t === 'string'))) {
            errors.push(`${label}.tools 必须是字符串数组（原语名白名单）`)
          }
        }
        if (!seen.has('primary')) errors.push('l2.roles 必须包含 primary 角色（多角色配置的对话入口）')
      }
    }
  }
  // l2 子键白名单（config 契约）：残留的 ollama/provider 键显式报错给迁移指引，不静默忽略
  if (cfg.l2) {
    const L2_KNOWN_KEYS = new Set([
      'enabled', 'model', 'cloudBaseUrl', 'cloudApiKeyEnv', 'maxSteps', 'cooldownMs',
      'cloudTimeoutMs', 'maxTokens', 'cloudMaxContextWindow', 'maxActionsPerCall', 'envInjection',
      'stateInjection', 'dangerInjection', 'thinking', 'effort', 'planEnabled', 'planCooldownMs',
      'roles', // v1.4.0 多角色数组（缺省 = 内置 primary+planner）
      'skillEnabled', 'skillLearnCooldownMs', 'skillInjection', // v1.5.0 技能学习
      'experienceCapacity', // v1.5.0 经验库容量可配
      '_comment' // JSON 注释惯例（config.example.json 使用；与 mineflayerPlugins/顶层一致）
    ])
    for (const key of Object.keys(cfg.l2)) {
      if (!L2_KNOWN_KEYS.has(key)) {
        errors.push(`l2 未知键: ${key}（v1.0.0 已移除本地 provider——ollamaUrl/ollamaModel/` +
          'ollamaTimeoutMs/ollamaNumCtx/provider 请删除该配置；拼写错误请对照 config.example.json）')
      }
    }
  }
  if (!Number.isInteger(cfg.chat?.maxLength) || cfg.chat?.maxLength < 32 || cfg.chat?.maxLength > 256) {
    errors.push(`chat.maxLength 必须是 32-256 的整数，当前: ${cfg.chat?.maxLength}`)
  }
  if (!Number.isInteger(cfg.chat?.commandCooldownMs) || cfg.chat.commandCooldownMs < 0) {
    errors.push(`chat.commandCooldownMs 必须是非负整数，当前: ${cfg.chat?.commandCooldownMs}`)
  }
  if (typeof cfg.http?.enabled !== 'boolean') errors.push('http.enabled 必须是布尔值')
  if (!Number.isInteger(cfg.http?.port) || cfg.http.port < 1 || cfg.http.port > 65535) {
    errors.push(`http.port 必须是 1-65535 的整数，当前: ${cfg.http?.port}`)
  }
  // webhook 通知可选——空字符串/未配置 = 关闭；非空必须是字符串（含 https:// 的完整 URL）
  if (cfg.notify && typeof cfg.notify.webhook !== 'string') {
    errors.push('notify.webhook 必须是字符串（webhook URL 或空字符串关闭）')
  }
  // 仓库坐标校验（storage.chests：{x,y,z} 整数三元组数组）
  if (cfg.storage && !Array.isArray(cfg.storage.chests)) {
    errors.push('storage.chests 必须是数组')
  } else {
    for (const [i, ch] of (cfg.storage?.chests ?? []).entries()) {
      for (const k of ['x', 'y', 'z']) {
        if (!Number.isInteger(ch?.[k])) errors.push(`storage.chests[${i}].${k} 必须是整数`)
      }
    }
  }
  // 受击响应（guard）：enabled 布尔 / radius 1-64 / cooldownMs ≥1000
  if (cfg.guard && typeof cfg.guard.enabled !== 'boolean') errors.push('guard.enabled 必须是布尔值')
  if (cfg.guard && (!Number.isInteger(cfg.guard.radius) || cfg.guard.radius < 1 || cfg.guard.radius > 64)) {
    errors.push('guard.radius 必须是 1-64 的整数（格）')
  }
  if (cfg.guard && (!Number.isInteger(cfg.guard.cooldownMs) || cfg.guard.cooldownMs < 1000)) {
    errors.push('guard.cooldownMs 必须是 ≥1000 的整数（毫秒）')
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
    // 条目级 durationMinutes 数值校验——负数/零此前只查存在性，触发时立即强制停止
    if (t.durationMinutes !== undefined &&
        (typeof t.durationMinutes !== 'number' || !Number.isFinite(t.durationMinutes) || t.durationMinutes <= 0)) {
      errors.push(`${label} durationMinutes 必须是正数（当前: ${t.durationMinutes}）`)
    }
    // 非法 cron 表达式启动即报错——避免任务注册但永不触发、只留一条 error 日志
    //（与 scheduleTimezone 同款"静默永不调度"失败模式）
    if (t.schedule) {
      const v = validateCron(t.schedule)
      if (!v.ok) errors.push(`${label} ${v.error}`)
    }
    // 任务链 next 校验（options/schedule 递归——与 start_task 原语共用 validateNextOptions）
    if (t.next !== undefined) {
      const v = validateNextOptions(t.next)
      if (!v.ok) errors.push(`${label} next ${v.error}`)
    }
    // options.schedule 迁移报错——调度器只消费顶层 entry.schedule，塞进 options 会
    // 静默不触发（"任务注册但永不调度"失败模式，与非法 cron 同款显式报错）
    if (t.options?.schedule !== undefined && t.schedule === undefined) {
      errors.push(`${label} schedule 请放在任务条目顶层（options.schedule 不会被调度器消费）`)
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
    // config 路径任务 options 接入统一 schema 校验——非法 options（afk intervalMinutes:0、
    // combat attackRange:-1 等）在配置期显式报错，避免任务静默不运行、玩家无感知。
    // 失败并入 errors：启动 exit(1) / reload 保留旧配置。
    const v = validateTaskOptions(t.type, opts)
    if (!v.ok) errors.push(`${label} ${v.error}`)
  }
  // 未知顶层键（拼写错误会被静默忽略——明确报出）
  const KNOWN_TOP_KEYS = new Set([
    'mcVersion', 'host', 'port', 'username', 'auth', 'spawnTimeoutMs',
    'reconnect', 'ops', 'log', 'tasks', 'mineflayerPlugins', 'l2', 'chat', 'http', 'scheduleTimezone',
    'notify', // webhook 运维通知
    'storage', // 仓库坐标（autoDeposit/store_items 默认目标）
    'guard', // 受击响应（怪物攻击时暂停任务优先清理）
    '_comment' // JSON 注释惯例（config.example.json 顶层使用；复制为 config.json 必须放行）
  ])
  for (const k of Object.keys(cfg)) {
    if (!KNOWN_TOP_KEYS.has(k)) errors.push(`未知配置键: ${k}（拼写错误会被静默忽略，请检查）`)
  }
  return { ok: errors.length === 0, errors }
}
