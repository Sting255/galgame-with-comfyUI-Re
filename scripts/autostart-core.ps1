# autostart-core.ps1 -- LinShe (agent-core) launcher for boot/logon autostart.
#
# Invoked by a Windows "At log on" scheduled task; can also be run manually.
#
# Hard rules (both are real pitfalls on this machine -- do NOT revert):
#   1. MUST use the bundled runtime\nodejs\node.exe. The node on PATH is a
#      different major (v25) whose ABI mismatches better-sqlite3's native
#      binding and crashes on load (app.js line 1 envCheck guards this).
#   2. Duplicate-guard: if the app port is already listening, do nothing -- two
#      instances would run the schedulers twice (duplicate Moments posts).
#   3. production mode: agent-core serves the built web UI itself, so
#      http://localhost:<PORT> is the full app (no separate Vite needed).
#
# P2-06（2026-11-16）：端口不再写死 3099。以前这里硬编码「探测 3099」，
# 而真实端口由 agent-core/.env 的 PORT 决定（默认 3099）。用户改过端口后，
# 这个守卫就永远探测不到已在跑的实例 ⇒ 开机又起一个，两个调度器同时发朋友圈。

$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $PSScriptRoot
$Core   = Join-Path $Root 'agent-core'
$Node   = Join-Path $Root 'runtime\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'

if (-not (Test-Path $Node)) {
  Write-Error "Bundled runtime not found: $Node (check runtime\nodejs)"
  exit 1
}

# 端口解析与 agent-core/src/config.js 同口径：.env 的 PORT，缺省 3099。
# .env 可能不存在（全新解压包），此时按默认值处理。
$Port = 3099
$EnvFile = Join-Path $Core '.env'
if (Test-Path $EnvFile) {
  $match = Select-String -Path $EnvFile -Pattern '^\s*PORT\s*=\s*(\d+)\s*$' -AllMatches |
    Select-Object -Last 1
  if ($match) { $Port = [int]$match.Matches[0].Groups[1].Value }
}

# Duplicate-guard
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Output ("agent-core already running on :{0} (PID {1}); skipping." -f $Port, $listening[0].OwningProcess)
  exit 0
}

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$stamp   = Get-Date -Format 'yyyy-MM-dd'
$logFile = Join-Path $LogDir ("autostart-console-{0}.log" -f $stamp)
$errFile = Join-Path $LogDir ("autostart-error-{0}.log" -f $stamp)

# App writes its own structured daily log (logs/backend-*.log) when LOG_TO_FILE=true;
# capturing stdout/stderr here too so a boot-time crash (ABI / missing dep) is visible.
$env:NODE_ENV    = 'production'
$env:LOG_TO_FILE = 'true'

# Start-Process launches node as an independent child: the scheduled task's
# PowerShell can exit while the app keeps running.
Start-Process -FilePath $Node `
  -ArgumentList 'app.js' `
  -WorkingDirectory $Core `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError  $errFile

Write-Output ("agent-core launched (production, :{0}); console log: {1} | error log: {2}" -f $Port, $logFile, $errFile)
