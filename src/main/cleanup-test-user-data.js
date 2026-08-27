#!/usr/bin/env node
// Remove one disposable Electron test-data directory after its parent exits.
// The strict temp-root + PID-name checks keep this helper incapable of
// targeting production AppData or an arbitrary caller-supplied directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = path.resolve(process.argv[2] || '');
const parentPid = Number(process.argv[3]);
const expectedRoot = path.resolve(os.tmpdir(), 'agent-orchestrator-tests');
const expectedTarget = Number.isSafeInteger(parentPid) && parentPid > 0
  ? path.join(expectedRoot, String(parentPid))
  : '';

if (!expectedTarget || target !== expectedTarget || target === expectedRoot) {
  process.exitCode = 2;
} else {
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const parentIsAlive = () => {
    try {
      process.kill(parentPid, 0);
      return true;
    } catch (_error) {
      return false;
    }
  };

  void (async () => {
    for (let attempt = 0; attempt < 120 && parentIsAlive(); attempt += 1) {
      await wait(100);
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        if (!fs.existsSync(target)) return;
      } catch (_error) {
        // Chromium can hold cache files briefly after the main process exits.
      }
      await wait(250);
    }
    process.exitCode = 1;
  })();
}
