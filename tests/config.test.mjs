import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, validateConfig } from '../src/core/config.js'

test('内置默认值：面向 Pi 5 生产', () => {
  const cfg = loadConfig({ argv: [], env: {} })
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

  const good = loadConfig({ argv: [], env: {} })
  assert.equal(validateConfig(good).ok, true)
})

// M6 修复：新增校验项
function base () {
  return loadConfig({ argv: [], env: {} })
}

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
  const bad = { ...base(), tasks: [{ id: 'a', type: 'afk', schedule: '0 3 * * *' }] }
  const { ok, errors } = validateConfig(bad)
  assert.equal(ok, false)
  assert.ok(errors.some(e => e.includes('durationMinutes')))

  const good = { ...base(), tasks: [{ id: 'a', type: 'afk', schedule: '0 3 * * *', options: { durationMinutes: 10 } }] }
  assert.equal(validateConfig(good).ok, true)

  // 有自然完成的类型（mine stopWhenDone）不需要 durationMinutes
  const mine = { ...base(), tasks: [{ id: 'm', type: 'mine', schedule: '0 3 * * *', options: { stopWhenDone: true } }] }
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
