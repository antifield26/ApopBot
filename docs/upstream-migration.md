# 上游迁移（PR pin → npm 正式版）

## 背景

本项目为 PaperMC 26.1.2（协议 775）pin 了 PrismarineJS 未合并的 PR 分支：

| 包 | pin 方式 | 上游状态（2026-08-05 核实） |
|---|---|---|
| minecraft-data 3.112.0 | overrides 固定版本 | ✅ 已正式支持 775 |
| minecraft-protocol | overrides git SHA `3fb78a8d...` | ⏳ PR #1487 open |
| prismarine-chunk | overrides git SHA `af619d32...` | ⚠️ PR #326 **closed 未合并**（最大风险点） |
| prismarine-physics | overrides git SHA `11a96c10...` | ⏳ PR #134 open |
| mineflayer | 直接依赖 git SHA `b30c85cb...` | ⏳ PR #3902 open |

上游状态跟踪：https://github.com/PrismarineJS/mineflayer/issues/3893

## 定期检查

```bash
node scripts/migrate-upstream.mjs --check   # 建议 cron 每 2-4 周跑一次
```

上游合并后输出"上游已支持"，然后：

## 执行迁移

```bash
node scripts/migrate-upstream.mjs --dry-run   # 演练：输出将做的修改
node scripts/migrate-upstream.mjs             # 实际执行：
#   1. 改 package.json（mineflayer → ^正式版，删除 4 项协议 overrides）
#   2. npm install
#   3. npm run check:compat + npm test 自动验证
# 最后人工在树莓派上: node scripts/smoke.mjs --steps connect,spawn,move
```

迁移成功后建议清理 `.npmrc`（`legacy-peer-deps` / `allow-git` 如无其他 git 依赖可删）。

## 备选 pin（官方 PR 分支失效时）

若官方 PR 分支被关闭/重写，切到 mneuhaus fork 分支（PR 作者的 fork，内容相同）：

```bash
git ls-remote https://github.com/mneuhaus/prismarine-chunk.git refs/heads/pc26_1_2-fluid-count
git ls-remote https://github.com/mneuhaus/node-minecraft-protocol.git refs/heads/pc26_1_2-clean
git ls-remote https://github.com/mneuhaus/prismarine-physics.git refs/heads/add-26.1-physics-features
git ls-remote https://github.com/mneuhaus/mineflayer.git refs/heads/add-26.1.2-support   # 分支名以 ls-remote 实际输出为准
```

将输出 SHA 写入 package.json 对应引用。

## 降级开关（最坏情况）

若上游长期不合并且 PR 依赖恶化：服务端降级到 1.21.11（协议 774），配置 `mcVersion: "1.21.11"`，依赖全部回 npm 正式版（mineflayer ^4.37.1 即可），`check:compat` 的目标版本映射表中 1.21.11=774 已内置。
