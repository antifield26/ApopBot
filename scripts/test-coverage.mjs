// 覆盖率入口：mkdir coverage/（node --test 的 reporter destination 不自动建目录，
// CI 干净 checkout 无 coverage/ 会 ENOENT）+ 跑 lcov 覆盖率。
// 独立脚本而非 npm 内联（嵌套引号在 Windows cmd 下不可靠；node --test 自身支持
// glob pattern，无需 shell 展开）。
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

mkdirSync('coverage', { recursive: true })
const r = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-coverage',
  '--test-reporter=lcov',
  '--test-reporter-destination=coverage/lcov.info',
  'tests/*.test.mjs'
], { stdio: 'inherit' })
process.exit(r.status ?? 1)
