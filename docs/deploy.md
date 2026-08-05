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

2. 白名单放行 bot：`whitelist add mcbot`
3. 关闭/调大 AFK 踢出（否则 afk 任务白费）：`afk-kick-timeout=-1` 或按需求保留

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

- `npm ci` 需要 Pi 能访问 GitHub（git 依赖）；失败会自动降级为同步本机 node_modules（纯 JS 跨架构可用）
- 私密配置放 `/etc/minecraft-bot/config.json`（rsync 排除 `config/config.json`）

## 日常运维

```bash
systemctl status minecraft-bot           # 状态
journalctl -u minecraft-bot -f           # 实时日志
systemctl reload minecraft-bot           # 热重载配置+任务（SIGHUP）
systemctl status minecraft-server        # 服务端
```

游戏内命令（op 白名单在 `config.ops`）：`!ping` `!status` `!task list|start|stop|pause|resume` `!reload` `!say` `!pos` `!follow <player>|off` `!agent ...`

## 验证清单

```bash
# 开发机（Windows）：
npm ci && npm test && npm run check:compat          # 全部通过
# Pi：
node scripts/check-compat.mjs --probe                # 服务器协议 775 ✓
node scripts/smoke.mjs --config config/smoke.json    # 全步骤 PASS
```

## 故障排查

| 症状 | 排查 |
|---|---|
| bot 反复重启后停止 | `journalctl -u minecraft-bot -n 50` — 查看是否 fatal 原因（版本/名字冲突/白名单），StartLimitBurst=5 触发 |
| `unsupported protocol version` | 本地 `npm run check:compat` 未过；overrides 被意外改动 |
| 服务器 OOM | `journalctl -k | grep -i oom`；调小 `-Xmx` 或 view-distance |
| 挖矿任务不动 | 确认区域内有目标方块（`!status` 看任务 lastError）；区域不可达时任务自动暂停重试 |
