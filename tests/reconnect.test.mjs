import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDisconnect, nextBackoff } from '../src/core/reconnect.js'

test('classifyDisconnect: 致命原因', () => {
  assert.equal(classifyDisconnect('Your username is already logged in!').isFatal, true)
  assert.equal(classifyDisconnect('You are not white-listed on this server').isFatal, true)
  assert.equal(classifyDisconnect('Outdated client! Please use 26.1.2').isFatal, true)
  assert.equal(classifyDisconnect('This server is not compatible with your client').type, 'version_mismatch')
  assert.equal(classifyDisconnect('random unknown reason').isFatal, true)
  assert.equal(classifyDisconnect('').isFatal, true)
})

test('classifyDisconnect: 非致命原因（值得重连）', () => {
  assert.equal(classifyDisconnect('Flying is not enabled on this server').isFatal, false)
  assert.equal(classifyDisconnect('Server is full!').isFatal, false)
  assert.equal(classifyDisconnect('Server is restarting').type, 'maintenance')
  assert.equal(classifyDisconnect(new Error('connect ETIMEDOUT')).type, 'network_error')
  assert.equal(classifyDisconnect(new Error('connect ETIMEDOUT')).isFatal, false)
})

test('classifyDisconnect: Error 对象与 kick 对象', () => {
  assert.equal(classifyDisconnect(new Error('socket hang up')).type, 'network_error')
  const kickObj = { text: 'You are banned.' }
  assert.equal(classifyDisconnect(kickObj).type, 'access_denied')
})

test('classifyDisconnect: AggregateError（空 message + code）不误判为 fatal', () => {
  // minecraft-protocol 连接失败的真实形态（IPv4/IPv6 合并）
  const agg = Object.assign(new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:25565')], ''), { code: 'ECONNREFUSED' })
  const r = classifyDisconnect(agg)
  assert.equal(r.type, 'network_error')
  assert.equal(r.isFatal, false)
  assert.ok(r.detail.length > 0, 'detail 不应为空')

  const aggEmpty = Object.assign(new AggregateError([], ''), { code: 'ECONNRESET' })
  assert.equal(classifyDisconnect(aggEmpty).type, 'network_error')
})

test('nextBackoff: 指数退避序列（无抖动路径）', () => {
  const params = { baseMs: 5000, maxMs: 300000, factor: 2, jitter: 0, minGapMs: 0 }
  assert.equal(nextBackoff({ attempt: 1, ...params }).delayMs, 5000)
  assert.equal(nextBackoff({ attempt: 2, ...params }).delayMs, 10000)
  assert.equal(nextBackoff({ attempt: 3, ...params }).delayMs, 20000)
  assert.equal(nextBackoff({ attempt: 7, ...params }).delayMs, 300000) // 封顶
})

test('nextBackoff: jitter 在 ±20% 范围内', () => {
  const params = { attempt: 3, baseMs: 5000, maxMs: 300000, factor: 2, jitter: 0.2, minGapMs: 0 }
  for (let i = 0; i < 50; i++) {
    const { delayMs } = nextBackoff(params)
    assert.ok(delayMs >= 16000 && delayMs <= 24000, `delayMs=${delayMs} 超出 ±20% 范围`)
  }
})

test('nextBackoff: minGapMs 防抖（崩溃循环保护）', () => {
  const params = { attempt: 1, baseMs: 2000, maxMs: 10000, factor: 2, jitter: 0, minGapMs: 10000 }
  const nowMs = 1_000_000_000_000
  // 距上次失败 1s → 应补齐到 10s
  const short = nextBackoff({ ...params, lastFailMs: nowMs - 1000, nowMs })
  assert.ok(short.delayMs >= 9000, `delayMs=${short.delayMs}`)
  // 距上次失败 30s → 不补齐，正常退避 2s
  const long = nextBackoff({ ...params, lastFailMs: nowMs - 30000, nowMs })
  assert.ok(long.delayMs <= 2500)
})
