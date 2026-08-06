#!/usr/bin/env node
// 上游迁移脚本：PrismarineJS 合并 26.1 支持（协议 775）后，一键从 PR pin 回切 npm 正式版。
// 用法: node scripts/migrate-upstream.mjs [--check] [--dry-run]
//  --check     只检查上游是否已支持 775，不修改任何文件（可配合 cron 定期跑）
//  --dry-run   演练：输出将做的修改，不落盘
// 流程: 检查 mineflayer@latest → 已支持 → 改 package.json（回正式版、删 overrides）→ npm install
//       → check:compat → smoke 全绿才算迁移成功

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG_PATH = path.join(ROOT, 'package.json')
const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const DRY_RUN = args.includes('--dry-run')

const TARGET_VERSION = '26.1.2'
// 仍为 git pin 的包（chunk/physics 已随 1.41.0/1.11.1 正式发布 26.1 支持，2026-07-31 起无需 pin）
const KNOWN_PINS = {
  mineflayer: 'b30c85cb24d9fc7a009f61fe71a4fead516f8802',
  'minecraft-protocol': '3fb78a8da17cbce774a6cf8d78dfd889f1fbb8bf'
}

// 检查 npm 上最新版 mineflayer 的 version.js 是否已含 26.1.2
async function checkUpstream () {
  const res = await fetch(`https://unpkg.com/mineflayer@latest/lib/version.js`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`unpkg 返回 ${res.status}`)
  const src = await res.text()
  return { supported: src.includes(TARGET_VERSION), url: res.url }
}

function applyChanges (pkg, newMineflayerVersion) {
  const next = structuredClone(pkg)
  next.dependencies.mineflayer = `^${newMineflayerVersion}`
  // 删除 overrides 中的 git 引用（minecraft-data 保留精确 pin：3.112.0 已含 775 且与 26.1.2 数据绑定）
  for (const key of Object.keys(KNOWN_PINS)) {
    delete next.overrides?.[key]
  }
  if (next.overrides && Object.keys(next.overrides).length === 0) delete next.overrides
  return next
}

async function main () {
  console.log(`=== 检查上游 26.1.2 (协议 775) 支持 ===`)
  let result
  try {
    result = await checkUpstream()
  } catch (err) {
    console.error(`检查失败（网络？）: ${err.message}`)
    process.exit(1)
  }

  if (!result.supported) {
    console.log('上游尚未支持 26.1.2 —— 保持当前 PR pin（无需操作）')
    process.exit(0)
  }
  console.log(`上游已支持! (来源: ${result.url})`)

  if (CHECK_ONLY) {
    console.log('可以执行 node scripts/migrate-upstream.mjs 完成迁移')
    process.exit(0)
  }

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
  const newVersion = (await (await fetch('https://registry.npmjs.org/mineflayer/latest', { signal: AbortSignal.timeout(15000) })).json()).version
  const next = applyChanges(pkg, newVersion)

  const changes = []
  if (next.dependencies.mineflayer !== pkg.dependencies.mineflayer) changes.push(`mineflayer: ${pkg.dependencies.mineflayer} → ^${newVersion}`)
  for (const [k, v] of Object.entries(pkg.overrides ?? {})) {
    if (!next.overrides?.[k]) changes.push(`overrides.${k}: 移除（${v}）`)
  }
  console.log('\n=== 计划修改 ===')
  for (const c of changes) console.log(`  - ${c}`)
  if (changes.length === 0) {
    console.log('无修改（可能已迁移过）')
    process.exit(0)
  }

  if (DRY_RUN) {
    console.log('\n（--dry-run：不落盘。人工 review 后运行不带 --dry-run）')
    process.exit(0)
  }

  writeFileSync(PKG_PATH, JSON.stringify(next, null, 2) + '\n')
  console.log('\npackage.json 已更新，执行 npm install ...')
  execSync('npm install', { cwd: ROOT, stdio: 'inherit' })

  console.log('\n=== 验证 ===')
  exec('npm run check:compat', 'check:compat 失败——迁移不完整')
  exec('npm test', '单元测试失败')
  console.log('\n迁移完成。最后在部署机上验证（需服务端在线）: node scripts/smoke.mjs --steps connect,spawn,move')
  console.log('注意: .npmrc 的 legacy-peer-deps / allow-git 可保留（无害），或手动清理')
}

function exec (cmd, failMsg) {
  try {
    console.log(`$ ${cmd}`)
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
  } catch {
    console.error(`✗ ${failMsg}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
