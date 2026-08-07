# Minecraft Bot（PaperMC 26.1.2 / Windows PC + 树莓派服务端）

Minecraft Bot，以 NSSM Windows 服务运行在 Windows PC 上，连接 PaperMC 26.1.2 服务端（协议 775）。基于 [mineflayer](https://github.com/PrismarineJS/mineflayer)（PR #3902 分支，26.1.2 支持），整合了 mindcraft / Voyager / baritone 的分析结论（见 [docs/architecture.md](docs/architecture.md)）。

## 功能

- **分层架构**：L1 精简生产核心（默认）+ L2 LLM 智能体层（可选启用，双 Provider：云端 API + 本地 Ollama）
- **连接守护**：断线原因分类（LoginGuard 思想）、指数退避重连（5s→300s）、10s 防抖防崩溃循环、spawn 超时兜底；名字冲突/白名单/版本不匹配/消息违规（illegal）算致命，其余退避重连
- **重连自愈**：每次 spawn 全量重建功能层（任务/命令/LLM 重新绑定新 bot，一次重连后一切照常）
- **任务系统**：7 种任务——挖矿（区域+背包满暂停）、钓鱼、AFK 防踢、**种植收割、伐木、战斗巡逻、养殖**；cron 调度（run-completion 语义，防重叠+时长上限）、热重载（SIGHUP/改配置/`!reload` 同一队列）
- **聊天命令**：`!ping` `!status` `!task`（含 `!task new/remove` 临时任务）`!reload` `!say` `!pos` `!follow` `!find`（地表方块定位）`!agent`（chat/doctor/reset 全员可用，act 需 op），op 白名单 + 速率限制 + 256 字符自动分片（见下方指令列表）
- **生产设施**：pino 结构化日志（按天轮转）、NSSM Windows 服务（自启+崩溃重启+fatal 停止等人工）、PowerShell 一键部署/一键更新（`scripts/deploy.ps1 -Update`）、兼容性门禁、冒烟测试、webhook 运维通知（企业微信/Server酱）、只读 HTTP 状态端点（/health /metrics，含坐标/等待原因）

## 指令列表

游戏内聊天前缀 `!` 触发。权限：`all` = 任何玩家；`op` = 仅 `config.ops` 白名单（offline 模式无法查 OP，故用配置白名单；大小写不敏感）。

| 指令 | 权限 | 说明 |
|---|---|---|
| `!ping` | all | 心跳检查，回复 `pong (uptime=...)` |
| `!status` | op | 状态摘要：坐标 / 血量 / 饱食度 / 连接状态 / 重连次数 / 内存 / 任务 |
| `!task list` | op | 全部任务：id、状态、等待原因、计数、排队位置、时长剩余、下次 cron 触发 |
| `!task new <type> <id> [jsonOptions]` | op | 运行时创建并启动任务（不持久化），如 `!task new mine probe-1 {"blockTypes":["iron_ore"]}`；options 过 schema 校验（类型/范围） |
| `!task remove <id>` | op | 移除任务（含其 cron 调度） |
| `!task start\|stop\|pause\|resume <id>` | op | 启停/暂停/恢复任务（`!task start` 立即反馈已启动/排队/失败，支持终态重启） |
| `!reload` | op | 热重载配置与任务（与改配置文件/`nssm restart` 等效；http 配置变更也即时生效） |
| `!say <text>` | op | 以 Bot 身份说话（超长自动分片） |
| `!pos` | op | 当前坐标与朝向（调试） |
| `!follow <player>\|off` | op | 跟随/停止跟随玩家（需 `mineflayerPlugins.follow: true`；exclusive 任务运行中拒绝——移动互斥） |
| `!find <方块名> [maxDistance]` | op | 找到指定方块的地表暴露位置（上方 2 格为天空，排除洞穴/液体）并走过去（3 格内）；报告实际到达坐标/距离/耗时。maxDistance 16-256（默认 64）。已知局限：高洞顶洞穴的 cave_air 也可能被判为地表（pc 版无 heightmap） |
| `!agent chat <text>` | all | 与 L2 LLM 对话（需 `l2.enabled=true`；LLM 通过技能执行动作，危险操作仍由技能层 op 门强制） |
| `!agent act <name> [json]` | op | 直调技能（不经 LLM），如 `!agent act status {}`、`!agent act move_to {"x":10,"y":64,"z":10}` |
| `!agent doctor` | all | cloud/ollama 连通性诊断 + 生效模式/最近延迟（只读） |
| `!agent reset` | all | 清空调用者会话记忆 |

聊天安全层：回复消息自动 ≤256 字符分片（`chat.maxLength`）；op 命令冷却（`chat.commandCooldownMs`）防刷屏；**发送时统一剥离 `§` 颜色码**（Paper 26.1.2 实测含颜色码的消息会被踢出，见下文兼容性说明；所有出口——含命令反馈/重连广播/任务通知——都走 sendChat 剥离）。

存活保障：死亡后自动重生（任务暂停 → LLM 一句话播报死因 → `respawn` 后自动恢复任务并播报重生位置）；断线重连后进行中的寻路不再挂死（`goto` 与断线事件 race）；配置/状态快照在进程退出时同步落盘。

## 任务类型

| 类型 | 必填 options | 说明 | 自然完成 |
|---|---|---|---|
| `mine` | `blockTypes` | 区域内挖掘（collectblock），背包满（NoChests）自动暂停等待 | `stopWhenDone: true` 时区域挖空即完成 |
| `fish` | `durationMinutes` | 钓鱼循环（60s 超时兜底防挂起） | 到时 / 背包满 |
| `afk` | `intervalMinutes` | 周期视角转动防踢 | 无（scheduled 时必须配 `durationMinutes`） |
| `farm` | `area` + `cropTypes` | 种植→等待成熟→收割循环（wheat/carrots/potatoes/beetroots/nether_wart） | 默认巡逻（`stopWhenIdle: true` 时区域空闲即完成） |
| `chop` | `area` | 区域伐木（默认匹配 `/_log$|_wood$/`） | 默认巡逻（`stopWhenDone: true` 时无树即完成） |
| `combat` | — | 区域内敌对实体巡逻（低血进食/远离、击杀计数、`maxTargets` 上限） | 默认巡逻（`stopWhenNoTargets: true` 时无怪即完成）/ 达上限 |
| `breed` | — | 区域内白名单动物喂养繁殖（`maxBreedings` 上限） | 默认巡逻（`stopWhenNoAnimals: true` 时无动物即完成）/ 达上限 |

- 调度：`schedule`（cron 表达式，时区 `scheduleTimezone`）触发后运行到完成，防重叠、`durationMinutes` 时长上限、完成/失败聊天通知（`notifyChat: false` 关闭）
- 仅 farm/chop 强制 area（mine 可选、combat/breed 可省略=无区域约束；afk/fish 无区域）；farm/chop/combat/breed 为 exclusive（互斥，避免争抢寻路/采集）
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
- [路线图（完善/升级/重构三档与取舍）](docs/roadmap.md)

## 性能要点（低配 PC + 同机 Ollama）

部署目标为 8GB 内存的 Windows PC，同机运行 Ollama（qwen3.5:4b）做 L2 本地推理：

- Bot 常驻 ~200-400MB RSS，已设低进程优先级（NSSM `BELOW_NORMAL_PRIORITY_CLASS`），不抢 Ollama 与其它程序的 CPU
- 内存预算：系统 ~2G + Ollama ~2.5-5G（视量化/GPU 卸载）+ Bot ~0.4G + 余量 ~1G——重程序按需关闭
- 依赖安装 `--omit=dev`（deploy.ps1 默认）；`maxSteps: 5` 防 LLM 工具循环；farm/chop/combat/breed 互斥不并发
- Windows 无 cgroup 等价物：内存靠任务管理器观察；Ollama 吃紧时换小量化档

## 配置

优先级：内置默认 → `config/default.json` → `--config` 文件 → `MCBOT_*` 环境变量 → CLI。
关键项（完整键值见内置默认（src/core/config.js）与 `config/config.example.json`）：

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
| `notify.webhook` | `''` | 运维通知（U10）：任务终态/断线重连/死亡重生/fatal 停服推送企业微信或 Server酱（URL 自动识别；空=关闭；零依赖，失败静默） |
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
| `bot.attack()/useOn()` 序列化报 `Sizeof error: reading 'x'` → 攻击/喂食即断线（PR 分支特性门控 bug：26.1 下 useEntityUsesEntityId=false 回退旧式 use_entity，而 26.1 schema 的 location 为必填 lpVec3） | 项目层 `src/core/entity-actions.js` 直接写正确包：attack 独立包 `{entityId}` + arm_animation、use_entity 新格式 `{target, hand, location, sneaking}`（combat/breed 接入；上游升级时 `tests/entity-actions.test.mjs` 用真实序列化器验证格式） |
| `bot.entity.health/food` 为 undefined（PR 分支实体元数据未解析 26.1 health 字段） | 状态读取走 `bot.health/bot.food`（update_health 包通道） |
| pathfinder 2.x 需 `setMovements(new Movements(bot))` 否则寻路中途放弃 | 插件注入时自动设置 |
| mineflayer 4.x 插件注入在 `inject_allowed` 事件后（registry 就绪时） | 插件句柄通过包装函数在注入时记录 |
| `bot.blockAt()` 必须传 Vec3 实例（普通对象触发 `pos.floored` 崩溃） | 任务内部统一 `new Vec3(x,y,z)` |
| Paper 26.1.2 RCON 认证成功响应 type=2（非标准的 3） | 运维脚本按 reqId 回显匹配（与 Bot 项目无关，备忘） |

## 许可与致谢

本项目 MIT。底层库 [mineflayer](https://github.com/PrismarineJS/mineflayer)（MIT）；架构模式借鉴 [mindcraft](https://github.com/mindcraft-bots/mindcraft)（MIT）、[Voyager](https://github.com/MineDojo/Voyager)（MIT）、[baritone](https://github.com/cabaletta/baritone)（LGPL，仅参考未集成）。
