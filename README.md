# Minecraft Bot（PaperMC 26.1.2 / Windows PC + 树莓派服务端）

Minecraft Bot，以 NSSM Windows 服务运行在低配 Windows PC（i7-4720HQ / 8GB）上，连接运行在树莓派 5 8G 上的 PaperMC 26.1.2 服务端（协议 775）。基于 [mineflayer](https://github.com/PrismarineJS/mineflayer)（PR #3902 分支，26.1.2 支持），整合了 mindcraft / Voyager / baritone 的分析结论（见 [docs/architecture.md](docs/architecture.md)）。

## 功能

- **分层架构**：L1 精简生产核心（默认）+ L2 LLM 智能体层（可选启用，双 Provider：云端 API + 本地 Ollama）
- **连接守护**：断线原因分类（LoginGuard 思想）、指数退避重连（5s→300s）、10s 防抖防崩溃循环、spawn 超时兜底；仅名字冲突/白名单/版本不匹配算致命，未知原因退避重连
- **重连自愈**：每次 spawn 全量重建功能层（任务/命令/LLM 重新绑定新 bot，一次重连后一切照常）
- **任务系统**：7 种任务——挖矿（区域+背包满暂停）、钓鱼、AFK 防踢、**种植收割、伐木、战斗巡逻、养殖**；cron 调度（run-completion 语义，防重叠+时长上限）、热重载（SIGHUP/改配置/`!reload` 同一队列）
- **聊天命令**：`!ping` `!status` `!task`（含 `!task new/remove` 临时任务）`!reload` `!say` `!pos` `!follow` `!agent`，op 白名单 + 速率限制 + 256 字符自动分片（见下方指令列表）
- **生产设施**：pino 结构化日志（按天轮转）、NSSM Windows 服务（自启+崩溃重启+fatal 停止等人工）、PowerShell 一键部署（`scripts/deploy.ps1`）、兼容性门禁、冒烟测试

## 指令列表

游戏内聊天前缀 `!` 触发。权限：`all` = 任何玩家；`op` = 仅 `config.ops` 白名单（offline 模式无法查 OP，故用配置白名单；大小写不敏感）。

| 指令 | 权限 | 说明 |
|---|---|---|
| `!ping` | all | 心跳检查，回复 `pong (uptime=...)` |
| `!status` | op | 状态摘要：坐标 / 血量 / 饱食度 / 连接状态 / 重连次数 / 内存 / 任务 |
| `!task list` | op | 全部任务：id、状态、等待原因、计数 |
| `!task new <type> <id> [jsonOptions]` | op | 运行时创建并启动任务（不持久化），如 `!task new mine probe-1 {"blockTypes":["iron_ore"]}` |
| `!task remove <id>` | op | 移除任务（含其 cron 调度） |
| `!task start\|stop\|pause\|resume <id>` | op | 启停/暂停/恢复任务（`!task start` 支持终态重启） |
| `!reload` | op | 热重载配置与任务（与改配置文件/`nssm restart` 等效） |
| `!say <text>` | op | 以 Bot 身份说话（超长自动分片） |
| `!pos` | op | 当前坐标与朝向（调试） |
| `!follow <player>\|off` | op | 跟随/停止跟随玩家（需 `mineflayerPlugins.follow: true`） |
| `!agent chat <text>` | op | 与 L2 LLM 对话（需 `l2.enabled=true`；LLM 通过技能执行动作） |
| `!agent act <name> [json]` | op | 直调技能（不经 LLM），如 `!agent act status {}`、`!agent act move_to {"x":10,"y":64,"z":10}` |

聊天安全层：回复消息自动 ≤256 字符分片（`chat.maxLength`）；op 命令冷却（`chat.commandCooldownMs`）防刷屏；**发送时统一剥离 `§` 颜色码**（Paper 26.1.2 实测含颜色码的消息会被踢出，见下文兼容性说明）。

## 任务类型

| 类型 | 必填 options | 说明 | 自然完成 |
|---|---|---|---|
| `mine` | `blockTypes` | 区域内挖掘（collectblock），背包满（NoChests）自动暂停等待 | `stopWhenDone: true` 时区域挖空即完成 |
| `fish` | `durationMinutes` | 钓鱼循环（60s 超时兜底防挂起） | 到时 / 背包满 |
| `afk` | `intervalMinutes` | 周期视角转动防踢 | 无（scheduled 时必须配 `durationMinutes`） |
| `farm` | `area` + `cropTypes` | 种植→等待成熟→收割循环（wheat/carrots/potatoes/beetroots/nether_wart） | 区域无作物可做 |
| `chop` | `area` | 区域伐木（默认匹配 `/_log$|_wood$/`） | 区域无树 |
| `combat` | — | 区域内敌对实体巡逻（低血进食/远离、击杀计数、`maxTargets` 上限） | 无目标 / 达上限 |
| `breed` | — | 区域内白名单动物喂养繁殖（`maxBreedings` 上限） | 无动物 / 达上限 |

- 调度：`schedule`（cron 表达式，时区 `scheduleTimezone`）触发后运行到完成，防重叠、`durationMinutes` 时长上限、完成/失败聊天通知（`notifyChat: false` 关闭）
- 任务均为区域限定（`area: {x1,y1,z1,x2,y2,z2}`）；farm/chop/combat/breed 为 exclusive（互斥，避免争抢寻路/采集）
- 遥测：`counters`（mined/caught/planted/chopped/kills/breedings…）显示于 `!task list`

## 快速开始（开发机）

```bash
npm ci
npm test                    # 单元测试（Windows 可跑）
npm run check:compat        # 协议 775 兼容性门禁
cp config/config.example.json config/config.json   # 按需编辑
npm start                   # 连接 localhost:25565
```

## 部署（Windows PC）

Bot 以 NSSM Windows 服务运行于低配 PC（同机跑 Ollama 做 L2 本地推理）；PaperMC 服务端仍在树莓派（systemd）。见 [docs/deploy.md](docs/deploy.md)。

```powershell
# Windows PC，管理员 PowerShell（前置：Node 22 LTS + NSSM，见 docs/deploy.md）
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Smoke
```

## 验证

```bash
# 开发机
npm test && npm run check:compat
# Windows PC（需树莓派服务端在线；--host 指向服务端 IP）
node scripts/check-compat.mjs --probe
node scripts/smoke.mjs --config config/smoke.json --host mc.antifield.work          # 全步骤
node scripts/smoke.mjs --config config/smoke.json --host mc.antifield.work --steps connect,spawn,chat   # 快速档
```

## 文档

- [架构与整合决策](docs/architecture.md)
- [部署指南（Windows PC + 树莓派服务端）](docs/deploy.md)
- [L2 LLM 层设计](docs/l2.md)
- [上游迁移（PR pin → 正式版）](docs/upstream-migration.md)

## 性能要点（低配 PC + 同机 Ollama）

部署目标为 8GB 内存的 Windows PC，同机运行 Ollama（qwen3.5:4b）做 L2 本地推理：

- Bot 常驻 ~200-400MB RSS，已设低进程优先级（NSSM `BELOW_NORMAL_PRIORITY_CLASS`），不抢 Ollama 与其它程序的 CPU
- 内存预算：系统 ~2G + Ollama ~2.5-5G（视量化/GPU 卸载）+ Bot ~0.4G + 余量 ~1G——重程序按需关闭
- 依赖安装 `--omit=dev`（deploy.ps1 默认）；`maxSteps: 5` 防 LLM 工具循环；farm/chop/combat/breed 互斥不并发
- Windows 无 cgroup 等价物：内存靠任务管理器观察；Ollama 吃紧时换小量化档

## 配置

优先级：内置默认 → `config/default.json` → `--config` 文件 → `MCBOT_*` 环境变量 → CLI。
关键项（完整见 `config/default.json`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mcVersion` | `26.1.2` | 协议 775；降级为 `1.21.11` 需同步更换依赖（见 upstream-migration.md） |
| `host` / `port` | `localhost` / `25565` | 生产指向服务端域名 `mc.antifield.work`（防 Pi 局域网 IP 变动） |
| `username` / `auth` | `mcbot` / `offline` | 生产为 LAN 离线服；Microsoft 认证需 `auth: microsoft` |
| `ops` | `[]` | 命令白名单（offline 模式无法查 OP；大小写不敏感） |
| `reconnect` | base 5s, max 300s | 指数退避参数 |
| `tasks` | `[]` | 任务定义（7 种类型，可带 schedule + durationMinutes） |
| `chat.maxLength` | `250` | 聊天分片上限（服务端上限 256） |
| `chat.commandCooldownMs` | `750` | op 命令冷却（防刷屏） |
| `scheduleTimezone` | `Asia/Shanghai` | cron 调度时区 |
| `l2` | `enabled: false` | LLM 层：`provider: auto\|cloud\|ollama`，密钥只走环境变量；默认 Ollama 模型 `qwen3.5:4b` |

环境变量示例：`MCBOT_USERNAME=bot2 MCBOT_OP_WHITELIST=steve,alex npm start`

## 依赖 pin 说明（重要）

mineflayer 正式版只支持到 1.21.11（协议 774）；26.1.2（775）支持链部分已合入上游。本项目：
- `minecraft-data 3.112.0`（npm 正式版，已含 775）
- **git SHA 固定引用 ×2**：`mineflayer`（PR #3902）、`minecraft-protocol`（PR #1487），不可变
- **官方版本覆盖 ×2**：`prismarine-chunk 1.41.0` / `prismarine-physics 1.11.1`（2026-07-31 已官方发布 26.1 支持；mineflayer PR 分支声明 fork 可变分支名，故以 overrides 强制官方版）
- `.npmrc`：`legacy-peer-deps`（npm 无法解析 git 依赖版本）+ `allow-git`（npm 12+ 供应链安全默认禁 git 依赖）
- 每次部署前 `npm run check:compat` 门禁；上游合并后 `npm run migrate-upstream` 一键回切

## 26.1.2 实测兼容性备忘（PaperMC 26.1.2 真机验证）

| 现象 | 处理 |
|---|---|
| 聊天消息含 `§` 颜色码 → 服务器踢出 `multiplayer.disconnect.illegal_characters` | sendChat 发送层统一剥离（`stripColorCodes`）；源码中的 `§a/§c` 仅为设计标记 |
| `bot.entity.health/food` 为 undefined（PR 分支实体元数据未解析 26.1 health 字段） | 状态读取走 `bot.health/bot.food`（update_health 包通道） |
| pathfinder 2.x 需 `setMovements(new Movements(bot))` 否则寻路中途放弃 | 插件注入时自动设置 |
| mineflayer 4.x 插件注入在 `inject_allowed` 事件后（registry 就绪时） | 插件句柄通过包装函数在注入时记录 |
| `bot.blockAt()` 必须传 Vec3 实例（普通对象触发 `pos.floored` 崩溃） | 任务内部统一 `new Vec3(x,y,z)` |
| Paper 26.1.2 RCON 认证成功响应 type=2（非标准的 3） | 运维脚本按 reqId 回显匹配（与 Bot 项目无关，备忘） |

## 许可与致谢

本项目 MIT。底层库 [mineflayer](https://github.com/PrismarineJS/mineflayer)（MIT）；架构模式借鉴 [mindcraft](https://github.com/mindcraft-bots/mindcraft)（MIT）、[Voyager](https://github.com/MineDojo/Voyager)（MIT）、[baritone](https://github.com/cabaletta/baritone)（LGPL，仅参考未集成）。
