# Copy the JB Capital floor from this PC to the VPS and (re)start it there.
#   powershell -ExecutionPolicy Bypass -File deploy\push.ps1 -Server <vps ip or tailscale name> [-WithState]
# -WithState also copies state.json (the fund's ledger/memories) — use it ONCE, for the move. After the move the VPS
# owns the state; don't run the floor on both machines at the same time (both would trade the same Alpaca account).
param([Parameter(Mandatory = $true)][string]$Server, [switch]$WithState, [string]$Key = "$HOME\.ssh\jb_vps")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ssh = @("-i", $Key, "-o", "StrictHostKeyChecking=accept-new")
$tmp = Join-Path $env:TEMP "jbfloor.tgz"
$exclude = @("--exclude=logs", "--exclude=__pycache__", "--exclude=*.pyc", "--exclude=state.json.tmp")
# the server owns its own state, secrets (.env holds its Claude token) and generated reports after the move
if (-not $WithState) { $exclude += @("--exclude=state.json", "--exclude=.env", "--exclude=career_reports") }
Push-Location $root
& (Join-Path $env:SystemRoot "System32\tar.exe") -czf $tmp @exclude .   # Windows' own tar (Git's tar reads "C:" as a remote host)
Pop-Location
"Packed $([math]::Round((Get-Item $tmp).Length / 1MB, 1)) MB"
scp @ssh $tmp "jb@${Server}:/home/jb/jbfloor.tgz"
ssh @ssh "jb@$Server" "set -e; cd /home/jb/ai-trading-floor && tar -xzf /home/jb/jbfloor.tgz && rm /home/jb/jbfloor.tgz && /home/jb/venv/bin/pip install -q -r requirements.txt && sudo /usr/bin/systemctl restart jbfloor && sleep 3 && sudo /usr/bin/systemctl status jbfloor --no-pager | head -5"
# the Career / Study towers read JB Terminal: send a fresh copy
$term = Join-Path $HOME "Documents\JBTerminal\data.json"
if (Test-Path $term) { scp @ssh $term "jb@${Server}:/home/jb/jbterminal/data.json"; "Synced JB Terminal data." }
"Deployed. Dashboard (over Tailscale): http://${Server}:8000"
