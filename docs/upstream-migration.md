# 上游迁移（patch-package 补丁 → 上游正式版）

## 背景

本项目为 PaperMC 26.1.2（协议 775）的适配以 **5 个本地补丁**（`patches/`，patch-package
承载）实现——依赖全部为官方 npm 版本（供应链干净、零 git 依赖）：

| 包 | 版本 | 补丁 | 上游状态 |
|---|---|---|---|
| minecraft-data | 3.113.0（overrides 固定） | 无（官方已含 775 数据） | ✅ |
| minecraft-protocol | 1.66.2（^） | ✅ PR #1487 适配（src/version.js 支持列表） | ⏳ 上游 PR open |
| mineflayer | 4.37.1（^） | ✅ PR #3902 适配（lib/：bed 属性/entityVelocityIsLpVec3/use_entity 新格式无条件/attack 独立包/update_time clockUpdates 对象数组） | ⏳ 上游 PR open |
| mineflayer-pathfinder | 2.4.5（^） | ✅ 爬升根治（执行器起跳中保留 forward） | 项目本地修复 |
| prismarine-chunk | 1.41.0（overrides 固定） | 无（官方已含 26.1） | ✅ |
| prismarine-physics | 1.11.1（overrides 固定） | ✅ 爬升根治（半嵌挤回 + F32_EPS 贴墙余量） | 项目本地修复 |
| prismarine-world | 3.7.0（^） | ✅ raycast 同步化（async 回归——A* 永不收敛超时根因修复） | 项目本地修复 |

上游状态跟踪：https://github.com/PrismarineJS/mineflayer/issues/3893

## 什么时候需要迁移

- mineflayer PR #3902 / minecraft-protocol PR #1487 **上游合并并发布**后，删掉对应补丁
  切回上游正式实现（适配随上游版本走，不再由项目维护）
- 上游大版本升级导致补丁 context 冲突（patch-package 行为：显式报错不会静默）——
  按冲突内容重新生成补丁或等上游合并
- 升级 mineflayer-pathfinder / prismarine-physics 时同理：本地修复未上游化则需重生成补丁

## 迁移流程（补丁 → 上游正式版）

```bash
# 0. 确认上游确实已合并（PR 状态 + npm 发布版本 > 当前 pin）
# 1. 删除对应补丁 + postinstall 的 patch-package
rm patches/mineflayer+4.37.1.patch        # 按实际删除
rm patches/minecraft-protocol+1.66.2.patch
#   若全部补丁清空：package.json 删 "postinstall": "patch-package"，.npmrc 可删
#   若仍有其他补丁：只删对应文件（patch-package 自动跳过缺失补丁）
# 2. 升级依赖到上游正式版
npm install mineflayer@latest minecraft-protocol@latest
# 3. 更新 check:compat 哨兵门禁（scripts/check-compat.mjs）：
#    PATCH_SENTINELS 删除对应条目；EXPECTED 更新版本
# 4. 全量验证
npm test && npm run check:compat
# 5. 部署机验收（需服务端在线）
node scripts/smoke.mjs --steps connect,spawn,move
# 6. 文档同步：architecture.md 依赖 pin 节 / CHANGELOG / 本文件
```

> 注：`scripts/migrate-upstream.mjs` 与 `scripts/upstream-lib.mjs` 保留 git-pin
> 时代的迁移逻辑（PR 分支 → npm 正式版）。当前项目已无 git 依赖，该
> 逻辑过时——正确迁移 = 上面的删补丁流程。保留脚本仅为历史参考，勿直接运行。

## 26.1.2 适配的补丁外残留（上游合并后一并清理）

- `use_entity` 新格式（26.1：`{target, hand, location(lpVec3 必填), sneaking}`）：
  补丁已让 mineflayer 原生路径（`bot.attack/useEntity`）写新格式；项目层
  `src/core/entity-actions.js` 为独立封装（同格式——combat/breed 用）。
  上游合并后删除补丁对应 hunk 即可（entity-actions.js 保留——封装含
  攻击判定/arm_animation 等组合逻辑，非纯协议层）

## 降级开关（最坏情况）

若上游长期不合并且补丁维护恶化：服务端降级到 1.21.11（协议 774），配置
`mcVersion: "1.21.11"`，依赖全部回官方 npm 正式版（mineflayer ^4.37.1 即可），
`check:compat` 的目标版本映射表中 1.21.11=774 已内置。
