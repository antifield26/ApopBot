# deploy.ps1 — Windows PC 部署脚本（Bot → NSSM Windows 服务）
# 本机部署，无 ssh；在目标 Windows PC 上运行。
#
# 用法（管理员 PowerShell，或 powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1）:
#   .\scripts\deploy.ps1              部署（依赖 + 服务注册/更新）并启动/重启服务
#   .\scripts\deploy.ps1 -Status      只读状态（无需管理员）
#   .\scripts\deploy.ps1 -Restart     仅重启服务（config 热重载已由 fs.watch 处理；全量重启用这个）
#   .\scripts\deploy.ps1 -Stop | -Remove   停止 / 卸载服务（-Remove 需要管理员）
#   .\scripts\deploy.ps1 -Smoke       部署后跑冒烟快速档（connect,spawn,chat）
#   .\scripts\deploy.ps1 -NoRestart   同步后不重启服务
#   .\scripts\deploy.ps1 -SkipTests   跳过 npm test
#   .\scripts\deploy.ps1 -Update      U11 一键更新：git pull → 完整部署流程（依赖哈希变化
#                                     自动触发 npm ci + check:compat + 测试）→ 重启服务
#
# 前置要求:
#   - Node.js >= 24 LTS   winget install --id OpenJS.NodeJS.LTS
#   - NSSM                winget install --id NSSM.NSSM --accept-package-agreements --accept-source-agreements
#   - git（仅部署仓库拉取用；依赖已零 git 引用——npm ci 不再需要 insteadOf 重写，第 11 轮清理）
#   - 私密配置放 config/service.env（gitignore；KEY=VALUE 行，# 开头为注释）
#     → 注入服务环境变量（nssm AppEnvironmentExtra），L2 密钥只走这里
#
# 说明:
#   - nssm set 不自动提权（非管理员静默失败），因此变更操作必须在管理员 shell 中执行
#   - nssm install 仅在服务不存在时执行；nssm set 每次部署重跑（幂等，配置变更即生效）
#   - 退出码语义: exit(2) = fatal（如白名单拒绝）→ AppExit 2 Exit 停止服务等人工；其余崩溃 10s 后自动重启

param(
  [switch]$NoRestart,
  [switch]$Smoke,
  [switch]$Status,
  [switch]$Restart,
  [switch]$Stop,
  [switch]$Remove,
  [switch]$SkipTests,
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
$serviceName = 'minecraft-bot'
$root = Split-Path -Parent $PSScriptRoot   # scripts\ → 项目根
Set-Location $root

function Test-Admin {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ServiceState {
  # 返回: running | stopped | missing（nssm 未安装或服务未注册都算 missing）
  if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) { return 'missing' }
  $out = (& nssm status $serviceName 2>&1) | Out-String
  if ($LASTEXITCODE -ne 0) { return 'missing' }
  if ($out -match 'SERVICE_RUNNING') { return 'running' }
  return 'stopped'
}

function Set-NssmParam {
  param([string]$Key, [string]$Value)
  & nssm set $serviceName $Key $Value
  if ($LASTEXITCODE -ne 0) { throw "nssm set $Key 失败 (exit=$LASTEXITCODE)" }
}

# ---- 只读/快捷操作 ----
if ($Status) {
  Write-Host "minecraft-bot: $(Get-ServiceState)"
  if ((Get-Command nssm -ErrorAction SilentlyContinue)) {
    & nssm status $serviceName
  }
  $log = Join-Path $root 'logs\bot.log'
  if (Test-Path $log) {
    Write-Host '--- 最近日志（logs\bot.log 尾部）---'
    Get-Content $log -Encoding UTF8 -Tail 20  # pino 输出无 BOM UTF-8——PS 5.1 默认 ANSI 读中文乱码
  }
  exit 0
}

if (-not (Test-Admin)) {
  Write-Error '请以管理员身份运行 PowerShell（开始菜单搜索 PowerShell → 右键 → 以管理员身份运行）后重试'
  exit 1
}

if ($Stop) {
  if ((Get-ServiceState) -eq 'missing') { Write-Error '服务未安装'; exit 1 }
  & nssm stop $serviceName
  if ($LASTEXITCODE -ne 0) { Write-Error 'nssm stop 失败'; exit 1 }
  exit 0
}

if ($Remove) {
  if ((Get-ServiceState) -eq 'missing') { Write-Warning '服务未安装，无需移除'; exit 0 }
  & nssm stop $serviceName 2>$null | Out-Null
  & nssm remove $serviceName confirm
  if ($LASTEXITCODE -ne 0) { Write-Error 'nssm remove 失败'; exit 1 }
  Write-Host '服务已移除'
  exit 0
}

if ($Restart) {
  if ((Get-ServiceState) -eq 'missing') { Write-Error '服务未安装，请先运行 deploy.ps1 部署'; exit 1 }
  & nssm restart $serviceName
  if ($LASTEXITCODE -ne 0) { Write-Error 'nssm restart 失败'; exit 1 }
  exit 0
}

# U11：一键更新——git pull 拉取最新代码后走完整部署流程（依赖哈希变化自动触发
# npm ci；check:compat 与 npm test 拦版本不匹配；最后重启服务）。消除"目录与服务端
# 版本不同步"的人为错误（此前更新 = 手动 git pull + 重跑脚本两步）
if ($Update) {
  Write-Host '=== [0/5] 更新代码（git pull）==='
  & git fetch origin
  if ($LASTEXITCODE -ne 0) { Write-Error 'git fetch 失败（网络/认证？）；请手动 git pull 排查'; exit 1 }
  & git pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    Write-Error 'git pull 失败——本地有未提交改动或已分叉？git status 查看后手动处理（可先 git stash）'
    exit 1
  }
  Write-Host '代码已更新，继续完整部署流程（依赖/协议门禁/测试随后自动执行）'
}

# ---- 预检 ----
Write-Host '=== [1/5] 预检 ==='
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  Write-Error "未找到 nssm。安装: winget install --id NSSM.NSSM --accept-package-agreements --accept-source-agreements`n（装完重开 shell 再跑本脚本）"
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error '未找到 node。安装: winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements'
  exit 1
}
$nodePath = (Get-Command node).Source
if ($nodePath -match 'WindowsApps') {
  Write-Error "检测到 Microsoft Store 版 node 存根（$nodePath）。请安装 Node.js LTS: winget install --id OpenJS.NodeJS.LTS 并重开 shell"
  exit 1
}
$nodeVer = (& node -v).Trim()
if ([int](($nodeVer -replace '^v(\d+)\..*', '$1')) -lt 24) {
  Write-Error "需要 Node.js >= 24，当前: $nodeVer"
  exit 1
}
Write-Host "node $nodeVer @ $nodePath"

# ---- 配置检查 ----
Write-Host '=== [2/5] 配置检查 ==='
if (-not (Test-Path 'config\config.json')) {
  Copy-Item 'config\config.example.json' 'config\config.json'
  Write-Warning '已生成 config/config.json（复制自 example）—— 请编辑 host（生产指向服务端域名 mc.antifield.work）与 ops/tasks 后再启动'
} else {
  Write-Host 'config/config.json 已存在（不覆盖）'
}
New-Item -ItemType Directory -Force -Path 'logs' | Out-Null

# ---- 数据备份（记忆文件无 git 版本控制：sessions/experience/state）----
# 每次部署前快照 data/ → data-backup/<时间戳>/，保留最近 7 份（删除更早）。
# data 文件均为 tmp+rename 原子写，复制不会拿到半写文件；服务可能仍在运行，
# 快照一致性对灾难恢复足够（备份是附加层，失败不阻断部署）。
if (Test-Path 'data') {
  $backupDir = Join-Path $root "data-backup\$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item -Path 'data\*' -Destination $backupDir -Recurse -Force
  Write-Host "已备份 data/ → $backupDir"
  Get-ChildItem (Join-Path $root 'data-backup') -Directory |
    Sort-Object Name -Descending |
    Select-Object -Skip 7 |
    Remove-Item -Recurse -Force
} else {
  Write-Host '无 data/ 目录（首次部署？），跳过备份'
}

# ---- 依赖安装（lock 哈希门控）----
Write-Host '=== [3/5] 依赖安装 ==='
$hashInput = @('package-lock.json', 'package.json', '.npmrc') | Where-Object { Test-Path $_ }
$hash = ((Get-FileHash $hashInput -Algorithm SHA256 | ForEach-Object { $_.Hash }) -join '')
$lockFile = 'logs\.lockhash'
$needInstall = $true
# 哈希一致 + node_modules 实际存在才算可跳过（手工删除 node_modules 后必须重装）。
# 读取侧 -replace 归一去尾换行：PS 5.1 旧 lockhash 可能带尾换行（历史 Set-Content 写入）
if ((Test-Path $lockFile) -and (((Get-Content $lockFile -Raw) -replace '\s+$','') -eq $hash) -and (Test-Path 'node_modules\.package-lock.json')) { $needInstall = $false }

if ($needInstall) {
  Write-Host '依赖文件有变化，执行 npm ci --omit=dev ...'
  & npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) {
    Write-Error "npm ci 失败（v1.0.0 起依赖已零 git 引用——检查网络/registry 后重试）"
    exit 1
  }
  # 无尾换行写入（Set-Content 追加尾换行 → Get-Content -Raw 含尾换行 → 与哈希恒不等
  # → 每次部署都重跑 npm ci，第六轮 C6 修复）
  [System.IO.File]::WriteAllText((Join-Path $root $lockFile), $hash)
} else {
  Write-Host '依赖未变化，跳过 npm ci'
}

& npm run check:compat
if ($LASTEXITCODE -ne 0) { Write-Error 'check:compat 失败'; exit 1 }
if (-not $SkipTests) {
  & npm test
  if ($LASTEXITCODE -ne 0) { Write-Error 'npm test 失败'; exit 1 }
}

# ---- NSSM 服务注册/更新 ----
Write-Host '=== [4/5] NSSM 服务 ==='
$state = Get-ServiceState
if ($state -eq 'missing') {
  Write-Host '服务未注册，执行 nssm install ...'
  & nssm install $serviceName $nodePath
  if ($LASTEXITCODE -ne 0) { Write-Error 'nssm install 失败'; exit 1 }
} else {
  Write-Host "服务已注册（状态: $state），重新应用参数（幂等）"
}

$cfgPath = Join-Path $root 'config\config.json'
Set-NssmParam 'AppDirectory' $root
Set-NssmParam 'AppParameters' "src/index.js --config `"$cfgPath`""
Set-NssmParam 'Start' 'SERVICE_AUTO_START'
# AppExit 是"参数名 + 退出码 + 动作"三段式（nssm set <svc> AppExit <code> <action>），
# 不走单 key/value 的 Set-NssmParam（'AppExit 2' 带空格会被 nssm 当作不存在的参数名）
& nssm set $serviceName AppExit 2 Exit    # fatal exit(2) → 停止服务等人工（镜像旧 systemd StartLimitBurst 语义）
if ($LASTEXITCODE -ne 0) { throw "nssm set AppExit 失败 (exit=$LASTEXITCODE)" }
Set-NssmParam 'AppRestartDelay' '10000'   # 其他崩溃（非 0 退出码）10s 后自动重启
# 必须 > src/core/signals.js 的 SHUTDOWN_TIMEOUT_MS(15s)：Ctrl+C 等待窗口须覆盖优雅退出
# 预算（低配机 stop 时任务清理可能超时），超时后 NSSM 发 CTRL_BREAK——Node 已注册
# SIGBREAK handler（第六轮 C5）走同一优雅路径，窗口内到达即 no-op
Set-NssmParam 'AppStopMethodConsole' '20000'
Set-NssmParam 'AppPriority' 'BELOW_NORMAL_PRIORITY_CLASS'  # 低优先级：同机 Ollama/其他程序优先
Set-NssmParam 'AppStdout' (Join-Path $root 'logs\nssm-stdout.log')
Set-NssmParam 'AppStderr' (Join-Path $root 'logs\nssm-stderr.log')

$envPairs = @()
if (Test-Path 'config\service.env') {
  # -Encoding UTF8：PS 5.1 对无 BOM 文件默认 ANSI 解码——值含中文（webhook 等）会乱码
  $envPairs = @(Get-Content 'config\service.env' -Encoding UTF8 |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and -not $_.StartsWith('#') })
  $valid = $true
  for ($i = 0; $i -lt $envPairs.Count; $i++) {
    $line = $envPairs[$i]
    if ($line -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      Write-Error "config\service.env 第 $($i + 1) 行格式非法（应为 KEY=VALUE）: $line"
      $valid = $false
      break
    }
    # 值含空格/等号/引号时包裹引号（NSSM AppEnvironmentExtra 语法）；否则原样
    if ($Matches[2] -match '[\s="]') {
      $envPairs[$i] = "$($Matches[1])=""$($Matches[2])"""
    } else {
      $envPairs[$i] = "$($Matches[1])=$($Matches[2])"
    }
  }
  if (-not $valid) { exit 1 }
  if ($envPairs.Count -gt 0) {
    Write-Host "从 config/service.env 注入 $($envPairs.Count) 个环境变量"
    & nssm set $serviceName AppEnvironmentExtra $envPairs
    if ($LASTEXITCODE -ne 0) { throw 'nssm set AppEnvironmentExtra 失败' }
  }
}

# ---- 启动/重启 ----
Write-Host '=== [5/5] 启动 ==='
if (-not $NoRestart) {
  if ($state -eq 'running') {
    & nssm restart $serviceName
  } else {
    & nssm start $serviceName
  }
  if ($LASTEXITCODE -ne 0) { Write-Error '服务启动失败，查看 logs\nssm-stderr.log 与 logs\bot.log'; exit 1 }
  Start-Sleep -Seconds 2
  Write-Host "服务状态: $(Get-ServiceState)"
}

if ($Smoke) {
  Write-Host '=== 冒烟（快速档: connect,spawn,chat）==='
  $cfg = Get-Content 'config\config.json' -Raw | ConvertFrom-Json
  $targetHost = $cfg.host
  $targetPort = $cfg.port
  if ($targetHost -eq 'localhost') { Write-Warning 'host 为 localhost——确认服务端跑在本机；生产场景应指向服务端域名（如 mc.antifield.work）' }
  # host 与 port 都从 config.json 转发（非 25565 端口时冒烟连错端口会误判失败）
  $smokeArgs = @('scripts\smoke.mjs', '--config', 'config\smoke.json', '--host', $targetHost, '--steps', 'connect,spawn,chat')
  if ($targetPort) { $smokeArgs += '--port'; $smokeArgs += [string]$targetPort }
  & node @smokeArgs
  if ($LASTEXITCODE -ne 0) { Write-Error '冒烟失败（确认服务端在线、mcbot-test 已加入服务端白名单）'; exit 1 }
}

Write-Host ''
Write-Host '部署完成。运维速查:'
Write-Host '  nssm status minecraft-bot                   # 服务状态（也可 .\scripts\deploy.ps1 -Status）'
Write-Host '  nssm restart minecraft-bot                  # 全量重启（热重载：改 config 自动生效 + 游戏内 !reload）'
Write-Host '  nssm stop minecraft-bot / nssm start minecraft-bot'
Write-Host "  日志: $root\logs\bot.log（pino 按天轮转）; nssm-stdout.log / nssm-stderr.log（stdout/stderr）"
Write-Host '  实时日志: Get-Content logs\bot.log -Encoding UTF8 -Wait'
Write-Host '  服务异常停止（fatal 白名单/名字冲突）后: 修复 → nssm start minecraft-bot'
Write-Host '  游戏内验收: !ping / !status / !task list / !agent chat ...'
