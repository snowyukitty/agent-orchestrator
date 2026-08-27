// ============================================================
// Workflow Document Core
// Versioned, loss-aware normalization plus immutable run snapshots.
// This module is intentionally free of DOM and Electron dependencies.
// ============================================================

import { BLOCK_TYPES, generateBlockId } from './blocks.mjs';

export const WORKFLOW_FORMAT_VERSION = 2;
export const MAX_WORKFLOW_NAME_CHARS = 128;
const WORKFLOW_FIELDS = new Set([
  'formatVersion',
  'id',
  'name',
  'defaultDirectory',
  'blocks',
  // `readJsonDir` adds this transport-only basename after parsing. It is never
  // part of the persisted workflow document and is deliberately not returned.
  'file',
]);
const BLOCK_FIELDS = new Set(['id', 'type', 'params']);
let workflowIdCounter = 0;

export class WorkflowFormatError extends Error {
  constructor(message, code = 'invalid-workflow') {
    super(message);
    this.name = 'WorkflowFormatError';
    this.code = code;
  }
}

/**
 * Load a workflow without silently deleting data from a newer document.
 * Legacy documents without `formatVersion` migrate to the current version.
 *
 * @returns {{ document: object, diagnostics: object[], migrated: boolean }}
 */
export function loadWorkflowDocument(data = {}, { defaultDirectory = '.' } = {}) {
  if (!isPlainObject(data)) {
    throw new WorkflowFormatError('Workflow document must be an object', 'invalid-root');
  }
  const source = data;
  assertKnownFields(source, WORKFLOW_FIELDS, 'workflow');
  const rawVersion = source.formatVersion;
  const version = rawVersion === undefined ? 0 : rawVersion;

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new WorkflowFormatError('Workflow formatVersion must be a non-negative integer', 'invalid-version');
  }
  if (version > WORKFLOW_FORMAT_VERSION) {
    throw new WorkflowFormatError(
      `This workflow uses format v${version}; this app supports up to v${WORKFLOW_FORMAT_VERSION}. Update the app before editing or saving it.`,
      'future-version'
    );
  }
  if (!Array.isArray(source.blocks)) {
    throw new WorkflowFormatError('Workflow blocks must be an array', 'invalid-blocks');
  }
  if (
    typeof source.name === 'string'
    && source.name.trim().length > MAX_WORKFLOW_NAME_CHARS
  ) {
    throw new WorkflowFormatError(
      `Workflow name is limited to ${MAX_WORKFLOW_NAME_CHARS} characters`,
      'size-limit'
    );
  }
  if (source.file !== undefined && (typeof source.file !== 'string' || !source.file.trim())) {
    throw new WorkflowFormatError('Workflow source file metadata must be a non-empty string', 'invalid-source');
  }

  const diagnostics = [];
  const duplicateSourceIds = duplicateBlockIds(source.blocks);
  for (const block of source.blocks) {
    const ref = block?.type === 'agentSend'
      ? String(block.params?.handoffFrom || '').trim()
      : '';
    if (ref && duplicateSourceIds.has(ref)) {
      throw new WorkflowFormatError(
        `Result handoff reference "${ref}" is ambiguous because more than one block uses that id.`,
        'ambiguous-result-reference'
      );
    }
  }
  const usedIds = new Set();
  const blocks = source.blocks.map((block, index) => (
    normalizeBlock(block, index, usedIds, diagnostics)
  ));

  const fallbackWorkflowId = source.file
    ? workflowIdForSourceFile(source.file)
    : generateWorkflowId();
  const id = normalizeUniqueId(source.id, fallbackWorkflowId, new Set(), diagnostics, {
    kind: 'workflow',
  });
  diagnostics.push(...analyzeResultReferences(blocks));

  return {
    document: {
      formatVersion: WORKFLOW_FORMAT_VERSION,
      id,
      name: typeof source.name === 'string' && source.name.trim()
        ? source.name.trim()
        : 'Untitled Workflow',
      defaultDirectory: typeof source.defaultDirectory === 'string'
        ? source.defaultDirectory
        : defaultDirectory,
      blocks,
    },
    diagnostics,
    migrated: version < WORKFLOW_FORMAT_VERSION,
  };
}

/**
 * Deep-clone and freeze the plan handed to the engine.
 * Editing the document while a run is active can only affect the next run.
 */
export function createRunSnapshot(workflow) {
  const clone = cloneData(workflow);
  return deepFreeze(clone);
}

/** Collision-resistant within one renderer lifetime, even in the same ms. */
export function generateWorkflowId(now = Date.now()) {
  return `wf-${now}-${++workflowIdCounter}`;
}

/** Stable migration id for one legacy file across periodic reloads. */
export function workflowIdForSourceFile(file) {
  const source = String(file);
  const stem = source
    .replace(/\.json$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'workflow';
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `wf-file-${stem}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeBlock(block, index, usedIds, diagnostics) {
  if (!isPlainObject(block)) {
    throw new WorkflowFormatError(`Block ${index + 1} is not an object`, 'invalid-block');
  }
  assertKnownFields(block, BLOCK_FIELDS, `block ${index + 1}`);
  if (typeof block.type !== 'string' || !Object.hasOwn(BLOCK_TYPES, block.type)) {
    const label = typeof block.type === 'string' && block.type ? `"${block.type}"` : '(missing type)';
    throw new WorkflowFormatError(
      `Block ${index + 1} uses unsupported type ${label}. It was not removed; open this workflow with a compatible app version.`,
      'unknown-block'
    );
  }

  const def = BLOCK_TYPES[block.type];
  if (block.params !== undefined && !isPlainObject(block.params)) {
    throw new WorkflowFormatError(
      `Block ${index + 1} params must be an object`,
      'invalid-params'
    );
  }
  const rawParams = block.params || {};
  assertKnownFields(
    rawParams,
    new Set(def.params.map(param => param.key)),
    `block ${index + 1} (${block.type}) params`
  );
  const params = { ...def.defaultParams };
  for (const paramDef of def.params) {
    if (!(paramDef.key in rawParams)) continue;
    params[paramDef.key] = normalizeParamValue(
      paramDef,
      rawParams[paramDef.key],
      params[paramDef.key]
    );
  }

  return {
    id: normalizeUniqueId(block.id, generateBlockId(), usedIds, diagnostics, {
      kind: 'block',
      index,
    }),
    type: block.type,
    params,
  };
}

function normalizeParamValue(paramDef, value, fallback) {
  switch (paramDef.type) {
    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      const min = Number.isFinite(Number(paramDef.min)) ? Number(paramDef.min) : -Infinity;
      const max = Number.isFinite(Number(paramDef.max)) ? Number(paramDef.max) : Infinity;
      return Math.min(max, Math.max(min, number));
    }
    case 'checkbox':
      return Boolean(value);
    case 'select':
      return paramDef.options.some(option => String(option.value) === String(value))
        ? String(value)
        : fallback;
    default:
      return (value == null ? '' : String(value))
        .slice(0, Number.isInteger(paramDef.maxLength) ? paramDef.maxLength : undefined);
  }
}

/**
 * Validate same-run result references without mutating the workflow.
 * A handoff may only point backward to a Join Agents block that explicitly
 * names a captured result. Result values never flow into shell/path blocks.
 */
export function analyzeResultReferences(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const byId = new Map(list.map((block, index) => [block?.id, { block, index }]));
  const diagnostics = [];

  list.forEach((block, index) => {
    if (block?.type !== 'agentSend') return;
    const ref = String(block.params?.handoffFrom || '').trim();
    if (!ref) return;
    const producer = byId.get(ref);
    let message = '';
    if (!producer) {
      message = 'The attached result producer no longer exists.';
    } else if (producer.index >= index) {
      message = 'A result handoff must come from an earlier Join Agents block.';
    } else if (
      producer.block?.type !== 'agentJoin'
      || !String(producer.block.params?.resultName || '').trim()
    ) {
      message = 'The selected block does not publish a named agent result.';
    }
    if (message) {
      diagnostics.push({
        code: 'invalid-result-reference',
        severity: 'error',
        index,
        blockId: block.id || null,
        reference: ref,
        message,
      });
    }
  });
  return diagnostics;
}

export function assertValidResultReferences(blocks) {
  const errors = analyzeResultReferences(blocks);
  if (errors.length) {
    throw new WorkflowFormatError(
      `Invalid result handoff at step ${errors[0].index + 1}: ${errors[0].message}`,
      'invalid-result-reference'
    );
  }
}

function duplicateBlockIds(blocks) {
  const seen = new Set();
  const duplicates = new Set();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = typeof block?.id === 'string' ? block.id : '';
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates;
}

function normalizeUniqueId(value, fallback, usedIds, diagnostics, context) {
  const supplied = value !== undefined && value !== null && value !== '';
  let id = typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    ? value
    : fallback;
  const original = id;
  while (usedIds.has(id)) id = generateBlockId();
  usedIds.add(id);

  if (supplied && id !== value) {
    diagnostics.push({
      code: usedIds.has(value) ? 'duplicate-id-repaired' : 'invalid-id-repaired',
      severity: 'warning',
      ...context,
      previousId: typeof value === 'string' ? value : null,
      id,
    });
  } else if (id !== original) {
    diagnostics.push({
      code: 'duplicate-id-repaired',
      severity: 'warning',
      ...context,
      previousId: original,
      id,
    });
  }
  return id;
}

function assertKnownFields(value, allowed, context) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length === 0) return;
  const quoted = unknown.map(key => `"${key}"`).join(', ');
  throw new WorkflowFormatError(
    `Unsupported field${unknown.length === 1 ? '' : 's'} ${quoted} in ${context}. Open this workflow with a compatible app version; no data was removed.`,
    'unknown-field'
  );
}

function cloneData(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
