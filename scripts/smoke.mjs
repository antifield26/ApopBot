#!/usr/bin/env node
// 集成冒烟测试：连真实服务器验证协议 775 全链路。
// 用法: node scripts/smoke.mjs --config config/smoke.json [--steps connect,spawn,move,chat,quit] [--dangerous]
// 每步 60s 超时，PASS/FAIL 汇总，任一失败 exit 1。

import { loadConfig, validateConfig } from '../src/core/config.js'
import { createConsoleLogger } from '../src/core/logger.js'
import { withTimeout } from '../src/util/promise-timeout.js'
import { createBotWithPlugins } from '../src/core/bot.js'

const STEP_TIMEOUT = 60_000
const ALL_STEPS = ['connect', 'spawn', 'move', 'mine', 'chat', 'quit']

function parseArgs () {
  const argv = process.argv.slice(2)
  const out = { config: 'config/smoke.json', steps: ALL_STEPS, dangerous: false, walkDistance: 3 }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--config': out.config = argv[++i]; break
      case '--steps': out.steps = argv[++i].split(','); break
      case '--dangerous': out.dangerous = true; break
      case '--walk': out.walkDistance = Number(argv[++i]); break
    }
  }
  return out
}

let passed = 0
let failed = 0

async function runStep (name, fn) {
  process.stdout.write(`\n▶ step: ${name} ... `)
  try {
    await withTimeout(fn(), STEP_TIMEOUT, `step ${name} 超时（${STEP_TIMEOUT}s）`)
    passed++
    console.log('PASS')
    return true
  } catch (err) {
    failed++
    console.log(`FAIL — ${err.message}`)
    return false
  }
}

async function main () {
  const args = parseArgs()
  const cfg = loadConfig({ argv: ['--config', args.config] })
  const { ok, errors } = validateConfig(cfg)
  if (!ok) {
    console.error('smoke 配置校验失败:', errors.join('; '))
    process.exit(1)
  }
  const logger = createConsoleLogger('warn', false)
  console.log(`=== smoke: ${cfg.host}:${cfg.port} mcVersion=${cfg.mcVersion} steps=[${args.steps.join(',')}] ===`)

  let bot = null
  const okAll = await runStep('connect', async () => {
    const { bot: b } = await createBotWithPlugins(cfg, logger)
    bot = b
    // 短观察窗：1.5s 内无 error/kicked/end 即视为连接建立成功
    await new Promise((resolve, reject) => {
      const fail = (label) => (e) => reject(new Error(`${label}: ${e?.message || e?.code || String(e)}`))
      bot.once('error', fail('connect error'))
      bot.once('kicked', fail('kicked'))
      bot.once('end', fail('end'))
      setTimeout(resolve, 1500)
    })
    return bot
  })
  if (!okAll) process.exit(1)

  if (args.steps.includes('spawn')) {
    const spawnOk = await runStep('spawn', () => new Promise((resolve, reject) => {
      bot.once('spawn', resolve)
      bot.once('error', (e) => reject(new Error(`spawn error: ${e.message}`)))
      bot.once('kicked', (r) => reject(new Error(`kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`)))
    }))
    if (!spawnOk) process.exit(1)
  }

  if (args.steps.includes('move') && bot.pathfinder) {
    const walk = args.walkDistance
    const moveOk = await runStep('move', async () => {
      const { goals } = bot.pathfinder
      const p = bot.entity.position
      const goal = new goals.GoalBlock(p.x + walk, p.y, p.z + walk)
      bot.pathfinder.setGoal(goal)
      await new Promise((resolve, reject) => {
        const check = () => {
          const cur = bot.entity.position
          const dx = Math.abs(cur.x - goal.x)
          const dz = Math.abs(cur.z - goal.z)
          if (dx < 1 && dz < 1) {
            bot.pathfinder.setGoal(null)
            resolve()
          } else if (bot.pathfinder.isMoving() === false) {
            reject(new Error(`pathfinder 停止移动，未能到达目标 (dist=${dx.toFixed(1)},${dz.toFixed(1)})`))
          } else {
            setTimeout(check, 500)
          }
        }
        setTimeout(check, 1500) // 等待 pathfinder 启动
      })
    })
    if (!moveOk) process.exit(1)
  }

  if (args.steps.includes('mine')) {
    if (!args.dangerous) {
      console.log('\n▶ step: mine — 跳过（需 --dangerous，会在服务器放置/挖掘方块）')
      return
    }
    const mineOk = await runStep('mine', async () => {
      // 挖脚下方块验证挖掘链路（放置方块需要背包预置物品，smoke 不保证有）
      const target = bot.entity.position.floored().offset(0, -1, 0)
      const block = bot.blockAt(target)
      if (!block) throw new Error('脚下无方块可挖')
      await bot.dig(block, true)
    })
    if (!mineOk) process.exit(1)
  }

  if (args.steps.includes('chat')) {
    const chatOk = await runStep('chat', () => new Promise((resolve, reject) => {
      const onMessage = (json) => {
        const text = typeof json === 'string' ? json : json?.text ?? JSON.stringify(json)
        if (text.includes('[smoke] ok')) {
          bot.removeListener('message', onMessage)
          resolve()
        }
      }
      bot.on('message', onMessage)
      bot.chat('[smoke] ok')
      setTimeout(() => reject(new Error('未收到自己的聊天回显')), STEP_TIMEOUT)
    }))
    if (!chatOk) process.exit(1)
  }

  if (args.steps.includes('quit')) {
    await runStep('quit', async () => {
      await new Promise((resolve) => {
        bot.once('end', resolve)
        bot.quit()
      })
      bot = null
    })
  }

  console.log(`\n=== 结果: ${passed} PASS, ${failed} FAIL ===`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
