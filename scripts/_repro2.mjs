import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { loadMineflayerPlugins } from '../src/plugins/index.js'
import { Vec3 } from 'vec3'
const { goals } = pathfinderPkg
const bot = mineflayer.createBot({ host: 'mc.antifield.work', port: 25565, username: 'mcbot-test', auth: 'offline', version: '26.1.2', hideErrors: true })
const noop = () => {}
bot.on('error', (e) => { console.log('ERROR:', e.message) })
bot.on('kicked', (r) => { console.log('KICKED:', typeof r === 'string' ? r : JSON.stringify(r)); process.exit(1) })
bot.on('spawn', async () => {
  await loadMineflayerPlugins(bot, { mineflayerPlugins: { pathfinder: true } }, { child: () => ({ info: noop, warn: noop, error: noop, debug: noop }), info: noop, warn: noop, error: noop, debug: noop })
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    if (bot.blockAt(new Vec3(426, 67, 173), false)) break
    await new Promise(r => setTimeout(r, 500))
  }
  console.log('start @', bot.entity.position.toString())
  // 每 500ms：位置不动 + onGround=false 持续 2s → dump 物理细节
  let lastPos = null, badSince = null
  const timer = setInterval(() => {
    const p = bot.entity.position
    const e = bot.entity
    const moved = lastPos && p.distanceTo(lastPos)
    lastPos = p.clone()
    if ((!moved || moved < 0.05) && !e.onGround) {
      if (!badSince) badSince = Date.now()
      else if (Date.now() - badSince > 1500) {
        const foot = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)), false)
        const at = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), false)
        console.log(`STUCK-DETAIL: pos=${p.toString()} vel=${e.velocity.toString()} onGround=${e.onGround} isCollidedV=${e.isCollidedVertically} isCollidedH=${e.isCollidedHorizontally}`)
        console.log(`  脚下块: ${foot?.name ?? 'null'} shapes=${JSON.stringify(foot?.shapes ?? null)} boundingBox=${foot?.boundingBox ?? '?'}`)
        console.log(`  身体块: ${at?.name ?? 'null'} shapes=${JSON.stringify(at?.shapes ?? null)}`)
        console.log(`  前方2格(x-): ${bot.blockAt(p.offset(-1, 0, 0))?.name ?? 'null'} / ${bot.blockAt(p.offset(-1, -1, 0))?.name ?? 'null'}`)
        badSince = null
      }
    } else badSince = null
  }, 500)
  const g = new goals.GoalBlock(430, 67, 173)
  console.log('goto 430,67,173')
  const t1 = Date.now()
  try {
    await bot.pathfinder.goto(g)
    console.log(`到达（${Date.now() - t1}ms）@ ${bot.entity.position.toString()}`)
  } catch (e) {
    console.log(`失败: ${e.name ?? e.message}（${Date.now() - t1}ms）@ ${bot.entity.position.toString()}`)
  }
  clearInterval(timer)
  process.exit(0)
})
