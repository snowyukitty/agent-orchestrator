[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Entrypoint,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9_.-]{1,64}$')]
    [string] $Alias,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9_-]{1,32}$')]
    [string] $Token
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This helper runs inside a real routed account shell. It deliberately emits
# only fixed health bits and a short one-way home fingerprint: no alias, path,
# doctor JSON, terminal transcript, or account identity leaves the probe.
$pwsh = (
    Get-Command -Name pwsh -CommandType Application -ErrorAction Stop |
        Select-Object -First 1
).Path
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $pwsh
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
foreach ($argument in @(
    '-NoLogo',
    '-NoProfile',
    '-File',
    $Entrypoint,
    'codex',
    'doctor',
    $Alias,
    '--json'
)) {
    $startInfo.ArgumentList.Add($argument)
}

$doctor = [System.Diagnostics.Process]::new()
$doctor.StartInfo = $startInfo
try {
    if (-not $doctor.Start()) {
        throw 'The routed doctor process did not start.'
    }
    $doctorText = $doctor.StandardOutput.ReadToEnd()
    $null = $doctor.StandardError.ReadToEnd()
    $doctor.WaitForExit()
    if ($doctor.ExitCode -ne 0) {
        throw 'The routed doctor process did not pass.'
    }
}
finally {
    $doctor.Dispose()
}

$parsed = ConvertFrom-Json -InputObject $doctorText
$report = @($parsed)[0]

$sameHomes = [string]::Equals(
    $env:CODEX_HOME,
    $env:CODEX_SQLITE_HOME,
    [StringComparison]::OrdinalIgnoreCase
)
$homeBytes = [Text.Encoding]::UTF8.GetBytes([string]$env:CODEX_HOME)
$fingerprint = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($homeBytes)
)
$bits = '{0}{1}{2}{3}{4}' -f @(
    [int]($report.Status -eq 'ok')
    [int]($report.ActiveCodexHomeMatches -eq $true)
    [int]($report.ActiveCodexSqliteHomeMatches -eq $true)
    [int]($report.AuthenticationStatePresent -eq $true)
    [int]($sameHomes -eq $true)
)
$marker = [string]::Concat('AO_LIVE_', $Token)
[Console]::Out.WriteLine(
    ('{0}:{1}:{2}' -f $marker, $bits, $fingerprint.Substring(0, 24))
)
