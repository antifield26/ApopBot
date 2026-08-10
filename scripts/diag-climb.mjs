// 1 格爬升诊断 v2（第 9 轮）：精确驱动到爬升点，每 tick 打印控制状态与
// pathfinder 状态——定位"1 格爬升卡住"的执行器/模拟层根因。
// 用法: node scripts/diag-climb.mjs <目标x> <y> <z>
import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { loadMineflayerPlugins } from '../src/plugins/index.js'
const { goals } = pathfinderPkg

const [tx, ty, tz] = process.argv.slice(2).map(Number)
if (!Number.isInteger(tx)) {
  console.error('用法: node scripts/diag-climb.mjs <目标x> <y> <z>')
  process.exit(1)
}

const bot = mineflayer.createBot({
  host: process.env.MCBOT_HOST ?? 'mc.antifield.work',
  port: 25565,
  username: 'mcbot-test',
  auth: 'offline',
  version: '26.1.2',
  hideErrors: true
})

let dumpCount = 0
bot.on('error', (e) => { console.log('ERROR:', e.message) })
bot.on('kicked', (r) => { console.log('KICKED:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('end', () => { console.log('END'); process.exit(1) })

bot.on('spawn', async () => {
  console.log('spawned @', bot.entity.position.toString(), 'version', bot.version)
  console.log('controlState keys:', Object.keys(bot.controlState ?? {}).join(','), '| 实例:', JSON.stringify(bot.controlState))
  const noop = () => {}
  await loadMineflayerPlugins(bot, { mineflayerPlugins: { pathfinder: true } }, { child: () => ({ info: noop, warn: noop, error: noop, debug: noop }), info: noop, warn: noop, error: noop, debug: noop })
  console.log('pathfinder loaded; movements =', bot.pathfinder?.movements ? 'set' : 'NOT SET')
  console.log('controlState after load keys:', Object.keys(bot.controlState ?? {}).join(','))

  // 每 200ms 采样
  const timer = setInterval(() => {
    const p = bot.entity.position
    const pf = bot.pathfinder
    const ctl = Object.keys(bot.controlState ?? {}).map(k => bot.controlState[k] ? k : '').filter(Boolean).join('+') || 'none'
    console.log(`t+${((Date.now() - t0) / 1000).toFixed(1)}s pos=${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} onGround=${bot.entity.onGround} ctl=[${ctl}] path=${pf?.path?.length ?? '?'} state=${pf?.state} lastNode=${pf?.path?.[0]?.toString() ?? '-'}`)
    // 地形剖面（前方 3 格）
    if (++dumpCount % 3 === 0) {
      for (let i = 1; i <= 3; i++) {
        const below = bot.blockAt(p.offset(0, -1, -i))
        const head = bot.blockAt(p.offset(0, 0, -i))
        console.log(`    f${i}: 地面=${below?.name}@${below?.position?.y ?? '?'} 身体位=${head?.name}@${head?.position?.y ?? '?'}`)
      }
    }
  }, 200)

  const t0 = Date.now()
  const goal = new goals.GoalBlock(tx, ty, tz)
  console.log(`setGoal -> ${tx},${ty},${tz}`)
  bot.pathfinder.setGoal(goal)
  // 600ms 后 dump 计算的路径
  setTimeout(() => {
    const pf = bot.pathfinder
    console.log('computed path:', (pf?.path ?? []).map(n => n.toString()).join(' -> ') || '(empty)')
  }, 800)
  setTimeout(() => {
    clearInterval(timer)
    console.log('=== 诊断结束（30s）===')
    process.exit(0)
  }, 30000)
})
