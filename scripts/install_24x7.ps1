# One-time setup: run the JB Capital floor 24/7 on this PC.
# Creates a scheduled task that starts the watchdog (hidden) every time you log in, then starts it right now.
# Undo: Unregister-ScheduledTask -TaskName "JB Capital Floor" -Confirm:$false
$root = Split-Path -Parent $PSScriptRoot
$wd = Join-Path $PSScriptRoot "watchdog.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wd`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "JB Capital Floor" -Action $action -Trigger $trigger -Settings $settings `
    -Description "Keeps the JB Capital AI trading floor running 24/7 (watchdog restarts it if it crashes or freezes)." -Force | Out-Null
Start-ScheduledTask -TaskName "JB Capital Floor"
"Installed. The floor now starts at logon and restarts itself. Logs: $root\logs"
