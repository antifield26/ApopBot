# 架构

## 总体结构

```
minecraft-bot (Node.js ≥22, ESM)
├── src/index.js              入口：配置 → logger → ConnectionManager → 功能层 → 信号
├── src/core/                 基础设施
│   ├── config.js             配置分层加载与校验（默认值 < default.json < --config < MCBOT_* < CLI；
│   │                          v1.0.0 契约冻结：l2 子键白名单 + CONFIG_SCHEMA_VERSION）
│   ├── logger.js             pino 结构化日志（文件按天轮转 + stdout）
│   ├── connection.js         ConnectionManager：连接/退避重连/spawn 超时/致命退出
│   ├── reconnect.js          断线分类（classifyDisconnect）+ 指数退避（nextBackoff），纯函数
│   ├── bot.js                createBot（同步）+ loadMineflayerPlugins（异步，事件零丢失窗口）
│   ├── feature-layer.js      功能层生命周期（每次 spawn 全量重建 tasks/commands/L2 + chat 监听）
│   ├── chat.js               聊天安全层（256 字符分片发送）
│   ├── signals.js            SIGINT/SIGTERM 优雅退出；热重载（配置监视/!reload，Linux 另支持 SIGHUP）
│   ├── primitives.js         动作原语注册表（v1.0.0：28 个原语——观察/移动/构建/战斗/交互/物品/流程/任务）
│   ├── executor.js           动作执行器（LLM act 数组与任务脚本共用：权限/exclusive/校验/超时/审计）
│   ├── audit.js              动作审计日志（logs/audit.log JSONL 按天轮转）
│   ├── state.js              schemaVersion 2 + 迁移器（未来版本拒绝加载）
│   ├── movement.js / entity-actions.js / arbiter.js / entities.js / resources.js / crops.js / discovery.js / explore.js / environment.js
│   └── (task-schemas.js)     任务 options schema 校验（!task new 与 start_task 共用入口）
├── src/tasks/                任务系统（v1.0.0 脚本化：任务 = 动作原语脚本）
│   ├── base.js               BaseTask 状态机（created→init→running⇄paused→stopped/completed/failed；
│   │                          run-completion 语义 + 终态重启 + _cancel 取消钩子 + _internalWait）
│   ├── manager.js            TaskManager：装载/启停/热重载 diff/cron 调度/临时任务/防重叠
│   ├── runner.js             ScriptTask（BaseTask 子类）+ ScriptRunner（脚本 DSL 解释器：
│   │                          loop/if/break/continue/return/count + 条件六型 + 模板求值 + 任务局部 op）
│   ├── scripts/              mine/fish/afk/farm/chop/combat/breed/explore 8 个任务脚本
│   ├── types.js              任务类型单一注册表（factory → ScriptTask + 脚本定义）
│   └── scheduled.js          croner 调度包装（单一 onTrigger 回调）
├── src/commands/             聊天命令系统
│   ├── parser.js             shell 式引号感知解析（token 内 " 按字面，支持 JSON 参数；未闭合引号报错）
│   ├── permissions.js        config.ops 白名单（offline 模式无法查 OP；大小写不敏感）
│   ├── registry.js           注册/分发/权限校验/op 命令速率限制
│   └── commands.js           内置命令
├── src/plugins/              mineflayer 生态插件装载（pathfinder→collectBlock→autoEat→armorManager→follow（条件装载））
├── src/l2/                   LLM 层（l2.enabled=false 时零依赖；单 Provider 见 docs/l2.md）
│   ├── agent-interface.js    chat 工具循环（act 动作数组 + 观察工具）+ 反思钩子（经验沉淀）
│   ├── provider.js           云端 Anthropic 兼容 API（non-reasoning）
│   ├── sessions.js           会话落盘（data/sessions.json）
│   ├── experience.js         经验记忆库（data/experience.json）
│   └── index.js              createL2 组装
└── src/util/                 promise-timeout
```

## 分层决策（为什么这样整合）

| 层 | 来源 | 决策 |
|---|---|---|
| 协议层 | **mineflayer**（PrismarineJS） | 唯一协议级 headless 实现、27 版本集成测试、MIT。直接依赖 PR #3902 分支获得 775 支持 |
| 生产模式 | **mindcraft**（借鉴，不依赖） | LoginGuard 断线分类 → 本项目 `reconnect.js`；10s 崩溃保护 → `minGapMs` + 服务管理器重启语义（NSSM `AppExit 2 Exit` / systemd `StartLimitBurst`）；配置分层 → `config.js`。mindcraft 锁定 mineflayer 4.33.0 + patch-package，不适合生产依赖 |
| 任务/技能 | **Voyager**（借鉴思想） | control_primitives 原子技能思想 → 本项目任务系统（7 种任务）作为 L2 agent 的技能层 |
| 寻路 | **baritone**（仅参考） | 客户端 Mod 无法 headless 集成；本项目用 mineflayer-pathfinder + collectblock 达成类似能力 |
| L2 LLM | mindcraft AgentProcess 模式（参考后弃用） | 本实现采用进程内双 Provider（Node 22 全局 fetch 零依赖）；mindcraft 的 AgentProcess/JSONL IPC 在此规模无收益，见 l2.md |

## 重连与失败语义

- 断线分类：`name_conflict` / `access_denied` / `version_mismatch` / `illegal_message` = **fatal**（exit(2)，NSSM `AppExit 2 Exit` / systemd `StartLimitBurst` 停止重启等人工）；`behavior` / `server_full` / `maintenance` / `network_error` / **未知原因** = **非 fatal**（指数退避重连——24/7 headless bot 应扛过维护窗口）
- 退避：base 5s，×2，max 300s，±20% jitter；`minGapMs: 10s` 进程内防抖；spawn 即重置重连计数（attempt=0）
- **重连自愈（B1）**：每次 spawn 由 feature-layer 全量重建功能层（tasks/commands/L2 重新绑定新 bot，chat 监听重挂）——重连后命令与任务照常
- 热重载：配置文件变化（fs.watch 防抖 500ms，rename 重挂）/ `!reload`（Linux 另支持 SIGHUP）走同一串行队列 → 校验 → updateCfg → 日志配置变化重建 logger → 任务 diff 重载
- **退出不变量（第六轮 C5）**：`NSSM stop 总窗口（AppStopMethodConsole 20s）> signals SHUTDOWN_TIMEOUT_MS（15s）`——Ctrl+C 超时后 NSSM 发 CTRL_BREAK，Node 注册 SIGBREAK handler 走同一优雅路径；两处互引声明，改动需同步

## 任务运行语义（v1.0.0 脚本化）

- **统一执行层**：8 个任务 = 动作原语脚本（`src/tasks/scripts/*.js`），与 LLM 的 act 动作数组**共用同一执行器**（`core/executor.js`——权限/exclusive/校验/超时/审计一致）。脚本 DSL：动作步 {op,args,as?,count?} + 控制步（loop/if/break/continue/return/count）+ 条件六型（last/result/counter/config/deadline/not）+ 模板求值（$结果引用/${options}/{expr 白名单四则}）+ 任务局部 op（有状态算法如 explore 螺旋）
- **BaseTask 状态机外壳保留**：run-completion（run 自然退出 → completed）、暂停（用户 pause 与 `_internalWait` 互不干扰）、取消（_cancel + abort signal 贯通）、代际守卫、stop 10s 上限、终态重启——全部原样继承
- **软失败语义**：脚本动作失败（ok:false）记录 lastResult 由 if 条件处理（重试/等待/退出）——原任务循环容错等价；maxActions 死循环兜底；脚本 init 钩子承载原任务 init 校验
- **调度**：cron 触发 `runScheduled`（防重叠；时长上限强制停止；完成/失败通知）；exclusive 互斥由 manager 仲裁（脚本内 bypassExclusive——owner 自己）
- 完成语义表：mine(stopWhenDone) / fish(时长|背包满) / farm(stopWhenIdle) / chop / combat(maxTargets|stopWhenNoTargets) / breed(maxBreedings|stopWhenNoAnimals) / explore(stopWhenDone 环满|area 覆盖) 有自然完成；afk 无，scheduled 时必须配 `options.durationMinutes`

## 依赖 pin 策略（v1.0.0 C1：官方 npm + patch-package）

- `mineflayer ^4.37.1` / `minecraft-protocol ^1.66.2` / `minecraft-data ^3.113.0`：**全部官方 npm 版**（供应链干净、npm audit 正常、CI 无 git hack）。官方最新版仅支持到 1.21.11——26.1.2 协议 775 适配由 `patches/` 的 patch-package 补丁承担（mineflayer PR #3902 的 lib/ 适配：bed 属性新格式 / entityVelocityIsLpVec3 / use_entity 门控分支 / attack 独立包 / update_time clockUpdates；protocol PR #1487 的 src/version.js 支持列表），`postinstall` 自动应用
- `minecraft-data 3.113.0`：官方版已含 26.1.2 数据（实测 version 775），零补丁
- `prismarine-chunk 1.41.0` / `prismarine-physics 1.11.1`：官方 npm 版，overrides 固定（已含 26.1 支持）
- `.npmrc`：`legacy-peer-deps=true`（补丁不改版本号，peer 校验解析依赖官方版本即可，保留以维持单一副本解析）；无 git 依赖 → 无 `allow-git`
- 门禁：`npm run check:compat`（含 3.7 补丁哨兵门禁——补丁缺失/未应用即 FAIL；每次部署预检）；上游合并后迁移 = 删 patches + 删 postinstall（见 scripts/upstream-lib.mjs 头注释）

## 已知风险

- mineflayer PR #3902 / minecraft-protocol PR #1487 上游仍未合并。补丁是本地载体：升级这两个包版本时补丁 context 冲突会显式报错（patch-package 行为，不会静默），需按 docs/upstream-migration.md 重新生成；26.1.2 的 use_entity 仍走旧格式（`useEntityUsesEntityId` feature=false），项目层 entity-actions.js 的旧格式原始包与之一致（部署机已验证），上游合并新格式后可删（保守保留）
- `npm audit` 的 axios 漏洞全部位于 Microsoft 认证链（prismarine-auth → @xboxreplay/xboxlive-auth），offline 模式不执行该路径。**已接受风险**（第六轮 C1 评估：overrides 覆盖 axios 版本有破坏 prismarine-auth 兼容性的风险，offline 部署不触达该链；CI 审计步骤信息性标记，不门禁）
- pino v9 transport 无法主动拆除：反复改日志配置会累积文件句柄（接受，文档化）
