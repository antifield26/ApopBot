import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from '../src/core/logger.js'

test('createLogger 生成可用实例并可写入临时目录', async () => {
  const logger = createLogger({ log: { dir: './logs', level: 'info', pretty: false, rotate: { frequency: 'daily', keepDays: 1 } } })
  logger.info('test message')
  await new Promise((resolve) => logger.flush(resolve))
  assert.ok(true, 'logger 写入无异常')
})
