// Qualification-only notify wrapper. It records a bounded summary of every
// Codex notify payload (event type, client, how many input messages, the
// first 80 characters of each, and the digest the product helper would
// send) into a private diagnostic file, then forwards the payload unchanged
// to the product helper. It exists so a failed qualification turn can show
// which turns completed and with what input, without guessing.

const fs = require('fs');
const path = require('path');

function createQualificationNotifyWrapper({ dir, productHelper, logFile }) {
  const wrapper = path.join(dir, 'qualify-notify.ps1');
  const quote = value => `'${String(value).replace(/'/g, "''")}'`;
  fs.writeFileSync(wrapper, [
    'param([Parameter(ValueFromRemainingArguments = $true)][string[]] $NotificationArguments)',
    'try {',
    '  $n = $NotificationArguments[-1] | ConvertFrom-Json',
    '  $sha = [System.Security.Cryptography.SHA256]::Create()',
    '  $inputs = @(@($n.\'input-messages\') | Where-Object { $_ -is [string] } | ForEach-Object {',
    '    [ordered]@{',
    '      chars = $_.Length',
    '      head = $_.Substring(0, [Math]::Min(80, $_.Length))',
    '      digest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($_.Trim()))).Replace(\'-\', \'\').ToLowerInvariant()',
    '    }',
    '  })',
    '  $summary = [ordered]@{ at = (Get-Date).ToString(\'o\'); type = $n.type; client = $n.client; inputs = $inputs;',
    '    lastAssistantChars = ([string]$n.\'last-assistant-message\').Length }',
    `  ($summary | ConvertTo-Json -Compress -Depth 4) | Add-Content -LiteralPath ${quote(logFile)} -Encoding utf8`,
    '} catch { }',
    `& pwsh -NoLogo -NoProfile -File ${quote(productHelper)} @NotificationArguments`,
    '',
  ].join('\r\n'), 'utf8');
  return wrapper;
}

module.exports = { createQualificationNotifyWrapper };
