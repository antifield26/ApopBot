// migrate-upstream 的纯逻辑（独立模块便于单测；migrate-upstream.mjs 为 CLI 入口）。
// 无顶层副作用，可安全 import。
//
// ⚠️ v1.0.0（C1）改造标注：依赖已全部为官方 npm 版，26.1.2 适配由 patches/ 补丁承担——
// 本模块的 git-pin→npm 迁移逻辑已过时。上游 PR #3902/#1487 合并后的正确迁移 =
// ① 删 patches/mineflayer+4.37.1.patch、patches/minecraft-protocol+1.66.2.patch
// ② package.json 删 postinstall patch-package、devDeps 删 patch-package
// ③ check-compat.mjs 删 PATCH_SENTINELS 与 3.7 门禁、恢复版本号检查
// （待上游合并时改造，届时 check:compat 会先报补丁冲突提示）

import { readFileSync, writeFileSync } from 'node:fs'

// 仍为 git pin 的包（chunk/physics 已随 1.41.0/1.11.1 正式发布 26.1 支持，2026-07-31 起无需 pin）
export const KNOWN_PINS = {
  mineflayer: 'b30c85cb24d9fc7a009f61fe71a4fead516f8802',
  'minecraft-protocol': '3fb78a8da17cbce774a6cf8d78dfd889f1fbb8bf'
}

// 各包的版本支持声明文件（均需已支持 26.1.2 才允许迁移）
export const VERSION_FILE = {
  mineflayer: 'lib/version.js',
  'minecraft-protocol': 'src/version.js'
}

export function applyChanges (pkg, newMineflayerVersion) {
  const next = structuredClone(pkg)
  next.dependencies.mineflayer = `^${newMineflayerVersion}`
  // 删除 overrides 中的 git 引用（minecraft-data 保留精确 pin：3.113.0 已含 775 且与 26.1.2 数据绑定）
  for (const key of Object.keys(KNOWN_PINS)) {
    delete next.overrides?.[key]
  }
  if (next.overrides && Object.keys(next.overrides).length === 0) delete next.overrides
  return next
}

// 迁移成功后同步 check-compat.mjs 的 EXPECTED：git pin → npm 版本（否则 check:compat 恒 FAIL）
export function updateCheckCompat (compatPath, newMfVersion, newMpVersion) {
  let src = readFileSync(compatPath, 'utf8')
  const before = src
  src = src.replace(
    /'minecraft-protocol': \{ kind: 'git', sha: '[0-9a-f]{40}' \}/,
    `'minecraft-protocol': { kind: 'npm', version: '${newMpVersion}' }`)
  src = src.replace(
    /'mineflayer': \{ kind: 'git', sha: '[0-9a-f]{40}' \}/,
    `'mineflayer': { kind: 'npm', version: '${newMfVersion}' }`)
  if (src === before) throw new Error('check-compat.mjs 的 EXPECTED 未匹配到 git pin 条目（格式已变化？）')
  writeFileSync(compatPath, src)
}
