#!/usr/bin/env node
// Local client for the desktop task host's loopback ingress.
//
//   node scripts/task-host-client.mjs capabilities
//   node scripts/task-host-client.mjs list [--origin remote|local] [--limit <1-64>]
//   node scripts/task-host-client.mjs status --launch <launchId>
//   node scripts/task-host-client.mjs remote-start --stdin          (one JSON body on stdin)
//   node scripts/task-host-client.mjs template --workspace <label> --base <commit> [--provider fixture] [--route complete]
//   node scripts/task-host-client.mjs start --request <request.json>
//   node scripts/task-host-client.mjs result|stop|show --launch <launchId>
//   node scripts/task-host-client.mjs diff --launch <launchId>      (patch on stdout)
//
// --data-dir <dir> overrides the default %APPDATA%\agent-orchestrator\task-host.
// This client only speaks the typed ingress; it never starts anything itself.
//
// capabilities, list, status and remote-start are what a controller reaches
// through Matrix (W2b): strict arguments, a bounded body and answer, and fixed
// error codes only, printed as one JSON document. `list` is the public
// task-list projection, without content.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readDiscovery, sendIngressCommand } = require('../src/main/task-host/ingress.js');
const { taskRequestDigest, validateTaskRequest } = require('../src/main/task-host/request.js');
const { AdapterError, runRemoteOperation } = require('../src/main/task-host/remote-adapter.js');

const REMOTE_OPS = new Set(['capabilities', 'list', 'status', 'remote-start']);
const [op, ...rest] = process.argv.slice(2);

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function remote() {
  try {
    const answer = await runRemoteOperation([op, ...rest]);
    print(answer);
    return answer.ok ? 0 : 1;
  } catch (error) {
    print({ ok: false, error: error instanceof AdapterError ? error.code : 'client-error' });
    return 2;
  }
}

function defaultDataDir() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA is not set; pass --data-dir');
  return path.join(appData, 'agent-orchestrator', 'task-host');
}

async function local() {
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--')) throw new Error(`Unexpected argument: ${rest[i]}`);
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (op === 'template') {
    if (!options.workspace || !options.base) throw new Error('template needs --workspace and --base');
    print({
      schema: 1,
      kind: 'agent-orchestrator.task-launch',
      launchId: randomUUID(),
      taskId: options.task || 'task',
      provider: options.provider || 'fixture',
      route: options.route || 'complete',
      workspace: options.workspace,
      baseRevision: options.base,
      presentation: 'task-window',
      instruction: 'Describe the outcome you want here.',
      checks: [{ kind: 'npm-script', name: 'test' }],
      gitEffects: 'edits-only',
    });
    return 0;
  }

  const discovery = readDiscovery(options['data-dir'] || defaultDataDir());
  const send = command => sendIngressCommand(discovery, command);
  let answer;
  if (op === 'start') {
    if (!options.request) throw new Error('start needs --request <file>');
    const request = validateTaskRequest(JSON.parse(fs.readFileSync(options.request, 'utf8')));
    answer = await send({ op, request, digest: taskRequestDigest(request) });
  } else if (['result', 'stop', 'show', 'diff'].includes(op)) {
    if (!options.launch) throw new Error(`${op} needs --launch <launchId>`);
    answer = await send({ op, launchId: options.launch });
    if (op === 'diff' && answer.ok) {
      process.stdout.write(Buffer.from(answer.patchBase64, 'base64'));
      return 0;
    }
  } else {
    throw new Error('Usage: task-host-client.mjs <capabilities|list|status|remote-start|template|start|result|diff|stop|show> [options]');
  }
  print(answer);
  return answer.ok ? 0 : 1;
}

// An absent or replaced host fails closed; say which, without retrying.
function describeFailure(error) {
  if (error.code === 'ENOENT') return 'The task host is not running here (no ingress discovery file).';
  if (error.code === 'ECONNREFUSED') return 'The task host is not running here (the discovery file is stale).';
  return error.message;
}

(REMOTE_OPS.has(op) ? remote() : local()).then(code => { process.exitCode = code; }, (error) => {
  process.stderr.write(`${describeFailure(error)}\n`);
  process.exitCode = 2;
});
