# 架构

## 总体结构

```
minecraft-bot (Node.js ≥24, ESM；src 全量 .ts——Node 原生类型剥离直接运行，见「质量工具」)
├── src/index.ts              入口：配置 → logger → ConnectionManager → 功能层 → 信号
├── src/core/                 基础设施
│   ├── config.ts             配置分层加载与校验（默认值 < default.json < --config < MCBOT_* < CLI；
│   │                          契约冻结：l2 子键白名单 + CONFIG_SCHEMA_VERSION）
│   ├── logger.ts             pino 结构化日志（文件按天轮转 + stdout）
│   ├── connection.ts         ConnectionManager：连接/退避重连/spawn 超时/致命退出
│   ├── reconnect.ts          断线分类（classifyDisconnect）+ 指数退避（nextBackoff），纯函数
│   ├── bot.ts                createBot（同步）+ loadMineflayerPlugins（异步，事件零丢失窗口）
│   ├── feature-layer.ts      功能层生命周期（每次 spawn 全量重建 tasks/commands/L2 + chat 监听）
│   ├── fl-chat.ts / fl-death.ts / fl-players.ts / fl-world.ts / fl-guard.ts
│   │                          事件监听类拆分（聊天分发/死亡重生/玩家问候/世界感知与记忆失效/受击响应）
│   ├── idle-watcher.ts       任务长 idle LLM 播报（模块级 interval，重建只换引用）
│   ├── chat.ts               聊天安全层（256 字符分片发送 + 全局串行队列）
│   ├── signals.ts            SIGINT/SIGTERM 优雅退出；热重载（配置监视/!reload，Linux 另支持 SIGHUP）
│   ├── reload.ts             热重载处理器（依赖注入可测——校验→cfg/conn→logger→L2→http→tasks）
│   ├── http-status.ts        只读 HTTP 端点 /health /metrics（EADDRINUSE 退避重试）
│   ├── notify.ts             webhook 运维通知（企业微信/Server酱）
│   ├── time-query.ts         时间查询（/minecraft:time 命令链路 + clockUpdates 解析）
│   ├── storage.ts / tool.ts  自动存储 + 工具耐久管理
│   ├── primitives/           动作原语注册表（按族拆分：observe/move/build/combat/interact/item/flow/task，36 个原语）
│   ├── executor.ts           动作执行器（LLM act 数组与任务脚本共用：权限/exclusive/校验/超时/审计）
│   ├── audit.ts              动作审计日志（logs/audit.log JSONL 按天轮转）
│   ├── state.ts              schemaVersion 2 + 迁移器（未来版本拒绝加载）
│   └── movement.ts / entity-actions.ts / arbiter.ts / entities.ts / resources.ts / crops.ts / discovery.ts / explore.ts / environment.ts
├── src/tasks/                任务系统（脚本化：任务 = 动作原语脚本）
│   ├── base.ts               BaseTask 状态机（created→init→running⇄paused→stopped/completed/failed；
│   │                          run-completion 语义 + 终态重启 + _cancel 取消钩子 + _internalWait）
│   ├── manager.ts            TaskManager：装载/启停/热重载 diff/cron 调度/临时任务/防重叠/时长上限持久化
│   ├── runner.ts             ScriptTask（BaseTask 子类）+ ScriptRunner（脚本 DSL 解释器：
│   │                          loop/if/break/continue/return/count + 条件六型 + 模板求值 + 任务局部 op）
│   ├── scripts/              mine/fish/afk/farm/chop/combat/breed/explore 8 个任务脚本
│   ├── types.ts              任务类型单一注册表（factory → ScriptTask + 脚本定义）
│   ├── util.ts               isArea 等任务校验工具
│   └── scheduled.ts          croner 调度包装（单一 onTrigger 回调）
├── src/commands/             聊天命令系统
│   ├── parser.ts             shell 式引号感知解析（token 内 " 按字面，支持 JSON 参数；未闭合引号报错）
│   ├── permissions.ts        config.ops 白名单（offline 模式无法查 OP；大小写不敏感）
│   ├── registry.ts           注册/分发/权限校验/op 命令速率限制
│   └── commands.ts           内置命令
├── src/plugins/              mineflayer 生态插件装载（pathfinder→collectBlock→autoEat→armorManager→follow（条件装载））
├── src/l2/                   LLM 层（l2.enabled=false 时零依赖；单 Provider 见 docs/l2.md）
│   ├── agent-interface.ts    chat 工具循环（act 动作数组 + 观察工具）+ 反思钩子（经验沉淀）+ 滚动摘要
│   ├── provider.ts           云端 Anthropic 兼容 API（预设 DeepSeek，thinking=disabled）
│   ├── sessions.ts           会话落盘（data/sessions.json）
│   ├── experience.ts         经验记忆库（data/experience.json）
│   ├── skills.ts             技能库（data/skills.json——任务完成自主学习循环）
│   └── index.ts              createL2 组装（多角色注册表）
└── src/util/                 promise-timeout / debounced-file-store
```

## 分层决策（为什么这样整合）

| 层 | 来源 | 决策 |
|---|---|---|
| 协议层 | **mineflayer**（PrismarineJS） | 唯一协议级 headless 实现、27 版本集成测试、MIT。官方 npm 4.37.1 + 本地补丁获得 775 支持（PR #3902 适配经 patches/ 承载） |
| 生产模式 | **mindcraft**（借鉴，不依赖） | LoginGuard 断线分类 → 本项目 `reconnect.js`；10s 崩溃保护 → `minGapMs` + 服务管理器重启语义（NSSM `AppExit 2 Exit` / systemd `StartLimitBurst`）；配置分层 → `config.js`。mindcraft 锁定 mineflayer 4.33.0 + patch-package，不适合生产依赖 |
| 任务/技能 | **Voyager**（借鉴思想） | control_primitives 原子技能思想 → 本项目任务系统（8 种任务，全部脚本化）作为 L2 agent 的技能层 |
| 寻路 | **baritone**（仅参考） | 客户端 Mod 无法 headless 集成；本项目用 mineflayer-pathfinder + collectblock 达成类似能力 |
| L2 LLM | mindcraft AgentProcess 模式（参考后弃用） | 本实现采用进程内单 Provider（Node ≥22 全局 fetch 零依赖）；mindcraft 的 AgentProcess/JSONL IPC 在此规模无收益，见 l2.md |

## 重连与失败语义

- 断线分类：`name_conflict` / `access_denied` / `version_mismatch` / `illegal_message` = **fatal**（exit(2)，NSSM `AppExit 2 Exit` / systemd `StartLimitBurst` 停止重启等人工）；`behavior` / `server_full` / `maintenance` / `network_error` / **未知原因** = **非 fatal**（指数退避重连——24/7 headless bot 应扛过维护窗口）
- 退避：base 5s，×2，max 300s，±20% jitter；`minGapMs: 10s` 进程内防抖；spawn 即重置重连计数（attempt=0）
- **重连自愈（B1）**：每次 spawn 由 feature-layer 全量重建功能层（tasks/commands/L2 重新绑定新 bot，chat 监听重挂）——重连后命令与任务照常
- 热重载：配置文件变化（fs.watch 防抖 500ms，rename 重挂）/ `!reload`（Linux 另支持 SIGHUP）走同一串行队列 → 校验 → updateCfg → 日志配置变化重建 logger → 任务 diff 重载
- **退出不变量（第六轮 C5）**：`NSSM stop 总窗口（AppStopMethodConsole 20s）> signals SHUTDOWN_TIMEOUT_MS（15s）`——Ctrl+C 超时后 NSSM 发 CTRL_BREAK，Node 注册 SIGBREAK handler 走同一优雅路径；两处互引声明，改动需同步

## 任务运行语义（脚本化）

- **统一执行层**：8 个任务 = 动作原语脚本（`src/tasks/scripts/*.js`），与 LLM 的 act 动作数组**共用同一执行器**（`core/executor.js`——权限/exclusive/校验/超时/审计一致）。脚本 DSL：动作步 {op,args,as?,count?} + 控制步（loop/if/break/continue/return/count）+ 条件六型（last/result/counter/config/deadline/not）+ 模板求值（$结果引用/${options}/{expr 白名单四则}）+ 任务局部 op（有状态算法如 explore 螺旋）
- **BaseTask 状态机外壳保留**：run-completion（run 自然退出 → completed）、暂停（用户 pause 与 `_internalWait` 互不干扰）、取消（_cancel + abort signal 贯通）、代际守卫、stop 10s 上限、终态重启——全部原样继承
- **软失败语义**：脚本动作失败（ok:false）记录 lastResult 由 if 条件处理（重试/等待/退出）——原任务循环容错等价；maxActions 死循环兜底；脚本 init 钩子承载原任务 init 校验
- **调度**：cron 触发 `runScheduled`（防重叠；时长上限强制停止；完成/失败通知）；exclusive 互斥由 manager 仲裁（脚本内 bypassExclusive——**仅 exclusive 任务跳过守卫**；非 exclusive 任务（mine）的 build/movement 类动作在 exclusive 运行中被守卫软拒绝——脚本 if 重试承接，与 LLM act 语义一致）
- **任务链**：任务条目可配 `next: {id, type, options?, schedule?}`——本任务**自然完成**后自动注册并启动下一个（ad-hoc 形态，可 !task remove）；失败/停止不接力；config 校验 next 形状
- **自动存储**：collect_blocks 遇 NoChests 时附近 32 格找 chest/barrel 存入（工具与食物豁免，至多开 3 箱）再继续——替代 mine/chop/farm 脚本的 5 分钟干等；全部失败回退 inventoryFull 语义
- 完成语义表：mine(stopWhenDone) / fish(时长|背包满) / farm(stopWhenIdle) / chop / combat(maxTargets|stopWhenNoTargets) / breed(maxBreedings|stopWhenNoAnimals) / explore(stopWhenDone 环满|area 覆盖) 有自然完成；afk 无，scheduled 时必须配 `options.durationMinutes`

## 依赖 pin 策略（官方 npm + patch-package）

- `mineflayer ^4.37.1` / `minecraft-protocol ^1.66.2` / `minecraft-data ^3.113.0`：**全部官方 npm 版**（供应链干净、npm audit 正常、CI 无 git hack）。官方最新版仅支持到 1.21.11——26.1.2 协议 775 适配由 `patches/` 的 patch-package 补丁承担（mineflayer PR #3902 的 lib/ 适配：bed 属性新格式 / entityVelocityIsLpVec3 / use_entity 门控分支 / attack 独立包 / update_time clockUpdates；protocol PR #1487 的 src/version.js 支持列表），`postinstall` 自动应用
- `minecraft-data 3.113.0`：官方版已含 26.1.2 数据（实测 version 775），零补丁
- `prismarine-chunk 1.41.0`：官方 npm 版，overrides 固定（已含 26.1 支持）
- `prismarine-world 3.7.0`：官方 npm 版 + **本地补丁（raycast 同步化）**——`raycast` 等路径在 26.1 下同步返回（调用点均为同步消费）
- `prismarine-physics 1.11.1`：官方 npm 版 + **本地补丁（爬升根治）**——`computeOffsetX/Z` 半嵌位挤回脱嵌 + 贴墙截断停在"块面 ± 1e-4"（`F32_EPS`：协议位置 float32 上报舍入 3e-5 级，贴墙若停在"恰好块面"，服务器算的 AABB 与块重叠 1e-5 级 → Paper 位置校验拒绝 → 每 tick 拉回钉死；真实玩家贴墙位移 0 不触发校验所以没事）
- `mineflayer-pathfinder 2.4.5`：官方 npm 版 + **本地补丁（爬升根治）**——执行器 `canWalkJump` 失败分支保留 forward（bot 起跳中 onGround=false 模拟必然失败，停 forward 会让起跳后失去前进 → 反复原地跳"半格高悬停"）
- `.npmrc`：`legacy-peer-deps=true`（补丁不改版本号，peer 校验解析依赖官方版本即可，保留以维持单一副本解析）；无 git 依赖 → 无 `allow-git`
- 门禁：`npm run check:compat`（含 3.7 补丁哨兵门禁——5 个补丁缺失/未应用即 FAIL，哨兵目标文件缺失也 FAIL；每次部署预检，`npm test` 经 pretest 自动执行）；上游合并后迁移 = 删 patches + 删 postinstall（见 scripts/upstream-lib.mjs 头注释）

## 功能扩展语义

- **仓库管理**：`storage.chests` 配置仓库坐标——collect_blocks 背包满（NoChests）时 autoDeposit 优先存入配置仓库，未配置才附近搜索；`store_items`/`fetch_items` 原语（卸货/取货，工具与食物豁免）
- **工具耐久管理**：collect_blocks 挖掘前 `ensureMiningTool`——空手/手持将坏时从背包换该类最高材料等级工具（镐/斧/锹按方块推断，只升不降）；combat init 护甲自动装备（armorManager.equipAll 防御式）
- **farm 作物扩展**：crops.js 单一来源四元组（CROP_MATURITY age 型 / CROP_BY_BLOCK 高度+果实型 / SEED_BY_CROP / CROP_PLANT_MODE 种植模式）——甘蔗（高度型，收顶部保留根部）、南瓜/西瓜（果实块）、甜浆果/可可（age 型）；可可只收不种（玩家预种）
- **睡觉**：`sleep` 原语昼夜判定内部化（白天直接返回不阻塞）——找床 → 走到 → 睡 → wake 事件等待（listener 配对移除）；farm/combat `sleepAtNight: true` 可选
- **命名地点**：discovery places（32 上限带维度）——`!home`/`set_place` 登记，query_map place 分支查询（LLM 语义导航）
- **移动卡住诊断**：goto stuck 重试时记录周围 3×3 方块/手持/落地态（issue #1 现场数据——离线不可复现依赖此日志定位）

## 自主推进与危险记忆（Planner + World Model）

- **自主推进**：任务自然完成且无配置链 → `agent.onTaskCompleted` → 规划器（受限工具循环）读 goal 生成下一个任务。start_task 支持 `next`（任务链）/`schedule`（cron 定时）——config 与 start_task 共用 validateNextOptions/validateCron 校验口径。9 层保护见 docs/l2.md「自主推进」节；`l2.planEnabled`/`l2.planCooldownMs` 配置。v1.4.0 起 planner 是独立角色（见下）
- **危险区域记忆**：discovery dangerZones（snapshot v3）——hostile 出没坐标 chunk 去重 + 1h 新鲜窗口；写入 = exploreStep/ExploreTask 站点 + entityHurt 被动点；查询 = query_map danger 分支（实体瞬态无法 blockAt 验证，用 fresh/ageMinutes 标记）；被动注入 = system"危险:"行（`l2.dangerInjection`）
- **语义聚合（v1.4.0）**：discovery `queryResourcesWithRisk`（资源点附最近危险区距离/实体名）与 `assessLocation`（坐标安全评估，过期不算威胁）；query_map 四分支互斥（blockName/place/danger/assess），blockName 附 nearestDanger + `minSafeDist` 过滤；规划器 system 补"危险:"行——决策层与查询层都拿到聚合语义

## 多角色 Agent（单 bot 多角色，v1.4.0）

- **角色注册表**：createL2 返回 `{primary, planner, roles, get, all, roleStats, ...委托}`——恒有 primary（对话）+ planner（规划）两角色，`l2.roles` 配置自定义角色（systemPrompt/tools 白名单/planEnabled/enabled 角色级覆盖）；共享 provider/executor/tasks（仲裁器保证动作串行）。planner 恒创建（planEnabled 只门控自主推进）
- **L2 实例化改造**：SESSIONS key 带角色前缀（磁盘零改动 + 旧裸 key 首读迁移）；plan 冷却入实例、summarize 冷却留模块级共享（防并发推理）；pickGoalSession 剥离前缀（权限身份）——架构上为多 bot 扩展留了口（发现/仲裁/连接仍单实例，扩展点在 l2 层已验证）
- **零改动面**：feature-layer/manager/fl-*/commands 的 `ctx.agent` 消费面全部经注册表显式委托（onTaskCompleted 路由 planner）——单角色升级多角色无源码改动，纯配置驱动

## 自主学习循环（skill 库，v1.5.0）

- **学习闭环**：任务自然完成 → 注册表 onTaskCompleted **并行**触发（planner 自主推进 + `learnFromTask` 学习，独立冷却互不阻塞）→ LLM 提炼结构化 skill（SKILL_SUMMARIZER_PROMPT 严格 JSON：name/summary/steps[≤6]/pitfalls[≤3]）→ skills.json 落盘（同 taskType+name 覆盖刷新 usage++）→ 后续对话按活跃任务类型注入"技能:"段
- **三层记忆分工**：会话（短期）/ 经验（失败教训，op 键控）/ **技能（成功实践，taskType 键控）**——检索键正交；CORE 第 11 条低权威声明（技能是参考提示不是规则）
- **安全面**：skill 是文本提示非可执行代码（不引入 LLM 生成代码执行）；taskType 以 rec.entry.type 强制覆盖（LLM 乱起类型名不污染检索键）；失败静默不重试（下个任务完成自然重试）；failed 任务不学习（manager 调用点天然保证 + 状态门双保险）
- **边界**：config 任务链（next）接力完成不学习（链优先短路，v-next 可加 onTaskSucceeded 通道）；planOnce 规划不注入技能（v-next）

## 注释与文档约定

- **代码注释只解释当前代码**的意图/契约/边界（现在时态）：为什么这样设计、何时触发、什么条件下跳过、与哪里的契约对应
- **不写历史**：注释中禁止轮次标记（`（第 N 轮）`、`（C\d+）`、`（U\d+）`、`（P\d+）` 等）、commit 引用、"此前……"修复叙事——这些信息统一记录在 CHANGELOG.md（逐轮变更）与 docs/roadmap.md（决策与验证细节）
- **例外**：patch-package 补丁哨兵字符串（scripts/check-compat.mjs 与 patches/ 内）是补丁应用性的验证契约，其中含历史轮次标记时**不得改动**（改需同步 patches 且已应用 node_modules 无法重应用——维护成本大于规范收益，待上游合并后随补丁整体删除）
- 历史修复若对理解当前行为必要（如"必须停在块面 ±1e-4 否则服务器拉回"），以**现在时的行为后果**表述，不叙述修复过程
- 新代码合入时：轮次式开发中"这轮做了什么"只进 CHANGELOG/roadmap，注释保持与文档解耦（改文档不需改注释）

## 质量工具

- **ESLint 10 flat config**（`eslint.config.js`）：eslint:recommended + 项目风格（无分号/单引号/2 空格），覆盖 src/tests/scripts；src 的 .ts 文件经 @typescript-eslint/parser 同一套规则解析；CI 门禁 `npm run lint`
- **全量 TS（第二阶段完成）**：src 72 个文件全部 .ts，Node ≥24 原生类型剥离直接运行（无构建步骤）；`npm run typecheck`（tsc -p，noEmit + allowImportingTsExtensions）门禁。迁移注意点（此 TS 版本行为）：JSDoc `@type` 表达式断言与带默认初始化器的 `@param` 在 .ts 中失效——类型修正一律用内联注解/`as` 断言；类属性需显式声明（不再从构造函数赋值推断）。typescript devDep 为 6.0 线（typescript-eslint 支持的 TS 6 API；TS 7 支持仍在 typescript-eslint 跟踪中，合并后再升级）
- **覆盖率**：`npm run test:coverage`（node --test lcov → coverage/lcov.info，CI artifact）；基线多数模块 85-100% 行覆盖，**暂不设阈值**（mock 为主，阈值意义有限）——引入真机集成测试后再设
- 类型门禁已拦截的真实缺陷示例（证明工具价值）：observe_blocks regex 路径 TDZ 使用 dim（运行时必崩）、collect_blocks const chests 重新赋值（NoChests 分支必抛）——同类错误在开发期暴露

## 已知风险

- mineflayer PR #3902 / minecraft-protocol PR #1487 上游仍未合并。补丁是本地载体：升级这两个包版本时补丁 context 冲突会显式报错（patch-package 行为，不会静默），需按 docs/upstream-migration.md 重新生成；mineflayer 补丁的 use_entity 已改**无条件新格式**（`{target, hand, location(lpVec3 必填), sneaking}` + 独立 attack 包——去特征门控，与 26.1.2 真实 schema 一致），项目层 entity-actions.ts 的原始包与之匹配（check-compat 哨兵按新格式验证）。注意：补丁只对 26.1.2 正确——回退旧 mcVersion 需恢复门控（保守保留至上游合并）
- `npm audit` 的 axios 漏洞全部位于 Microsoft 认证链（prismarine-auth → @xboxreplay/xboxlive-auth），offline 模式不执行该路径。**已接受风险**（第六轮 C1 评估：overrides 覆盖 axios 版本有破坏 prismarine-auth 兼容性的风险，offline 部署不触达该链；CI 审计步骤信息性标记，不门禁）
- pino v9 transport 无法主动拆除：反复改日志配置会累积文件句柄（接受，文档化）。**仅 rotate/pretty/dir 变化才重建 logger**（只改 level 时复用 transport——旧实现双写同一 bot.log 会丢行/坏 JSONL）
- 审计日志（audit.log）为**进程级共享单例**（dir+keepDays 键缓存）：热重载改 log.dir 时旧 worker 随旧配置弃用（句柄累积面收敛）
- 任务长 idle LLM 播报依赖 summarize（60s 全局冷却与死亡/任务播报共享）：高密度死亡场景下 idle 播报可能被冷却饿死（已按任务+原因去重 + 1 小时冷却限制频次，接受）
- **LLM 提示注入残余风险**：CORE_SYSTEM_PROMPT 有注入防御段（玩家消息是唯一输入），执行器 op 权限门拦截非 op 会话的危险动作；但 **op 玩家自己的会话被注入文本时无二次确认**（LLM 自主性优先的设计取舍）——不做动作确认，文档化接受；部署机验证项见 docs/acceptance.md
- **真机验证缺口**：功能迭代以离线 mock 测试为主，真实服务器交互项（B1 仓库/B4 作物/B5 睡觉/B6 剪羊毛等）集中在 docs/acceptance.md 跟踪——release 前应核对清单，缺失验收项不阻塞 release 但需显式记录
- 自动存储开箱依赖 collectblock 的 NoChests 错误码；找不到箱子/UI 卡死时回退 inventoryFull 语义（5 分钟等待）——不改变任务失败行为
