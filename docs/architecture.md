# 架构

## 总体结构

```
minecraft-bot (Node.js ≥22, ESM)
├── src/index.js              入口：配置 → logger → ConnectionManager → 功能层 → 信号
├── src/core/                 基础设施
│   ├── config.js             配置分层加载与校验（默认值 < default.json < --config < MCBOT_* < CLI）
│   ├── logger.js             pino 结构化日志（文件按天轮转 + stdout）
│   ├── connection.js         ConnectionManager：连接/退避重连/spawn 超时/致命退出
│   ├── reconnect.js          断线分类（classifyDisconnect）+ 指数退避（nextBackoff），纯函数
│   ├── bot.js                createBot（同步）+ loadMineflayerPlugins（异步，事件零丢失窗口）
│   ├── feature-layer.js      功能层生命周期（每次 spawn 全量重建 tasks/commands/L2 + chat 监听）
│   ├── chat.js               聊天安全层（256 字符分片发送）
│   └── signals.js            SIGINT/SIGTERM 优雅退出；热重载（配置监视/!reload，Linux 另支持 SIGHUP）
├── src/tasks/                任务系统
│   ├── base.js               BaseTask 状态机（created→init→running⇄paused→stopped/completed/failed；
│   │                          run-completion 语义 + 终态重启 + _cancel 取消钩子 + _internalWait）
│   ├── manager.js            TaskManager：装载/启停/热重载 diff/cron 调度/临时任务/防重叠
│   ├── mine.js               MineTask：collectblock+pathfinder 按区域挖矿（背包满暂停/stopWhenDone）
│   ├── fish.js               FishTask：bot.fish() 循环（60s 超时兜底）
│   ├── afk.js                AfkTask：周期视角转动防踢
│   ├── farm.js               FarmTask：种植/等待成熟/收割循环
│   ├── chop.js               ChopTask：按区域伐木
│   ├── combat.js             CombatTask：区域内敌对实体战斗巡逻
│   ├── breed.js              BreedTask：动物喂养繁殖
│   └── scheduled.js          croner 调度包装（单一 onTrigger 回调）
├── src/commands/             聊天命令系统
│   ├── parser.js             shell 式引号感知解析（token 内 " 按字面，支持 JSON 参数；未闭合引号报错）
│   ├── permissions.js        config.ops 白名单（offline 模式无法查 OP；大小写不敏感）
│   ├── registry.js           注册/分发/权限校验/op 命令速率限制
│   └── commands.js           内置命令
├── src/plugins/              mineflayer 生态插件装载（pathfinder→tool→collectBlock→autoEat→armorManager）
├── src/l2/                   LLM 层（l2.enabled=false 时零依赖；双 Provider 见 docs/l2.md）
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

- 断线分类：`name_conflict` / `access_denied` / `version_mismatch` = **fatal**（exit(2)，NSSM `AppExit 2 Exit` / systemd `StartLimitBurst` 停止重启等人工）；`behavior` / `server_full` / `maintenance` / `network_error` / **未知原因** = **非 fatal**（指数退避重连——24/7 headless bot 应扛过维护窗口）
- 退避：base 5s，×2，max 300s，±20% jitter；`minGapMs: 10s` 进程内防抖；spawn 后正常运行 60s 重置计数
- **重连自愈（B1）**：每次 spawn 由 feature-layer 全量重建功能层（tasks/commands/L2 重新绑定新 bot，chat 监听重挂）——重连后命令与任务照常
- 热重载：配置文件变化（fs.watch 防抖 500ms，rename 重挂）/ `!reload`（Linux 另支持 SIGHUP）走同一串行队列 → 校验 → updateCfg → 日志配置变化重建 logger → 任务 diff 重载

## 任务运行语义

- **run-completion**：`startTask` 返回 run 完成 Promise；run 自然退出 → `completed`，stop → `stopped`，抛错 → `failed`；终态可重启（`!task start` 生效）
- **调度**：cron 触发 `runScheduled`（防重叠：运行中触发跳过；时长上限强制停止；完成/失败聊天通知，`notifyChat:false` 关闭）
- **暂停**：用户 pause 与任务内部等待（`_internalWait` + `waitingReason`）互不干扰
- 完成语义表：mine(stopWhenDone) / fish(时长) / farm / chop / combat / breed 有自然完成；afk 无，scheduled 时必须配 `options.durationMinutes`

## 依赖 pin 策略（协议 775 的核心）

- `mineflayer`：git SHA 直接依赖（PR #3902）
- `minecraft-data`：overrides 固定 `3.112.0`（npm 正式版已含 775）
- `minecraft-protocol`：overrides 固定官方 PR 分支 SHA（PR #1487 未合并）
- `prismarine-chunk 1.41.0` / `prismarine-physics 1.11.1`：**官方 npm 版本覆盖**（2026-07-31 已发布 26.1 支持；mineflayer PR 分支声明 mneuhaus fork 的可变分支名，overrides 强制官方版以消除 force-push 风险）
- `.npmrc`：`legacy-peer-deps=true`（npm 无法解析 git 依赖版本做 peer 校验，语义上已满足）+ `allow-git=all`（npm 12+ 供应链安全默认禁止 git 依赖，git 引用全部为 SHA 固定的官方仓库）
- 门禁：`npm run check:compat`（每次部署预检，含 chunk/physics 26.1 内容检查与版本一致性）；迁移：`npm run migrate-upstream`（上游合并后一键回切）

## 已知风险

- mineflayer PR #3902 / minecraft-protocol PR #1487 尚未合并（上游链进度：chunk 已合、physics 已发布、protocol/mineflayer 待合）。SHA pin 不可变；上游合并后 `npm run migrate-upstream -- --check` 检测
- `npm audit` 的 axios 漏洞全部位于 Microsoft 认证链（prismarine-auth → @xboxreplay/xboxlive-auth），offline 模式不执行该路径
- pino v9 transport 无法主动拆除：反复改日志配置会累积文件句柄（接受，文档化）
