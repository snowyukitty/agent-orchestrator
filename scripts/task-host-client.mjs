#!/usr/bin/env node
// Local client for the desktop task host's loopback ingress.
//
//   node scripts/task-host-client.mjs capabilities
//   node scripts/task-host-client.mjs template --workspace <label> --base <commit> [--provider fixture] [--route complete]
//   node scripts/task-host-client.mjs start --request <request.json>
//   node scripts/task-host-client.mjs status|result|stop|show --launch <launchId>
//   node scripts/task-host-client.mjs diff --launch <launchId>      (patch on stdout)
//
// --data-dir <dir> overrides the default %APPDATA%\agent-orchestrator\task-host.
// This client only speaks the typed ingress; it never starts anything itself.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readDiscovery, sendIngressCommand } = require('../src/main/task-host/ingress.js');
const { taskRequestDigest, validateTaskRequest } = require('../src/main/task-host/request.js');

const [op, ...rest] = process.argv.slice(2);
const options = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i]?.startsWith('--')) throw new Error(`Unexpected argument: ${rest[i]}`);
  options[rest[i].slice(2)] = rest[i + 1];
}

function defaultDataDir() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA is not set; pass --data-dir');
  return path.join(appData, 'agent-orchestrator', 'task-host');
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
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
  if (op === 'capabilities') {
    answer = await send({ op });
  } else if (op === 'start') {
    if (!options.request) throw new Error('start needs --request <file>');
    const request = validateTaskRequest(JSON.parse(fs.readFileSync(options.request, 'utf8')));
    answer = await send({ op, request, digest: taskRequestDigest(request) });
  } else if (['status', 'result', 'stop', 'show', 'diff'].includes(op)) {
    if (!options.launch) throw new Error(`${op} needs --launch <launchId>`);
    answer = await send({ op, launchId: options.launch });
    if (op === 'diff' && answer.ok) {
      process.stdout.write(Buffer.from(answer.patchBase64, 'base64'));
      return 0;
    }
  } else {
    throw new Error('Usage: task-host-client.mjs <capabilities|template|start|status|result|diff|stop|show> [options]');
  }
  print(answer);
  return answer.ok ? 0 : 1;
}

main().then(code => { process.exitCode = code; }, (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
