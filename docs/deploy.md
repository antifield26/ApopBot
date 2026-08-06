# 部署指南（Bot: Windows PC / 服务端: 树莓派）

## 拓扑

```
树莓派 5 8G (LAN 192.168.3.93)            Windows PC（低配：i7-4720HQ / 8GB DDR3）
├── PaperMC 26.1.2 服务端                 ├── Bot —— NSSM 服务 minecraft-bot
│   └── systemd/minecraft-server.service  ├── Ollama（qwen3.5:4b，L2 本地推理）
│   └── 白名单: mcbot / smokebot           └── deploy.ps1 一键部署
└── white-list=true
```

- Bot 不再部署到树莓派（旧 Linux 产物 `deploy.sh` / `minecraft-bot.service` 在 [legacy/](../legacy/README.md)）
- PaperMC 服务端仍在树莓派运行（单元文件 `systemd/minecraft-server.service` 未移动）

## 环境准备（Windows PC，一次性）

```powershell
winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements   # Node.js 22 LTS
winget install --id NSSM.NSSM --accept-package-agreements --accept-source-agreements           # Windows 服务注册
winget install --id Git.Git                                                                     # git（npm ci 需要）
# npm ci 的 git+ssh 依赖（mineflayer PR pin）防挂起：
git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"
```

重开 shell 后验证：`node -v`（≥22）、`nssm version`。

## 目录布局

- 建议 `C:\minecraft-bot`（整仓拷贝/克隆）
- 日志：`log.dir` 默认 `./logs`（项目内，无需额外目录；相对路径基于项目根解析，跨平台）
- 配置：`config/config.json`（gitignore；缺失时 deploy.ps1 从 example 复制，不会覆盖已有配置）
- 私密配置：`config/service.env`（gitignore；`KEY=VALUE` 行，`#` 开头为注释）→ deploy.ps1 注入 NSSM 服务环境变量（L2 密钥只走这里）

## Bot 配置（config/config.json）

```json
{
  "host": "192.168.3.93",
  "username": "mcbot",
  "ops": ["steve", "alex"],
  "l2": { "enabled": true, "provider": "ollama", "ollamaModel": "qwen3.5:4b" }
}
```

- `host` 指向树莓派局域网 IP（`localhost` 仅限开发机连本机服务端）
- `username: mcbot` 已在服务端白名单；smoke 用 `config/smoke.json` 以 smokebot 身份登录（同样需白名单）
- L2 默认 `ollama` + `qwen3.5:4b`（已是代码默认值）；云端回退/密钥见 [docs/l2.md](l2.md)

## 部署（管理员 PowerShell）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1          # 部署 + 启动/重启
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Smoke   # 部署后冒烟快速档（connect,spawn,chat）
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Status  # 只读状态（无需管理员）
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Restart # 仅重启服务
```

deploy.ps1 流程：预检（node ≥22、非 Store 存根、nssm 存在）→ 补 config.json → 依赖哈希门控 `npm ci --omit=dev` → `check:compat` + `npm test` → 服务不存在则 `nssm install` → **重跑全部 `nssm set`（幂等，参数变更即生效）** → 启动/重启。`nssm set` 不自动提权，故变更操作必须在管理员 shell 中执行。

## NSSM 服务语义（systemd → NSSM 映射）

| systemd（legacy/） | NSSM / Windows |
|---|---|
| `Restart=on-failure` + `RestartSec=10` | 非 0 退出码默认自动重启 + `AppRestartDelay 10000`（崩溃 10s 后拉起） |
| `StartLimitBurst=5`（fatal 后停止） | `AppExit 2 Exit`：fatal（exit 2：白名单拒绝/名字冲突/版本不匹配）→ 服务一次即停等人工；修复后 `nssm start minecraft-bot` |
| `ExecReload`（SIGHUP） | Windows 无 SIGHUP。热重载 = 改 config 自动生效（fs.watch 500ms 防抖）/ 游戏内 `!reload` / `nssm restart` |
| `EnvironmentFile=/etc/minecraft-bot/env` | `AppEnvironmentExtra`（deploy.ps1 从 `config/service.env` 注入）；改动后重跑 deploy 或手动 `nssm set` + restart |
| `CPUWeight=30` | `AppPriority BELOW_NORMAL_PRIORITY_CLASS`（低优先级：同机 Ollama/其他程序优先） |
| `MemoryHigh` / `MemoryMax` | **无等价**（Windows 无 cgroup）→ 内存靠预算与监控（见性能） |
| `LogsDirectory` + `StandardOutput=journal` | pino `logs/bot.log` 按天轮转 + `AppStdout/AppStderr` → `logs/nssm-*.log` |
| `systemctl status` / `journalctl -u minecraft-bot -f` | `nssm status minecraft-bot` / `Get-Content logs\bot.log -Wait` |
| `systemctl stop/restart` | `nssm stop/restart minecraft-bot`（stop 发 Ctrl+C 事件 → Node SIGINT → 优雅退出：停任务→断开→flush 日志） |
| `systemctl reset-failed` | 不需要（`AppExit 2 Exit` 后服务为 Stopped，修复后直接 `nssm start`） |

## 日常运维

```powershell
nssm status minecraft-bot                  # 状态（SERVICE_RUNNING / STOPPED）
nssm restart minecraft-bot                 # 全量重启
Get-Content logs\bot.log -Wait             # 实时日志（pino 按天轮转）
Get-Content logs\nssm-stderr.log -Tail 50  # 启动期 stderr（服务起不来先看这里）
```

游戏内命令（op 白名单在 `config.ops`）：`!ping` `!status` `!task list` `!task new <type> <id> [json]` `!task remove <id>` `!task start|stop|pause|resume <id>` `!reload` `!say` `!pos` `!follow <player>|off` `!agent ...`

## 性能（低配 PC：i7-4720HQ / 8GB DDR3 + 同机 Ollama）

内存预算（约）：

| 组件 | 占用 |
|---|---|
| Windows + 系统进程 | ~2GB |
| Ollama qwen3.5:4b（Q4 量化，部分层卸载到 GTX 960M） | ~2.5–5GB |
| Bot（Node） | 200–400MB |
| 余量 | ~1GB（浏览器等重程序按需关闭） |

- 依赖安装 `--omit=dev`（deploy.ps1 默认，省 dev 包）
- Bot 已设 `BELOW_NORMAL_PRIORITY_CLASS`：Ollama 推理与其他程序优先；卡顿可 `nssm set minecraft-bot AppPriority NORMAL_PRIORITY_CLASS` 后 restart
- `maxSteps: 5` 保持默认（防 LLM 工具循环吃 CPU）；`l2.cooldownMs` 可调大（如 10000）降低 Ollama 负载
- 任务均为区域限定；farm/chop/combat/breed 为 exclusive 互斥（不会并发抢寻路/采集）
- 无 MemoryMax 等价物：用任务管理器观察；Ollama 吃紧时换更小量化档（`ollama ps` 查看当前模型）或关浏览器

## 服务端（树莓派）运维速查

服务端单元仍在仓库 `systemd/minecraft-server.service`（Pi 上使用）：

```bash
ssh pi@<host>   # 或直接在 Pi 上操作
systemctl status minecraft-server        # 状态
journalctl -u minecraft-server -f        # 实时日志
systemctl restart minecraft-server       # 重启
# 白名单（游戏控制台）：
whitelist add mcbot
whitelist add smokebot
```

- JVM `-Xms2G -Xmx2G`（Pi 5 8G 上限约 3G 堆）；`white-list=true`；`online-mode=false`
- Pi 侧无需再装 Node（Bot 已不在 Pi 上跑）；`legacy/minecraft-bot.service` 仅作历史参考

## 验证清单

```bash
# 开发机/部署机（Windows）：
npm ci && npm test && npm run check:compat
# Windows PC（需树莓派服务端在线）：
node scripts/check-compat.mjs --probe
node scripts/smoke.mjs --config config/smoke.json --host 192.168.3.93          # 全步骤（mine 默认 SKIP，--dangerous 开启）
node scripts/smoke.mjs --config config/smoke.json --host 192.168.3.93 --steps connect,spawn,chat   # 快速档
```

## 故障排查

| 症状 | 排查 |
|---|---|
| 服务启动即停止 | `Get-Content logs\nssm-stderr.log -Tail 50` + `logs\bot.log`。fatal（exit 2：白名单拒绝/名字冲突/版本不匹配）触发 `AppExit 2 Exit` 停止——修复后 `nssm start minecraft-bot` |
| 服务反复重启 | 启动期错误（exit 1，如配置/日志目录问题）每 10s 重试 → 看 `logs\bot.log` 首段报错 |
| 启动即退出 "日志目录不可写" | `log.dir` 指向不可写路径；改用默认 `./logs` 或确认运行账户写权限 |
| 连不上服务端 | `Test-NetConnection 192.168.3.93 -Port 25565`；确认服务端在线、`host` 正确、Windows 防火墙放行出站 25565 |
| `unsupported protocol version` | 本地 `npm run check:compat` 未过；overrides 被意外改动 |
| Ollama 内存不足/无响应 | 任务管理器看内存；`ollama ps` 确认模型已加载；换小量化档或 `ollama stop` 后重试 |
| 挖矿任务不动 | `!task list` 看 waitingReason（no-target/inventory-full/collect-retry）；背包满需配置 `chestLocations` 或清空背包 |
| 定时任务不执行 | 检查 `schedule` 表达式与 `scheduleTimezone`；afk 类无自然完成的任务必须配 `options.durationMinutes` |
