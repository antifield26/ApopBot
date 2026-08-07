// U10：运维 webhook 通知测试——零依赖 fetch + 平台自动识别（企业微信 JSON / Server酱 form），
// 失败静默不阻塞主流程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier } from '../src/core/notify.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

/** 覆盖全局 fetch（恢复原实现）。 */
function stubFetch (impl) {
  const orig = globalThis.fetch
  globalThis.fetch = impl
  return () => { globalThis.fetch = orig }
}

test('U10: 未配置 webhook → disabled，send 不发请求', async () => {
  let called = false
  const restore = stubFetch(async () => { called = true; return { ok: true } })
  try {
    const n = createNotifier({ notify: {} }, makeLogger())
    assert.equal(n.enabled, false)
    await n.send('task', 'x')
    assert.equal(called, false, '未配置时不得发请求')
  } finally {
    restore()
  }
})

test('U10: Server酱式 URL → form-encoded {title, desp}', async () => {
  let body = null
  const restore = stubFetch(async (url, init) => {
    assert.ok(url.includes('sctapi.ftqq.com'), `url: ${url}`)
    body = init.body.toString()
    return { ok: true, status: 200 }
  })
  try {
    const n = createNotifier({ notify: { webhook: 'https://sctapi.ftqq.com/xxx.send' } }, makeLogger())
    await n.send('task', '任务 m1 completed', '{"mined":5}')
    const params = new URLSearchParams(body) // 中文 %XX 编码、空格 +——解析后断言最稳
    assert.equal(params.get('title'), '任务 m1 completed')
    assert.ok(params.get('desp').includes('{"mined":5}'), body)
  } finally {
    restore()
  }
})

test('U10: 企业微信机器人 URL → JSON {msgtype, text.content}', async () => {
  let parsed = null
  const restore = stubFetch(async (url, init) => {
    assert.ok(url.includes('qyapi.weixin.qq.com'))
    parsed = JSON.parse(init.body)
    return { ok: true, status: 200 }
  })
  try {
    const n = createNotifier({ notify: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' } }, makeLogger())
    await n.send('death', 'Bot 死亡（0,64,0）')
    assert.equal(parsed.msgtype, 'text')
    assert.ok(parsed.text.content.includes('[death] Bot 死亡'), parsed.text.content)
  } finally {
    restore()
  }
})

test('U10: HTTP 非 2xx → 静默不抛（log.warn 留痕）', async () => {
  let warned = false
  const logger = { child: () => logger, warn: () => { warned = true }, info () {}, error () {}, debug () {} }
  const restore = stubFetch(async () => ({ ok: false, status: 500 }))
  try {
    const n = createNotifier({ notify: { webhook: 'https://sctapi.ftqq.com/x.send' } }, logger)
    await n.send('task', 'x') // 不得 throw
    assert.equal(warned, true, '失败应 log.warn')
  } finally {
    restore()
  }
})

test('U10: 网络错误/超时 → 静默不抛（失败绝不阻塞主流程）', async () => {
  const restore = stubFetch(async () => { throw new Error('ECONNREFUSED') })
  try {
    const n = createNotifier({ notify: { webhook: 'https://sctapi.ftqq.com/x.send' } }, makeLogger())
    await n.send('reconnect', '已重连') // 不得 throw
  } finally {
    restore()
  }
})
