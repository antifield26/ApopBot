// 插件装载器测试（零覆盖模块补齐）：条件装载、装载顺序、句柄记录。
// 用 deps.imports 注入 fake 插件（真实动态 import 由 connection.test 的注入路径覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadMineflayerPlugins } from '../src/plugins/index.js'

function makeLogger () {
  return { child: () => makeLogger(), info () {}, warn () {}, error () {}, debug () {} }
}

/** fake bot：loadPlugin 同步执行回调（注入 fake 插件安全）。 */
function makeBot () {
  const bot = {
    injected: [],
    pathfinder: { setMovements () {} },
    loadPlugin: (fn) => { bot.injected.push(fn) }
  }
  return bot
}

/** fake 插件模块表（与生产 import 路径对齐）。注入时设置句柄（真实插件注入后 bot[name] 才存在）。 */
function makeFakes () {
  const mk = (name) => (b) => { b.injected.push(name); b[name] = b[name] ?? {} }
  return {
    pathfinder: async () => ({ pathfinder: mk('pathfinder'), Movements: class {} }),
    collectblock: async () => ({ plugin: mk('collectBlock') }),
    autoeat: async () => ({ loader: mk('autoEat') }),
    armor: async () => ({ default: mk('armorManager') }),
    follow: async () => ({ followPlugin: mk('follow') })
  }
}

/** 执行回调触发注入。 */
function runInjections (bot) {
  for (const fn of bot.injected.splice(0)) fn(bot, {})
}

test('默认配置：pathfinder→collectBlock→autoEat→armorManager 顺序装载，follow 不装', async () => {
  const bot = makeBot()
  const loaded = await loadMineflayerPlugins(bot, { mineflayerPlugins: {} }, makeLogger(), { imports: makeFakes() })
  runInjections(bot)
  assert.deepEqual(bot.injected, ['pathfinder', 'collectBlock', 'autoEat', 'armorManager'], '应按注册顺序注入')
  assert.deepEqual(Object.keys(loaded).sort(), ['armorManager', 'autoEat', 'collectBlock', 'pathfinder'])
  assert.ok(!loaded.follow, 'follow 未配置 true 不应装载')
})

test('follow: true 时装载（含顺序在 armorManager 之后）', async () => {
  const bot = makeBot()
  await loadMineflayerPlugins(bot, { mineflayerPlugins: { follow: true } }, makeLogger(), { imports: makeFakes() })
  runInjections(bot)
  assert.ok(bot.pathfinder, 'getHandle 应记录 pathfinder 句柄')
})

test('条件关闭：pathfinder/collectBlock/autoEat: false 不装载（B6 后 collectBlock 依赖校验）', async () => {
  const bot = makeBot()
  const loaded = await loadMineflayerPlugins(
    bot,
    { mineflayerPlugins: { pathfinder: false, collectBlock: false, autoEat: false } },
    makeLogger(),
    { imports: makeFakes() }
  )
  runInjections(bot)
  assert.ok(!loaded.pathfinder)
  assert.ok(!loaded.collectBlock)
  assert.ok(!loaded.autoEat)
  assert.ok(loaded.armorManager, '未关闭的插件应正常装载')
})

test('pathfinder 注入时立即 setMovements（2.x 必需）', async () => {
  let setMovementsCalls = 0
  const bot = {
    injected: [],
    pathfinder: { setMovements: () => { setMovementsCalls++ } },
    loadPlugin: (fn) => { bot.injected.push(fn) }
  }
  await loadMineflayerPlugins(bot, { mineflayerPlugins: {} }, makeLogger(), { imports: makeFakes() })
  runInjections(bot)
  assert.equal(setMovementsCalls, 1, 'pathfinder 注入时应立即 setMovements')
})

test('B6: collectBlock 依赖 pathfinder——关闭 pathfinder 保留 collectBlock 报错', async () => {
  const bot = makeBot()
  await assert.rejects(
    loadMineflayerPlugins(bot, { mineflayerPlugins: { pathfinder: false, collectBlock: true } }, makeLogger(), { imports: makeFakes() }),
    /依赖 pathfinder/
  )
})

test('B6: 同时关闭 pathfinder 与 collectBlock 合法（无依赖问题）', async () => {
  const bot = makeBot()
  const loaded = await loadMineflayerPlugins(
    bot,
    { mineflayerPlugins: { pathfinder: false, collectBlock: false } },
    makeLogger(),
    { imports: makeFakes() }
  )
  runInjections(bot)
  assert.ok(!loaded.pathfinder && !loaded.collectBlock)
  assert.ok(loaded.autoEat, '其余插件不受影响')
})
