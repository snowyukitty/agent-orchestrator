param(
    [Parameter(Mandatory = $true)][string]$ExpectedSourceHash,
    [Parameter(Mandatory = $true)][string]$ExpectedTargetHash
)

# Install only the reviewed app archive after the running app exits naturally.
# Runtime and native dependencies are unchanged; production user data is untouched.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$preparedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist-ui-restore'))
$sourceArchive = Join-Path $preparedRoot 'AgentOrchestrator-win32-x64\resources\app.asar'
$targetRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist\AgentOrchestrator-win32-x64'))
$targetArchive = Join-Path $targetRoot 'resources\app.asar'
$targetExecutable = Join-Path $targetRoot 'AgentOrchestrator.exe'
$receipt = Join-Path $preparedRoot 'desktop-update.json'
$pendingArchive = Join-Path $targetRoot 'resources\app.asar.pending'
$backupArchive = Join-Path $preparedRoot 'desktop-before-restoration.asar'

foreach ($item in @($sourceArchive, $targetArchive, $pendingArchive, $backupArchive, $receipt)) {
    $resolved = [IO.Path]::GetFullPath($item)
    if (-not $resolved.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing an update path outside this project.'
    }
}
function Write-Receipt([string]$State, [string]$Detail = '') {
    $result = @{ state = $State; detail = $Detail; updatedAt = [DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText($receipt, ($result | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
function Get-ArchiveHash([string]$Archive) {
    $stream = [IO.File]::OpenRead($Archive)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
    finally { $hasher.Dispose(); $stream.Dispose() }
}
function Assert-Hashes {
    if ((Get-ArchiveHash $sourceArchive) -ne $ExpectedSourceHash) {
        throw 'Prepared archive changed after verification; update cancelled.'
    }
    if ((Get-ArchiveHash $targetArchive) -ne $ExpectedTargetHash) {
        throw 'Installed archive changed while waiting; update cancelled.'
    }
}
try {
    Assert-Hashes
    Write-Receipt 'waiting_for_exit'
    $deadline = [DateTime]::UtcNow.AddMinutes(30)
    do {
        $running = @(Get-Process -Name 'AgentOrchestrator' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $targetExecutable })
        if ($running.Count -eq 0) { break }
        if ([DateTime]::UtcNow -ge $deadline) { Write-Receipt 'timed_out'; exit 2 }
        Start-Sleep -Seconds 2
    } while ($true)
    Assert-Hashes
    if (Test-Path -LiteralPath $pendingArchive) { throw 'An archive update is already pending.' }
    if (Test-Path -LiteralPath $backupArchive) { throw 'A restoration backup already exists.' }
    Copy-Item -LiteralPath $sourceArchive -Destination $pendingArchive
    [IO.File]::Replace($pendingArchive, $targetArchive, $backupArchive)
    if ((Get-ArchiveHash $targetArchive) -ne $ExpectedSourceHash) {
        throw 'Installed archive did not match the verified build.'
    }
    Write-Receipt 'updated'
} catch {
    Write-Receipt 'failed' $_.Exception.Message
    exit 1
}
