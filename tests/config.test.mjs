import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, validateConfig, assertLogDirWritable } from '../src/core/config.js'

test('内置默认值：生产基线', () => {
  const cfg = loadConfig({ argv: [], env: {} }, { skipProdConfig: true })
  assert.equal(cfg.mcVersion, '26.1.2')
  assert.equal(cfg.host, 'localhost')
  assert.equal(cfg.port, 25565)
  assert.equal(cfg.auth, 'offline')
  assert.equal(cfg.l2.enabled, false)
  assert.equal(cfg.l2.provider, 'auto', 'BUILTIN 默认 provider 不应被 default.json 覆盖为 null（M4 回归）')
  assert.equal(cfg.reconnect.baseMs, 5000)
  assert.ok(cfg.log.dir.endsWith('logs'))
})

test('环境变量覆盖（含类型转换与逗号分隔）', () => {
  const cfg = loadConfig({
    argv: [],
    env: {
      MCBOT_USERNAME: 'bot2',
      MCBOT_PORT: '25566',
      MCBOT_OP_WHITELIST: 'steve, alex ',
      MCBOT_L2_ENABLED: 'true',
      MCBOT_LOG_KEEP_DAYS: '7'
    }
  })
  assert.equal(cfg.username, 'bot2')
  assert.equal(cfg.port, 25566)
  assert.deepEqual(cfg.ops, ['steve', 'alex'])
  assert.equal(cfg.l2.enabled, true)
  assert.equal(cfg.log.rotate.keepDays, 7)
})

test('CLI 参数优先级最高', () => {
  const cfg = loadConfig({
    argv: ['--mc-version', '1.21.11', '--port', '30000'],
    env: { MCBOT_PORT: '25566', MCBOT_MC_VERSION: '26.1.2' }
  })
  assert.equal(cfg.mcVersion, '1.21.11')
  assert.equal(cfg.port, 30000)
})

test('--config 文件合并覆盖 default.json', () => {
  const cfg = loadConfig({ argv: ['--config', 'config/smoke.json'], env: {} })
  assert.equal(cfg.username, 'smokebot')
  assert.equal(cfg.spawnTimeoutMs, 30000)
  assert.equal(cfg.mcVersion, '26.1.2') // 未被 smoke.json 覆盖 → 保持默认
})

test('validateConfig 校验非法值', () => {
  const bad = loadConfig({ argv: ['--port', '99999', '--auth', 'weird'], env: {} })
  const { ok, errors } = validateConfig(bad)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('port')))
  assert.ok(errors.some(e => e.includes('auth')))

  const good = loadConfig({ argv: [], env: {} }, { skipProdConfig: true })
  assert.equal(validateConfig(good).ok, true)
})

// M6 修复：新增校验项
function base () {
  return loadConfig({ argv: [], env: {} }, { skipProdConfig: true })
}

test('A2/F3: config 任务 options 过统一 schema（此前静默放行 → init 抛错被吞 → 任务静默不运行）', () => {
  // afk intervalMinutes:0（忙循环风险）——旧内联校验放行
  const bad1 = { ...base(), tasks: [{ id: 'a', type: 'afk', options: { intervalMinutes: 0 } }] }
  const v1 = validateConfig(bad1)
  assert.equal(v1.ok, false)
  assert.ok(v1.errors.some(e => e.includes('intervalMinutes')), v1.errors.join('; '))
  // combat attackRange:-1（病态行为：dist > -1 恒真永不攻击）——schema min 0.5 拦截
  const bad2 = { ...base(), tasks: [{ id: 'c', type: 'combat', options: { attackRange: -1 } }] }
  const v2 = validateConfig(bad2)
  assert.equal(v2.ok, false)
  assert.ok(v2.errors.some(e => e.includes('attackRange')), v2.errors.join('; '))
  // mine 缺 blockTypes（required）
  const bad3 = { ...base(), tasks: [{ id: 'm', type: 'mine', options: {} }] }
  assert.equal(validateConfig(bad3).ok, false)
  // 合法 config 任务不受影响
  const good = { ...base(), tasks: [{ id: 'g', type: 'mine', options: { blockTypes: ['iron_ore'], radius: 32 } }] }
  assert.equal(validateConfig(good).ok, true)
  // A2/F2 联动：area-only chop（代码合法契约）在 config 路径同样放行
  const chop = { ...base(), tasks: [{ id: 'ch', type: 'chop', options: { area: { x1: 0, y1: 0, z1: 0, x2: 10, y2: 10, z2: 10 } } }] }
  assert.equal(validateConfig(chop).ok, true, 'area-only chop 应合法（chop 读 logTypes 非 blockTypes）')
})

test('M6: reconnect.jitter 越界拒绝', () => {
  const bad = { ...base(), reconnect: { ...base().reconnect, jitter: 1.5 } }
  const { ok, errors } = validateConfig(bad)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('jitter')))
})

test('M6: log.rotate.frequency 非法拒绝', () => {
  const bad = { ...base(), log: { ...base().log, rotate: { ...base().log.rotate, frequency: 'weird' } } }
  const { ok, errors } = validateConfig(bad)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('frequency')))
})

test('M6: mineflayerPlugins 字符串 "false" 拒绝', () => {
  const bad = { ...base(), mineflayerPlugins: { ...base().mineflayerPlugins, pathfinder: 'false' } }
  const { ok, errors } = validateConfig(bad)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('mineflayerPlugins.pathfinder')))
})

test('M6: 任务 id 重复拒绝', () => {
  const bad = { ...base(), tasks: [{ id: 'a', type: 'afk' }, { id: 'a', type: 'fish' }] }
  const { ok, errors } = validateConfig(bad)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('id 重复')))
})

test('M6: 未知任务类型拒绝', () => {
  const bad = { ...base(), tasks: [{ id: 'x', type: 'unknown' }] }
  const { ok, errors } = validateConfig(bad)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('未知类型')))
})

test('M6: blockTypes 命名空间前缀拒绝 / area 边界校验', () => {
  const bad = { ...base(), tasks: [{ id: 'm', type: 'mine', options: { blockTypes: ['minecraft:iron_ore'], area: { x1: 10, x2: 5, y1: 0, y2: 10, z1: 0, z2: 10 } } }] }
  const { ok, errors } = validateConfig(bad)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('命名空间')))
  assert.ok(errors.some(e => e.includes('area.x1')))

  const good = { ...base(), tasks: [{ id: 'm', type: 'mine', options: { blockTypes: ['iron_ore'], area: { x1: 0, x2: 10, y1: 0, y2: 10, z1: 0, z2: 10 } } }] }
  assert.equal(validateConfig(good).ok, true)
})

test('M6: scheduled 无自然完成类型必须配 durationMinutes', () => {
  // A2 后 afk 还必须配 intervalMinutes（schema required，afk.js init 同款校验）——
  // bad 只缺 durationMinutes（intervalMinutes 给全，验证 M6 校验本身）
  const bad = { ...base(), tasks: [{ id: 'a', type: 'afk', schedule: '0 3 * * *', options: { intervalMinutes: 1 } }] }
  const { ok, errors } = validateConfig(bad)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('durationMinutes')))

  const good = { ...base(), tasks: [{ id: 'a', type: 'afk', schedule: '0 3 * * *', options: { durationMinutes: 10, intervalMinutes: 1 } }] }
  assert.equal(validateConfig(good).ok, true)

  // 有自然完成的类型（mine stopWhenDone）不需要 durationMinutes（blockTypes 仍需）
  const mine = { ...base(), tasks: [{ id: 'm', type: 'mine', schedule: '0 3 * * *', options: { blockTypes: ['iron_ore'], stopWhenDone: true } }] }
  assert.equal(validateConfig(mine).ok, true)
})

test('M6: l2.enabled 时 provider 非法拒绝', () => {
  const bad = { ...base(), l2: { ...base().l2, enabled: true, provider: 'bogus' } }
  const { ok, errors } = validateConfig(bad)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('provider')))
})

test('M6: L2 环境变量映射与数值转换', () => {
  const cfg = loadConfig({
    argv: [],
    env: {
      MCBOT_L2_PROVIDER: 'ollama',
      MCBOT_L2_MAX_STEPS: '3',
      MCBOT_L2_COOLDOWN_MS: '1000',
      MCBOT_CHAT_MAX_LENGTH: '200',
      MCBOT_SCHEDULE_TIMEZONE: 'UTC'
    }
  })
  assert.equal(cfg.l2.provider, 'ollama')
  assert.equal(cfg.l2.maxSteps, 3)
  assert.equal(cfg.l2.cooldownMs, 1000)
  assert.equal(cfg.chat.maxLength, 200)
  assert.equal(cfg.scheduleTimezone, 'UTC')
  assert.equal(validateConfig(cfg).ok, true)
})

test('未知顶层键拒绝（拼写错误不再静默忽略）', () => {
  const cfg = loadConfig({ argv: [], env: {} }, { skipProdConfig: true })
  const { ok, errors } = validateConfig({ ...cfg, mcversion: '1.20' })
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('未知配置键')), JSON.stringify(errors))
})

test('log.pretty 非布尔拒绝（MCBOT_LOG_PRETTY=1 场景）', () => {
  const cfg = loadConfig({ argv: [], env: {} }, { skipProdConfig: true })
  const { ok, errors } = validateConfig({ ...cfg, log: { ...cfg.log, pretty: '1' } })
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('log.pretty')), JSON.stringify(errors))
})

test('log.dir 非字符串拒绝（config 置 log:null 不抛 TypeError）', () => {
  const cfg = loadConfig({ argv: [], env: {} }, { skipProdConfig: true })
  const { ok, errors } = validateConfig({ ...cfg, log: null })
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('log.dir')), JSON.stringify(errors))
})

test('畸形形状配置不抛 TypeError（reconnect:null / chat:null）', () => {
  const cfg = loadConfig({ argv: [], env: {} }, { skipProdConfig: true })
  const r1 = validateConfig({ ...cfg, reconnect: null })
  assert.equal(r1.ok, false)
  const r2 = validateConfig({ ...cfg, chat: null })
  assert.equal(r2.ok, false)
})

test('l2 数值/模型校验（maxSteps/超时/ollamaModel）', () => {
  const cfg = loadConfig({ argv: [], env: {} }, { skipProdConfig: true })
  const base = { ...cfg, l2: { ...cfg.l2, enabled: true } }
  for (const [patch, kw] of [
    [{ maxSteps: 'abc' }, 'l2.maxSteps'],
    [{ ollamaTimeoutMs: -1 }, 'ollamaTimeoutMs'],
    [{ cloudTimeoutMs: 0 }, 'cloudTimeoutMs'],
    [{ ollamaModel: '' }, 'ollamaModel'],
    [{ maxTokens: 0 }, 'maxTokens']
  ]) {
    const { ok, errors } = validateConfig({ ...base, l2: { ...base.l2, ...patch } })
    assert.equal(ok, false, JSON.stringify(patch))
    assert.ok(errors.some(e => e.includes(kw)), `${kw} 未报错: ${JSON.stringify(errors)}`)
  }
})

test('MCBOT_TASKS_FILE 任务文件合并（内部键加载后删除）', () => {
  const tmp = path.join(os.tmpdir(), `mcbot-tasks-${process.pid}-${Date.now()}.json`)
  writeFileSync(tmp, JSON.stringify([{ id: 't1', type: 'mine', options: { blockTypes: ['iron_ore'] } }]))
  try {
    const cfg = loadConfig({ argv: [], env: { MCBOT_TASKS_FILE: tmp } })
    assert.equal(cfg.tasks.length, 1)
    assert.equal(cfg.tasks[0].id, 't1')
    assert.equal(cfg.tasksFile, undefined, 'tasksFile 是内部键，加载后应删除')
  } finally {
    rmSync(tmp, { force: true })
  }
})

test('assertLogDirWritable：空路径报错（mkdirSync recursive 对已存在文件不抛，需无效路径）', () => {
  const cfg = loadConfig({ argv: [], env: {} }, { skipProdConfig: true })
  assert.throws(
    () => assertLogDirWritable({ ...cfg, log: { ...cfg.log, dir: '' } }),
    /日志目录不可写/)
})

test('P1-4 修复：顶层 _comment 放行（config.example.json 复制为 config.json 即可用）', () => {
  const cfg = { ...loadConfig({ argv: [], env: {} }, { skipProdConfig: true }), _comment: '生产配置示例' }
  const { ok, errors } = validateConfig(cfg)
  assert.equal(ok, true, `含顶层 _comment 的配置应通过校验: ${errors.join('; ')}`)
})

test('B2: ENV_MAP 覆盖 l2.maxTokens/cloudTimeoutMs/ollamaTimeoutMs', () => {
  const cfg = loadConfig({
    argv: [],
    env: {
      MCBOT_L2_MAX_TOKENS: '2048',
      MCBOT_L2_CLOUD_TIMEOUT_MS: '30000',
      MCBOT_L2_OLLAMA_TIMEOUT_MS: '45000'
    }
  })
  assert.equal(cfg.l2.maxTokens, 2048)
  assert.equal(cfg.l2.cloudTimeoutMs, 30000)
  assert.equal(cfg.l2.ollamaTimeoutMs, 45000)
})

test('B2: scheduled fish 缺 durationMinutes 在配置校验期报错（与 afk 一致）', () => {
  const cfg = { ...loadConfig({ argv: [], env: {} }, { skipProdConfig: true }),
    tasks: [{ id: 'f', type: 'fish', schedule: '0 20 * * *' }] }
  const { ok, errors } = validateConfig(cfg)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('durationMinutes')), `应报缺 durationMinutes: ${errors.join('; ')}`)
})

test('B3: KNOWN_TASK_TYPES 与 TASK_TYPES 键集一致（第六轮 C3 后为单一来源派生——保留断言防回退）', async () => {
  const { KNOWN_TASK_TYPES } = await import('../src/core/config.js')
  const { TASK_TYPES } = await import('../src/tasks/types.js')
  assert.deepEqual([...KNOWN_TASK_TYPES].sort(), Object.keys(TASK_TYPES).sort())
  // C3：自然完成语义也来自注册表（NATURAL_COMPLETION_TYPES 非导出——经 scheduled 校验间接断言）
  assert.ok(TASK_TYPES.afk.naturalCompletion === false, 'afk 无自然完成')
  assert.ok(TASK_TYPES.mine.naturalCompletion === true, 'mine 有自然完成')
})

test('B7: 无 --config 时存在 config/config.json 则合并（README 复制即用生效）', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'config.json')
  const existed = fs.existsSync(file)
  const backup = existed ? fs.readFileSync(file, 'utf8') : null
  fs.writeFileSync(file, JSON.stringify({ host: 'prod.example.com' }))
  try {
    const cfg = loadConfig({ argv: [], env: {} }) // B7 专测 prod 合并——必须真实读取（有备份恢复）
    assert.equal(cfg.host, 'prod.example.com', 'config.json 应合并覆盖 default.json（此前只读 default）')
    assert.equal(cfg.mcVersion, '26.1.2', 'default 键应保留（合并而非替换）')
  } finally {
    if (existed) fs.writeFileSync(file, backup)
    else fs.rmSync(file)
  }
})
