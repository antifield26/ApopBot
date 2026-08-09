#!/usr/bin/env node
// 版本 bump 脚本（第六轮 C4，版本单一来源：package.json 为唯一权威）。
// 用法: node scripts/release.mjs [patch|minor|major]（默认 patch）
//
// 行为：读 package.json → 版本递增 → 写回 package.json + package-lock.json（根
// version 与 packages[""].version 两处同步）→ 打印 CHANGELOG 模板与 git 命令序列。
//
// git 操作（commit/tag/push）默认只打印不执行——版本发布是审阅性操作：CHANGELOG
// 文案必须人工写，自动 commit 会把未审阅内容入库；自动 tag 在错误状态下不可逆。
// 版本一致性由 check:compat 3.6 交叉校验 package.json ↔ lockfile 兜底。

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 版本递增（纯函数，供测试）。major/minor 递增时归零低位；patch 只进最低位。 */
export function computeNextVersion (cur, kind) {
  const parts = String(cur).split('.').map(n => {
    const v = Number(n)
    if (!Number.isInteger(v) || v < 0) throw new Error(`非法版本号: ${cur}（应为 x.y.z 数字段）`)
    return v
  })
  if (parts.length !== 3) throw new Error(`非法版本号: ${cur}（应为 x.y.z 三段）`)
  const [major, minor, patch] = parts
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`未知递增类型: ${kind}（patch|minor|major）`)
}

/**
 * 写回版本号到 package.json 与 package-lock.json（根 version + packages[""].version）。
 * @param {string} version 新版本
 * @param {{ pkgPath?: string, lockPath?: string }} [opts] 测试注入路径
 * @returns {Array<string>} 修改的文件路径
 */
export function bumpFiles (version, { pkgPath = path.join(ROOT, 'package.json'), lockPath = path.join(ROOT, 'package-lock.json') } = {}) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = version
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.version = version
  if (lock.packages?.['']) lock.packages[''].version = version
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
  return [pkgPath, lockPath]
}

async function main () {
  const kind = process.argv[2] ?? 'patch'
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const next = computeNextVersion(pkg.version, kind)

  // 工作树非干净时警告（不阻止——未提交改动不影响版本号一致性）
  //（git status 检查依赖外部 git；失败静默）
  try {
    const { execFileSync } = await import('node:child_process')
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
    if (dirty) console.warn(`⚠ 工作树有未提交改动（${dirty.split('\n').length} 项）——版本 commit 前请先确认改动归属\n`)
  } catch { /* git 不可用/非仓库——跳过检查 */ }

  const files = bumpFiles(next)
  console.log(`已更新版本: ${pkg.version} → ${next}`)
  console.log(`  修改: ${files.map(f => path.relative(ROOT, f)).join(', ')}`)

  const today = new Date().toISOString().slice(0, 10)
  console.log(`
下一步（人工审阅后执行）：

1. 编辑 CHANGELOG.md，把 [Unreleased] 的条目收敛为正式条目：
   ## [v${next}] - ${today}
   （把 Unreleased 下已完成的条目移入；未完成条目保留在 Unreleased）

2. 提交并打 tag：
   git add CHANGELOG.md package.json package-lock.json
   git commit -m "release: v${next}"
   git tag v${next}
   git push origin main --tags
`)
}

// 主入口判定（ESM：仅当直接以脚本方式运行时执行 main——测试 import 纯函数不受影响）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(`release 失败: ${err.message}`)
    process.exit(1)
  })
}
