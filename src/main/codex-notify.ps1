param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $NotificationArguments
)

$ErrorActionPreference = 'Stop'

try {
    if (-not $NotificationArguments -or $NotificationArguments.Count -lt 1) { exit 0 }
    $notification = $NotificationArguments[-1] | ConvertFrom-Json
    if ($notification.type -ne 'agent-turn-complete') { exit 0 }

    $pipeName = [Environment]::GetEnvironmentVariable('AGENT_ORCHESTRATOR_NOTIFY_SECRET_PIPE')
    $token = [Environment]::GetEnvironmentVariable('AGENT_ORCHESTRATOR_NOTIFY_SECRET_TOKEN')
    $incarnation = [Environment]::GetEnvironmentVariable('AGENT_ORCHESTRATOR_NOTIFY_SECRET_INCARNATION')
    if (-not $pipeName -or -not $token -or -not $incarnation) { exit 0 }
    if ($pipeName -notmatch '^agent-orchestrator-[A-Za-z0-9-]+$') { exit 0 }

    $client = [System.IO.Pipes.NamedPipeClientStream]::new(
        '.',
        $pipeName,
        [System.IO.Pipes.PipeDirection]::Out,
        [System.IO.Pipes.PipeOptions]::Asynchronous
    )
    try {
        $client.Connect(1000)
        $encoding = [System.Text.UTF8Encoding]::new($false)
        $writer = [System.IO.StreamWriter]::new($client, $encoding, 1024, $true)
        try {
            $payload = @{
                token = $token
                incarnationId = $incarnation
                type = 'agent-turn-complete'
            } | ConvertTo-Json -Compress
            $writer.WriteLine($payload)
            $writer.Flush()
        } finally {
            $writer.Dispose()
        }
    } finally {
        $client.Dispose()
    }
} catch {
    # Notification delivery is best-effort. Missing a receipt keeps the
    # session fail-closed; never print paths, tokens, or provider payloads.
    exit 0
}
