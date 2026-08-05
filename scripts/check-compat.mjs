#!/usr/bin/env node
// 兼容性门禁：校验本地 node_modules 的协议栈是否支持目标 MC 版本（默认 26.1.2 = 协议 775）。
// 用法: node scripts/check-compat.mjs [--mc-version 26.1.2] [--probe --host localhost --port 25565]
// 任一失败 exit 1 并输出修复指引。

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 期望的 pin（与 package.json 同步维护）
// mineflayer PR 分支将 chunk/physics 声明为 mneuhaus fork 的可变分支名（force-push 风险），
// 故 overrides 以官方 npm 版本覆盖：prismarine-chunk 1.41.0 / prismarine-physics 1.11.1
// 已于 2026-07-31 官方发布 26.1 支持（含 #329 的 fluid-count/fromLocalPalette 修复）。
// 语义正确性由下方内容检查（3.5）兜底。
const EXPECTED = {
  'minecraft-data': { kind: 'npm', version: '3.112.0' },
  'minecraft-protocol': { kind: 'git', sha: '3fb78a8da17cbce774a6cf8d78dfd889f1fbb8bf' },
  'mineflayer': { kind: 'git', sha: 'b30c85cb24d9fc7a009f61fe71a4fead516f8802' },
  'prismarine-chunk': { kind: 'npm', version: '1.41.0' },
  'prismarine-physics': { kind: 'npm', version: '1.11.1' }
}

// 当前项目版本（与 package.json 同步维护——版本单一来源）
const EXPECTED_VERSION = '0.2.0'

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
      'overrides.minecraft-protocol 应指向 PR #1487 分支 ' + EXPECTED['minecraft-protocol'].sha)
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
      const resolved = String(node.resolved ?? '')
      const sha = resolved.match(/#([0-9a-f]{40})$/)?.[1] ?? ''
      check(`${pkg} SHA 固定`, sha === spec.sha,
        `locked=${sha || '(非 git 引用)'}\n  expected=${spec.sha}`,
        `overrides.${pkg} 应指向官方 PR 分支（github:PrismarineJS/${pkg}#${spec.sha}）`)
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

  // 3.6 项目版本一致性（版本单一来源）
  const pkgPath = path.join(ROOT, 'package.json')
  const pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
  check('项目版本一致', pkgVersion === EXPECTED_VERSION,
    `package.json=${pkgVersion}, check-compat=${EXPECTED_VERSION}`,
    '版本号以 check-compat.mjs 的 EXPECTED_VERSION 为准同步 package.json')

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
