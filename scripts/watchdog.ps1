# JB Capital 24/7 watchdog. Keeps the trading floor server running on this PC:
#  - starts server.py (no browser pop-up) and restarts it if it crashes
#  - restarts it if it stops answering /api/status for 3 minutes (frozen)
#  - backs off if it keeps crashing, writes everything to logs\
# Started hidden at logon by the "JB Capital Floor" scheduled task (scripts\install_24x7.ps1).
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force $logs | Out-Null
$wlog = Join-Path $logs "watchdog.log"
$port = 8000
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content -Path $wlog -Encoding utf8 }
function Healthy { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 "http://127.0.0.1:$port/api/status").StatusCode -eq 200 } catch { $false } }
function PortOwner { $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess } }

# only one watchdog at a time
$mutex = New-Object System.Threading.Mutex($false, "Global\JBCapitalFloorWatchdog")
if (-not $mutex.WaitOne(0)) { exit }

# the real python.exe (not the py launcher), so killing a frozen server kills the actual process
$py = $null
try { $py = (& py -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1).Trim() } catch {}
if (-not $py) { $py = (Get-Command python -ErrorAction SilentlyContinue).Source }
Log "watchdog started (python: $py)"
$fails = 0
while ($true) {
    $existing = PortOwner
    if ($existing) {
        # a server is already up (e.g. started by hand): just keep an eye on it
        Log "server already running (pid $existing); monitoring"
        $proc = Get-Process -Id $existing -ErrorAction SilentlyContinue
    } else {
        $env:FLOOR_NO_BROWSER = "1"
        $env:PYTHONIOENCODING = "utf-8"
        $stamp = Get-Date -Format "yyyyMMdd"
        $proc = Start-Process -FilePath $py -ArgumentList "-u", "server.py" -WorkingDirectory $root -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logs "floor-$stamp.out.log") -RedirectStandardError (Join-Path $logs "floor-$stamp.err.log")
        Log "started server (pid $($proc.Id))"
        Start-Sleep -Seconds 45
    }
    $bad = 0
    while ($proc -and -not $proc.HasExited) {
        Start-Sleep -Seconds 60
        if (Healthy) { $bad = 0; $fails = 0 } else { $bad++; Log "health check failed ($bad/3)" }
        if ($bad -ge 3) {
            Log "server frozen; killing pid $($proc.Id)"
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            break
        }
    }
    $fails++
    $wait = [Math]::Min(300, 10 * $fails)
    Log "server stopped (exit $($proc.ExitCode)); restarting in $wait s"
    Start-Sleep -Seconds $wait
    Get-ChildItem $logs -Filter "floor-*.log" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -ErrorAction SilentlyContinue
}
