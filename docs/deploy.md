# 树莓派 5 部署指南

## 环境准备（一次性）

```bash
# 1. Raspberry Pi OS 64-bit (Bookworm)，启用 SSH
sudo raspi-config   # Interface → SSH

# 2. Node.js 22 LTS (ARM64)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 应 ≥ 22

# 3. Java 25+（Paper 26.1.2 要求）
sudo apt install -y openjdk-25-jdk-headless   # 源内没有则用 sdkman 装 temurin-25
java -version

# 4. 基础工具与目录
sudo apt install -y git rsync
sudo mkdir -p /opt/minecraft-bot /opt/minecraft-server /var/lib/minecraft-bot /etc/minecraft-bot
sudo chown -R pi:pi /opt/minecraft-bot /opt/minecraft-server /var/lib/minecraft-bot /etc/minecraft-bot

# 5. journald 限容（服务器+bot 日志共享）
sudo tee -a /etc/systemd/journald.conf <<'EOF'
SystemMaxUse=100M
EOF
sudo systemctl restart systemd-journald
```

## Paper 服务端配置（/opt/minecraft-server）

1. 放置 `paper-26.1.2.jar`，`server.properties` 关键项：

```properties
online-mode=false
enforce-secure-profile=false
view-distance=8
simulation-distance=6
white-list=true
motd=Minecraft 26.1.2 on Pi 5
```

2. 白名单放行 bot 与 smoke：`whitelist add mcbot` 和 `whitelist add smokebot`
   （smoke 用 `config/smoke.json` 以 smokebot 身份登录，不白名单会直接失败）
3. 关闭/调大 AFK 踢出（否则 afk 任务白费）：`afk-kick-timeout=-1` 或按需求保留

## Bot 配置（/etc/minecraft-bot/config.json）

```json
{
  "username": "mcbot",
  "ops": ["steve", "alex"],
  "log": { "dir": "/var/lib/minecraft-bot/logs" },
  "l2": { "enabled": false }
}
```

- `log.dir` 必须指向可写路径（systemd `ProtectSystem=strict` 下 `/opt/minecraft-bot` 只读；
  默认值会落在只读目录并启动失败——这是设计：宁可启动报错，不要日志静默丢失）
- L2 密钥只走环境变量（见 docs/l2.md），绝不写进配置文件

## 安装 systemd 单元

```bash
sudo cp systemd/minecraft-bot.service systemd/minecraft-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now minecraft-server   # 先启动服务端
sudo systemctl enable --now minecraft-bot      # bot 依赖 After=minecraft-server
```

- 服务端 JVM：`-Xms2G -Xmx2G`（Pi 5 8G 的实际上限约 3G 堆，Aikar's flags 要求 6-10G 堆，**不适用于 Pi**）
- bot 内存：systemd `MemoryHigh=384M / MemoryMax=768M`；实际 RSS 约 200-400MB
- CPU 权重：服务端 70 / bot 30

## 部署更新（开发机执行）

```bash
./scripts/deploy.sh pi@<host>            # 常规部署（预检→rsync→按需 npm ci→重启）
./scripts/deploy.sh pi@<host> --fast     # 部署 + 冒烟快速档（connect,spawn,chat）
./scripts/deploy.sh pi@<host> --no-restart
```

- **Windows 前置**：deploy.sh 需要 `rsync`（Git for Windows 不内置）。推荐 WSL 中运行本脚本，
  或安装 MSYS2（`pacman -S rsync`）/cwRsync 并加入 PATH。脚本会先检查 rsync 是否存在。
- **Pi 的 npm ci**：lockfile 含 `git+ssh://` 依赖，HTTP 代理无法穿透。在 Pi 上执行一次：
  ```bash
  git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"
  ```
  否则 npm ci 可能长时间卡住。npm ci 失败会自动降级为同步本机 node_modules（纯 JS 跨架构可用，
  该降级路径也会把 SSH 依赖换成 HTTPS 无法覆盖的场景一并兜住）。
- deploy.sh 会自动把 `systemd/*.service` 安装到 `/etc/systemd/system` 并 daemon-reload
  （仓库内单元文件是唯一来源，改单元只需重新部署）
- 依赖变更判定基于 `package-lock.json + package.json + .npmrc` 的复合哈希，仅成功后落盘
- 私密配置放 `/etc/minecraft-bot/config.json`（rsync 排除 `config/config.json`）

## 日常运维

```bash
systemctl status minecraft-bot           # 状态
journalctl -u minecraft-bot -f           # 实时日志
systemctl reload minecraft-bot           # 热重载配置+任务（SIGHUP；也可直接改 config.json 自动生效）
systemctl status minecraft-server        # 服务端
systemctl reset-failed minecraft-bot     # 连续 5 次 fatal 后单元进入 failed 态，修复后需先 reset
```

游戏内命令（op 白名单在 `config.ops`）：`!ping` `!status` `!task list` `!task new <type> <id> [json]` `!task remove <id>` `!task start|stop|pause|resume <id>` `!reload` `!say` `!pos` `!follow <player>|off` `!agent ...`

任务类型：`mine`（挖矿，需 blockTypes/area）、`fish`（钓鱼）、`afk`（防踢）、`farm`（种植收割）、`chop`（伐木）、`combat`（战斗巡逻）、`breed`（养殖）

## 验证清单

```bash
# 开发机（Windows）：
npm ci && npm test && npm run check:compat          # 全部通过
# Pi：
node scripts/check-compat.mjs --probe                # 服务器协议 775 ✓
node scripts/smoke.mjs --config config/smoke.json    # 全步骤 PASS（mine 默认 SKIP，--dangerous 开启）
```

## 故障排查

| 症状 | 排查 |
|---|---|
| bot 反复重启后停止 | `journalctl -u minecraft-bot -n 50` — fatal 原因仅三类：名字冲突/白名单拒绝/版本不匹配，StartLimitBurst=5 触发；未知原因不再算 fatal（退避重连） |
| 启动即退出 "日志目录不可写" | 见上文 Bot 配置段：`log.dir` 需指向可写路径 |
| `unsupported protocol version` | 本地 `npm run check:compat` 未过；overrides 被意外改动 |
| 服务器 OOM | `journalctl -k | grep -i oom`；调小 `-Xmx` 或 view-distance |
| 挖矿任务不动 | `!task list` 看 waitingReason（no-target/inventory-full/collect-retry）；背包满需配置 `chestLocations` 或清空背包 |
| 定时任务不执行 | 检查 `schedule` 表达式与 `scheduleTimezone`；afk 类无自然完成的任务必须配 `options.durationMinutes` |
