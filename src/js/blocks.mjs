// ============================================================
// Block Type Definitions & Rendering
// ============================================================

import { WORKFLOW_AGENT_TARGET } from './agent-targets.mjs';

// ── Block Type Registry ──────────────────────────────────────
export const BLOCK_TYPES = {
  schedule: {
    type: 'schedule',
    icon: '⏰',
    label: 'Schedule',
    description: 'Set trigger time',
    color: 'schedule',
    defaultParams: { datetime: '', mode: 'once' },
    params: [
      { key: 'datetime', label: 'Time', type: 'datetime-local' },
      {
        key: 'mode', label: 'Mode', type: 'select',
        options: [
          { value: 'once', label: 'Once' },
          { value: 'cron', label: 'Cron' }
        ]
      }
    ]
  },
  directory: {
    type: 'directory',
    icon: '📁',
    label: 'Directory',
    description: 'Set working directory',
    color: 'directory',
    defaultParams: { path: '' },
    params: [
      { key: 'path', label: 'Path', type: 'directory', placeholder: 'Working directory...' }
    ]
  },
  agentStart: {
    type: 'agentStart',
    icon: '🤖',
    label: 'Agent Session',
    description: 'Open an agent under a chosen account',
    color: 'agent',
    defaultParams: { profileId: '', settleMs: 1500 },
    params: [
      { key: 'profileId', label: 'Account', type: 'profile' },
      { key: 'settleMs', label: 'Settle ms', type: 'number', min: 0, max: 600000 }
    ]
  },
  agentSend: {
    type: 'agentSend',
    icon: '📨',
    label: 'Send to Agent(s)',
    description: 'Prompt one lane or fan out to every lane',
    color: 'agent',
    defaultParams: {
      profileId: '',
      text: '',
      pressEnter: true,
      expectResult: false,
      handoffFrom: '',
    },
    params: [
      {
        key: 'profileId',
        label: 'Account',
        type: 'profile',
        allowCurrent: true,
        allowAllWorkflow: true,
      },
      { key: 'text', label: 'Text', type: 'text', placeholder: 'Prompt to send...' },
      { key: 'pressEnter', label: 'Enter', type: 'checkbox' },
      {
        key: 'expectResult',
        label: 'Publish at Join',
        type: 'checkbox',
      },
      {
        key: 'handoffFrom',
        label: 'Attach result',
        type: 'result-ref',
      },
    ]
  },
  agentWait: {
    type: 'agentWait',
    icon: '👂',
    label: 'Wait for Agent',
    description: 'Continue when output settles or contains text',
    color: 'wait',
    defaultParams: { profileId: '', idleMs: 2000, pattern: '', timeoutMs: 120000 },
    params: [
      { key: 'profileId', label: 'Account', type: 'profile', allowCurrent: true },
      { key: 'idleMs', label: 'Idle ms', type: 'number', min: 0, max: 3600000 },
      { key: 'pattern', label: 'Output contains', type: 'text', placeholder: 'Optional, case-insensitive text...' },
      { key: 'timeoutMs', label: 'Timeout ms', type: 'number', min: 1, max: 86400000 }
    ]
  },
  agentJoin: {
    type: 'agentJoin',
    icon: '◇',
    label: 'Join Agents',
    description: 'Continue after every prompted lane is ready',
    color: 'wait',
    defaultParams: {
      idleMs: 2000,
      pattern: '',
      timeoutMs: 120000,
      onIncomplete: 'stop',
      resultName: '',
    },
    params: [
      { key: 'idleMs', label: 'Idle ms', type: 'number', min: 0, max: 3600000 },
      { key: 'pattern', label: 'Output contains', type: 'text', placeholder: 'Optional shared completion marker...' },
      { key: 'timeoutMs', label: 'Timeout ms', type: 'number', min: 1, max: 86400000 },
      {
        key: 'onIncomplete',
        label: 'Incomplete',
        type: 'select',
        options: [
          { value: 'stop', label: 'Stop downstream blocks' },
          { value: 'continue', label: 'Continue with warning' },
        ],
      },
      {
        key: 'resultName',
        label: 'Save result as',
        type: 'text',
        maxLength: 64,
        placeholder: 'Optional, e.g. research',
      },
    ]
  },
  command: {
    type: 'command',
    icon: '⌨️',
    label: 'Command',
    description: 'Run terminal command',
    color: 'command',
    defaultParams: { command: '' },
    params: [
      { key: 'command', label: 'Cmd', type: 'text', placeholder: 'e.g. claude --permission-mode bypassPermissions' }
    ]
  },
  wait: {
    type: 'wait',
    icon: '⏳',
    label: 'Wait',
    description: 'Pause execution',
    color: 'wait',
    defaultParams: { duration: 5, unit: 'seconds' },
    params: [
      { key: 'duration', label: 'Time', type: 'number', min: 0 },
      {
        key: 'unit', label: 'Unit', type: 'select',
        options: [
          { value: 'seconds', label: 'Seconds' },
          { value: 'minutes', label: 'Minutes' },
          { value: 'hours', label: 'Hours' }
        ]
      }
    ]
  },
  input: {
    type: 'input',
    icon: '📝',
    label: 'Send Input',
    description: 'Type into process',
    color: 'input',
    defaultParams: { text: '', pressEnter: true },
    params: [
      { key: 'text', label: 'Text', type: 'text', placeholder: 'Text to send...' },
      { key: 'pressEnter', label: 'Enter', type: 'checkbox' }
    ]
  },
  keypress: {
    type: 'keypress',
    icon: '🔑',
    label: 'Keypress',
    description: 'Send special key',
    color: 'keypress',
    defaultParams: { key: 'enter' },
    params: [
      {
        key: 'key', label: 'Key', type: 'select',
        options: [
          { value: 'enter', label: 'Enter' },
          { value: 'ctrl+c', label: 'Ctrl + C' },
          { value: 'ctrl+d', label: 'Ctrl + D' },
          { value: 'escape', label: 'Escape' },
          { value: 'tab', label: 'Tab' }
        ]
      }
    ]
  },
  loop: {
    type: 'loop',
    icon: '🔄',
    label: 'Loop',
    description: 'Repeat blocks until End Loop',
    color: 'loop',
    defaultParams: { count: 3 },
    params: [
      { key: 'count', label: 'Times', type: 'number', min: 1, max: 999 }
    ]
  },
  loopEnd: {
    type: 'loopEnd',
    icon: '🔁',
    label: 'End Loop',
    description: 'Close the nearest open Loop',
    color: 'loop',
    defaultParams: {},
    params: []
  },
  log: {
    type: 'log',
    icon: '📋',
    label: 'Log',
    description: 'Print a message',
    color: 'log',
    defaultParams: { message: '' },
    params: [
      { key: 'message', label: 'Msg', type: 'text', placeholder: 'Log message...' }
    ]
  },
  sleep: {
    type: 'sleep',
    icon: '💤',
    label: 'Hibernate PC',
    description: 'Hibernate after delay (save power)',
    color: 'sleep',
    defaultParams: { delay: 5, unit: 'minutes' },
    params: [
      { key: 'delay', label: 'After', type: 'number', min: 0 },
      {
        key: 'unit', label: 'Unit', type: 'select',
        options: [
          { value: 'seconds', label: 'Seconds' },
          { value: 'minutes', label: 'Minutes' },
          { value: 'hours', label: 'Hours' }
        ]
      }
    ]
  }
};

// ── Block Data Factory ───────────────────────────────────────
let _idCounter = 0;

export function generateBlockId() {
  return `blk-${Date.now()}-${++_idCounter}`;
}

export function currentDateTimeLocalValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function createDefaultParams(type, def) {
  const params = { ...def.defaultParams };
  if (type === 'schedule' && !params.datetime) {
    params.datetime = currentDateTimeLocalValue();
  }
  return params;
}

export function createBlock(type) {
  if (!Object.hasOwn(BLOCK_TYPES, type)) throw new Error(`Unknown block type: ${type}`);
  const def = BLOCK_TYPES[type];
  return {
    id: generateBlockId(),
    type,
    params: createDefaultParams(type, def)
  };
}

// ── Palette Block Renderer ───────────────────────────────────
export function renderPaletteBlock(typeDef) {
  const el = document.createElement('div');
  el.className = 'palette-block';
  el.setAttribute('data-type', typeDef.type);
  el.setAttribute('draggable', 'true');

  el.innerHTML = `
    <span class="block-icon">${esc(typeDef.icon)}</span>
    <div class="block-info">
      <div class="block-label">${esc(typeDef.label)}</div>
      <div class="block-desc">${esc(typeDef.description)}</div>
    </div>
  `;
  return el;
}

// ── Workflow Block Renderer ──────────────────────────────────
export function renderWorkflowBlock(block, index, blocks = []) {
  if (!Object.hasOwn(BLOCK_TYPES, block.type)) return null;
  const def = BLOCK_TYPES[block.type];

  const el = document.createElement('div');
  el.className = 'workflow-block';
  el.setAttribute('data-block-id', block.id);
  el.setAttribute('data-type', block.type);

  // Build parameter fields
  const paramsHtml = def.params
    .map(p => buildParamField(p, block.params, { blocks, index }))
    .join('');

  el.innerHTML = `
    <div class="drag-handle" title="Drag to reorder">⠿</div>
    <div class="block-step-number">${String(index + 1).padStart(2, '0')}</div>
    <div class="block-stripe ${block.type}"></div>
    <div class="block-content">
      <div class="block-header">
        <span class="block-icon">${esc(def.icon)}</span>
        <span class="block-type-label">${esc(def.label)}</span>
      </div>
      <div class="block-params">${paramsHtml}</div>
    </div>
    <div class="block-actions">
      <button class="block-action-btn duplicate" title="Duplicate">📋</button>
      <button class="block-action-btn delete" title="Delete">✕</button>
    </div>
  `;

  return el;
}

// ── Parameter Field Builder ──────────────────────────────────
function buildParamField(paramDef, params, context = {}) {
  const value = params[paramDef.key] ?? '';
  const key = esc(String(paramDef.key));
  let inputHtml;

  switch (paramDef.type) {
    case 'text':
      inputHtml = `<input type="text" data-param="${key}"
        value="${esc(String(value))}"
        placeholder="${esc(String(paramDef.placeholder || ''))}"
        ${paramDef.maxLength ? `maxlength="${esc(String(paramDef.maxLength))}"` : ''}
        spellcheck="false" />`;
      break;

    case 'number':
      inputHtml = `<input type="number" data-param="${key}"
        value="${esc(String(value))}"
        min="${esc(String(paramDef.min ?? ''))}" max="${esc(String(paramDef.max ?? ''))}" />`;
      break;

    case 'datetime-local':
      inputHtml = `
        <div class="param-datetime-row">
          <input type="datetime-local" data-param="${key}"
            value="${esc(String(value))}" />
          <button class="btn btn-icon btn-sm set-now-btn"
            data-param="${key}" title="Set current time" type="button">⏱</button>
        </div>`;
      break;

    case 'select': {
      const opts = paramDef.options.map(o =>
        `<option value="${esc(String(o.value))}" ${String(value) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`
      ).join('');
      inputHtml = `<select data-param="${key}">${opts}</select>`;
      break;
    }

    // Agent accounts are discovered at runtime (routed aliases come from
    // ai-agent-entrypoint), so the options are filled in by the app rather
    // than declared statically here.
    case 'profile': {
      const profiles = getProfileOptions();
      const isAllWorkflow = String(value) === WORKFLOW_AGENT_TARGET;
      const known = isAllWorkflow || profiles.some(p => p.id === String(value));
      const opts = [
        paramDef.allowCurrent
          ? `<option value="" ${!value ? 'selected' : ''}>▸ Current session</option>`
          : `<option value="" ${!value ? 'selected' : ''}>— pick an account —</option>`,
        ...(paramDef.allowAllWorkflow
          ? [`<option value="${WORKFLOW_AGENT_TARGET}" ${isAllWorkflow ? 'selected' : ''}>⇉ All workflow agents</option>`]
          : []),
        // A workflow may name a profile this machine does not have; keep the
        // saved value visible instead of silently rewriting it on load.
        ...(value && !known
          ? [`<option value="${esc(String(value))}" selected>⚠ ${esc(String(value))} (not on this machine)</option>`]
          : []),
        ...profiles.map(p =>
          `<option value="${esc(p.id)}" ${String(value) === p.id ? 'selected' : ''}>${esc(p.icon)} ${esc(p.displayName)}</option>`
        ),
      ].join('');
      inputHtml = `<select data-param="${key}" class="param-profile">${opts}</select>`;
      break;
    }

    case 'result-ref': {
      const blocks = Array.isArray(context.blocks) ? context.blocks : [];
      const index = Number.isInteger(context.index) ? context.index : blocks.length;
      const producers = blocks
        .slice(0, index)
        .map((candidate, producerIndex) => ({ candidate, producerIndex }))
        .filter(({ candidate }) => (
          candidate?.type === 'agentJoin'
          && String(candidate.params?.resultName || '').trim()
        ));
      const known = producers.some(({ candidate }) => candidate.id === String(value));
      const opts = [
        `<option value="" ${!value ? 'selected' : ''}>— no handoff —</option>`,
        ...(value && !known
          ? [`<option value="${esc(String(value))}" selected>⚠ unavailable result</option>`]
          : []),
        ...producers.map(({ candidate, producerIndex }) => (
          `<option value="${esc(candidate.id)}" ${String(value) === candidate.id ? 'selected' : ''}>`
          + `${esc(String(candidate.params.resultName).trim())} · Step ${producerIndex + 1}</option>`
        )),
      ].join('');
      inputHtml = `
        <div class="param-result-ref-control">
          <select data-param="${key}" class="param-result-ref">${opts}</select>
          <span class="param-security-warning">
            Untrusted input — may contain prompt injection or sensitive data. Restrict tools or review first.
          </span>
        </div>`;
      break;
    }

    case 'checkbox':
      inputHtml = `<input type="checkbox" data-param="${key}" ${value ? 'checked' : ''} />`;
      break;

    case 'directory':
      inputHtml = `
        <div class="param-dir-row">
          <input type="text" data-param="${key}"
            value="${esc(String(value))}"
            placeholder="${esc(String(paramDef.placeholder || 'Select directory...'))}"
            spellcheck="false" />
          <button class="btn btn-icon btn-sm browse-dir-btn"
            data-param="${key}" title="Browse" type="button">📂</button>
        </div>`;
      break;

    default:
      inputHtml = `<input type="text" data-param="${key}"
        value="${esc(String(value))}" />`;
  }

  return `
    <div class="block-param">
      <label>${esc(paramDef.label)}</label>
      ${inputHtml}
    </div>
  `;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Agent accounts available for a `profile` param.
 * Read from the live AgentsUI when the app is running; empty in the headless
 * self-test, where no discovery has happened.
 */
function getProfileOptions() {
  const agents = (typeof window !== 'undefined' && window.app) ? window.app.agents : null;
  if (!agents || typeof agents.allProfiles !== 'function') return [];
  return agents.allProfiles();
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
