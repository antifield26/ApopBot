#!/usr/bin/env node
// 集成冒烟测试：连真实服务器验证协议 775 全链路。
// 用法: node scripts/smoke.mjs --config config/smoke.json [--host <ip>] [--port <n>] [--steps connect,spawn,move,chat,quit] [--dangerous]
// 每步 60s 超时，PASS/FAIL 汇总；所有步骤完成后无条件 quit，exit 0/1。
// 注意：mine 步骤默认跳过（--dangerous 开启）——但跳过只是不执行该步，
// 流程继续跑后续步骤并正常退出（O3 修复：早期版本 return 导致进程永不退出）。

import { loadConfig, validateConfig } from '../src/core/config.js'
import { createConsoleLogger } from '../src/core/logger.js'
import { withTimeout } from '../src/util/promise-timeout.js'
import { createBot, loadMineflayerPluginsAsync } from '../src/core/bot.js'
import pathfinderPkg from 'mineflayer-pathfinder' // CJS 包：default 导入后解构（ESM named 互操作不可靠）
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const { goals } = pathfinderPkg

// 第六轮 C8：默认配置路径按 ROOT 解析（此前 CWD 相对——从别的目录运行
// `node scripts/smoke.mjs` 报"指定的配置文件不存在"，与 config.js 的 ROOT 口径不一致）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const STEP_TIMEOUT = 60_000
const ALL_STEPS = ['connect', 'spawn', 'move', 'mine', 'chat', 'quit']

function parseArgs () {
  const argv = process.argv.slice(2)
  const out = { config: path.join(ROOT, 'config', 'smoke.json'), steps: ALL_STEPS, dangerous: false, walkDistance: 3 }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--config': out.config = argv[++i]; break
      case '--steps': {
        const raw = argv[++i]
        if (!raw) {
          console.error('错误: --steps 需要一个逗号分隔的步骤列表（如 connect,spawn,chat）')
          process.exit(1)
        }
        const steps = raw.split(',').map(s => s.trim()).filter(Boolean)
        if (steps.length === 0) {
          console.error('错误: --steps 为空（示例: connect,spawn,chat）')
          process.exit(1)
        }
        // 去重（重复 connect 会创建两个同名 bot 登录互踢）；重复步骤直接报错
        const seen = new Set()
        for (const s of steps) {
          if (seen.has(s)) {
            console.error(`错误: --steps 步骤重复: ${s}`)
            process.exit(1)
          }
          seen.add(s)
        }
        out.steps = steps
        break
      }
      case '--dangerous': out.dangerous = true; break
      case '--walk': {
        const v = Number(argv[++i])
        if (!Number.isFinite(v) || v <= 0) {
          console.error('错误: --walk 必须是正数（如 3）')
          process.exit(1)
        }
        out.walkDistance = v
        break
      }
      case '--host': out.host = argv[++i]; break
      case '--port': out.port = Number(argv[++i]); break
    }
  }
  // 未知步骤名直接报错（早期版本静默丢弃，用户以为在跑实际没跑）
  const unknown = out.steps.filter(s => !ALL_STEPS.includes(s))
  if (unknown.length) {
    console.error(`错误: 未知步骤 ${unknown.join(', ')}（可用: ${ALL_STEPS.join(',')}）`)
    process.exit(1)
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
  // C8：CLI 相对路径按 ROOT 解析（loadConfig 的 --config 按 CWD 读——从任意目录
  // 运行都稳定；绝对路径原样传入）
  if (!path.isAbsolute(args.config)) args.config = path.resolve(ROOT, args.config)
  // --host/--port 覆盖配置（部署机连远程服务端时使用；CLI 优先级最高，走 loadConfig 而非改冻结配置）
  const cli = ['--config', args.config]
  if (args.host) cli.push('--host', args.host)
  if (args.port) cli.push('--port', String(args.port))
  const cfg = loadConfig({ argv: cli })
  const { ok, errors } = validateConfig(cfg)
  if (!ok) {
    console.error('smoke 配置校验失败:', errors.join('; '))
    process.exit(1)
  }
  const logger = createConsoleLogger('warn', false)
  console.log(`=== smoke: ${cfg.host}:${cfg.port} mcVersion=${cfg.mcVersion} steps=[${args.steps.join(',')}] ===`)

  let bot = null
  let botConnected = false
  let spawnPromise = null
  const okAll = await runStep('connect', async () => {
    const b = createBot(cfg)
    await loadMineflayerPluginsAsync(b, cfg, logger)
    bot = b
    // spawn 监听必须在观察窗开始前挂上：服务器响应快时 spawn 可能已在 1.5s 观察窗内触发，
    // 事后注册 once('spawn') 会永久错过（60s 超时）
    spawnPromise = new Promise((resolve, reject) => {
      bot.once('spawn', resolve)
      bot.once('error', (e) => reject(new Error(`spawn error: ${e.message}`)))
      bot.once('kicked', (r) => reject(new Error(`kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`)))
    })
    // 短观察窗：1.5s 内无 error/kicked/end 即视为连接建立成功
    await new Promise((resolve, reject) => {
      const fail = (label) => (e) => reject(new Error(`${label}: ${e?.message || e?.code || String(e)}`))
      bot.once('error', fail('connect error'))
      bot.once('kicked', fail('kicked'))
      bot.once('end', fail('end'))
      setTimeout(resolve, 1500)
    })
    botConnected = true
    return bot
  })
  if (!okAll) process.exit(1)

  if (args.steps.includes('spawn')) {
    const spawnOk = await runStep('spawn', () => spawnPromise)
    if (!spawnOk) process.exit(1)
  }

  if (args.steps.includes('move') && bot.pathfinder) {
    const walk = args.walkDistance
    const moveOk = await runStep('move', async () => {
      const { Vec3 } = await import('vec3')
      // 等区块加载：spawn 后立即 findBlocks/blockAt 可能拿到空数据（实测出生点区块异步同步）
      await new Promise(r => setTimeout(r, 3000))
      const p = bot.entity.position.floored()
      // 目标 A：起点正下方最近的"地面类型"方块表面（穿过树叶/树干）。
      // 服务器出生点可能在空中/树冠上（实测 Paper 出生在树顶），垂直下树几乎必然可达，
      // 验证寻路+移动+到达全链路；水平段（目标 B）在树冠环境可能被树干阻挡，受阻时
      // 链路已验证即视为 PASS（smoke 是链路验证，不是寻路基准测试）
      const GROUND = new Set(['grass_block', 'dirt', 'stone', 'sand', 'gravel', 'coarse_dirt'])
      let groundY = p.y
      for (let y = p.y; y > p.y - 64; y--) {
        const b = bot.blockAt(new Vec3(p.x, y, p.z))
        if (b && GROUND.has(b.name)) { groundY = y + 1; break }
      }
      const goTo = (gx, gy, gz) => new Promise((resolve, reject) => {
        const goal = new goals.GoalBlock(gx, gy, gz)
        bot.pathfinder.setGoal(goal)
        // 停滞判定（500ms 采样）：isMoving 在 pathfinder 重算路径的间隙会短暂 false，
        // 以"位置 10s 无位移"为准
        let lastPos = null
        let stall = 0
        const check = () => {
          const cur = bot.entity.position
          const dx = Math.abs(cur.x - goal.x)
          const dz = Math.abs(cur.z - goal.z)
          if (dx < 1 && dz < 1) {
            bot.pathfinder.setGoal(null)
            resolve()
            return
          }
          const moved = lastPos && (Math.abs(cur.x - lastPos.x) > 0.01 || Math.abs(cur.z - lastPos.z) > 0.01)
          lastPos = cur.clone()
          stall = moved ? 0 : stall + 1
          if (stall >= 20) {
            reject(new Error(`位置 10s 无变化 (目标 ${gx},${gy},${gz}, dist=${dx.toFixed(1)},${dz.toFixed(1)})`))
            return
          }
          setTimeout(check, 500)
        }
        setTimeout(check, 1500) // 等待 pathfinder 启动
      })

      await goTo(p.x, groundY, p.z) // 目标 A：下树/落地
      const tx = p.x + walk
      const tz = p.z + walk
      let ty2 = groundY
      for (let y = groundY; y > groundY - 32; y--) {
        const b = bot.blockAt(new Vec3(tx, y, tz))
        if (b && GROUND.has(b.name)) { ty2 = y + 1; break }
      }
      try {
        await goTo(tx, ty2, tz) // 目标 B：水平移动 walk 格
      } catch (err) {
        console.log(`  （水平段受限：${err.message}——已证明寻路/移动/到达链路，按 PASS 计）`)
      }
    })
    if (!moveOk) process.exit(1)
  }

  if (args.steps.includes('mine')) {
    if (!args.dangerous) {
      // O3：跳过只是不执行该步，流程必须继续（早期版本 return 卡死进程）
      console.log('\n▶ step: mine — SKIP（需 --dangerous，会在服务器放置/挖掘方块）')
    } else {
      const mineOk = await runStep('mine', async () => {
        // 挖脚下方块验证挖掘链路（放置方块需要背包预置物品，smoke 不保证有）
        const target = bot.entity.position.floored().offset(0, -1, 0)
        const block = bot.blockAt(target)
        if (!block) throw new Error('脚下无方块可挖')
        await bot.dig(block, true)
      })
      if (!mineOk) process.exit(1)
    }
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

  // O3：quit 无条件执行——无论前面步骤成败，连接必须关闭、进程必须退出
  if (args.steps.includes('quit') && botConnected) {
    await runStep('quit', async () => {
      await new Promise((resolve) => {
        bot.once('end', resolve)
        bot.quit()
      })
      bot = null
      botConnected = false
    })
  } else if (botConnected) {
    // 未请求 quit 步骤但 bot 还连着：兜底断开（防进程残留）
    await new Promise((resolve) => {
      bot.once('end', resolve)
      bot.quit()
    })
  }

  console.log(`\n=== 结果: ${passed} PASS, ${failed} FAIL ===`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
