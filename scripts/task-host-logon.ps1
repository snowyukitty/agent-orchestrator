# Starts this checkout's task host, tray only, whenever the owner logs on.
#
# Registers one scheduled task for the current account: a logon trigger scoped
# to that account, an interactive logon and a limited token. It never logs in,
# stores no password, and does nothing while nobody is logged on. A running host
# is left alone, because the app is single-instance and `--background` does not
# show its window.
#
#   pwsh scripts/task-host-logon.ps1 -Action Register
#   pwsh scripts/task-host-logon.ps1 -Action Status
#   pwsh scripts/task-host-logon.ps1 -Action Remove
param(
    [Parameter(Mandatory)][ValidateSet('Register', 'Status', 'Remove')][string]$Action,
    [string]$TaskName = 'Agent Orchestrator Task Host'
)
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$owner = "$env:COMPUTERNAME\$env:USERNAME"

switch ($Action) {
    'Register' {
        if (-not (Test-Path -LiteralPath $electron)) { throw 'Electron is not installed in this checkout; run npm ci first.' }
        $launch = New-ScheduledTaskAction -Execute $electron -Argument '. --background' -WorkingDirectory $root
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $owner
        # Let the shell create the notification area before the tray icon needs it.
        $trigger.Delay = 'PT20S'
        $principal = New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $TaskName -Action $launch -Trigger $trigger -Principal $principal `
            -Settings $settings -Force | Out-Null
        "registered: $TaskName"
    }
    'Status' {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $task) { 'not registered'; exit 1 }
        $info = $task | Get-ScheduledTaskInfo
        [ordered]@{
            state = "$($task.State)"
            trigger = $task.Triggers[0].CimClass.CimClassName
            logonType = "$($task.Principal.LogonType)"
            runLevel = "$($task.Principal.RunLevel)"
            lastRun = $info.LastRunTime
            lastResult = $info.LastTaskResult
        } | ConvertTo-Json
    }
    'Remove' {
        # Removing the task does not stop a host that is already running.
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        "removed: $TaskName"
    }
}
