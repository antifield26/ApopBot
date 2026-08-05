# Minecraft Bot（PaperMC 26.1.2 / 树莓派 5）

Minecraft Bot，连接运行在树莓派 5 8G 上的 PaperMC 26.1.2 服务端（协议 775）。基于 [mineflayer](https://github.com/PrismarineJS/mineflayer)（PR #3902 分支，26.1.2 支持），整合了 mindcraft / Voyager / baritone 的分析结论（见 [docs/architecture.md](docs/architecture.md)）。

## 功能

- **分层架构**：L1 精简生产核心（默认）+ L2 LLM 智能体层（骨架，可选启用）
- **连接守护**：断线原因分类（LoginGuard 思想）、指数退避重连（5s→300s）、10s 防抖防崩溃循环、spawn 超时兜底、致命原因自动停止等人工
- **任务系统**：挖矿（区域限定）、钓鱼（定时/背包满）、AFK 防踢、cron 调度、热重载（`systemctl reload` 或改配置）
- **聊天命令**：`!ping` `!status` `!task` `!reload` `!say` `!pos` `!follow` `!agent`，op 白名单权限
- **生产设施**：pino 结构化日志（按天轮转）、systemd 双单元（资源限流）、一键部署脚本、兼容性门禁、冒烟测试

## 快速开始（开发机）

```bash
npm ci
npm test                    # 单元测试（Windows 可跑）
npm run check:compat        # 协议 775 兼容性门禁
cp config/config.example.json config/config.json   # 按需编辑
npm start                   # 连接 localhost:25565
```

## 树莓派部署

```bash
# Pi 一次性准备见 docs/deploy.md（Node 22 LTS、Java 25、systemd 单元）
./scripts/deploy.sh pi@<host> --fast
```

## 验证

```bash
# 开发机
npm test && npm run check:compat
# Pi（需服务端在线）
node scripts/check-compat.mjs --probe
node scripts/smoke.mjs --config config/smoke.json          # 全步骤
node scripts/smoke.mjs --config config/smoke.json --steps connect,spawn,chat   # 快速档
```

## 文档

- [架构与整合决策](docs/architecture.md)
- [树莓派部署指南](docs/deploy.md)
- [L2 LLM 层设计](docs/l2.md)
- [上游迁移（PR pin → 正式版）](docs/upstream-migration.md)

## 配置

优先级：内置默认 → `config/default.json` → `--config` 文件 → `MCBOT_*` 环境变量 → CLI。
关键项（完整见 `config/default.json`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mcVersion` | `26.1.2` | 协议 775；降级为 `1.21.11` 需同步更换依赖（见 upstream-migration.md） |
| `host` / `port` | `localhost` / `25565` | |
| `username` / `auth` | `mcbot` / `offline` | 生产为 LAN 离线服；Microsoft 认证需 `auth: microsoft` |
| `ops` | `[]` | 命令白名单（offline 模式无法查 OP） |
| `reconnect` | base 5s, max 300s | 指数退避参数 |
| `tasks` | `[]` | 任务定义（mine/fish/afk，可带 schedule） |
| `l2.enabled` | `false` | LLM 层开关 |

环境变量示例：`MCBOT_USERNAME=bot2 MCBOT_OP_WHITELIST=steve,alex npm start`

## 依赖 pin 说明（重要）

mineflayer 正式版只支持到 1.21.11（协议 774）；26.1.2（775）支持链尚未合并到上游。本项目：
- `minecraft-data 3.112.0`（npm 正式版，已含 775）
- 4 个 PR 分支包以 **git SHA 固定引用**（不可变，不受 force-push 影响）
- `.npmrc`：`legacy-peer-deps`（npm 无法解析 git 依赖版本）+ `allow-git`（npm 12+ 供应链安全默认禁 git 依赖）
- 每次部署前 `npm run check:compat` 门禁；上游合并后 `npm run migrate-upstream` 一键回切

## 许可与致谢

本项目 MIT。底层库 [mineflayer](https://github.com/PrismarineJS/mineflayer)（MIT）；架构模式借鉴 [mindcraft](https://github.com/mindcraft-bots/mindcraft)（MIT）、[Voyager](https://github.com/MineDojo/Voyager)（MIT）、[baritone](https://github.com/cabaletta/baritone)（LGPL，仅参考未集成）。
