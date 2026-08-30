// Manual, credential-free ConPTY boundary check for the routed direct-agent
// argv shape. It launches a disposable PowerShell script, never an agent,
// account route, login, or network request.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');

const { buildLaunchSpec } = require('../src/main/agents');

function assertDisposablePath(candidate) {
  const root = path.resolve(os.tmpdir());
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to clean a path outside the temporary directory');
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent orchestrator direct argv-'));
  const entrypoint = path.join(dir, 'bin', 'agent-entrypoint.ps1');
  const notifyHelper = path.join(dir, 'notify helper.ps1');
  const receipt = path.join(dir, 'argv.json');
  let child = null;
  assertDisposablePath(dir);

  try {
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, String.raw`$ForwardedArguments = $args
$encoding = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
    $env:AGENT_ORCHESTRATOR_ARGV_RECEIPT,
    ($ForwardedArguments | ConvertTo-Json -Compress),
    $encoding
)
Start-Sleep -Milliseconds 500
`, 'utf8');
    fs.writeFileSync(notifyHelper, '# argv fixture only\n', 'utf8');

    const spec = buildLaunchSpec({
      id: 'codex:a',
      kind: 'routed',
      agent: 'codex',
      alias: 'a',
      displayName: 'Codex A',
    }, {
      baseEnv: {
        ...process.env,
        AGENT_ORCHESTRATOR_ARGV_RECEIPT: receipt,
      },
      entrypointPath: dir,
      notifyScriptPath: notifyHelper,
      sessionMode: 'direct-agent',
    });

    child = pty.spawn(spec.file, spec.args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: dir,
      env: spec.env,
      useConpty: true,
      // The DLL backend uses the same Windows argv serializer but avoids the
      // legacy console-list cleanup helper, which races very short probes.
      useConptyDll: true,
      conptyInheritCursor: true,
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { child.kill(); } catch (_error) { /* already exited */ }
        reject(new Error('Disposable PowerShell argv probe timed out'));
      }, 5_000);
      child.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (exitCode === 0) resolve();
        else reject(new Error(`Disposable PowerShell argv probe exited ${exitCode}`));
      });
    });

    const received = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.deepEqual(received, spec.args.slice(4));
    assert.ok(received[5].includes('notify helper.ps1'));
    assert.equal(received[7], 'shell_environment_policy.ignore_default_excludes=false');
    console.log(`Direct-agent argv round-trip passed (${received.length} forwarded arguments).`);
  } finally {
    try { child?.kill(); } catch (_error) { /* already exited */ }
    await new Promise(resolve => setTimeout(resolve, 500));
    assertDisposablePath(dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.message);
    process.exit(1);
  }
);
