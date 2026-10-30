# autostart-core.ps1 -- LinShe (agent-core) launcher for boot/logon autostart.
#
# Invoked by a Windows "At log on" scheduled task; can also be run manually.
#
# Hard rules (both are real pitfalls on this machine -- do NOT revert):
#   1. MUST use the bundled runtime\nodejs\node.exe. The node on PATH is a
#      different major (v25) whose ABI mismatches better-sqlite3's native
#      binding and crashes on load (app.js line 1 envCheck guards this).
#   2. Duplicate-guard: if :3099 is already listening, do nothing -- two
#      instances would run the schedulers twice (duplicate Moments posts).
#   3. production mode: agent-core serves the built web UI itself, so
#      http://localhost:3099 is the full app (no separate Vite needed).

$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $PSScriptRoot
$Core   = Join-Path $Root 'agent-core'
$Node   = Join-Path $Root 'runtime\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'

if (-not (Test-Path $Node)) {
  Write-Error "Bundled runtime not found: $Node (check runtime\nodejs)"
  exit 1
}

# Duplicate-guard
$listening = Get-NetTCPConnection -LocalPort 3099 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Output ("agent-core already running (PID {0}); skipping." -f $listening[0].OwningProcess)
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

Write-Output ("agent-core launched (production, :3099); console log: {0} | error log: {1}" -f $logFile, $errFile)
