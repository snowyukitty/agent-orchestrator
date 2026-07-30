// ============================================================
// Agent Orchestrator — Main Application
// Wires together blocks, editor, engine, and UI
// ============================================================

import {
  BLOCK_TYPES, createBlock, generateBlockId,
  currentDateTimeLocalValue, renderPaletteBlock, renderWorkflowBlock
} from './blocks.js';

import { ExecutionEngine, analyzeLoops } from './engine.js';
import { TEMPLATES } from './templates.js';
import {
  computeJobTarget,
  isDue,
  formatCountdown,
  mergeScheduledWorkflowSources,
  DEFAULT_GRACE_MS,
} from './schedule.js';
import { runSelfTest } from './selftest.js';
import { SessionManager, TARGET_ACTIVE } from './sessions.js';
import { AgentsUI } from './agents-ui.js';
import {
  assertValidResultReferences,
  createRunSnapshot,
  loadWorkflowDocument,
} from './workflow-document.js';
import { RunJournalViewState } from './run-journal-view-state.js';

class App {
  constructor() {
    this._isSelfTest = new URLSearchParams(location.search).get('selftest') === '1';
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
    this._workflowSourceFile = null;     // basename when the editor owns a stored workflow
    this._runStartPending = false;       // closes the journal-start TOCTOU window
    this._runJournalItems = [];
    this._runJournalView = new RunJournalViewState();

    // Renderer regressions are pure module tests. Do not initialize timers,
    // discovery, settings, or a real PTY in this mode.
    if (this._isSelfTest) {
      this._runSelfTest();
      return;
    }

    this._init();
    this._loadDemoWorkflow();
    this._loadDefaultDirectory();
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
      // Template-local ids make internal references (such as a result
      // handoff from a named Join block) stable. Each template becomes a new
      // workflow document, so those ids remain scoped to that document.
      return { ...(b.id ? { id: b.id } : {}), type: b.type, params };
    });

    this.workflow = this._normalizeWorkflow({
      id: `wf-${Date.now()}`,
      name: tpl.name,
      defaultDirectory: dir,
      blocks,
    });
    this._workflowSourceFile = null;

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

  // ── Run Journal ────────────────────────────────────────────

  _initRunJournal() {
    const modal = document.getElementById('runs-modal');
    const close = () => modal?.classList.add('hidden');
    const open = async () => {
      modal?.classList.remove('hidden');
      await this._refreshRunJournal();
    };

    document.getElementById('btn-runs')?.addEventListener('click', open);
    document.getElementById('btn-close-runs')?.addEventListener('click', close);
    document.getElementById('btn-refresh-runs')?.addEventListener('click', () => {
      this._refreshRunJournal();
    });
    modal?.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });

    document.getElementById('runs-list')?.addEventListener('click', (event) => {
      const row = event.target.closest('[data-run-id]');
      if (row) this._openRunJournalEntry(row.dataset.runId);
    });

    document.getElementById('run-detail')?.addEventListener('click', async (event) => {
      const resultButton = event.target.closest('[data-result-id]');
      if (resultButton) {
        await this._revealRunResult(resultButton.dataset.runId, resultButton.dataset.resultId);
        return;
      }
      const deleteButton = event.target.closest('[data-delete-run]');
      if (!deleteButton) return;
      const runId = deleteButton.dataset.deleteRun;
      if (!confirm('Delete this run journal entry and its explicit results?')) return;
      // No earlier list/detail response may repopulate a run after the user
      // has committed to deleting the exact id carried by this button.
      this._runJournalView.invalidateAll();
      try {
        await window.api.deleteRunJournal({
          runId,
          opId: this._operationId('journal-delete'),
        });
        this._runJournalView.clearSelectionIf(runId);
        await this._refreshRunJournal();
      } catch (error) {
        this._termLog(`❌ Could not delete run: ${error.message}`, 'stderr');
      }
    });
  }

  async _refreshRunJournal() {
    const list = document.getElementById('runs-list');
    const detail = document.getElementById('run-detail');
    if (!list) return;
    const request = this._runJournalView.beginListRequest();
    // A refresh establishes a new list snapshot. Detail responses belonging
    // to the prior snapshot must not mutate the pane after this point.
    list.innerHTML = '<div class="sched-empty">Loading run history…</div>';

    try {
      const response = await window.api.listRunJournal({ limit: 100 });
      if (!this._runJournalView.isCurrentListRequest(request)) return;
      const runs = Array.isArray(response) ? response : (response?.runs || []);
      this._runJournalItems = runs;
      if (runs.length === 0) {
        this._runJournalView.clearSelection();
        list.innerHTML = '<div class="sched-empty">No recorded runs yet.</div>';
        if (detail) {
          detail.innerHTML = '<div class="sched-empty">A run appears here as soon as its immutable snapshot is accepted.</div>';
        }
        return;
      }

      list.innerHTML = runs.map(run => {
        const selected = run.id === this._runJournalView.selectedRunId ? ' selected' : '';
        const name = run.workflow?.name || 'Untitled workflow';
        const when = this._formatJournalTime(run.startedAt);
        const durability = run.snapshot?.storage === 'memory'
          ? ' · memory only'
          : '';
        return `
          <button class="run-row${selected}" type="button" data-run-id="${this._esc(run.id)}">
            <span class="run-row-main">
              <strong>${this._esc(name)}</strong>
              <small>${this._esc(when)}${this._esc(durability)}</small>
            </span>
            <span class="run-status status-${this._esc(run.status)}">${this._esc(run.status)}</span>
          </button>`;
      }).join('');

      const selectedStillExists = runs.some(
        run => run.id === this._runJournalView.selectedRunId
      );
      await this._openRunJournalEntry(
        selectedStillExists ? this._runJournalView.selectedRunId : runs[0].id
      );
    } catch (error) {
      if (!this._runJournalView.isCurrentListRequest(request)) return;
      list.innerHTML = `<div class="sched-empty">Run Journal unavailable.<br>${this._esc(error.message)}</div>`;
      if (detail) detail.innerHTML = '<div class="sched-empty">No run detail is available.</div>';
    }
  }

  async _openRunJournalEntry(runId) {
    if (!runId) return;
    const detail = document.getElementById('run-detail');
    if (!detail) return;
    const request = this._runJournalView.beginDetailRequest(runId);
    detail.innerHTML = '<div class="sched-empty">Loading run detail…</div>';
    document.querySelectorAll('#runs-list .run-row').forEach(row => {
      row.classList.toggle('selected', row.dataset.runId === runId);
    });

    try {
      const response = await window.api.getRunJournal({ runId });
      if (
        !this._runJournalView.isCurrentDetailRequest(request, runId)
      ) return;
      const run = response?.run || response;
      if (!run) throw new Error('Run not found');

      const visits = Array.isArray(run.blocks) ? run.blocks : [];
      const results = Array.isArray(run.results) ? run.results : [];
      const trigger = run.trigger?.kind || 'manual';
      const storage = run.snapshot?.storage === 'memory'
        ? 'Memory only · may expire and is unavailable after restart'
        : 'Protected by the operating system';
      const finished = run.finishedAt
        ? ` → ${this._formatJournalTime(run.finishedAt)}`
        : '';

      detail.innerHTML = `
        <div class="run-detail-head">
          <div>
            <h3>${this._esc(run.workflow?.name || 'Untitled workflow')}</h3>
            <p>${this._esc(this._formatJournalTime(run.startedAt))}${this._esc(finished)}
              · ${this._esc(trigger)} · ${this._esc(storage)}</p>
          </div>
          <span class="run-status status-${this._esc(run.status)}">${this._esc(run.status)}</span>
        </div>
        <section class="run-detail-section">
          <h4>Block visits <span>${visits.length}</span></h4>
          ${visits.length ? visits.map((visit, index) => `
            <div class="run-visit">
              <span class="run-visit-index">${index + 1}</span>
              <span class="run-visit-main">
                <strong>${this._esc(visit.blockType || visit.type || 'block')}</strong>
                <small>${this._esc(visit.blockId || '')}</small>
              </span>
              <span class="run-status status-${this._esc(visit.status)}">${this._esc(visit.status)}</span>
            </div>`).join('') : '<div class="run-detail-empty">No block visits were recorded.</div>'}
        </section>
        <section class="run-detail-section">
          <h4>Explicit results <span>${results.length}</span></h4>
          ${results.length ? results.map(result => `
            <div class="run-result">
              <div class="run-result-summary">
                <span>
                  <strong>${this._esc(result.name || 'result')}</strong>
                  <small>${this._esc(String(result.lanes?.length || 0))} lane(s)
                    · ${this._esc(this._formatBytes(result.byteLength))}
                    · ${this._esc(result.storage === 'memory' ? 'memory only' : 'protected')}</small>
                </span>
                <button class="btn btn-secondary btn-sm" type="button"
                  data-run-id="${this._esc(run.id)}" data-result-id="${this._esc(result.id)}">View</button>
              </div>
              <pre class="run-result-body hidden" id="result-body-${this._esc(result.id)}"></pre>
            </div>`).join('') : '<div class="run-detail-empty">No explicit result was published.</div>'}
        </section>
        <div class="run-detail-actions">
          <button class="btn btn-danger btn-sm" type="button" data-delete-run="${this._esc(run.id)}">Delete run</button>
        </div>`;
    } catch (error) {
      if (
        !this._runJournalView.isCurrentDetailRequest(request, runId)
      ) return;
      detail.innerHTML = `<div class="sched-empty">Could not load run detail.<br>${this._esc(error.message)}</div>`;
    }
  }

  async _revealRunResult(runId, resultId) {
    const body = document.getElementById(`result-body-${resultId}`);
    if (!body) return;
    if (body.dataset.loaded === 'true') {
      body.classList.toggle('hidden');
      return;
    }
    body.classList.remove('hidden');
    body.textContent = 'Decrypting explicit result…';
    try {
      const response = await window.api.getRunResult({ runId, resultId });
      const result = response?.result || response;
      if (!result) throw new Error('Result not found');
      let display = result.body;
      if (typeof display === 'string') {
        try { display = JSON.parse(display); } catch (_error) { /* plain text result */ }
      }
      body.textContent = typeof display === 'string'
        ? display
        : JSON.stringify(display, null, 2);
      body.dataset.loaded = 'true';
    } catch (error) {
      body.textContent = `Result unavailable: ${error.message}`;
    }
  }

  _formatJournalTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
  }

  _formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
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

    let next;
    try {
      next = this._normalizeWorkflow(raw);
    } catch (error) {
      this._termLog(`❌ Could not open "${raw.name || file}": ${error.message}`, 'stderr');
      this._flashStatus('Workflow needs a newer or compatible app version');
      return false;
    }
    this.workflow = next;
    this._workflowSourceFile = file;
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
    this._workflowSourceFile = null;
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
    this._initRunJournal();
    this._initAgents();
    this._initModalDismissal();
    this._initVersionLabel();
    this._restoreSettings();
    this._updateEmptyState();
  }

  /** Re-apply preferences persisted by a previous session. */
  async _restoreSettings() {
    let stored;
    try {
      stored = await window.api.getSettings?.();
    } catch (_e) { return; }
    if (!stored) return;

    if (stored.theme) {
      const select = document.getElementById('theme-selector');
      if (select) select.value = stored.theme;
      this._applyTerminalTheme(stored.theme);
    }
    if (stored.terminalPanelWidth) {
      const panel = document.getElementById('terminal-panel');
      if (panel) panel.style.width = `${stored.terminalPanelWidth}px`;
    }
    if (stored.logPaneHeight) {
      const log = document.getElementById('output-log');
      if (log) log.style.flex = `0 0 ${stored.logPaneHeight}px`;
    }
    if (this.fitAddon) this.fitAddon.fit();
  }

  /**
   * Agent accounts: routed Codex aliases discovered from ai-agent-entrypoint
   * plus this app's own env-only profiles. Starting one opens a session tab.
   */
  _initAgents() {
    this.agents = new AgentsUI({
      onLog: (msg, type) => this._termLog(msg, type),
      onStartSession: async (profileId) => {
        const id = await this.sessions.startProfile(profileId, {
          cwd: this.workflow?.defaultDirectory || this._defaultDirectory,
        });
        if (id) this._switchToTerminalTab();
      },
    });
    this.agents.init();
    // Populate the badge and the block-parameter dropdown without opening the modal.
    this.agents.refresh().catch(() => {});
  }

  /** Bring the Terminal pane forward (used after starting a session). */
  _switchToTerminalTab() {
    document.getElementById('tab-term')?.click();
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
      const replaceDefaults = new Set(['', '.']);
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
    const { document, diagnostics } = loadWorkflowDocument(data, {
      defaultDirectory: this._defaultDirectory,
    });
    if (diagnostics.length && this.engine) {
      const repaired = diagnostics.filter(item => item.code.endsWith('-id-repaired')).length;
      if (repaired) {
        this._termLog?.(`⚠️ Repaired ${repaired} invalid or duplicate workflow id(s) while loading`, 'system');
      }
    }
    return document;
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
      if (type && Object.hasOwn(BLOCK_TYPES, type)) {
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
        // Remember the choice; it used to reset to PowerShell Blue on every launch.
        window.api.updateSettings?.({ theme: e.target.value }).catch(() => {});
      });
    }

    document.getElementById('btn-clear-log').addEventListener('click', () => {
      const log = document.getElementById('output-log');
      log.innerHTML = '';
      this._appendLog('🧹 Log cleared.', 'system');
    });

    document.getElementById('btn-clear-terminal').addEventListener('click', () => {
      this.sessions.clearActive();
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
    this._runSessionIds = new Set();
    this._visualizedRunId = null;

    engine.onLog = (msg, type) => this._termLog(msg, type);

    // Every PTY a run opens gets a tab, and is remembered so the *next* run
    // can close it without touching sessions started by hand.
    engine.onSessionSpawned = (meta) => {
      this._runSessionIds.add(meta.id);
      this.sessions.adopt(meta);
    };

    engine.onBlockStart = (index, blockId) => {
      if (!this._visualizedRunId || this.workflow?.id !== this._visualizedRunId) return;
      this._forEachBlock(el => el.classList.remove('executing'));
      const el = blockId ? this._blockElById(blockId) : this._blockElAt(index);
      if (el) {
        el.classList.remove('done', 'error');
        el.classList.add('executing');
      }
    };

    engine.onBlockEnd = (index, ok, blockId) => {
      if (!this._visualizedRunId || this.workflow?.id !== this._visualizedRunId) return;
      const el = blockId ? this._blockElById(blockId) : this._blockElAt(index);
      if (el) {
        el.classList.remove('executing');
        el.classList.add(ok ? 'done' : 'error');
      }
    };

    engine.onComplete = (success, outcome = {}) => {
      const completedRunId = outcome.runId || engine.runId;
      const completedVisualId = this._visualizedRunId;
      const stopped = outcome.status === 'stopped';
      // Restore toolbar
      document.getElementById('btn-run').classList.remove('hidden');
      document.getElementById('btn-stop').classList.add('hidden');

      // Status badge
      const badge = document.getElementById('workflow-status');
      badge.textContent = success ? 'Done' : (stopped ? 'Stopped' : 'Error');
      badge.className = `workflow-status ${success ? '' : 'error'}`;

      // Status indicator
      const dot = document.getElementById('status-indicator');
      dot.className = `status-indicator ${success ? '' : 'error'}`;
      document.getElementById('status-text').textContent = success
        ? 'Completed'
        : (stopped ? 'Stopped' : 'Failed');

      if (!document.getElementById('runs-modal')?.classList.contains('hidden')) {
        this._refreshRunJournal();
      }

      // Reset visual states after a delay
      setTimeout(() => {
        // A newer run may have started during this four-second result window.
        // Its status and block decorations belong to it, not this old timer.
        if (engine.isRunning || engine.runId !== completedRunId) return;
        if (completedVisualId && this.workflow?.id === completedVisualId) {
          this._forEachBlock((el) => {
            el.classList.remove('done', 'error', 'executing');
          });
          this._clearRunBadges();
        }
        if (this._visualizedRunId === completedVisualId) this._visualizedRunId = null;
        badge.textContent = 'Idle';
        badge.className = 'workflow-status';
        dot.className = 'status-indicator';
        document.getElementById('status-text').textContent = 'Ready';
      }, 4000);
    };

    engine.onStatusChange = (status) => {
      document.getElementById('status-text').textContent = status;
    };

    engine.onLoopIteration = (loopIndex, iter, total, done, blockId) => {
      if (!this._visualizedRunId || this.workflow?.id !== this._visualizedRunId) return;
      const el = blockId ? this._blockElById(blockId) : this._blockElAt(loopIndex);
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

    engine.onAgentJoinProgress = ({ blockId, index, ready, total }) => {
      if (!this._visualizedRunId || this.workflow?.id !== this._visualizedRunId) return;
      const el = blockId ? this._blockElById(blockId) : this._blockElAt(index);
      const header = el?.querySelector('.block-header');
      if (!header) return;
      let badge = header.querySelector('.agent-join-progress');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'agent-join-progress';
        header.appendChild(badge);
      }
      badge.textContent = `${ready}/${total} ready`;
      badge.classList.toggle('done', total > 0 && ready >= total);
    };
  }

  /** Remove transient loop/join badges left on blocks after a run. */
  _clearRunBadges() {
    document
      .querySelectorAll('.workflow-block .loop-iter, .workflow-block .agent-join-progress')
      .forEach(badge => badge.remove());
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
    for (const block of this.workflow.blocks) {
      if (block.type === 'agentSend' && block.params?.handoffFrom === id) {
        block.params.handoffFrom = '';
      }
    }
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

      const el = renderWorkflowBlock(block, i, this.workflow.blocks);
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
      if (block.type === 'agentJoin' && key === 'resultName') {
        input.addEventListener('change', () => this.renderBlocks());
      }
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

  async runWorkflow(note = null, {
    workflow = null,
    visualize = true,
    trigger = null,
  } = {}) {
    const sourceWorkflow = workflow || this.workflow;
    if (!sourceWorkflow || sourceWorkflow.blocks.length === 0) {
      this._flashStatus('No blocks to run');
      return;
    }
    if (this._runStartPending) {
      this._flashStatus('A run is already starting');
      return;
    }
    if (this.engine.isRunning) {
      this._flashStatus('A run is already active — use Stop first');
      return;
    }

    // Only the editor-owned document has live DOM params. Scheduled workflows
    // arrive as already-normalized documents and must never replace or clear
    // an unrelated dirty editor.
    if (!workflow) this._syncParams();

    this._runStartPending = true;
    let runPlan;
    let journalRun = null;
    let engineStarted = false;
    try {
      assertValidResultReferences(sourceWorkflow.blocks);
      runPlan = createRunSnapshot(sourceWorkflow);
      if (!window.api.startRunJournal) {
        throw new Error('Run Journal is unavailable in this build');
      }
      journalRun = await window.api.startRunJournal({
        workflow: runPlan,
        trigger: trigger || (workflow ? { kind: 'scheduled' } : { kind: 'manual' }),
        opId: this._operationId('run-start'),
      });
      if (!journalRun?.id) throw new Error('Run Journal did not return a run id');

      // Close only the sessions a *previous run* opened. Sessions you started
      // yourself from the Agents panel are left alone — killing a logged-in
      // agent because a workflow happened to start would be hostile.
      this._closePreviousRunSessions();

      document.getElementById('output-log').innerHTML = '';
      this._clearRunBadges();
      if (note) this._appendLog(note, 'system');

      this._visualizedRunId = visualize ? runPlan.id : null;

      // Toggle buttons
      document.getElementById('btn-run').classList.add('hidden');
      document.getElementById('btn-stop').classList.remove('hidden');

      // Status badge
      const badge = document.getElementById('workflow-status');
      badge.textContent = 'Running';
      badge.className = 'workflow-status running';

      const dot = document.getElementById('status-indicator');
      dot.className = 'status-indicator running';

      // execute() sets its running flag synchronously before its first await.
      // Keep the app-level gate until ownership of the journal has transferred
      // to the engine, so concurrent clicks/ticks cannot create a second run.
      const execution = this.engine.execute(runPlan.blocks, runPlan.defaultDirectory, {
        runId: journalRun.id,
        journal: true,
      });
      engineStarted = this.engine.isRunning && this.engine.runId === journalRun.id;
      if (!engineStarted) throw new Error('The execution engine did not accept the journal run');
      this._runStartPending = false;
      await execution;
    } catch (err) {
      if (!engineStarted && journalRun?.id) {
        try {
          await window.api.finishRunJournal({
            runId: journalRun.id,
            status: 'cancelled',
            opId: this._operationId('run-start-cancel'),
          });
        } catch (journalError) {
          this._termLog(
            `❌ Unstarted Run Journal cancellation failed: ${journalError.message}`,
            'stderr'
          );
        }
      }
      this._termLog(
        `❌ ${engineStarted ? 'Run failed' : 'Run did not start'}: ${err.message}`,
        'stderr'
      );
      document.getElementById('btn-run').classList.remove('hidden');
      document.getElementById('btn-stop').classList.add('hidden');
      const badge = document.getElementById('workflow-status');
      badge.textContent = 'Error';
      badge.className = 'workflow-status error';
      const dot = document.getElementById('status-indicator');
      dot.className = 'status-indicator error';
      document.getElementById('status-text').textContent = 'Failed';
      this._flashStatus(engineStarted ? 'Run failed' : 'Run did not start');
    } finally {
      this._runStartPending = false;
    }
  }

  /**
   * Close the sessions the last workflow run opened, leaving manually started
   * ones untouched. Before multi-session this was a blanket killAllProcesses().
   */
  _closePreviousRunSessions() {
    for (const id of this._runSessionIds || []) {
      if (this.sessions.has(id)) this.sessions.close(id);
    }
    this._runSessionIds = new Set();
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
      const path = await window.api.saveWorkflow({
        workflow: this.workflow,
        file: this._workflowSourceFile,
      });
      this._workflowSourceFile ||= String(path).split(/[\\/]/).pop() || null;
      this._termLog(`💾 Saved → ${path}`, 'system');
      this._setDirty(false);
      // Promote exactly what was persisted into the schedule cache now. This
      // avoids a short window where a just-saved due job could execute the
      // previous disk snapshot while the periodic refresh is still pending.
      const persisted = this._normalizeWorkflow(this.workflow);
      this._diskJobs = this._diskJobs.filter(wf => wf.id !== persisted.id);
      if (this._scheduleOf(persisted)) this._diskJobs.push(persisted);
      this._rebuildJobs();
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
      // Importing from an arbitrary path creates a new managed copy on Save;
      // it must not claim a same-named file in the app's workflow store.
      this._workflowSourceFile = null;
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
    // Terminals are owned by the SessionManager: one xterm per live PTY, all
    // rendering in the background, only the active tab visible. `activeProcessId`
    // stays as the "session the engine and keyboard target" so the engine and
    // saved workflows keep working unchanged.
    this.sessions = new SessionManager({
      onLog: (msg, type) => this._termLog(msg, type),
      onActiveChange: (id) => { this.activeProcessId = id; },
    });
    this.sessions.mount({
      stack: document.getElementById('terminal-output'),
      tabs: document.getElementById('session-tabs'),
      target: document.getElementById('quick-target'),
    });
    this._applyTerminalTheme('ps'); // default until settings load

    // The app owns the single, persistent set of process IPC listeners.
    // They are registered exactly once here and never removed, so terminals
    // keep rendering across multiple workflow runs.
    window.api.onProcessOutput((data) => {
      if (data.stream === 'stdout' || data.stream === 'stderr') {
        this.sessions.handleOutput(data);
      }
    });

    window.api.onProcessExit((data) => {
      this.sessions.handleExit(data);
      if (this.engine) this.engine.handleProcessExit(data);
    });

    window.api.onProcessError((data) => {
      if (this.engine) this.engine.handleProcessError(data);
    });

    window.api.onSessionStatus?.((meta) => this.sessions.handleStatus(meta));

    this._initQuickSend();

    // Start a plain shell so the terminal is interactive on load.
    this._spawnDefaultShell();
  }

  /** The active session's xterm. Engine and toolbar read cols/rows from this. */
  get term() { return this.sessions?.activeTerm || null; }
  get fitAddon() { return this.sessions?.activeFitAddon || null; }

  // ── Quick Send ─────────────────────────────────────────────
  // Fire an ad-hoc command or prompt at one session, every session of one
  // agent, or all of them, using the same human-paced typing the engine uses.

  _initQuickSend() {
    const input = document.getElementById('quick-input');
    const target = document.getElementById('quick-target');
    const button = document.getElementById('btn-quick-send');

    const send = async () => {
      const text = input?.value ?? '';
      if (!text.trim()) return;
      const selector = target?.value || TARGET_ACTIVE;
      const ids = this.sessions.resolveTargets(selector);
      if (ids.length === 0) {
        this._flashStatus('No live session to send to');
        return;
      }

      input.value = '';
      input.disabled = true;
      if (button) button.disabled = true;
      try {
        const delivered = await this.sessions.sendTo(selector, text);
        if (delivered.length) {
          this._appendLog(`▸ Sent to ${delivered.join(', ')}: ${text}`, 'input-echo');
        }
      } finally {
        input.disabled = false;
        if (button) button.disabled = false;
        input.focus();
      }
    };

    button?.addEventListener('click', send);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  }

  async _spawnDefaultShell() {
    try {
      const id = 'default-shell-' + Date.now();
      const result = await window.api.executeCommand({
        id,
        command: '', // Empty command drops into an interactive PowerShell session
        cwd: this.workflow?.defaultDirectory || this._defaultDirectory || '.',
        cols: 80,
        rows: 24,
      });
      if (result.error) throw new Error(result.error);
      this.sessions.adopt({
        id: result.id,
        label: 'Shell',
        agent: 'shell',
        assurance: 'L0-native',
        status: 'running',
      });
    } catch (e) {
      console.error('Failed to start default shell', e);
    }
  }

  _applyTerminalTheme(themeName) {
    if (!this.sessions) return;
    const baseColors = {
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
      blue: '#3b78ff', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c',
      brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e',
      brightCyan: '#61d6d6', brightWhite: '#f2f2f2'
    };
    
    let theme;
    if (themeName === 'dark') {
      theme = { ...baseColors, background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', selectionBackground: '#264f78' };
    } else if (themeName === 'light') {
      theme = { ...baseColors, background: '#ffffff', foreground: '#333333', cursor: '#000000', selectionBackground: '#cce2ff' };
    } else {
      // ps default
      theme = { ...baseColors, background: '#012456', foreground: '#f2f2f2', cursor: '#ffffff', selectionBackground: '#264f78' };
    }
    // Applies to every session's terminal, present and future.
    this.sessions.setTheme(theme);
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
        window.api.updateSettings?.({ terminalPanelWidth: terminalPanel.offsetWidth }).catch(() => {});
      }
      if (isResizingH) {
        isResizingH = false;
        resizerH.classList.remove('dragging');
        document.body.style.cursor = 'default';
        if (this.fitAddon) this.fitAddon.fit();
        window.api.updateSettings?.({ logPaneHeight: logPane.offsetHeight }).catch(() => {});
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
        this._diskJobs = [];
        const scheduledIds = new Set();
        for (const raw of (Array.isArray(all) ? all : [])) {
          try {
            const wf = this._normalizeWorkflow(raw);
            if (!this._scheduleOf(wf)) continue;
            if (scheduledIds.has(wf.id)) {
              this._termLog(
                `⚠️ Scheduled workflow "${raw?.name || raw?.file || 'unknown'}" was skipped: duplicate workflow id "${wf.id}"`,
                'stderr'
              );
              continue;
            }
            scheduledIds.add(wf.id);
            this._diskJobs.push(wf);
          } catch (error) {
            this._termLog(
              `⚠️ Scheduled workflow "${raw?.name || raw?.file || 'unknown'}" was skipped: ${error.message}`,
              'stderr'
            );
          }
        }
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
    const jobs = [];
    // A persisted workflow is the schedule authority for its id. Dirty editor
    // changes remain visible in the editor but affect only a later save/run.
    for (const wf of mergeScheduledWorkflowSources(this._diskJobs, this.workflow)) {
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
      if (job?.workflow === this.workflow && sb) {
        job.datetime = sb.params.datetime;
        job.mode = sb.params.mode || 'once';
      }
    }

    // Periodically re-sync the job list from disk (picks up newly saved workflows).
    // Refresh the disk list periodically (non-blocking — keep checking fires
    // this tick using the current cached list).
    if (now - this._lastDiskRefresh > 10000) this._refreshScheduledJobs();

    this._renderCountdowns(now);

    if (this._runStartPending || (this.engine && this.engine.isRunning)) return;

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
    // Execute an immutable copy without replacing the document currently open
    // in the editor. In particular, a background schedule must not erase
    // unrelated unsaved work or mark it clean.
    try {
      const wf = this._normalizeWorkflow(job.workflow);
      document.getElementById('schedule-modal')?.classList.add('hidden');
      this.runWorkflow(
        `⏰ Scheduled run: "${wf.name}" @ ${new Date().toLocaleString()}`,
        {
          workflow: wf,
          visualize: false,
          trigger: {
            kind: 'scheduled',
            scheduledFor: new Date(this._jobTarget(job, Date.now())).toISOString(),
          },
        }
      );
    } catch (error) {
      this._termLog(`❌ Scheduled workflow could not start: ${error.message}`, 'stderr');
    }
  }

  _operationId(prefix = 'op') {
    const random = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`;
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

  _blockElById(id) {
    if (!id) return null;
    return document.querySelector(`[data-block-id="${this._cssEscape(id)}"]`);
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
