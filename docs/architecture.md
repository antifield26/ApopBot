# 架构

## 总体结构

```
minecraft-bot (Node.js ≥22, ESM)
├── src/index.js              入口：配置 → logger → ConnectionManager → 任务/命令/L2 → 信号
├── src/core/                 基础设施
│   ├── config.js             配置分层加载与校验（默认值 < default.json < --config < MCBOT_* < CLI）
│   ├── logger.js             pino 结构化日志（文件按天轮转 + stdout → journald）
│   ├── connection.js         ConnectionManager：连接/退避重连/spawn 超时/致命退出
│   ├── reconnect.js          断线分类（classifyDisconnect）+ 指数退避（nextBackoff），纯函数
│   ├── bot.js                createBot + 插件装载
│   └── signals.js            SIGINT/SIGTERM 优雅退出；SIGHUP 热重载
├── src/tasks/                任务系统
│   ├── base.js               BaseTask 状态机（created→init→running⇄paused→stopped/failed）
│   ├── manager.js            TaskManager：装载/启停/热重载 diff/cron 调度
│   ├── mine.js               MineTask：collectblock+pathfinder 按区域挖矿
│   ├── fish.js               FishTask：bot.fish() 循环
│   ├── afk.js                AfkTask：周期视角转动防踢
│   └── scheduled.js          croner 调度包装
├── src/commands/             聊天命令系统
│   ├── parser.js             shell 式引号感知解析（token 内 " 按字面，支持 JSON 参数）
│   ├── permissions.js        config.ops 白名单（offline 模式无法查 OP）
│   ├── registry.js           注册/分发/权限校验
│   └── commands.js           内置命令
├── src/plugins/              mineflayer 生态插件装载（pathfinder→tool→collectBlock→autoEat→armorManager）
├── src/l2/                   LLM 层（l2.enabled=false 时零依赖）
└── src/util/                 promise-timeout
```

## 分层决策（为什么这样整合）

| 层 | 来源 | 决策 |
|---|---|---|
| 协议层 | **mineflayer**（PrismarineJS） | 唯一协议级 headless 实现、27 版本集成测试、MIT。直接依赖 PR #3902 分支获得 775 支持 |
| 生产模式 | **mindcraft**（借鉴，不依赖） | LoginGuard 断线分类 → 本项目 `reconnect.js`；10s 崩溃保护 → `minGapMs` + systemd StartLimitBurst；配置分层 → `config.js`。mindcraft 锁定 mineflayer 4.33.0 + patch-package，不适合生产依赖 |
| 任务/技能 | **Voyager**（借鉴思想） | control_primitives 原子技能思想 → 本项目任务系统（mine/fish/afk）作为 L2 agent 的技能层 |
| 寻路 | **baritone**（仅参考） | 客户端 Mod 无法 headless 集成；本项目用 mineflayer-pathfinder + collectblock 达成类似能力 |
| L2 LLM | mindcraft AgentProcess 模式 | 子进程 + JSONL IPC（见 l2.md），避免进程内依赖污染 |

## 重连与失败语义

- 断线分类：`name_conflict` / `access_denied` / `version_mismatch` / 未知原因 = **fatal**（exit(2)，systemd 连续 5 次失败停止服务等人工）；`behavior` / `server_full` / `maintenance` / `network_error` = **非 fatal**（指数退避重连）
- 退避：base 5s，×2，max 300s，±20% jitter；`minGapMs: 10s` 进程内防抖；spawn 后正常运行 60s 重置计数
- 热重载：SIGHUP（`systemctl reload`）或配置文件变化（fs.watch 防抖 500ms）→ 任务 diff 重载

## 依赖 pin 策略（协议 775 的核心）

- `mineflayer`：git SHA 直接依赖（PR #3902）
- `minecraft-data`：overrides 固定 `3.112.0`（npm 正式版已含 775）
- `minecraft-protocol` / `prismarine-chunk` / `prismarine-physics`：overrides 固定官方 PR 分支 SHA（防止 PR 分支 package.json 里指向作者 fork 的可变分支引用被拉取）
- `.npmrc`：`legacy-peer-deps=true`（npm 无法解析 git 依赖版本做 peer 校验，语义上已满足）+ `allow-git=all`（npm 12+ 供应链安全默认禁止 git 依赖，全部为 SHA 固定的官方仓库）
- 门禁：`npm run check:compat`（每次部署预检）；迁移：`npm run migrate-upstream`（上游合并后一键回切）

## 已知风险

- `prismarine-chunk` PR #326 已被 close 未合并（fluid count 修复缺失）。当前 pin 的分支 SHA 不可变所以安全，但若上游彻底放弃该修复需备选 mneuhaus fork 分支（见 package.json 注释与 upstream-migration.md）
- `npm audit` 的 axios 漏洞全部位于 Microsoft 认证链（prismarine-auth → @xboxreplay/xboxlive-auth），offline 模式不执行该路径
