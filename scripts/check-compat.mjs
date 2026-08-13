#!/usr/bin/env node
// 兼容性门禁：校验本地 node_modules 的协议栈是否支持目标 MC 版本（默认 26.1.2 = 协议 775）。
// 用法: node scripts/check-compat.mjs [--mc-version 26.1.2] [--probe --host localhost --port 25565]
// 任一失败 exit 1 并输出修复指引。

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 期望的 pin（与 package.json 同步维护）
// v1.0.0（C1）：全部依赖为官方 npm 版——26.1.2 协议 775 适配由 patches/ 的
// patch-package 补丁承担（mineflayer PR#3902 / protocol PR#1487 上游未合并，官方
// npm 最新版最高支持 1.21.11）。补丁应用性由 3.7 哨兵检查兜底。
// minecraft-data 官方 3.113.0 已含 26.1.2 数据（零补丁）；prismarine-chunk 1.41.0 /
// prismarine-physics 1.11.1 官方版已含 26.1 支持（语义正确性由 3.5 内容检查兜底）。
const EXPECTED = {
  'minecraft-data': { kind: 'npm', version: '3.113.0' },
  'minecraft-protocol': { kind: 'npm', version: '1.66.2' },
  'mineflayer': { kind: 'npm', version: '4.37.1' },
  'mineflayer-pathfinder': { kind: 'npm', version: '2.4.5' },
  'prismarine-chunk': { kind: 'npm', version: '1.41.0' },
  'prismarine-physics': { kind: 'npm', version: '1.11.1' },
  // 26.1 raycast 同步化补丁（第 12 轮根因修复）——版本 pin + 哨兵见 PATCH_SENTINELS
  'prismarine-world': { kind: 'npm', version: '3.7.0' }
}

// 补丁哨兵（3.7）：node_modules 内必须存在补丁引入的标记行——它只出现在
// patches/ 对应的补丁里，存在即证明 postinstall 的 patch-package 已应用
const PATCH_SENTINELS = {
  // 多哨兵（嵌套数组）：version.js 验证 26.1.2 版本 pin；entities.js 验证
  // use_entity 去门控（第 13 轮独立审查）——useEntityUsesEntityId 特性不存在，
  // 旧门控是死代码，attackUsesOwnPacket 分支写独立 attack 包（哨兵字符串仅
  // 存在于补丁后文件；回退旧门控 → 行消失 → check:compat FAIL）
  'mineflayer+4.37.1.patch': [
    ['node_modules/mineflayer/lib/version.js', "'26.1.2'"],
    ['node_modules/mineflayer/lib/plugins/entities.js', "write('attack', { entityId: target.id })"]
  ],
  'minecraft-protocol+1.66.2.patch': ['node_modules/minecraft-protocol/src/version.js', "'26.1.2'"],
  // 半嵌挤回 + float32 余量（第 9 轮爬升根治）：computeOffsetX/Z 对"位置与方块
  // 重叠的水平前进"挤回块外脱嵌；贴墙停在"块面 ± F32_EPS"（float32 上报不重叠，
  // 消除 Paper 拉回循环与半嵌死锁）
  'prismarine-physics+1.11.1.patch': ['node_modules/prismarine-physics/lib/aabb.js', 'F32_EPS'],
  // 执行器起跳中停 forward 修复（第 9 轮）：补丁第 4 个（第 11 轮补哨兵——
  // 此前 EXPECTED/PATCH_SENTINELS 只覆盖 3/4，pathfinder 版本漂移且补丁恰好
  // 仍能 apply 时 check:compat 全绿但爬升根治语义可能已变）
  'mineflayer-pathfinder+2.4.5.patch': ['node_modules/mineflayer-pathfinder/index.js', '爬升修复（第 9 轮）'],
  // raycast 同步化（第 12 轮 A* 永不收敛超时根因修复）：async getBlock 让同步调用者
  //（pathfinder GoalLookAtBlock.isEnd / mineflayer blockAtCursor）拿到 Promise 恒 false
  'prismarine-world+3.7.0.patch': ['node_modules/prismarine-world/src/world.js', '同步版（26.1 回归修复）']
}

// 目标协议版本（与 mcVersion 对应；上游更新时在 docs/upstream-migration.md 说明）
const PROTOCOL_BY_VERSION = { '26.1.2': 775, '26.1.1': 775, '26.1': 775, '1.21.11': 774 }

function parseArgs () {
  const argv = process.argv.slice(2)
  const out = { mcVersion: '26.1.2', probe: false, host: 'localhost', port: 25565 }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--mc-version': out.mcVersion = argv[++i]; break
      case '--probe': out.probe = true; break
      case '--host': out.host = argv[++i]; break
      case '--port': out.port = Number(argv[++i]); break
    }
  }
  return out
}

let failures = 0
const results = []

function check (name, ok, detail, fix) {
  results.push({ name, ok, detail, fix })
  if (!ok) failures++
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}: ${detail}`)
  if (!ok && fix) console.log(`      修复: ${fix}`)
}

function findProtocolVersionsFile () {
  for (const p of [
    'node_modules/minecraft-data/minecraft-data/data/pc/common/protocolVersions.json',
    'node_modules/minecraft-data/data/pc/common/protocolVersions.json'
  ]) {
    const full = path.join(ROOT, p)
    if (existsSync(full)) return full
  }
  return null
}

async function main () {
  const args = parseArgs()
  const expectedProtocol = PROTOCOL_BY_VERSION[args.mcVersion]
  if (!expectedProtocol) {
    console.error(`未知 mcVersion: ${args.mcVersion}（已知: ${Object.keys(PROTOCOL_BY_VERSION).join(', ')}）`)
    process.exit(1)
  }
  console.log(`=== minecraft-bot 兼容性检查 (target: ${args.mcVersion} / protocol ${expectedProtocol}) ===`)

  // 1. minecraft-data 版本与协议表
  const dataPkgPath = path.join(ROOT, 'node_modules', 'minecraft-data', 'package.json')
  if (!existsSync(dataPkgPath)) {
    check('minecraft-data 已安装', false, 'node_modules/minecraft-data 不存在', '先运行 npm ci')
  } else {
    const dataPkg = JSON.parse(readFileSync(dataPkgPath, 'utf8'))
    check('minecraft-data 版本', dataPkg.version === EXPECTED['minecraft-data'].version,
      `installed=${dataPkg.version}, expected=${EXPECTED['minecraft-data'].version}`,
      'package.json overrides.minecraft-data 应固定为 ' + EXPECTED['minecraft-data'].version)

    const pvFile = findProtocolVersionsFile()
    if (!pvFile) {
      check('minecraft-data 协议表', false, '找不到 protocolVersions.json', '检查 minecraft-data 包内容')
    } else {
      const pv = JSON.parse(readFileSync(pvFile, 'utf8'))
      const entry = pv.find(e => e.minecraftVersion === args.mcVersion)
      const proto = entry?.version ?? entry?.protocol // protocolVersions.json 字段名为 version
      check(`minecraft-data 支持 ${args.mcVersion}`, Boolean(entry),
        entry ? `minecraftVersion=${entry.minecraftVersion} → protocol ${proto}` : '协议表中无此版本',
        '升级 minecraft-data（overrides 中的版本号）')
      if (entry) {
        check(`协议号 ${expectedProtocol}`, proto === expectedProtocol,
          `实际 protocol=${proto}`, '版本与协议号不匹配，检查 overrides 与 mcVersion')
      }
    }
  }

  // 2. minecraft-protocol version.js 支持列表
  const mpFile = path.join(ROOT, 'node_modules', 'minecraft-protocol', 'src', 'version.js')
  if (!existsSync(mpFile)) {
    check('minecraft-protocol 已安装', false, 'node_modules/minecraft-protocol 不存在', '先运行 npm ci')
  } else {
    const src = readFileSync(mpFile, 'utf8')
    const m = src.match(/supportedVersions\s*[:=]\s*\[([\s\S]*?)\]/)
    const versions = m ? m[1].match(/'([^']+)'/g).map(s => s.replaceAll("'", '')) : []
    check(`minecraft-protocol 支持 ${args.mcVersion}`, versions.includes(args.mcVersion),
      `installed versions: ${versions.join(', ') || '(解析失败)'}`,
      '运行 npm install（postinstall 的 patch-package 会应用 26.1.2 补丁，见 patches/minecraft-protocol+1.66.2.patch）')
  }

  // 3. 各包 resolved SHA（读 package-lock.json，比 npm ls 更稳、跨平台）
  const lockPath = path.join(ROOT, 'package-lock.json')
  if (!existsSync(lockPath)) {
    check('package-lock.json', false, '不存在（请先 npm install 生成）', '运行 npm install')
  } else {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    for (const [pkg, spec] of Object.entries(EXPECTED)) {
      const node = lock.packages?.[`node_modules/${pkg}`]
      if (!node) {
        check(`${pkg} 已锁定`, false, 'lockfile 中未找到', '重新 npm install')
        continue
      }
      if (spec.kind === 'npm') {
        check(`${pkg} 版本`, node.version === spec.version, `locked=${node.version}, expected=${spec.version}`, '检查 overrides')
        continue
      }
    }
  }

  // 3.5 正式版 26.1 支持内容检查（chunk/physics 已随 npm 发布，无需 override）
  const chunkIdx = path.join(ROOT, 'node_modules', 'prismarine-chunk', 'src', 'index.js')
  if (!existsSync(chunkIdx)) {
    check('prismarine-chunk 已安装', false, 'node_modules/prismarine-chunk 不存在', '先运行 npm ci')
  } else {
    const src = readFileSync(chunkIdx, 'utf8')
    check('prismarine-chunk 支持 26.1', /26\.1\s*:\s*require\('\.\/pc\/1\.18\/chunk'\)/.test(src),
      'src/index.js 含 26.1 chunk 实现',
      '需 prismarine-chunk ≥ 1.41.0（官方已发布 26.1 支持，npm install 即可）')
  }
  const physicsFeatures = path.join(ROOT, 'node_modules', 'prismarine-physics', 'lib', 'features.json')
  if (!existsSync(physicsFeatures)) {
    check('prismarine-physics 已安装', false, 'node_modules/prismarine-physics 不存在', '先运行 npm ci')
  } else {
    const src = readFileSync(physicsFeatures, 'utf8')
    check('prismarine-physics 支持 26.1', /"26\.1"/.test(src),
      'features.json 含 26.1 特性标记',
      '需 prismarine-physics ≥ 1.11.0（官方已发布 26.1 特性标记，npm install 即可）')
  }

  // 3.6 项目版本一致性（第六轮 C4：版本单一来源 = package.json，lockfile 交叉校验——
  // 此前 check-compat 持有 EXPECTED_VERSION 双处维护。package-lock.json 根 version 与
  // packages[""].version 两处漏改会被这里拦截，指引用 release.mjs）
  const pkgPath = path.join(ROOT, 'package.json')
  const pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
  const lockRoot = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const lockVersion = lockRoot.version
  const lockPkgVersion = lockRoot.packages?.['']?.version ?? null
  check('项目版本一致（package.json ↔ lockfile）', pkgVersion === lockVersion && pkgVersion === lockPkgVersion,
    `package.json=${pkgVersion}, lock=${lockVersion}, lock.packages[""]=${lockPkgVersion ?? '(缺失)'}`,
    '运行 node scripts/release.mjs patch|minor|major 同步版本（版本单一来源 = package.json）')

  // 3.7 patch-package 补丁应用性（v1.0.0 C1：26.1.2 适配的唯一载体——补丁缺失/未
  // 应用时其余检查全过但协议栈不支持 26.1.2，此门禁是本方案的成败关键）
  for (const [patchName, spec] of Object.entries(PATCH_SENTINELS)) {
    const patchPath = path.join(ROOT, 'patches', patchName)
    check(`补丁 ${patchName} 存在`, existsSync(patchPath), patchPath, '从仓库重新拉取（git checkout patches/）')
    // 多哨兵支持：值可以是单组 [file, sentinel] 或嵌套数组（一组一个哨兵行）
    const specs = Array.isArray(spec[0]) ? spec : [spec]
    for (const [targetFile, sentinel] of specs) {
      const filePath = path.join(ROOT, targetFile)
      if (existsSync(filePath)) {
        const src = readFileSync(filePath, 'utf8')
        check(`补丁 ${patchName} 已应用（哨兵 ${sentinel}）`, src.includes(sentinel),
          `${targetFile} 含哨兵行`,
          '运行 npm install（postinstall 自动应用）或手动 npx patch-package')
      }
    }
  }

  // 4. --probe: ping 真实服务器
  if (args.probe) {
    try {
      const require = createRequire(import.meta.url)
      const mcp = require('minecraft-protocol')
      const res = await new Promise((resolve, reject) => {
        mcp.ping({ host: args.host, port: args.port, version: args.mcVersion, timeout: 5000 }, (err, data) =>
          err ? reject(err) : resolve(data))
      })
      check('服务器协议探测', Number(res.version.protocol) === expectedProtocol,
        `${args.host}:${args.port} → ${res.version.name} (protocol ${res.version.protocol})`,
        `服务器协议 ${res.version.protocol} ≠ 期望 ${expectedProtocol}，检查服务端版本`)
    } catch (err) {
      check('服务器协议探测', false, err.message, '服务器未启动或端口不通（--probe 需服务端在线）')
    }
  }

  console.log(failures === 0 ? '\n=== 全部通过 ===' : `\n=== ${failures} 项失败 ===`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
