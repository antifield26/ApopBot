# legacy/ — 已退役的 Linux 部署产物

2026-08 起，Bot 不再部署到树莓派，改以 **NSSM Windows 服务**运行于 Windows PC（当前指南见 [docs/deploy.md](../docs/deploy.md)）；PaperMC 服务端仍运行在树莓派（`systemd/minecraft-server.service` **未移动，仍在正常使用**）。

| 文件 | 原位置 | 退役原因 |
|---|---|---|
| `deploy.sh` | `scripts/deploy.sh` | bash/ssh/rsync/systemd 远程部署流程，已被 [scripts/deploy.ps1](../scripts/deploy.ps1)（本机 PowerShell + NSSM）替代 |
| `minecraft-bot.service` | `systemd/minecraft-bot.service` | Bot 的 systemd 单元，已被 NSSM 服务注册替代（systemd → NSSM 语义对照表见 docs/deploy.md） |

如需恢复到树莓派部署（拓扑回退）：将文件 `git mv` 回原位置（`scripts/deploy.sh`、`systemd/minecraft-bot.service`），按 `deploy.sh` 头注释与旧部署流程执行（`sudo cp systemd/minecraft-bot.service /etc/systemd/system/` + `daemon-reload` + `enable --now`）。`deploy.sh` 的前置要求（rsync 可用；Pi 上执行 `git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"` 使 npm ci 的 git 依赖走 HTTPS）仍记录在脚本头注释中。
