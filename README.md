# Minecraft Bot（PaperMC 26.1.2 / Windows PC + 树莓派服务端）

[![CI](https://github.com/antifield26/ApopBot/actions/workflows/ci.yml/badge.svg)](https://github.com/antifield26/ApopBot/actions/workflows/ci.yml)

Minecraft Bot，以 NSSM Windows 服务运行在 Windows PC 上，连接 PaperMC 26.1.2 服务端（协议 775）。基于 [mineflayer](https://github.com/PrismarineJS/mineflayer)（官方 npm 4.37.1 + 本地补丁承载 26.1.2 支持——见依赖 pin 说明），整合了 mindcraft / Voyager / baritone 的分析结论（见 [docs/architecture.md](docs/architecture.md)）。

## 功能

- **分层架构**：L1 精简生产核心（默认）+ L2 LLM 智能体层（可选启用，**单 Provider：云端 Anthropic 兼容 API——预设 DeepSeek（deepseek-v4-flash，Anthropic 兼容端点），thinking=disabled 低延迟模式**）
- **连接守护**：断线原因分类（LoginGuard 思想）、指数退避重连（5s→300s）、10s 防抖防崩溃循环、spawn 超时兜底；名字冲突/白名单/版本不匹配/消息违规（illegal）算致命，其余退避重连
- **重连自愈**：每次 spawn 全量重建功能层（任务/命令/LLM 重新绑定新 bot，一次重连后一切照常）
- **任务系统**：8 种任务全部**脚本化**（动作原语脚本，与 LLM 共用执行层——挖矿、钓鱼、AFK 防踢、种植收割、伐木、战斗巡逻、养殖、螺旋探索）；BaseTask 状态机外壳保留（暂停/恢复/取消/调度/防重叠）；cron 调度（防重叠+时长上限）、热重载（SIGHUP/改配置/`!reload` 同一队列）
- **L2 直接操作协议**：LLM 通过 **act 动作数组**（≤8 个动作/次）自由组合 36 个动作原语直接操控 Bot（观察/移动/挖掘/放置/采集/战斗/交互/任务）——彻底打破「提示词→固定技能」映射；行动-观察循环 + 失败反思经验跨会话注入；云端上下文预算裁剪
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
| `!agent chat <text>` | all | 与 L2 LLM 对话（需 `l2.enabled=true`；LLM 经 act 工具执行动作原语数组——危险操作仍由执行器 op 门强制）。自然语言示例：`!agent chat 你周围有什么？`、`!agent chat 帮我挖点铁`、`!agent chat 附近有什么矿？` |
| `!agent act <op> [json]` | op | 直调动作原语（不经 LLM），如 `!agent act observe_status {}`、`!agent act goto {"x":10,"y":64,"z":10}` |
| `!agent doctor` | all | 云端连通性诊断 + 生效模式/最近延迟（只读） |
| `!agent reset` | all | 清空调用者会话记忆 |
| `!agent goal` / `set <text>` / `clear` | all / set,clear 需 op | 长期目标记忆（跨会话注入 LLM 提示词——Bot 持续朝目标推进）；set 文本 ≤200 字符 |
| `!home set <name>` / `remove <name>` / `list` | all / set,remove 需 op | 命名地点（家/矿场/基地，带维度）；LLM 经 `query_map place:<name>` 查询 |

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
| `combat` | — | 区域内敌对实体巡逻（低血进食/等待重扫、击杀计数、`maxTargets` 上限） | 默认巡逻（`stopWhenNoTargets: true` 时无怪即完成）/ 达上限 |
| `breed` | — | 区域内白名单动物喂养繁殖（`maxBreedings` 上限） | 默认巡逻（`stopWhenNoAnimals: true` 时无动物即完成）/ 达上限 |
| `explore` | — | 方形螺旋游荡覆盖（每站采样记录 23 种资源与实体到探索记忆，LLM 经 `query_map` 查询）；`maxDistance` 半径上限（16-256）、`area` 可限定 | `stopWhenDone: true` 时环满即完成 / 无则到边界后以当前位置重启（有界漫游）；scheduled 由 durationMinutes 到时停止 |

- 调度：`schedule`（cron 表达式，时区 `scheduleTimezone`）触发后运行到完成，防重叠、`durationMinutes` 时长上限、完成/失败聊天通知（`notifyChat: false` 关闭）
- **任务链**：任务条目可配 `next: {id, type, options?}`——自然完成后自动接力下一个任务，如 `{"id":"mine-then-chop","type":"mine","options":{...},"next":{"id":"chop-a","type":"chop","options":{"area":{...}}}}`
- **自动存储**：collect_blocks 背包满（NoChests）时自动找附近 32 格箱子/木桶存入（工具与食物豁免）再继续——不再干等 5 分钟
- 仅 farm/chop 强制 area（mine 可选、combat/breed 可省略=无区域约束；afk/fish 无区域）；farm/chop/combat/breed/explore 为 exclusive（互斥，避免争抢寻路/采集）；mine 非 exclusive——exclusive 任务运行期间其采集动作软失败自动重试
- 遥测：`counters`（mined/caught/planted/chopped/kills/breedings…）显示于 `!task list`
- **维度感知**：探索记忆按维度存储——下界/末地坐标独立，`query_map` 只返回当前维度的记录（旧主世界数据兼容）；`observe_blocks` 观察到的资源自动记入探索记忆（LLM 探索即积累）；任务长 idle（等待原因持续 10 分钟）经 LLM 一句话播报原因
- **LLM 能力深化**：长期目标记忆（`!agent goal` + `set_goal` 原语——目标+计划跨会话注入）；对话滚动摘要（历史超限 LLM 压缩，"继续"不断片）；检索式经验（按失败动作匹配注入 + 重复教训合并计数）；退化状态自动注入（低血/饥饿/背包满/工具将坏，零工具调用成本）；`observe_tasks` 任务状态感知；世界事件被动感知（被攻击/低血/背包满/稀有收集——下次对话 LLM 知道发生了什么）；命名地点（`!home` + `set_place`——家/矿场语义坐标，`query_map place:` 查询）
- **Bot 功能扩展**：仓库管理（`storage.chests` 配置 + `store_items`/`fetch_items`——背包满自动存配置仓库，替代临时找箱）；工具耐久管理（挖掘自动换最优工具 + 护甲自动装备）；farm 扩展 5 作物（甘蔗/南瓜/西瓜/甜浆果/可可——三种成熟判定四种种植模式）；`sleep` 睡觉（天黑过夜，farm/combat `sleepAtNight` 可选）；`harvest_animals` 剪羊毛/捡掉落物
- **自主推进（Planner）**：任务自然完成且无配置链时，LLM 规划器读长期目标自动生成下一个任务（start_task 支持 `next` 任务链 / `schedule` 定时）；`!agent goal set <文本> --plan=[...]` 设置目标+计划；9 层保护（开关/冷却/busy/预算/受限工具集/静默/链优先/失控边界/权限闭环）
- **危险区域记忆（World Model）**：hostile 出没坐标自动记录（探索站 + 被攻击被动点），`query_map {"danger":true}` 查询附近危险区（fresh/stale 标记）；LLM 对话自动注入"危险:"行（1 小时新鲜窗口内）——Bot 知道哪里安全
- **语义聚合（v1.4.0）**：资源×危险区关联——`query_map {"blockName":"iron_ore"}` 每条返回附最近危险区距离（nearestDanger），`{"assess":"home"}` 位置安全评估（半径 64 内危险区 + safe 标记），`minSafeDist` 过滤危险区附近的资源点；四分支严格互斥
- **多角色 Agent（v1.4.0）**：单 bot 多角色——恒有 primary（对话）+ planner（规划）两角色，`l2.roles` 配置自定义角色（独立人设/工具白名单/会话/冷却）；`!agent role list` / `!agent role <name> <action>` / `!agent <role> <action>` 便捷路由；各角色会话隔离，v1.3.0 旧会话自动迁移
- **自主学习循环（v1.5.0）**：任务自然完成后 LLM 把成功实践提炼为结构化 skill（步骤+注意点）存库——后续对话按活跃任务类型自动注入"技能:"行（LLM 参考过往成功做法）；与失败教训经验库互补成完整学习闭环；`l2.skillEnabled` / `skillLearnCooldownMs` / `skillInjection` 可配
- **受击响应（guard，v1.5.1）**：被怪物攻击（entityHurt 怪物源）时自动响应——非 exclusive 任务暂停、exclusive 任务停止（含排队中），启动战斗清理怪物（`guard.radius`/`cooldownMs` 可配），战斗结束后自动恢复被抢占的任务；死亡自动重置冷却（重生后首次受击立即响应，防被蹲守连环击杀）

## 快速开始（开发机）

```bash
npm ci
npm test                    # 单元测试（Windows 可跑）
npm run lint                # ESLint 门禁（eslint:recommended + 项目风格）
npm run typecheck           # checkJs 类型门禁（src 全部 @ts-check，渐进 TS 路线第一阶段）
npm run test:coverage       # 覆盖率报告（lcov → coverage/lcov.info，CI artifact）
npm run check:compat        # 协议 775 兼容性门禁
cp config/config.example.json config/config.json   # 按需编辑
npm start                   # 连接 localhost:25565
```

## 部署（Windows PC）

Bot 以 NSSM Windows 服务运行于 PC（L2 推理在云端——无本地 LLM 进程）；PaperMC 服务端仍在树莓派（systemd）。见 [docs/deploy.md](docs/deploy.md)。

```powershell
# Windows PC，管理员 PowerShell（前置：Node 24 LTS + NSSM，见 docs/deploy.md）
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Smoke
```

## 验证

```bash
# 开发机
npm test && npm run check:compat
# Windows PC（需树莓派服务端在线；--host 指向服务端 IP）
node scripts/check-compat.mjs --probe
node scripts/smoke.mjs --config config/smoke.json --host mc.antifield.work          # 全步骤（mine 默认 SKIP，--dangerous 开启）
node scripts/smoke.mjs --config config/smoke.json --host mc.antifield.work --steps connect,spawn,chat   # 快速档
```

## 文档

- [架构与整合决策](docs/architecture.md)
- [部署指南（Windows PC + 树莓派服务端）](docs/deploy.md)
- [L2 LLM 层设计](docs/l2.md)
- [上游迁移（PR pin → 正式版）](docs/upstream-migration.md)
- [路线图（完善/升级/重构三档与取舍）](docs/roadmap.md)
- [部署机验收清单](docs/acceptance.md)（真机验证项跟踪——release 前核对；含 issue #1 现场数据采集指引）

## 性能要点（低配 PC）

部署目标为 8GB 内存的 Windows PC：

- Bot 常驻 ~200-400MB RSS，已设低进程优先级（NSSM `BELOW_NORMAL_PRIORITY_CLASS`），不抢其它程序的 CPU
- 内存预算：系统 ~2G + Bot ~0.4G + 余量充足——重程序按需关闭
- 依赖安装 `--omit=dev`（deploy.ps1 默认）；`maxSteps: 15` × `maxActionsPerCall: 8` 防 LLM 工具循环；farm/chop/combat/breed/explore 互斥不并发
- Windows 无 cgroup 等价物：内存靠任务管理器观察

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
| `tasks` | `[]` | 任务定义（8 种类型，可带 schedule + durationMinutes） |
| `chat.maxLength` | `250` | 聊天分片上限（服务端上限 256） |
| `chat.commandCooldownMs` | `750` | op 命令冷却（防刷屏） |
| `chat.replyLimit` / `chat.replyWindowMs` | `5` / `10000` | 命令回复限流（per-sender token bucket：窗口内最多回复 N 条，桶满静默丢弃——防刷屏踢服 DoS，全部反馈路径统一纳入） |
| `scheduleTimezone` | `Asia/Shanghai` | cron 调度时区 |
| `notify.webhook` | `''` | 运维通知：任务终态/断线重连/死亡重生/fatal 停服推送企业微信或 Server酱（URL 自动识别；空=关闭；零依赖，失败静默） |
| `l2` | `enabled: false` | LLM 层：单 Provider，预设 DeepSeek（`deepseek-v4-flash` + Anthropic 兼容端点 `api.deepseek.com/anthropic`，`thinking: disabled`/`effort: low`——disabled 时不传 reasoning_effort，DeepSeek 端点两者互斥 400；`thinking: enabled` 时注入 `thinkingBudgetTokens`（Anthropic 协议必填，`maxTokens` 必须大于它））；密钥只走 `l2.cloudApiKeyEnv` 指定环境变量；残留旧键（provider/ollama 系）启动即报错（契约冻结） |

环境变量示例：`MCBOT_USERNAME=bot2 MCBOT_OP_WHITELIST=steve,alex npm start`

## 依赖 pin 说明（重要）

mineflayer 正式版只支持到 1.21.11（协议 774）；26.1.2（775）上游 PR（#3902/#1487）未合并。本项目：
- **全部官方 npm 版**：`mineflayer 4.37.1` / `minecraft-protocol 1.66.2` / `minecraft-data 3.113.0`（已含 775）/ `prismarine-chunk 1.41.0` / `prismarine-physics 1.11.1`（已含 26.1）
- **26.1.2 适配 = 本地补丁**：`patches/` 的 patch-package 补丁（postinstall 自动应用，`npm ci` 零手工步骤）——供应链 100% 干净（零 git 依赖、npm audit 无高危）。共 5 个：`minecraft-protocol`（775 协议）/ `mineflayer`（lib/ 26.1 适配）/ `mineflayer-pathfinder`（爬升根治——执行器起跳保留 forward）/ `prismarine-physics`（爬升根治——半嵌挤回 + float32 贴墙余量）/ `prismarine-world`（raycast 同步化——A* 永不收敛超时根因修复）
- 门禁：`npm run check:compat`（含 3.7 补丁哨兵——补丁缺失/未应用即 FAIL）；上游合并后删补丁 + 更新版本号回切（见 docs/upstream-migration.md）

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
