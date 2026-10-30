// Task-launch adapters: how one fresh provider receives its instruction and
// what lifecycle evidence it can produce.
//
// Both adapters use argv-pointer delivery: the instruction lives in a private
// per-launch file outside the worktree, and the provider's initial prompt is a
// fixed sentence naming that file. Task text never enters argv, the clipboard,
// or an existing PTY.

const path = require('path');
const { randomBytes } = require('crypto');

const { parseStrictJson } = require('./strict-json');

const MAX_SUMMARY_CHARS = 4000;
const MAX_CLAIMED_CHECKS = 16;
const CLAIM_OUTCOMES = new Set(['passed', 'failed', 'not-run']);

function pointerPrompt(promptFile) {
  return `Your complete task is in the file ${promptFile} . Read that file first and follow it exactly.`;
}

/** Per-launch secrets that appear only inside the private prompt file. */
function createResultFrame() {
  const frameId = randomBytes(8).toString('hex');
  return {
    nonce: randomBytes(16).toString('hex'),
    startMarker: `AO-TASK-RESULT-BEGIN-${frameId}`,
    endMarker: `AO-TASK-RESULT-END-${frameId}`,
  };
}

function renderPromptFile(request, frame) {
  const checks = request.checks.length
    ? request.checks.map(check => `- \`npm run ${check.name}\``).join('\n')
    : '- (none requested)';
  return [
    `# Task ${request.taskId}`,
    '',
    'You are running in a fresh Git worktree created only for this task. It is',
    'your current working directory.',
    '',
    '## Instruction',
    '',
    request.instruction,
    '',
    '## Rules',
    '',
    '- Change files only inside the current working directory.',
    '- Do not commit, push, merge, or deploy. Leave every change uncommitted; the',
    '  host collects the diff for review.',
    '- Ask in this window if a decision is outside the instruction.',
    '',
    '## Checks',
    '',
    'Run these if you can. The host will also run them itself after you finish,',
    'and will report your claims and its own observations separately.',
    '',
    checks,
    '',
    '## Report',
    '',
    'When you are finished, print exactly one result block as plain text, with',
    'each marker alone on its own line and one line of JSON between them:',
    '',
    frame.startMarker,
    `{"nonce":"${frame.nonce}","summary":"<one paragraph>","checks":[{"name":"<check>","outcome":"passed|failed|not-run"}]}`,
    frame.endMarker,
    '',
  ].join('\n');
}

/**
 * Interpret a captured frame body. Everything in it is AI-reported and
 * untrusted; this only bounds and types it.
 */
function parseResultFrame(capture, frame) {
  if (!capture) return { frame: 'missing', nonce: 'not-observed', aiReported: null };
  if (!capture.complete) {
    // A frame that began but never ended is partial output, not an absent one.
    return {
      frame: capture.missingStart ? 'missing' : 'truncated',
      nonce: 'not-observed',
      aiReported: null,
    };
  }
  let body;
  try {
    body = parseStrictJson(capture.text.replace(/\s+/g, ' ').trim(), { maxDepth: 4 });
  } catch (_error) {
    return { frame: 'invalid', nonce: 'not-observed', aiReported: null };
  }
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
  if (keys.join(',') !== 'checks,nonce,summary') return { frame: 'invalid', nonce: 'not-observed', aiReported: null };
  const nonce = body.nonce === frame.nonce ? 'echoed' : 'mismatch';
  if (
    typeof body.summary !== 'string' || body.summary.length > MAX_SUMMARY_CHARS ||
    !Array.isArray(body.checks) || body.checks.length > MAX_CLAIMED_CHECKS ||
    !body.checks.every(check => check && typeof check === 'object' && !Array.isArray(check) &&
      Object.keys(check).sort().join(',') === 'name,outcome' &&
      typeof check.name === 'string' && check.name.length <= 64 && CLAIM_OUTCOMES.has(check.outcome))
  ) {
    return { frame: 'invalid', nonce, aiReported: null };
  }
  return {
    frame: 'complete',
    nonce,
    aiReported: {
      summary: body.summary,
      checks: body.checks.map(check => ({ name: check.name, outcome: check.outcome })),
    },
  };
}

/** Fixture provider: a local script that behaves like a scripted agent. */
function createFixtureAdapter({ script, execPath = process.execPath, baseEnv = process.env } = {}) {
  if (!script || !path.isAbsolute(script)) throw new TypeError('Fixture adapter needs an absolute script path');
  return {
    id: 'fixture',
    qualification: 'fixture-only',
    delivery: 'argv-pointer',
    lifecycle: 'authenticated-turn-complete',
    async buildSpec({ route, worktree, promptFile }) {
      return {
        file: execPath,
        args: [script, '--scenario', route, pointerPrompt(promptFile)],
        env: { ...baseEnv },
        cwd: worktree,
        profileId: `fixture:${route}`,
        agent: 'fixture',
        label: `fixture · ${route}`,
        assurance: 'L0-native',
        resultInputCapable: false,
        sessionMode: 'direct-agent',
        initialTurnSubmitted: true,
      };
    },
  };
}

/**
 * Routed Codex through ai-agent-entrypoint's direct-agent contract. Built and
 * unit-tested, but unqualified: the host refuses it at admission until a
 * separately authorized live turn qualifies argv-pointer delivery.
 */
function createCodexAdapter({ resolveProfile, buildLaunchSpec, launchContext } = {}) {
  if (typeof resolveProfile !== 'function' || typeof buildLaunchSpec !== 'function') {
    throw new TypeError('Codex adapter needs profile resolution and launch-spec construction');
  }
  return {
    id: 'codex',
    qualification: 'unqualified',
    delivery: 'argv-pointer',
    lifecycle: 'authenticated-turn-complete',
    async buildSpec({ route, worktree, promptFile }) {
      const profile = await resolveProfile(route);
      if (!profile || profile.kind !== 'routed') throw new Error('route-unavailable');
      const spec = buildLaunchSpec(profile, { ...(await launchContext()), sessionMode: 'direct-agent' });
      if (spec.sessionMode !== 'direct-agent' || spec.agent !== 'codex') throw new Error('route-unavailable');
      return {
        ...spec,
        args: [...spec.args, pointerPrompt(promptFile)],
        cwd: worktree,
        initialTurnSubmitted: true,
      };
    },
  };
}

module.exports = {
  createCodexAdapter,
  createFixtureAdapter,
  createResultFrame,
  parseResultFrame,
  pointerPrompt,
  renderPromptFile,
};
