#!/usr/bin/env node
// Controller-side relay for unattended remote starts (W2b), over Matrix.
//
//   node scripts/task-host-remote.mjs start  --binding <binding.json> --request <request.json>
//   node scripts/task-host-remote.mjs status --binding <binding.json> --launch <launchId>
//   node scripts/task-host-remote.mjs list   --binding <binding.json>
//
// The binding is the owner's private file naming the Matrix executable, the
// node and named workspace of the target's agent-orchestrator checkout, and
// the destination hostId enrolled for it. See docs/task-host.md.
//
// start prints one outcome and never retries: accepted (exit 0), refused (1),
// unknown (3: reconcile with `status`, never by starting again), not-sent (4).
// Attempt checkpoints are kept under %APPDATA%\agent-orchestrator\task-host-remote.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadBinding, remoteList, remoteStatus, startRemote } = require('../src/main/task-host/remote-relay.js');

const EXIT = { accepted: 0, refused: 1, unknown: 3, 'not-sent': 4 };
const [op, ...rest] = process.argv.slice(2);

function options() {
  const out = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.startsWith('--') ? rest[i].slice(2) : null;
    if (!name || Object.hasOwn(out, name) || rest[i + 1] === undefined) throw new Error('invalid arguments');
    out[name] = rest[i + 1];
  }
  return out;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function attemptsDir() {
  if (!process.env.APPDATA) throw new Error('APPDATA is not set');
  return path.join(process.env.APPDATA, 'agent-orchestrator', 'task-host-remote', 'attempts');
}

async function main() {
  const o = options();
  if (!o.binding) throw new Error('--binding is required');
  const binding = loadBinding(path.resolve(o.binding));
  if (op === 'start') {
    if (!o.request) throw new Error('start needs --request');
    const request = JSON.parse(fs.readFileSync(path.resolve(o.request), 'utf8'));
    const result = await startRemote({ binding, request, attemptsDir: attemptsDir() });
    print(result);
    return EXIT[result.outcome] ?? 3;
  }
  if (op === 'status') {
    if (!o.launch) throw new Error('status needs --launch');
    const result = await remoteStatus(binding, o.launch);
    print(result);
    return result.outcome === 'answer' && result.answer.ok ? 0 : 1;
  }
  if (op === 'list') {
    const result = await remoteList(binding);
    print(result);
    return result.outcome === 'answer' && result.answer.ok ? 0 : 1;
  }
  throw new Error('Usage: task-host-remote.mjs <start|status|list> --binding <file> [...]');
}

main().then(code => { process.exitCode = code; }, (error) => {
  // Fixed messages only; never echo request content.
  process.stderr.write(`${error.code || error.message}\n`);
  process.exitCode = 2;
});
