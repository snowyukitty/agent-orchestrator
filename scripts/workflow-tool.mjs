#!/usr/bin/env node
// ============================================================
// Headless workflow authoring: validate, resolve, install.
//
// The GUI is not the only way a workflow is written. A scheduled pre-warm, a
// nightly job, or anything an agent sets up on Snowy's behalf is a JSON
// document dropped into the app's workflow store. Doing that by hand means
// re-deriving three things that are easy to get wrong: the document schema,
// which accounts actually exist, and which directory the app is reading.
//
// This tool answers all three with the app's own code rather than a copy of
// it — the same loader the renderer uses, the same account discovery the main
// process uses, and the same user-data rule the app applies at startup. It
// never launches an agent, never consumes a provider turn, and never starts
// the app.
//
//   node scripts/workflow-tool.mjs where
//   node scripts/workflow-tool.mjs validate <file>
//   node scripts/workflow-tool.mjs check    <file>
//   node scripts/workflow-tool.mjs install  <file> [--force]
//   node scripts/workflow-tool.mjs list
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const { resolveExistingUserData } = require(path.join(ROOT, 'src/main/user-data.js'));
const agentProfiles = require(path.join(ROOT, 'src/main/agents.js'));
const { loadSettings } = require(path.join(ROOT, 'src/main/settings.js'));

// The renderer modules are ES modules with no DOM dependency at import time.
const { loadWorkflowDocument, WORKFLOW_FORMAT_VERSION } = await import(
  pathToFileURL(path.join(ROOT, 'src/js/workflow-document.mjs')).href
);
const { BLOCK_TYPES } = await import(
  pathToFileURL(path.join(ROOT, 'src/js/blocks.mjs')).href
);
const { computeJobTarget, formatCountdown } = await import(
  pathToFileURL(path.join(ROOT, 'src/js/schedule.mjs')).href
);

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

class ToolError extends Error {}

function appDataRoot() {
  if (process.platform === 'win32' && process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** Where the app reads workflows today. Never creates or migrates anything. */
function workflowStore() {
  const resolved = resolveExistingUserData({ appDataRoot: appDataRoot() });
  return { ...resolved, workflows: path.join(resolved.path, 'workflows') };
}

function readDocument(file) {
  const target = path.resolve(file);
  let raw;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error('not a file');
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('document is too large');
    raw = fs.readFileSync(target, 'utf8');
  } catch (error) {
    throw new ToolError(`Cannot read "${file}": ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ToolError(`"${file}" is not valid JSON: ${error.message}`);
  }
  return { target, raw, parsed };
}

/** Parse with the app's loader, so acceptance here means acceptance there. */
function validateDocument(parsed) {
  let loaded;
  try {
    loaded = loadWorkflowDocument(parsed);
  } catch (error) {
    throw new ToolError(`Rejected by the workflow loader: ${error.message}`);
  }
  const errors = loaded.diagnostics.filter(d => d.severity === 'error');
  const warnings = loaded.diagnostics.filter(d => d.severity !== 'error');
  return { ...loaded, errors, warnings };
}

/**
 * Accounts the app can actually open right now.
 *
 * Routed aliases come from ai-agent-entrypoint, which stays the authority;
 * local profiles come from the app's own profile file. Canonical account-home
 * paths are stripped by `describeProfile` before anything is printed.
 */
async function knownProfiles() {
  const store = workflowStore();
  const localFile = path.join(store.path, 'agents.json');
  const local = agentProfiles.loadLocalProfiles(localFile).map(agentProfiles.describeProfile);
  // Resolve the entrypoint exactly as main does: the user's configured path
  // first, then the sibling checkout. This app never becomes the authority.
  const configured = loadSettings(path.join(store.path, 'settings.json')).entrypointPath;
  const discovery = await agentProfiles.discoverRoutedProfiles({
    entrypointPath: agentProfiles.resolveEntrypointPath({ configured, appRoot: ROOT }),
  });
  return {
    local,
    routed: discovery.profiles.map(agentProfiles.describeProfile),
    routedError: discovery.error,
  };
}

function scheduleSummary(document, now = Date.now()) {
  const block = document.blocks.find(b => b.type === 'schedule' && b.params.datetime);
  if (!block) return null;
  const target = computeJobTarget(block.params.datetime, block.params.mode, now);
  if (target <= 0) {
    return { invalid: true, datetime: block.params.datetime, mode: block.params.mode };
  }
  return {
    invalid: false,
    datetime: block.params.datetime,
    mode: block.params.mode,
    fires: new Date(target),
    inMs: target - now,
    past: target < now,
  };
}

function printDocument(document) {
  console.log(`  name        ${document.name}`);
  console.log(`  id          ${document.id}`);
  console.log(`  blocks      ${document.blocks.map(b => b.type).join(' → ')}`);
}

// ── Commands ─────────────────────────────────────────────────

function cmdWhere() {
  const store = workflowStore();
  console.log(`user data   ${store.path}`);
  console.log(`workflows   ${store.workflows}`);
  console.log(`exists      ${store.exists}`);
  if (store.migrationPending) {
    console.log(
      'note        this is the pre-rename directory; the app still reads it and\n'
      + '            copies app-owned JSON forward on its next launch. Write here,\n'
      + '            not to the canonical directory — creating that one early\n'
      + '            cancels the migration and strands the real data.'
    );
  }
  return 0;
}

function cmdList() {
  const store = workflowStore();
  if (!fs.existsSync(store.workflows)) {
    console.log('No workflow store yet.');
    return 0;
  }
  const files = fs.readdirSync(store.workflows).filter(f => f.toLowerCase().endsWith('.json'));
  if (files.length === 0) {
    console.log('No stored workflows.');
    return 0;
  }
  for (const file of files) {
    const full = path.join(store.workflows, file);
    try {
      const { document } = validateDocument(JSON.parse(fs.readFileSync(full, 'utf8')));
      const schedule = scheduleSummary(document);
      const when = schedule
        ? (schedule.invalid
          ? 'invalid schedule'
          : `${schedule.mode} ${schedule.datetime}${schedule.past ? ' (past)' : ''}`)
        : 'no schedule';
      console.log(`${file}  —  ${document.name}  [${when}]`);
    } catch (error) {
      console.log(`${file}  —  UNREADABLE: ${error.message}`);
    }
  }
  return 0;
}

function cmdValidate(file) {
  const { parsed } = readDocument(file);
  const { document, errors, warnings, migrated } = validateDocument(parsed);
  console.log(`✓ Valid workflow document (format v${WORKFLOW_FORMAT_VERSION})`);
  printDocument(document);
  if (migrated) console.log('  note        an older format version was upgraded on load');
  for (const warning of warnings) console.log(`  ⚠ ${warning.code}: ${JSON.stringify(warning)}`);
  for (const problem of errors) console.log(`  ✗ ${problem.code}: ${JSON.stringify(problem)}`);
  return errors.length === 0 ? 0 : 1;
}

async function cmdCheck(file) {
  const { parsed } = readDocument(file);
  const { document, errors } = validateDocument(parsed);
  printDocument(document);
  let failed = errors.length > 0;
  for (const problem of errors) console.log(`  ✗ ${problem.code}`);

  // Accounts. This is the check that catches a workflow outliving its cast.
  const wanted = [...new Set(
    document.blocks
      .filter(b => b.type === 'agentStart')
      .map(b => String(b.params.profileId || '').trim())
  )];
  if (wanted.length > 0) {
    const { local, routed, routedError } = await knownProfiles();
    const known = new Set([...local, ...routed].map(p => p.id));
    if (routedError) console.log(`  ⚠ routed discovery: ${routedError}`);
    for (const id of wanted) {
      if (!id) {
        console.log('  ✗ account      (an Agent Session block has no account selected)');
        failed = true;
      } else if (known.has(id)) {
        console.log(`  ✓ account      ${id}`);
      } else {
        console.log(`  ✗ account      ${id} is not available`);
        failed = true;
      }
    }
  }

  const schedule = scheduleSummary(document);
  if (!schedule) {
    console.log('  · schedule     none (manual run only)');
  } else if (schedule.invalid) {
    console.log(`  ✗ schedule     "${schedule.datetime}" is not a valid date-time`);
    failed = true;
  } else {
    console.log(`  ✓ schedule     ${schedule.mode} → ${schedule.fires.toLocaleString()}`);
    if (schedule.past) {
      console.log('  ⚠ schedule     that time is in the past; a one-shot will not fire');
    } else {
      console.log(`  · fires in     ${formatCountdown(schedule.inMs)}`);
    }
    console.log('  · reminder     schedules only fire while the app is running');
  }
  return failed ? 1 : 0;
}

async function cmdInstall(file, { force }) {
  const checkCode = await cmdCheck(file);
  if (checkCode !== 0 && !force) {
    console.log('\nNot installed. Fix the problems above, or pass --force.');
    return 1;
  }
  const { parsed } = readDocument(file);
  const { document } = validateDocument(parsed);
  const store = workflowStore();
  fs.mkdirSync(store.workflows, { recursive: true });

  // Same basename the app uses, so a later Save from the GUI overwrites this
  // record instead of creating a second copy of the same workflow.
  const safeId = document.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
  const target = path.join(store.workflows, `${safeId}.json`);
  const existed = fs.existsSync(target);

  const body = `${JSON.stringify(document, null, 2)}\n`;
  const temp = `${target}.${process.pid}.tmp`;
  const handle = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(handle, body, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, target);

  console.log(`\n${existed ? 'Replaced' : 'Installed'}  ${target}`);
  if (store.migrationPending) {
    console.log('Written to the pre-rename directory; the app migrates it on next launch.');
  }
  console.log('The app re-reads its workflow store every 10 seconds while running.');
  return 0;
}

function usage() {
  console.log(`Workflow authoring for Agent Orchestrator.

  where               print the workflow store the app reads today
  list                list stored workflows and their schedules
  validate <file>     parse with the app's own loader
  check <file>        validate, resolve every account, report the next trigger
  install <file>      check, then write into the store (--force to install anyway)

Block types: ${Object.keys(BLOCK_TYPES).join(', ')}
Document:    { formatVersion: ${WORKFLOW_FORMAT_VERSION}, id, name, defaultDirectory, blocks: [{ id, type, params }] }

See docs/authoring-workflows.md for the parameter catalog and worked examples.`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const force = rest.includes('--force');
  const file = rest.find(arg => !arg.startsWith('--'));
  const needsFile = ['validate', 'check', 'install'];
  if (needsFile.includes(command) && !file) {
    throw new ToolError(`"${command}" needs a workflow file path.`);
  }
  switch (command) {
    case 'where': return cmdWhere();
    case 'list': return cmdList();
    case 'validate': return cmdValidate(file);
    case 'check': return cmdCheck(file);
    case 'install': return cmdInstall(file, { force });
    default:
      usage();
      return command ? 1 : 0;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof ToolError) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
