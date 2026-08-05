#!/usr/bin/env bash
# 部署脚本：开发机 → 树莓派
# 用法: ./scripts/deploy.sh pi@<host> [--no-restart] [--fast]
#  --no-restart  同步后不重启服务
#  --fast        部署后运行 smoke 快速档（connect,spawn,chat）
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

REMOTE_DIR="/opt/minecraft-bot"
LOCKHASH_REMOTE="/var/lib/minecraft-bot/.lockhash"

echo "=== [1/5] 本地兼容性预检 ==="
npm run check:compat

echo "=== [2/5] 同步代码到 $TARGET:$REMOTE_DIR ==="
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude logs \
  --exclude config/config.json \
  ./ "$TARGET:$REMOTE_DIR/"

echo "=== [3/5] 远程依赖安装（lockfile 变化时才执行）==="
LOCKHASH_LOCAL=$(sha256sum package-lock.json | awk '{print $1}')
LOCKHASH_REMOTE_OLD=$(ssh "$TARGET" "cat $LOCKHASH_REMOTE 2>/dev/null || true")
if [ "$LOCKHASH_LOCAL" != "$LOCKHASH_REMOTE_OLD" ]; then
  echo "package-lock.json 已变化，远程执行 npm ci --omit=dev"
  if ! ssh "$TARGET" "cd $REMOTE_DIR && npm ci --omit=dev"; then
    echo "远程 npm ci 失败（可能无法访问 GitHub）—— 尝试同步本机 node_modules 兜底" >&2
    echo "（全 JS 无原生编译，x64 → ARM64 可直接复用）"
    rsync -az node_modules/ "$TARGET:$REMOTE_DIR/node_modules/"
  fi
  echo "$LOCKHASH_LOCAL" | ssh "$TARGET" "cat > $LOCKHASH_REMOTE"
else
  echo "lockfile 未变化，跳过 npm ci"
fi

if [ "$NO_RESTART" = "1" ]; then
  echo "=== [4/5] 跳过重启（--no-restart）==="
  exit 0
fi

echo "=== [4/5] 重启服务 ==="
ssh "$TARGET" "sudo systemctl daemon-reload && sudo systemctl restart minecraft-bot"

echo "=== [5/5] 服务状态 ==="
ssh "$TARGET" "systemctl status minecraft-bot --no-pager -l | head -12"

if [ "$FAST" = "1" ]; then
  echo "=== [5b/5] 冒烟快速档 ==="
  ssh "$TARGET" "cd $REMOTE_DIR && node scripts/smoke.mjs --config config/smoke.json --steps connect,spawn,chat"
fi

echo "=== 部署完成 ==="
