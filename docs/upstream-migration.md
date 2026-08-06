# 上游迁移（PR pin → npm 正式版）

## 背景

本项目为 PaperMC 26.1.2（协议 775）pin 了 PrismarineJS 未合并的 PR 分支：

| 包 | pin 方式 | 上游状态（2026-08-05 核实） |
|---|---|---|
| minecraft-data 3.112.0 | overrides 固定版本 | ✅ 已正式支持 775 |
| minecraft-protocol | overrides git SHA `3fb78a8d...` | ⏳ PR #1487 open |
| prismarine-chunk 1.41.0 | overrides **官方 npm 版本** | ✅ **2026-07-31 正式发布 26.1**（PR #329 merged，含 #326 的 fluid-count + fromLocalPalette 修复） |
| prismarine-physics 1.11.1 | overrides **官方 npm 版本** | ✅ **2026-07-28 发布版含 26.1 特性标记** |
| mineflayer | 直接依赖 git SHA `b30c85cb...` | ⏳ PR #3902 open（被上面两项阻塞） |

> chunk/physics 为何仍保留 overrides：mineflayer PR 分支的 package.json 把这两个依赖
> 声明为 mneuhaus fork 的**可变分支名**（`#pc26_1_2-fluid-count` 等）。即使官方已发布，
> npm 仍会按声明拉 fork 分支——overrides 以官方版本号覆盖，同时消除 fork 分支
> force-push 的供应链风险（比早期 SHA pin 更进一步：内容也切换到维护者合并的实现）。

上游状态跟踪：https://github.com/PrismarineJS/mineflayer/issues/3893

## 定期检查

```bash
npm run migrate-upstream -- --check   # 建议 cron 每 2-4 周跑一次（npm script 已注册）
```

上游合并后输出"上游已支持"，然后：

## 执行迁移

```bash
npm run migrate-upstream -- --dry-run   # 演练：输出将做的修改
npm run migrate-upstream                # 实际执行：
#   1. 改 package.json（mineflayer → ^正式版，删除 overrides 中的 git 引用；
#      chunk/physics 版本覆盖与 minecraft-data 精确 pin 保留）
#   2. npm install
#   3. npm run check:compat + npm test 自动验证
# 最后在部署机上验证（需服务端在线）: node scripts/smoke.mjs --steps connect,spawn,move
```

迁移成功后建议清理 `.npmrc`（`legacy-peer-deps` / `allow-git` 如无其他 git 依赖可删）。

## 备选 pin（官方 PR 分支失效时）

若官方 PR 分支被关闭/重写，切到 mneuhaus fork 分支（PR 作者的 fork，内容相同）：

```bash
git ls-remote https://github.com/mneuhaus/node-minecraft-protocol.git refs/heads/pc26_1_2-clean
git ls-remote https://github.com/mneuhaus/mineflayer.git refs/heads/pc26_1_2   # 分支名以 ls-remote 实际输出为准
```

将输出 SHA 写入 package.json 对应引用（chunk/physics 已不需要：官方版本即可）。

## 降级开关（最坏情况）

若上游长期不合并且 PR 依赖恶化：服务端降级到 1.21.11（协议 774），配置 `mcVersion: "1.21.11"`，依赖全部回 npm 正式版（mineflayer ^4.37.1 即可），`check:compat` 的目标版本映射表中 1.21.11=774 已内置。
