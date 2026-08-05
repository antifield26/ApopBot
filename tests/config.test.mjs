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
