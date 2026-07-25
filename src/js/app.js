// ============================================================
// Agents Orchestrator — Main Application
// Wires together blocks, editor, engine, and UI
// ============================================================

import {
  BLOCK_TYPES, createBlock, generateBlockId,
  currentDateTimeLocalValue, renderPaletteBlock, renderWorkflowBlock
} from './blocks.js';

import { ExecutionEngine, analyzeLoops } from './engine.js';
import { TEMPLATES } from './templates.js';
import { computeJobTarget, isDue, formatCountdown, DEFAULT_GRACE_MS } from './schedule.js';
import { runSelfTest } from './selftest.js';

class App {
  constructor() {
    this._defaultDirectory = '.';
    /** @type {{ id: string, name: string, defaultDirectory: string, blocks: Array }} */
    this.workflow = this._normalizeWorkflow({
      id: `wf-${Date.now()}`,
      name: 'New Workflow',
      defaultDirectory: this._defaultDirectory,
      blocks: [],
    });

    this.engine = new ExecutionEngine();
    this.sortable = null;
    this._dirty = false;                // unsaved-changes flag
    this._savedWorkflowsRaw = [];       // last-fetched saved workflows (for the picker)

    this._init();
    this._loadDemoWorkflow();
    this._loadDefaultDirectory();

    // Headless regression run: `electron . --self-test` loads the page with
    // ?selftest=1, exercises the engine's loop control flow with no real PTYs,
    // and reports pass/fail to the main process which sets the exit code.
    if (new URLSearchParams(location.search).get('selftest') === '1') {
      this._runSelfTest();
    }
  }

  // ── Self-Test (headless regression) ────────────────────────
  // The cases live in selftest.js; the app only reports the result to main,
  // which turns it into the `npm test` exit code.

  async _runSelfTest() {
    let result;
    try {
      result = await runSelfTest();
    } catch (err) {
      result = { passed: false, details: `self-test harness threw: ${err?.message || err}` };
    }
    try {
      await window.api.selfTestResult?.({ passed: result.passed, details: result.details });
    } catch (_e) { /* main will time out and exit non-zero */ }
  }

  // ── Templates ──────────────────────────────────────────────
  // Pre-built starting points. The first one is loaded on launch; the rest are
  // available from the Templates picker. Definitions live in templates.js.

  _loadDemoWorkflow() {
    if (TEMPLATES.length > 0) this._applyTemplate(TEMPLATES[0], { silent: true });
  }

  /** Instantiate a template into the editor, filling in dir/time placeholders. */
  _applyTemplate(tpl, { silent = false } = {}) {
    if (!tpl) return;
    if (!silent && !this._confirmDiscardIfDirty()) return;
    const dir = this._defaultDirectory || '.';
    const now = currentDateTimeLocalValue();

    const blocks = tpl.blocks.map(b => {
      const params = { ...b.params };
      if (b.type === 'directory' && !params.path) params.path = dir;
      if (b.type === 'schedule' && !params.datetime) params.datetime = now;
      return { type: b.type, params };
    });

    this.workflow = this._normalizeWorkflow({
      id: `wf-${Date.now()}`,
      name: tpl.name,
      defaultDirectory: dir,
      blocks,
    });

    const nameInput = document.getElementById('workflow-name');
    if (nameInput) nameInput.value = this.workflow.name;
    this.renderBlocks();
    this._onWorkflowChanged();

    // Loading a template should never auto-fire: treat its default schedule
    // time as already handled for the current occurrence.
    this._markScheduleBlockTargetHandled(this._scheduleOf(this.workflow));
    this._setDirty(false);

    if (!silent) {
      this._termLog(`🧩 Loaded template: ${tpl.name}`, 'system');
      this._flashStatus('Template loaded');
    }
  }

  _initTemplates() {
    const modal = document.getElementById('template-modal');
    const list = document.getElementById('template-list');
    const open = () => { this._renderTemplateList(); modal?.classList.remove('hidden'); };
    const close = () => modal?.classList.add('hidden');

    document.getElementById('btn-templates')?.addEventListener('click', open);
    document.getElementById('btn-close-templates')?.addEventListener('click', close);
    modal?.addEventListener('click', (e) => { if (e.target === modal) close(); });

    if (list) {
      list.addEventListener('click', (e) => {
        const row = e.target.closest('[data-template-id]');
        if (!row) return;
        const tpl = TEMPLATES.find(t => t.id === row.dataset.templateId);
        if (tpl) { this._applyTemplate(tpl); close(); }
      });
    }
  }

  _renderTemplateList() {
    const list = document.getElementById('template-list');
    if (!list) return;
    list.innerHTML = TEMPLATES.map(t => {
      const count = t.blocks.length;
      return `
        <div class="tpl-row" data-template-id="${this._esc(t.id)}">
          <div class="tpl-main">
            <div class="tpl-name">${this._esc(t.name)}</div>
            <div class="tpl-desc">${this._esc(t.description)}</div>
          </div>
          <div class="tpl-meta">${count} block${count === 1 ? '' : 's'} ›</div>
        </div>`;
    }).join('');
  }

  // ── My Workflows (saved-workflow manager) ──────────────────

  _initWorkflows() {
    const modal = document.getElementById('workflows-modal');
    const close = () => modal?.classList.add('hidden');
    this._openWorkflowsModal = () => { this._refreshWorkflowsList(); modal?.classList.remove('hidden'); };

    document.getElementById('btn-close-workflows')?.addEventListener('click', close);
    modal?.addEventListener('click', (e) => { if (e.target === modal) close(); });

    document.getElementById('btn-new-workflow')?.addEventListener('click', () => {
      if (this._newWorkflow()) close();
    });
    document.getElementById('btn-import-workflow')?.addEventListener('click', async () => {
      close();
      await this.loadWorkflow();
    });

    const list = document.getElementById('workflows-list');
    list?.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('[data-delete]');
      if (delBtn) {
        e.stopPropagation();
        await this._deleteSavedWorkflow(delBtn.dataset.delete, delBtn.dataset.name);
        return;
      }
      const row = e.target.closest('[data-file]');
      if (row && this._openSavedWorkflow(row.dataset.file)) close();
    });
  }

  /**
   * One global Escape handler for every modal. Registered once from _init()
   * so adding a modal never means adding another key listener.
   */
  _initModalDismissal() {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    });
  }

  async _refreshWorkflowsList() {
    const list = document.getElementById('workflows-list');
    if (!list) return;

    let raw = [];
    try { raw = await window.api.loadWorkflow({}); } catch (_e) { raw = []; }
    this._savedWorkflowsRaw = Array.isArray(raw) ? raw : [];

    const items = this._savedWorkflowsRaw.map(w => {
      const blocks = Array.isArray(w.blocks) ? w.blocks : [];
      const sb = blocks.find(b => b?.type === 'schedule' && b.params?.datetime);
      return {
        file: w.file || '',
        id: w.id || '',
        name: (typeof w.name === 'string' && w.name.trim()) ? w.name : 'Untitled',
        count: blocks.length,
        scheduled: !!sb,
        datetime: sb?.params?.datetime || '',
        mode: sb?.params?.mode || 'once',
      };
    }).filter(it => it.file);

    items.sort((a, b) => a.name.localeCompare(b.name));

    if (items.length === 0) {
      list.innerHTML = `<div class="sched-empty">No saved workflows yet.<br>Build one and hit <strong>💾 Save</strong>, or start from <strong>🧩 Templates</strong>.</div>`;
      return;
    }

    list.innerHTML = items.map(it => {
      const isCurrent = it.id && this.workflow && it.id === this.workflow.id;
      let when = `${it.count} block${it.count === 1 ? '' : 's'}`;
      if (it.scheduled) {
        const t = new Date(it.datetime);
        const valid = !isNaN(t.getTime());
        when += ` · ⏱ ${valid ? t.toLocaleString() : 'invalid time'} (${it.mode === 'cron' ? 'Daily' : 'Once'})`;
      }
      return `
        <div class="wf-row" data-file="${this._esc(it.file)}">
          <div class="wf-main">
            <div class="wf-name">${isCurrent ? '✏️ ' : ''}${this._esc(it.name)}</div>
            <div class="wf-when">${this._esc(when)}</div>
          </div>
          <button class="btn btn-icon btn-sm wf-delete" data-delete="${this._esc(it.file)}"
            data-name="${this._esc(it.name)}" title="Delete from disk">🗑️</button>
        </div>`;
    }).join('');
  }

  /** Open a saved workflow (by file basename) from the last-fetched list. */
  _openSavedWorkflow(file) {
    const raw = (this._savedWorkflowsRaw || []).find(w => w.file === file);
    if (!raw) return false;
    if (!this._confirmDiscardIfDirty()) return false;

    this.workflow = this._normalizeWorkflow(raw);
    document.getElementById('workflow-name').value = this.workflow.name;
    this.renderBlocks();
    this._onWorkflowChanged();
    // Note: do NOT mark the schedule target handled here — opening an existing
    // workflow must keep its (possibly future) schedule armed. Suppression is
    // only for freshly-created/template schedules that default to "now".
    this._setDirty(false);
    this._termLog(`📂 Opened: ${this.workflow.name} (${this.workflow.blocks.length} blocks)`, 'system');
    return true;
  }

  async _deleteSavedWorkflow(file, name) {
    if (!confirm(`Delete workflow "${name}"? This removes it from disk and cannot be undone.`)) return;
    // Resolve via the file's saved id (robust to id sanitization) before the
    // list is refreshed underneath us.
    const deleted = (this._savedWorkflowsRaw || []).find(w => w.file === file);
    try {
      await window.api.deleteWorkflow({ file });
      this._termLog(`🗑️ Deleted workflow: ${name}`, 'system');
      // If we just deleted the on-disk copy of what's open, it's now unsaved.
      if (this.workflow && deleted && deleted.id === this.workflow.id) this._setDirty(true);
    } catch (e) {
      this._termLog(`❌ Delete failed: ${e.message}`, 'stderr');
    }
    await this._refreshWorkflowsList();
    this._refreshScheduledJobs();
  }

  /** Start a blank workflow. Returns false if the user cancelled a discard. */
  _newWorkflow() {
    if (!this._confirmDiscardIfDirty()) return false;
    const dir = this._defaultDirectory || '.';
    this.workflow = this._normalizeWorkflow({
      id: `wf-${Date.now()}`, name: 'New Workflow', defaultDirectory: dir, blocks: [],
    });
    document.getElementById('workflow-name').value = this.workflow.name;
    this.renderBlocks();
    this._onWorkflowChanged();
    this._setDirty(false);
    this._flashStatus('New workflow');
    return true;
  }

  // ── Unsaved-changes (dirty) tracking ───────────────────────

  _setDirty(val) {
    this._dirty = !!val;
    const dot = document.getElementById('dirty-dot');
    if (dot) dot.classList.toggle('hidden', !this._dirty);
  }

  _markDirty() {
    if (!this._dirty) this._setDirty(true);
  }

  _confirmDiscardIfDirty() {
    if (!this._dirty) return true;
    return confirm('You have unsaved changes. Discard them?');
  }

  // ── Initialization ─────────────────────────────────────────

  _init() {
    this._initPalette();
    this._initEditorDrop();
    this._initToolbar();
    this._initTerminal();
    this._initResizer();
    this._initEngine();
    this._initScheduler();
    this._initSleep();
    this._initTemplates();
    this._initWorkflows();
    this._initModalDismissal();
    this._initVersionLabel();
    this._updateEmptyState();
  }

  /** Fill the title-bar version from package.json instead of hardcoding it. */
  async _initVersionLabel() {
    const el = document.getElementById('app-version');
    if (!el) return;
    try {
      const version = await window.api.getVersion?.();
      if (version) el.textContent = `v${version}`;
    } catch (_e) { /* leave the placeholder */ }
  }

  async _loadDefaultDirectory() {
    try {
      const dir = await window.api.getDefaultDirectory?.();
      if (!dir) return;

      this._defaultDirectory = dir;
      const oldDevDir = 'D:\\AI_Projects\\agents-orchestrator';
      const replaceDefaults = new Set(['', '.', oldDevDir]);
      let changed = false;

      if (replaceDefaults.has(this.workflow.defaultDirectory)) {
        this.workflow.defaultDirectory = dir;
        changed = true;
      }

      for (const block of this.workflow.blocks) {
        if (block.type === 'directory' && replaceDefaults.has(block.params?.path || '')) {
          block.params.path = dir;
          changed = true;
        }
      }

      if (changed) {
        this.renderBlocks();
        this._onWorkflowChanged();
      }
    } catch (e) {
      console.warn('Failed to load default directory', e);
    }
  }

  _normalizeWorkflow(data = {}) {
    const source = data && typeof data === 'object' ? data : {};
    const blocks = Array.isArray(source.blocks)
      ? source.blocks.map(block => this._normalizeBlock(block)).filter(Boolean)
      : [];

    return {
      id: this._safeId(source.id, `wf-${Date.now()}`),
      name: typeof source.name === 'string' && source.name.trim()
        ? source.name
        : 'Untitled Workflow',
      defaultDirectory: typeof source.defaultDirectory === 'string'
        ? source.defaultDirectory
        : this._defaultDirectory,
      blocks,
    };
  }

  _normalizeBlock(block) {
    if (!block || typeof block !== 'object' || !BLOCK_TYPES[block.type]) {
      return null;
    }

    const def = BLOCK_TYPES[block.type];
    const params = { ...def.defaultParams };
    const rawParams = block.params && typeof block.params === 'object' ? block.params : {};

    for (const paramDef of def.params) {
      if (!(paramDef.key in rawParams)) continue;
      params[paramDef.key] = this._normalizeParamValue(paramDef, rawParams[paramDef.key], params[paramDef.key]);
    }

    return {
      id: this._safeId(block.id, generateBlockId()),
      type: block.type,
      params,
    };
  }

  _normalizeParamValue(paramDef, value, fallback) {
    switch (paramDef.type) {
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        const min = Number.isFinite(Number(paramDef.min)) ? Number(paramDef.min) : -Infinity;
        const max = Number.isFinite(Number(paramDef.max)) ? Number(paramDef.max) : Infinity;
        return Math.min(max, Math.max(min, n));
      }
      case 'checkbox':
        return Boolean(value);
      case 'select':
        return paramDef.options.some(option => String(option.value) === String(value))
          ? String(value)
          : fallback;
      default:
        return value == null ? '' : String(value);
    }
  }

  _safeId(value, fallback) {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    return /^[a-zA-Z0-9_-]+$/.test(value) ? value : fallback;
  }

  _cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/["\\]/g, '\\$&');
  }

  _onWorkflowChanged() {
    if (typeof this._rebuildJobs === 'function' && Array.isArray(this._scheduledJobs)) {
      this._rebuildJobs();
    }
  }

  // ── Palette (Left Panel) ───────────────────────────────────

  _initPalette() {
    const container = document.getElementById('palette-blocks');

    for (const [type, def] of Object.entries(BLOCK_TYPES)) {
      const el = renderPaletteBlock(def);

      // Double-click → add to end
      el.addEventListener('dblclick', () => this.addBlock(type));

      // Drag from palette
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-block-type', type);
        e.dataTransfer.effectAllowed = 'copy';
        el.style.opacity = '0.4';
      });

      el.addEventListener('dragend', () => {
        el.style.opacity = '1';
      });

      container.appendChild(el);
    }
  }

  // ── Editor Canvas Drop Zone ────────────────────────────────

  _initEditorDrop() {
    const canvas = document.getElementById('editor-canvas');
    const list = document.getElementById('block-list');

    canvas.addEventListener('dragover', (e) => {
      // Only accept palette drags (not SortableJS internal drags)
      if (e.dataTransfer.types.includes('application/x-block-type')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        canvas.classList.add('drag-over');
        this._placeDropMarker(list, e.clientY);
      }
    });

    canvas.addEventListener('dragleave', (e) => {
      if (!canvas.contains(e.relatedTarget)) {
        canvas.classList.remove('drag-over');
        this._removeDropMarker();
      }
    });

    canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      canvas.classList.remove('drag-over');
      const type = e.dataTransfer.getData('application/x-block-type');
      const index = this._dropIndexFromY(list, e.clientY);
      this._removeDropMarker();
      if (type && BLOCK_TYPES[type]) {
        // Drop position determines where the block lands (not always the end).
        this.addBlock(type, index);
      }
    });

    // Workflow name
    const nameInput = document.getElementById('workflow-name');
    nameInput.addEventListener('change', (e) => {
      this.workflow.name = e.target.value;
      this._onWorkflowChanged();
      this._markDirty();
    });

    // Clear all
    document.getElementById('btn-clear').addEventListener('click', () => {
      if (this.workflow.blocks.length === 0) return;
      if (confirm('Remove all blocks from this workflow?')) {
        this.workflow.blocks = [];
        this.renderBlocks();
        this._onWorkflowChanged();
        this._markDirty();
      }
    });
  }

  /** Index at which a palette drop at the given Y should insert (0..length). */
  _dropIndexFromY(list, clientY) {
    const els = [...list.querySelectorAll('.workflow-block')];
    for (let k = 0; k < els.length; k++) {
      const rect = els[k].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return k;
    }
    return els.length; // past the last block → append
  }

  /** Show a horizontal insertion line at the prospective drop position. */
  _placeDropMarker(list, clientY) {
    if (!this._dropMarker) {
      this._dropMarker = document.createElement('div');
      this._dropMarker.className = 'drop-marker';
    }
    const els = [...list.querySelectorAll('.workflow-block')];
    const idx = this._dropIndexFromY(list, clientY);
    if (idx >= els.length) list.appendChild(this._dropMarker);
    else list.insertBefore(this._dropMarker, els[idx]);
  }

  _removeDropMarker() {
    if (this._dropMarker && this._dropMarker.parentNode) {
      this._dropMarker.parentNode.removeChild(this._dropMarker);
    }
  }

  // ── Bottom Toolbar ─────────────────────────────────────────

  _initToolbar() {
    document.getElementById('btn-run').addEventListener('click', () => this.runWorkflow());
    document.getElementById('btn-stop').addEventListener('click', () => this.engine.abort());
    document.getElementById('btn-save').addEventListener('click', () => this.saveWorkflow());
    document.getElementById('btn-load').addEventListener('click', () => this._openWorkflowsModal());
    document.getElementById('btn-export').addEventListener('click', () => this.exportWorkflow());

    const themeSelect = document.getElementById('theme-selector');
    if (themeSelect) {
      themeSelect.addEventListener('change', (e) => {
        this._applyTerminalTheme(e.target.value);
      });
    }

    document.getElementById('btn-clear-log').addEventListener('click', () => {
      const log = document.getElementById('output-log');
      log.innerHTML = '';
      this._appendLog('🧹 Log cleared.', 'system');
    });

    document.getElementById('btn-clear-terminal').addEventListener('click', () => {
      this.term.clear();
    });

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const logPane = document.getElementById('output-log');
        const termPane = document.getElementById('terminal-output');
        const resizerH = document.getElementById('resizer-h');
        if (tab === 'log') {
          logPane.style.display = 'block';
          resizerH.style.display = 'block';
          termPane.style.flex = '1';
        } else {
          logPane.style.display = 'none';
          resizerH.style.display = 'none';
          termPane.style.flex = '1';
        }
        if (this.fitAddon) this.fitAddon.fit();
      });
    });
  }

  // ── Engine Callbacks ───────────────────────────────────────

  _initEngine() {
    const engine = this.engine;

    engine.onLog = (msg, type) => this._termLog(msg, type);

    engine.onBlockStart = (index) => {
      this._forEachBlock((el, i) => {
        el.classList.remove('executing', 'done', 'error');
        if (i < index) el.classList.add('done');
        if (i === index) el.classList.add('executing');
      });
    };

    engine.onBlockEnd = (index, ok) => {
      const el = this._blockElAt(index);
      if (el) {
        el.classList.remove('executing');
        el.classList.add(ok ? 'done' : 'error');
      }
    };

    engine.onComplete = (success) => {
      // Restore toolbar
      document.getElementById('btn-run').classList.remove('hidden');
      document.getElementById('btn-stop').classList.add('hidden');

      // Status badge
      const badge = document.getElementById('workflow-status');
      badge.textContent = success ? 'Done' : 'Error';
      badge.className = `workflow-status ${success ? '' : 'error'}`;

      // Status indicator
      const dot = document.getElementById('status-indicator');
      dot.className = `status-indicator ${success ? '' : 'error'}`;
      document.getElementById('status-text').textContent = success ? 'Completed' : 'Failed';

      // Reset visual states after a delay
      setTimeout(() => {
        this._forEachBlock((el) => {
          el.classList.remove('done', 'error', 'executing');
        });
        this._clearLoopBadges();
        badge.textContent = 'Idle';
        badge.className = 'workflow-status';
        dot.className = 'status-indicator';
        document.getElementById('status-text').textContent = 'Ready';
      }, 4000);
    };

    engine.onStatusChange = (status) => {
      document.getElementById('status-text').textContent = status;
    };

    engine.onLoopIteration = (loopIndex, iter, total, done) => {
      const el = this._blockElAt(loopIndex);
      if (!el) return;
      const header = el.querySelector('.block-header');
      if (!header) return;
      let badge = header.querySelector('.loop-iter');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'loop-iter';
        header.appendChild(badge);
      }
      badge.textContent = `${iter}/${total}`;
      badge.classList.toggle('done', !!done);
      if (!done) {
        document.getElementById('status-text').textContent = `🔄 Loop ${iter}/${total}`;
      }
    };
  }

  /** Remove any loop-iteration badges left on Loop blocks after a run. */
  _clearLoopBadges() {
    document.querySelectorAll('.workflow-block .loop-iter').forEach(b => b.remove());
  }

  // ── Block CRUD ─────────────────────────────────────────────

  addBlock(type, insertIndex = -1) {
    const block = createBlock(type);

    // Adding a Loop also seeds its matching End Loop so the pair stays balanced;
    // the user drags the blocks to repeat in between them.
    const extra = type === 'loop' ? [block, createBlock('loopEnd')] : [block];

    if (insertIndex >= 0 && insertIndex < this.workflow.blocks.length) {
      this.workflow.blocks.splice(insertIndex, 0, ...extra);
    } else {
      this.workflow.blocks.push(...extra);
    }

    this.renderBlocks();
    this._onWorkflowChanged();
    this._markDirty();
    this._markScheduleBlockTargetHandled(block);
    this._scrollToBlock(block.id);
    return block;
  }

  removeBlock(id) {
    this.workflow.blocks = this.workflow.blocks.filter(b => b.id !== id);
    this.renderBlocks();
    this._onWorkflowChanged();
    this._markDirty();
  }

  duplicateBlock(id) {
    const idx = this.workflow.blocks.findIndex(b => b.id === id);
    if (idx === -1) return;

    const original = this.workflow.blocks[idx];
    const copy = createBlock(original.type);
    copy.params = { ...original.params };

    this.workflow.blocks.splice(idx + 1, 0, copy);
    this.renderBlocks();
    this._onWorkflowChanged();
    this._markDirty();
    this._markScheduleBlockTargetHandled(copy);
    this._scrollToBlock(copy.id);
  }

  // ── Render All Blocks ──────────────────────────────────────

  renderBlocks() {
    const list = document.getElementById('block-list');
    list.innerHTML = '';

    // Indent blocks by their loop-nesting depth so the body of a Loop reads as
    // a visually nested group between its Loop and End Loop markers; flag any
    // structurally broken loop markers.
    const { depths, errors, unmatched } = analyzeLoops(this.workflow.blocks);
    const unmatchedSet = new Set(unmatched);

    this.workflow.blocks.forEach((block, i) => {
      // Add connector line between blocks, indented to follow the loop body
      // so the nesting rail reads as continuous.
      if (i > 0) {
        const conn = document.createElement('div');
        conn.className = 'block-connector';
        const connDepth = Math.min(depths[i - 1] || 0, depths[i] || 0);
        if (connDepth > 0) conn.style.marginLeft = `${Math.min(connDepth, 6) * 22}px`;
        list.appendChild(conn);
      }

      const el = renderWorkflowBlock(block, i);
      if (!el) return;
      const depth = depths[i] || 0;
      if (depth > 0) {
        el.classList.add('nested');
        el.style.marginLeft = `${Math.min(depth, 6) * 22}px`;
      }
      if (unmatchedSet.has(i)) {
        el.classList.add('unmatched');
        el.title = block.type === 'loop'
          ? 'This Loop has no matching “End Loop” — its body will be skipped at run time.'
          : 'This “End Loop” has no matching Loop — it will be ignored at run time.';
      }
      this._attachBlockEvents(el, block);
      list.appendChild(el);
    });

    this._renderLoopValidation(errors);

    this._updateEmptyState();
    this._initSortable();
  }

  /** Show/hide the loop structure validation banner above the block list. */
  _renderLoopValidation(errors) {
    const banner = document.getElementById('loop-validation');
    if (!banner) return;
    if (!errors || errors.length === 0) {
      banner.classList.add('hidden');
      banner.textContent = '';
      return;
    }
    const head = errors.length === 1
      ? '⚠ 1 loop structure issue:'
      : `⚠ ${errors.length} loop structure issues:`;
    banner.textContent = `${head} ${errors.join(' · ')}`;
    banner.classList.remove('hidden');
  }

  _attachBlockEvents(el, block) {
    // Delete
    el.querySelector('.block-action-btn.delete')
      ?.addEventListener('click', () => this.removeBlock(block.id));

    // Duplicate
    el.querySelector('.block-action-btn.duplicate')
      ?.addEventListener('click', () => this.duplicateBlock(block.id));

    // Parameter inputs
    el.querySelectorAll('[data-param]').forEach(input => {
      const key = input.dataset.param;
      const handler = () => {
        if (input.type === 'checkbox') {
          block.params[key] = input.checked;
        } else if (input.type === 'number') {
          block.params[key] = Number(input.value);
        } else {
          block.params[key] = input.value;
        }
        this._markDirty();
        if (block.type === 'schedule') this._onWorkflowChanged();
      };
      input.addEventListener('change', handler);
      if (input.type === 'text' || input.tagName === 'TEXTAREA') {
        input.addEventListener('input', handler);
      }
    });

    // Browse directory button
    el.querySelectorAll('.browse-dir-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const dir = await window.api.selectDirectory();
        if (dir) {
          const key = btn.dataset.param;
          block.params[key] = dir;
          const input = el.querySelector(`input[data-param="${key}"]`);
          if (input) input.value = dir;
          this._markDirty();
          if (block.type === 'schedule') this._onWorkflowChanged();
        }
      });
    });

    el.querySelectorAll('.set-now-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.param;
        const value = currentDateTimeLocalValue();
        block.params[key] = value;
        const input = el.querySelector(`input[data-param="${key}"]`);
        if (input) input.value = value;
        this._markDirty();
        if (block.type === 'schedule') {
          this._onWorkflowChanged();
          this._markScheduleBlockTargetHandled(block);
          this._flashStatus('Schedule set to now');
        }
      });
    });
  }

  // ── SortableJS ─────────────────────────────────────────────

  _initSortable() {
    if (this.sortable) {
      this.sortable.destroy();
      this.sortable = null;
    }

    const list = document.getElementById('block-list');

    if (typeof Sortable === 'undefined' || this.workflow.blocks.length === 0) return;

    this.sortable = new Sortable(list, {
      handle: '.drag-handle',
      animation: 200,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',
      // Filter out connector elements
      draggable: '.workflow-block',
      onEnd: (evt) => {
        // SortableJS moved DOM elements; we need to sync our data model.
        // Because connectors are interspersed, compute real block indices.
        const blockEls = [...list.querySelectorAll('.workflow-block')];
        const newOrder = blockEls.map(el => el.dataset.blockId);

        // Rebuild blocks array in the new order
        const blockMap = new Map(this.workflow.blocks.map(b => [b.id, b]));
        this.workflow.blocks = newOrder.map(id => blockMap.get(id)).filter(Boolean);

        // Re-render to fix connectors and step numbers
        this.renderBlocks();
        this._onWorkflowChanged();
        this._markDirty();
      }
    });
  }

  // ── Workflow Execution ─────────────────────────────────────

  async runWorkflow(note = null) {
    if (!this.workflow || this.workflow.blocks.length === 0) {
      this._flashStatus('No blocks to run');
      return;
    }

    // Stop any currently running workflow engine
    if (this.engine.isRunning) {
      this.engine.abort();
    }

    // Prevent zombie processes: clear the default shell and anything left
    // over from previous runs before spawning fresh PTYs.
    await window.api.killAllProcesses().catch(() => {});
    this.activeProcessId = null;

    // Clear log and terminal
    document.getElementById('output-log').innerHTML = '';
    this.term.clear();
    this._clearLoopBadges();
    if (note) this._appendLog(note, 'system');

    // Sync params from DOM → data
    this._syncParams();

    // Toggle buttons
    document.getElementById('btn-run').classList.add('hidden');
    document.getElementById('btn-stop').classList.remove('hidden');

    // Status badge
    const badge = document.getElementById('workflow-status');
    badge.textContent = 'Running';
    badge.className = 'workflow-status running';

    const dot = document.getElementById('status-indicator');
    dot.className = 'status-indicator running';

    // Go!
    try {
      await this.engine.execute(this.workflow.blocks, this.workflow.defaultDirectory);
    } catch (err) {
      this._termLog(`❌ Run failed: ${err.message}`, 'stderr');
      document.getElementById('btn-run').classList.remove('hidden');
      document.getElementById('btn-stop').classList.add('hidden');
      badge.textContent = 'Error';
      badge.className = 'workflow-status error';
      dot.className = 'status-indicator error';
      document.getElementById('status-text').textContent = 'Failed';
    }
  }

  _syncParams() {
    document.querySelectorAll('.workflow-block').forEach(el => {
      const id = el.dataset.blockId;
      const block = this.workflow.blocks.find(b => b.id === id);
      if (!block) return;

      el.querySelectorAll('input[data-param], select[data-param], textarea[data-param]').forEach(input => {
        const key = input.dataset.param;
        if (input.type === 'checkbox') {
          block.params[key] = input.checked;
        } else if (input.type === 'number') {
          block.params[key] = Number(input.value);
        } else {
          block.params[key] = input.value;
        }
      });
    });
  }

  // ── Save / Load / Export ───────────────────────────────────

  async saveWorkflow() {
    this._syncParams();
    this.workflow = this._normalizeWorkflow({
      ...this.workflow,
      name: document.getElementById('workflow-name').value,
    });
    document.getElementById('workflow-name').value = this.workflow.name;
    this.renderBlocks();
    this._onWorkflowChanged();

    try {
      const path = await window.api.saveWorkflow({ workflow: this.workflow });
      this._termLog(`💾 Saved → ${path}`, 'system');
      this._setDirty(false);
      this._flashStatus('Saved');
    } catch (err) {
      this._termLog(`❌ Save failed: ${err.message}`, 'stderr');
    }
  }

  async loadWorkflow() {
    try {
      if (!this._confirmDiscardIfDirty()) return;
      const filePath = await window.api.openFileDialog();
      if (!filePath) return;

      const data = await window.api.loadWorkflow({ filePath });
      if (!data) return;

      this.workflow = this._normalizeWorkflow(data);
      document.getElementById('workflow-name').value = this.workflow.name || 'Loaded';
      this.renderBlocks();
      this._onWorkflowChanged();
      // Keep an imported workflow's schedule armed (don't suppress its target).
      this._setDirty(false);
      this._termLog(`📂 Loaded: ${this.workflow.name} (${this.workflow.blocks.length} blocks)`, 'system');
    } catch (err) {
      this._termLog(`❌ Load failed: ${err.message}`, 'stderr');
    }
  }

  async exportWorkflow() {
    this._syncParams();
    this.workflow = this._normalizeWorkflow(this.workflow);
    document.getElementById('workflow-name').value = this.workflow.name;
    this.renderBlocks();
    this._onWorkflowChanged();

    try {
      const filePath = await window.api.saveFileDialog();
      if (!filePath) return;

      await window.api.saveWorkflow({ workflow: this.workflow, filePath });
      this._termLog(`📤 Exported → ${filePath}`, 'system');
    } catch (err) {
      this._termLog(`❌ Export failed: ${err.message}`, 'stderr');
    }
  }

  // ── Terminal Output ────────────────────────────────────────

  _initTerminal() {
    // Track the active PTY process ID for keyboard interaction
    // (separate from engine.currentProcessId which resets between steps)
    this.activeProcessId = null;

    this.term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 14,
      cursorBlink: true,
      cursorStyle: 'bar',
      disableStdin: false
    });
    this._applyTerminalTheme('ps'); // default

    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);

    const container = document.getElementById('terminal-output');
    container.innerHTML = '';
    this.term.open(container);
    this.fitAddon.fit();

    // Handle resizes
    window.addEventListener('resize', () => this.fitAddon.fit());
    this.term.onResize(({ cols, rows }) => {
      const pid = this.activeProcessId;
      if (pid) {
        window.api.resizeProcess({ id: pid, cols, rows }).catch(() => {});
      }
    });

    // Support Ctrl+C Copy (if selection exists, copy; otherwise send SIGINT)
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.code === 'KeyC' && e.type === 'keydown') {
        const selection = this.term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
          this.term.clearSelection();
          return false;
        }
      }
      return true;
    });

    // Forward ALL keystrokes to the running process
    this.term.onData((data) => {
      const pid = this.activeProcessId;
      if (pid) {
        window.api.sendInput({ id: pid, text: data }).catch(() => {});
      }
    });

    // The app owns the single, persistent set of process IPC listeners.
    // They are registered exactly once here and never removed, so the
    // terminal keeps rendering across multiple workflow runs.
    window.api.onProcessOutput((data) => {
      if (data.id === this.activeProcessId) {
        if (data.stream === 'stdout' || data.stream === 'stderr') {
          this.term.write(data.data);
        }
      }
    });

    window.api.onProcessExit((data) => {
      if (data.id === this.activeProcessId) {
        this.term.write(`\r\n\x1b[90m⬡ Process exited (code ${data.code})\x1b[0m\r\n`);
        this.activeProcessId = null;
      }
      if (this.engine) this.engine.handleProcessExit(data);
    });

    window.api.onProcessError((data) => {
      if (this.engine) this.engine.handleProcessError(data);
    });

    // Start a default PowerShell session immediately so the terminal is interactive on load
    this._spawnDefaultShell();
  }

  async _spawnDefaultShell() {
    try {
      const result = await window.api.executeCommand({
        id: 'default-shell-' + Date.now(),
        command: '', // Empty command drops into an interactive PowerShell session
        cwd: this.workflow?.defaultDirectory || this._defaultDirectory || '.',
        cols: this.term.cols,
        rows: this.term.rows
      });
      if (result.error) {
        throw new Error(result.error);
      }
      this.activeProcessId = result.id;
    } catch (e) {
      console.error('Failed to start default shell', e);
    }
  }

  _applyTerminalTheme(themeName) {
    if (!this.term) return;
    const baseColors = {
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
      blue: '#3b78ff', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c',
      brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e',
      brightCyan: '#61d6d6', brightWhite: '#f2f2f2'
    };
    
    if (themeName === 'dark') {
      this.term.options.theme = { ...baseColors, background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', selectionBackground: '#264f78' };
    } else if (themeName === 'light') {
      this.term.options.theme = { ...baseColors, background: '#ffffff', foreground: '#333333', cursor: '#000000', selectionBackground: '#cce2ff' };
    } else {
      // ps default
      this.term.options.theme = { ...baseColors, background: '#012456', foreground: '#f2f2f2', cursor: '#ffffff', selectionBackground: '#264f78' };
    }
  }

  _initResizer() {
    // Every binding the shared mousemove/mouseup handlers close over is
    // declared up front — the handlers below run long after this function
    // returns, but keeping the declarations first makes that obvious instead
    // of relying on hoisting order.
    const resizer = document.getElementById('resizer');            // editor ↔ right panel
    const terminalPanel = document.getElementById('terminal-panel');
    const resizerH = document.getElementById('resizer-h');         // log ↔ terminal
    const logPane = document.getElementById('output-log');
    let isResizingV = false;
    let isResizingH = false;

    resizer.addEventListener('mousedown', (e) => {
      isResizingV = true;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    resizerH.addEventListener('mousedown', (e) => {
      isResizingH = true;
      resizerH.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (isResizingV) {
        const newWidth = document.body.clientWidth - e.clientX;
        if (newWidth >= 220 && newWidth <= document.body.clientWidth - 300) {
          terminalPanel.style.width = `${newWidth}px`;
          if (this.fitAddon) this.fitAddon.fit();
        }
      }
      if (isResizingH) {
        const panelRect = terminalPanel.getBoundingClientRect();
        const headerH = terminalPanel.querySelector('.panel-header').offsetHeight;
        const offset = e.clientY - panelRect.top - headerH;
        const maxH = panelRect.height - headerH - 84; // leave room for terminal
        if (offset >= 40 && offset <= maxH) {
          logPane.style.flex = `0 0 ${offset}px`;
          if (this.fitAddon) this.fitAddon.fit();
        }
      }
    });

    document.addEventListener('mouseup', () => {
      if (isResizingV) {
        isResizingV = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = 'default';
        if (this.fitAddon) {
          this.fitAddon.fit();
          if (this.engine && this.engine.currentProcessId && this.term) {
            window.api.resizeProcess({
              id: this.engine.currentProcessId,
              cols: this.term.cols,
              rows: this.term.rows
            }).catch(() => {});
          }
        }
      }
      if (isResizingH) {
        isResizingH = false;
        resizerH.classList.remove('dragging');
        document.body.style.cursor = 'default';
        if (this.fitAddon) this.fitAddon.fit();
      }
    });
  }

  // ── Scheduler & Countdown Board ────────────────────────────
  // Tracks EVERY scheduled workflow (saved on disk + the one being edited),
  // shows a live per-workflow countdown, and auto-runs each when its time
  // arrives. A workflow is "scheduled" when it contains a Schedule block
  // with a datetime.

  _initScheduler() {
    this._scheduledJobs = [];   // [{ id, name, datetime, mode, workflow, isCurrent }]
    this._diskJobs = [];        // cached workflows loaded from disk
    this._firedTargets = {};    // jobId → the target timestamp we already fired
    this._keepAwake = false;    // whether we've asked main to hold off sleep
    this._lastDiskRefresh = 0;
    this._refreshingSchedules = null;
    // Fire even if a tick lands up to 5 min late (tolerates throttling / brief
    // sleep). Also bounds staleness so ancient schedules don't fire on load.
    this._graceMs = DEFAULT_GRACE_MS;

    const modal = document.getElementById('schedule-modal');
    const openModal = () => { this._refreshScheduledJobs(); modal?.classList.remove('hidden'); };
    const closeModal = () => modal?.classList.add('hidden');

    document.getElementById('btn-schedules')?.addEventListener('click', openModal);
    document.getElementById('btn-close-schedules')?.addEventListener('click', closeModal);
    document.getElementById('btn-refresh-schedules')?.addEventListener('click', () => this._refreshScheduledJobs());
    modal?.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    this._refreshScheduledJobs();
    // Renderer-side ticker (1s) for smooth countdown display...
    this._scheduleTimer = setInterval(() => this._tickSchedules(), 1000);
    // ...plus a main-process heartbeat that keeps firing even when the window
    // is hidden in the tray or the screen is locked (Chromium would otherwise
    // throttle the renderer timer above).
    window.api.onSchedulerTick(() => this._tickSchedules());
  }

  /** Returns the first schedule block (with a datetime) of a workflow, or null. */
  _scheduleOf(wf) {
    const blocks = wf?.blocks || [];
    return blocks.find(b => b.type === 'schedule' && b.params && b.params.datetime) || null;
  }

  /** Reload scheduled workflows from disk, merge with the current one, re-render. */
  async _refreshScheduledJobs() {
    if (this._refreshingSchedules) return this._refreshingSchedules;

    this._refreshingSchedules = (async () => {
      try {
        const all = await window.api.loadWorkflow({});
        this._diskJobs = (Array.isArray(all) ? all : [])
          .map(wf => this._normalizeWorkflow(wf))
          .filter(wf => this._scheduleOf(wf));
      } catch (e) {
        this._diskJobs = [];
      } finally {
        this._lastDiskRefresh = Date.now();
        this._rebuildJobs();
        this._refreshingSchedules = null;
      }
    })();

    return this._refreshingSchedules;
  }

  /** Build the merged job list (disk ∪ current workflow) and render it. */
  _rebuildJobs() {
    const map = new Map();
    for (const wf of this._diskJobs) map.set(wf.id, wf);
    if (this.workflow) map.set(this.workflow.id, this.workflow); // current overrides its saved copy

    const jobs = [];
    for (const wf of map.values()) {
      const sb = this._scheduleOf(wf);
      if (!sb) continue;
      jobs.push({
        id: wf.id,
        name: wf.name || 'Untitled',
        datetime: sb.params.datetime,
        mode: sb.params.mode || 'once',
        workflow: wf,
        isCurrent: !!(this.workflow && wf.id === this.workflow.id),
      });
    }
    this._scheduledJobs = jobs;
    this._renderScheduleList();
  }

  /** Compute the next trigger timestamp (ms) for a job. Delegates to schedule.js. */
  _jobTarget(job, now) {
    return computeJobTarget(job.datetime, job.mode, now, this._graceMs);
  }

  _formatCountdown(ms) {
    return formatCountdown(ms);
  }

  _tickSchedules() {
    const now = Date.now();

    // Keep the currently-edited workflow's entry fresh (its datetime may change live).
    if (this.workflow) {
      const job = this._scheduledJobs.find(j => j.id === this.workflow.id);
      const sb = this._scheduleOf(this.workflow);
      if (job && sb) { job.datetime = sb.params.datetime; job.mode = sb.params.mode || 'once'; }
    }

    // Periodically re-sync the job list from disk (picks up newly saved workflows).
    // Refresh the disk list periodically (non-blocking — keep checking fires
    // this tick using the current cached list).
    if (now - this._lastDiskRefresh > 10000) this._refreshScheduledJobs();

    this._renderCountdowns(now);

    if (this.engine && this.engine.isRunning) return;

    for (const job of this._scheduledJobs) {
      const target = this._jobTarget(job, now);
      if (target <= 0) continue;
      // Due, and not stale beyond the grace window (so a late/throttled tick
      // still fires, but a schedule from hours ago doesn't fire on app load).
      if (isDue(target, now, this._graceMs)) {
        // Fire once per occurrence (the target timestamp is the occurrence key).
        if (this._firedTargets[job.id] !== target) {
          this._firedTargets[job.id] = target;
          this._runScheduledJob(job);
          break;
        }
      }
    }
  }

  _runScheduledJob(job) {
    // Load the scheduled workflow into the editor, then run it.
    const wf = this._normalizeWorkflow(JSON.parse(JSON.stringify(job.workflow)));
    this.workflow = wf;
    const nameInput = document.getElementById('workflow-name');
    if (nameInput) nameInput.value = wf.name || 'Scheduled';
    this.renderBlocks();
    this._setDirty(false);
    document.getElementById('schedule-modal')?.classList.add('hidden');
    this.runWorkflow(`⏰ Scheduled run: "${wf.name}" @ ${new Date().toLocaleString()}`);
  }

  _markScheduleBlockTargetHandled(block) {
    if (!block || block.type !== 'schedule' || !this.workflow || !Array.isArray(this._scheduledJobs)) return;
    if (this._scheduleOf(this.workflow) !== block) return;
    const target = this._jobTarget({
      datetime: block.params?.datetime,
      mode: block.params?.mode || 'once',
    }, Date.now());
    if (target > 0) {
      this._firedTargets[this.workflow.id] = target;
    }
  }

  _renderScheduleList() {
    const badge = document.getElementById('sched-badge');
    if (badge) badge.textContent = String(this._scheduledJobs.length);

    const list = document.getElementById('schedule-list');
    if (!list) return;

    if (this._scheduledJobs.length === 0) {
      list.innerHTML = `<div class="sched-empty">No scheduled workflows yet.<br>Add a <strong>Schedule</strong> block, set a time, and Save.</div>`;
      this._renderCountdowns(Date.now());
      return;
    }

    const now = Date.now();
    const sorted = [...this._scheduledJobs].sort((a, b) => this._jobTarget(a, now) - this._jobTarget(b, now));
    list.innerHTML = sorted.map(job => {
      const target = this._jobTarget(job, now);
      const valid = !isNaN(new Date(job.datetime).getTime());
      const when = valid ? new Date(target).toLocaleString() : '(invalid time)';
      const id = this._esc(job.id);
      return `
        <div class="sched-row" data-job-id="${id}">
          <div class="sched-main">
            <div class="sched-name">${job.isCurrent ? '✏️ ' : ''}${this._esc(job.name)}</div>
            <div class="sched-when">${this._esc(when)} · ${job.mode === 'cron' ? 'Daily' : 'Once'}</div>
          </div>
          <div class="sched-right">
            <div class="sched-countdown" data-job-id="${id}">—</div>
            <div class="sched-state" data-job-id="${id}"></div>
          </div>
        </div>`;
    }).join('');
    this._renderCountdowns(now);
  }

  /** Update countdown text/state in place each second (no full re-render). */
  _renderCountdowns(now) {
    let next = null;
    for (const job of this._scheduledJobs) {
      const target = this._jobTarget(job, now);
      const remaining = target - now;
      const running = !!(this.engine?.isRunning && this.workflow?.id === job.id);
      const handled = this._firedTargets[job.id] === target;
      const passed = job.mode !== 'cron' && now > target + this._graceMs;
      const sel = `[data-job-id="${this._cssEscape(job.id)}"]`;
      const cdEl = document.querySelector(`#schedule-list .sched-countdown${sel}`);
      const stEl = document.querySelector(`#schedule-list .sched-state${sel}`);

      if (cdEl) {
        cdEl.textContent = running ? 'running' : (passed ? 'passed' : (handled ? 'set' : this._formatCountdown(remaining)));
        cdEl.classList.toggle('due', !running && !passed && !handled && remaining <= 0);
        cdEl.classList.toggle('running', running);
        cdEl.classList.toggle('passed', passed);
        cdEl.classList.toggle('handled', handled && !running && !passed);
      }
      if (stEl) stEl.textContent = running ? '▶' : (passed ? '·' : (handled ? '✓' : (remaining <= 0 ? '⏰' : '')));

      if (!running && !passed && !handled && remaining > 0 && (next === null || remaining < next)) next = remaining;
    }

    const nextEl = document.getElementById('schedule-next');
    if (nextEl) nextEl.textContent = (next !== null) ? `next in ${this._formatCountdown(next)}` : '';

    // Hold off system sleep only while a future run is actually pending.
    const wantAwake = next !== null;
    if (wantAwake !== this._keepAwake) {
      this._keepAwake = wantAwake;
      window.api.setKeepAwake(wantAwake).catch(() => {});
    }
  }

  // ── Delayed Hibernate Countdown ────────────────────────────
  // A Hibernate block arms a delayed system hibernate in the main process.
  // Here we mirror the armed state as a toolbar banner with a live countdown
  // and a force-cancel button. The authoritative timer lives in main.js.

  _initSleep() {
    this._sleepTarget = null;     // epoch ms when hibernate fires (null = none)

    document.getElementById('btn-cancel-sleep')?.addEventListener('click', async () => {
      const wasArmed = await window.api.cancelSleep().catch(() => false);
      this._sleepTarget = null;
      this._renderSleepBanner();
      if (wasArmed) this._appendLog('🚫 Pending hibernate cancelled by user.', 'system');
    });

    // Main process pushes state whenever hibernate is armed / cancelled / fired.
    window.api.onSleepState((state) => {
      this._sleepTarget = state?.target ?? null;
      this._renderSleepBanner();
    });

    // Re-sync in case hibernate was armed before this renderer (re)loaded.
    window.api.getSleepState?.().then((state) => {
      this._sleepTarget = state?.target ?? null;
      this._renderSleepBanner();
    }).catch(() => {});

    // Smooth 1s countdown (backgroundThrottling is off, so this keeps ticking
    // when hidden). The actual hibernate is fired by the main-process timer.
    this._sleepTicker = setInterval(() => this._renderSleepBanner(), 1000);
    this._renderSleepBanner();
  }

  _renderSleepBanner() {
    const banner = document.getElementById('sleep-banner');
    if (!banner) return;

    const remaining = this._sleepTarget != null ? this._sleepTarget - Date.now() : -1;
    if (this._sleepTarget == null || remaining <= 0) {
      banner.classList.add('hidden');
      return;
    }

    banner.classList.remove('hidden');
    const cd = document.getElementById('sleep-countdown');
    if (cd) cd.textContent = this._formatCountdown(remaining);
  }

  _esc(str) {
    const el = document.createElement('span');
    el.textContent = String(str);
    return el.innerHTML;
  }

  _termLog(text, type = 'stdout') {
    if (type === 'stdout') {
      // Raw PTY data → xterm.js only
      if (this.term) this.term.write(text);
    } else {
      // System, stderr, input-echo → Log pane
      this._appendLog(text, type);
    }
  }

  _appendLog(text, type = 'system') {
    const log = document.getElementById('output-log');
    const line = document.createElement('div');
    line.className = `log-line ${type}`;

    // Preserve the engine's intentional blank-line spacing as a top margin,
    // so the timestamp prefix stays on the same row as the message.
    if (typeof text === 'string' && text.startsWith('\n')) {
      line.classList.add('log-spaced');
      text = text.replace(/^\n+/, '');
    }

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = this._timestamp();

    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = text;

    line.append(time, msg);
    log.appendChild(line);
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }

  /** Wall-clock timestamp like "20:14:07.382" for log prefixes. */
  _timestamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  // ── Helpers ────────────────────────────────────────────────

  _updateEmptyState() {
    const el = document.getElementById('editor-empty');
    el.classList.toggle('hidden', this.workflow.blocks.length > 0);
  }

  _scrollToBlock(id) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-block-id="${this._cssEscape(id)}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  _forEachBlock(fn) {
    document.querySelectorAll('.workflow-block').forEach((el, i) => fn(el, i));
  }

  _blockElAt(index) {
    return document.querySelectorAll('.workflow-block')[index] || null;
  }

  _flashStatus(text, duration = 2000) {
    const el = document.getElementById('status-text');
    el.textContent = text;
    setTimeout(() => { el.textContent = 'Ready'; }, duration);
  }
}

// ── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
