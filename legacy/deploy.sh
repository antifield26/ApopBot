#!/usr/bin/env bash
# 部署脚本：开发机 → 树莓派
# 用法: ./scripts/deploy.sh pi@<host> [--no-restart] [--fast]
#  --no-restart  同步后不重启服务
#  --fast        部署后运行 smoke 快速档（connect,spawn,chat）
#
# 前置要求（Windows Git Bash 也适用）：
#   - rsync 可用（Git for Windows 不内置，需 MSYS2/cwRsync/WSL 安装，见 docs/deploy.md）
#   - Pi 上 `git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"`
#     使 npm ci 的 git 依赖走 HTTPS（HTTP 代理可穿透），否则可能长时间卡住
set -euo pipefail

TARGET="${1:?用法: ./scripts/deploy.sh pi@<host> [--no-restart] [--fast]}"
shift || true
NO_RESTART=0
FAST=0
for arg in "$@"; do
  case "$arg" in
    --no-restart) NO_RESTART=1 ;;
    --fast) FAST=1 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

# 传输工具：rsync 优先；本机无 rsync（Git for Windows）时用 tar-over-ssh 兜底
if command -v rsync >/dev/null 2>&1; then
  HAS_RSYNC=1
else
  HAS_RSYNC=0
  echo "提示: 未找到 rsync（Git for Windows 不内置），改用 tar-over-ssh 同步（功能等价）"
fi

REMOTE_DIR="/opt/minecraft-bot"
LOCKHASH_REMOTE="/var/lib/minecraft-bot/.lockhash"

echo "=== [1/5] 本地兼容性预检 ==="
npm run check:compat

# 远程 Node 探测（nvm 安装的 node 不在 PATH；systemd 单元 ExecStart 需绝对路径）
NODE_DIR=$(ssh "$TARGET" "ls -d ~/.nvm/versions/node/*/bin 2>/dev/null | head -1 || dirname \$(command -v node 2>/dev/null) 2>/dev/null")
if [ -z "$NODE_DIR" ] || [ "$NODE_DIR" = "." ]; then
  echo "错误: 远程未找到 node（探测 ~/.nvm/versions/node/*/bin 与 PATH）" >&2
  exit 1
fi
NODE_BIN="$NODE_DIR/node"
echo "远程 node: $NODE_BIN"

echo "=== [2/5] 初始化远程目录 + 同步代码到 $TARGET:$REMOTE_DIR ==="
# logs 目录必须存在：ProtectSystem=strict 的 ReadWritePaths 要求路径存在，否则 226/NAMESPACE
ssh "$TARGET" "sudo mkdir -p $REMOTE_DIR/logs /var/lib/minecraft-bot/logs && sudo chown -R \$(whoami):\$(whoami) $REMOTE_DIR /var/lib/minecraft-bot"

if [ "$HAS_RSYNC" = "1" ]; then
  rsync -az --delete \
    --exclude node_modules --exclude .git --exclude logs \
    --exclude config/config.json \
    ./ "$TARGET:$REMOTE_DIR/"
else
  # tar-over-ssh：覆盖解压（无 --delete 语义，多余残留文件影响小；node_modules 由依赖步骤管理）
  tar -czf - \
    --exclude node_modules --exclude .git --exclude logs \
    --exclude config/config.json \
    . | ssh "$TARGET" "mkdir -p $REMOTE_DIR && tar -xzf - -C $REMOTE_DIR"
fi

echo "=== [3/5] 远程依赖安装（依赖文件变化时才执行）==="
# O6：hash 覆盖 package-lock.json + package.json + .npmrc（package.json/.npmrc 变更
# 同样应触发 npm ci，避免 overrides/代理配置漂移被掩盖）
LOCKHASH_LOCAL=$(sha256sum package-lock.json package.json .npmrc | sha256sum | awk '{print $1}')
LOCKHASH_REMOTE_OLD=$(ssh "$TARGET" "cat $LOCKHASH_REMOTE 2>/dev/null || true")
if [ "$LOCKHASH_LOCAL" != "$LOCKHASH_REMOTE_OLD" ]; then
  echo "依赖文件已变化，远程执行 npm ci --omit=dev"
  # O7：npm ci 可能因 GitHub 不可达长时间重试——timeout 600 兜底，超时视为失败走兜底
  if ! timeout 600 ssh "$TARGET" "export PATH=$NODE_DIR:\$PATH; cd $REMOTE_DIR && npm ci --omit=dev"; then
    echo "远程 npm ci 失败（可能无法访问 GitHub）—— 尝试同步本机 node_modules 兜底" >&2
    echo "（全 JS 无原生编译，x64 → ARM64 可直接复用）"
    if [ "$HAS_RSYNC" = "1" ]; then
      if ! rsync -az node_modules/ "$TARGET:$REMOTE_DIR/node_modules/"; then
        echo "node_modules 兜底同步也失败，退出（不写 lockhash，下次部署会重试 npm ci）" >&2
        exit 1
      fi
    else
      if ! tar -czf - node_modules | ssh "$TARGET" "mkdir -p $REMOTE_DIR/node_modules && tar -xzf - -C $REMOTE_DIR"; then
        echo "node_modules 兜底同步也失败，退出（不写 lockhash，下次部署会重试 npm ci）" >&2
        exit 1
      fi
    fi
  fi
  # O6：仅在 npm ci 或兜底同步成功后才写 hash（失败不写，下次部署重试）
  echo "$LOCKHASH_LOCAL" | ssh "$TARGET" "cat > $LOCKHASH_REMOTE"
else
  echo "依赖文件未变化，跳过 npm ci"
fi

echo "=== [4/5] 安装/更新 systemd 单元并重载 ==="
# O9：仓库内 systemd/ 单元变更必须传播到 /etc/systemd/system；
# 部署时按目标机实际情况替换：
#   - ExecStart 的 /usr/bin/node → 探测到的 node 绝对路径（nvm 场景）
#   - User=pi → 远程登录用户名（首次部署实测：默认 pi 在非 pi 系统上 217/USER 失败）
REMOTE_USER=$(ssh "$TARGET" "whoami")
# 前缀匹配而非 $ 行尾锚点：仓库文件在 Windows autocrlf 下可能携带 CRLF（\r 使 $ 锚点失效）
ssh "$TARGET" "sed -e 's|/usr/bin/node|$NODE_BIN|' -e 's|^User=pi|User=$REMOTE_USER|' $REMOTE_DIR/systemd/minecraft-bot.service | sudo tee /etc/systemd/system/minecraft-bot.service > /dev/null && sudo systemctl daemon-reload"

if [ "$NO_RESTART" = "1" ]; then
  echo "=== [5/5] 跳过重启（--no-restart）==="
  exit 0
fi

echo "=== [5/5] 启用并重启服务 ==="
# enable 幂等（首跑后开机自启）；单元可能处于 StartLimit 失败态，先 reset-failed 再 restart
ssh "$TARGET" "sudo systemctl enable minecraft-bot >/dev/null 2>&1; sudo systemctl reset-failed minecraft-bot 2>/dev/null || true; sudo systemctl restart minecraft-bot"

echo "=== [5b/5] 服务状态 ==="
ssh "$TARGET" "systemctl status minecraft-bot --no-pager -l | head -12"

if [ "$FAST" = "1" ]; then
  echo "=== [5c/5] 冒烟快速档 ==="
  ssh "$TARGET" "cd $REMOTE_DIR && node scripts/smoke.mjs --config config/smoke.json --steps connect,spawn,chat"
fi

echo "=== 部署完成 ==="
