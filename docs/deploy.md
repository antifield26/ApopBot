# 部署指南（Bot: Windows PC / 服务端: 树莓派）

## 拓扑

```
树莓派 5 8G (LAN 192.168.3.93)            Windows PC
├── PaperMC 26.1.2 服务端                 ├── Bot —— NSSM 服务 minecraft-bot
│   └── systemd/minecraft-server.service
│   └── 白名单: mcbot / mcbot-test           └── deploy.ps1 一键部署
└── white-list=true
```

- PaperMC 服务端仍在树莓派运行（单元文件 `systemd/minecraft-server.service` ）

## 环境准备（Windows PC，一次性）

```powershell
winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements   # Node.js LTS（当前 24；部署机实际运行 26）
winget install --id NSSM.NSSM --accept-package-agreements --accept-source-agreements           # Windows 服务注册
winget install --id Git.Git                                                                     # git（部署拉取用；依赖已无 git 引用，npm ci 不再需要）
```

重开 shell 后验证：`node -v`（≥22）、`nssm version`。

> v1.0.0（C1）：依赖全部为官方 npm 版，26.1.2 协议适配由 `patches/` 的 patch-package
> 补丁承担（`npm install`/`npm ci` 的 postinstall 自动应用，无需任何手工步骤）。
> 升级 mineflayer/minecraft-protocol 版本时补丁会因 context 冲突报错——先删补丁重装
> 再按 docs/upstream-migration.md 重新生成。

重开 shell 后验证：`node -v`（≥22）、`nssm version`。

## 目录布局

- 建议 `C:\minecraft-bot`（整仓拷贝/克隆）
- 日志：`log.dir` 默认 `./logs`（项目内，无需额外目录；相对路径基于项目根解析，跨平台）
- 配置：`config/config.json`（gitignore；缺失时 deploy.ps1 从 example 复制，不会覆盖已有配置）
- 私密配置：`config/service.env`（gitignore；`KEY=VALUE` 行，`#` 开头为注释）→ deploy.ps1 注入 NSSM 服务环境变量（L2 密钥只走这里）

## Bot 配置（config/config.json）

```json
{
  "host": "mc.antifield.work",
  "username": "mcbot",
  "ops": ["steve", "alex"],
  "l2": { "enabled": true, "model": "claude-sonnet-5" }
}
```

- `host` 指向服务端域名 `mc.antifield.work`（DNS 指向 Pi 的当前 IP；Pi 换 IP 只改 DNS，Bot 重连时自动解析新地址，DNS 解析失败归类为 network_error 自动退避重连而非 fatal）。`localhost` 仅限开发机连本机服务端
- `username: mcbot` 已在服务端白名单；smoke 用 `config/smoke.json` 以 mcbot-test 身份登录（同样需白名单）
- L2 仅云端 Anthropic 兼容 API（v1.0.0）；API key 走 `l2.cloudApiKeyEnv` 指定环境变量（service.env 注入），见 [docs/l2.md](l2.md)

## 部署（管理员 PowerShell）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1          # 部署 + 启动/重启
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Smoke   # 部署后冒烟快速档（connect,spawn,chat）
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Status  # 只读状态（无需管理员）
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Restart # 仅重启服务
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Update  # U11 一键更新：git pull → 完整部署流程 → 重启（消除手动 git pull + 重跑两步）
```

deploy.ps1 流程：预检（node ≥22、非 Store 存根、nssm 存在）→ 补 config.json → 依赖哈希门控 `npm ci --omit=dev` → `check:compat` + `npm test` → 服务不存在则 `nssm install` → **重跑全部 `nssm set`（幂等，参数变更即生效）** → 启动/重启。`nssm set` 不自动提权，故变更操作必须在管理员 shell 中执行。

## NSSM 服务语义（systemd → NSSM 映射）

| systemd（原 Linux 部署） | NSSM / Windows |
|---|---|
| `Restart=on-failure` + `RestartSec=10` | 非 0 退出码默认自动重启 + `AppRestartDelay 10000`（崩溃 10s 后拉起） |
| `StartLimitBurst=5`（fatal 后停止） | `AppExit 2 Exit`：fatal（exit 2：白名单拒绝/名字冲突/版本不匹配）→ 服务一次即停等人工；修复后 `nssm start minecraft-bot` |
| `ExecReload`（SIGHUP） | Windows 无 SIGHUP。热重载 = 改 config 自动生效（fs.watch 500ms 防抖）/ 游戏内 `!reload` / `nssm restart` |
| `EnvironmentFile=/etc/minecraft-bot/env` | `AppEnvironmentExtra`（deploy.ps1 从 `config/service.env` 注入）；改动后重跑 deploy 或手动 `nssm set` + restart |
| `CPUWeight=30` | `AppPriority BELOW_NORMAL_PRIORITY_CLASS`（低优先级：其他程序优先） |
| `MemoryHigh` / `MemoryMax` | **无等价**（Windows 无 cgroup）→ 内存靠预算与监控（见性能） |
| `LogsDirectory` + `StandardOutput=journal` | pino `logs/bot.log` 按天轮转 + `AppStdout/AppStderr` → `logs/nssm-*.log` |
| `systemctl status` / `journalctl -u minecraft-bot -f` | `nssm status minecraft-bot` / `Get-Content logs\bot.log -Encoding UTF8 -Wait` |
| `systemctl stop/restart` | `nssm stop/restart minecraft-bot`（stop 发 Ctrl+C 事件 → Node SIGINT → 优雅退出：停任务→断开→flush 日志） |
| `systemctl reset-failed` | 不需要（`AppExit 2 Exit` 后服务为 Stopped，修复后直接 `nssm start`） |

## 日常运维

```powershell
nssm status minecraft-bot                  # 状态（SERVICE_RUNNING / STOPPED）
nssm restart minecraft-bot                 # 全量重启
Get-Content logs\bot.log -Encoding UTF8 -Wait             # 实时日志（pino 按天轮转；UTF8 编码——PS 5.1 默认 ANSI 读中文乱码）
Get-Content logs\nssm-stderr.log -Encoding UTF8 -Tail 50  # 启动期 stderr（服务起不来先看这里）
```

游戏内命令（op 白名单在 `config.ops`）：`!ping` `!status` `!task list` `!task new <type> <id> [json]` `!task remove <id>` `!task start|stop|pause|resume <id>` `!reload` `!say` `!pos` `!find <方块> [距离]` `!follow <player>|off` `!agent chat|act|doctor|reset ...`。完整说明见 README 指令列表（含 `!task list` 的排队位置/剩余时长/下次 cron 字段与 `!find` 的 16-256 限幅）。

## 性能（低配 PC：i7-4720HQ / 8GB DDR3）

内存预算（约）：

| 组件 | 占用 |
|---|---|
| Windows + 系统进程 | ~2GB |
| （v1.0.0 起推理在云端——本地无 LLM 进程） | — |
| Bot（Node） | 200–400MB |
| 余量 | ~1GB（浏览器等重程序按需关闭） |

- 依赖安装 `--omit=dev`（deploy.ps1 默认，省 dev 包）
- Bot 已设 `BELOW_NORMAL_PRIORITY_CLASS`：其他程序优先；卡顿可 `nssm set minecraft-bot AppPriority NORMAL_PRIORITY_CLASS` 后 restart
- `maxSteps: 8` / `maxActionsPerCall: 8` 保持默认（防 LLM 工具循环吃 CPU）；`l2.cooldownMs` 可调大（如 10000）降低请求负载；`l2.cloudTimeoutMs` 默认 60s
- 任务均为区域限定；farm/chop/combat/breed 为 exclusive 互斥（不会并发抢寻路/采集）
- 无 MemoryMax 等价物：用任务管理器观察；LLM 推理在云端（v1.0.0），本地负载主要是 Bot 自身

## 验证清单

```bash
# 开发机/部署机（Windows）：
npm ci && npm test && npm run check:compat
# Windows PC（需树莓派服务端在线）：
node scripts/check-compat.mjs --probe
node scripts/smoke.mjs --config config/smoke.json --host mc.antifield.work          # 全步骤（mine 默认 SKIP，--dangerous 开启）
node scripts/smoke.mjs --config config/smoke.json --host mc.antifield.work --steps connect,spawn,chat   # 快速档
```

## 故障排查

| 症状 | 排查 |
|---|---|
| 服务启动即停止 | `Get-Content logs\nssm-stderr.log -Encoding UTF8 -Tail 50` + `logs\bot.log`。fatal（exit 2：白名单拒绝/名字冲突/版本不匹配）触发 `AppExit 2 Exit` 停止——修复后 `nssm start minecraft-bot` |
| 服务反复重启 | 启动期错误（exit 1，如配置/日志目录问题）每 10s 重试 → 看 `logs\bot.log` 首段报错 |
| 启动即退出 "日志目录不可写" | `log.dir` 指向不可写路径；改用默认 `./logs` 或确认运行账户写权限 |
| 连不上服务端 | `Test-NetConnection mc.antifield.work -Port 25565`（IP 直测可换 `192.168.3.93`）；确认 DNS 解析正确、服务端在线、`host` 正确、Windows 防火墙放行出站 25565 |
| `unsupported protocol version` | 本地 `npm run check:compat` 未过；overrides 被意外改动 |
| LLM 请求超时/无响应 | 检查云端端点连通（`!agent doctor`）与 `l2.cloudTimeoutMs` |
| 挖矿任务不动 | `!task list` 看 waitingReason（no-target/inventory-full/collect-retry）；背包满需配置 `chestLocations` 或清空背包 |
| 定时任务不执行 | 检查 `schedule` 表达式与 `scheduleTimezone`；afk 类无自然完成的任务必须配 `options.durationMinutes` |
