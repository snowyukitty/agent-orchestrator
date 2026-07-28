// ============================================================
// Agent Accounts UI (renderer)
//
// Two lists with deliberately different framing:
//
//   • routed accounts — discovered from ai-agent-entrypoint, read-only here.
//     This app cannot create, edit, or delete them; that repository owns the
//     account manifest.
//   • local profiles  — env-only profiles this app does own, for CLIs the
//     entrypoint does not manage yet.
//
// The assurance chip on every row states which is which, so a weaker
// env-only profile is never mistaken for a routed account.
// ============================================================

const ASSURANCE_CHIP = {
  'L1-routed': 'L1 · routed',
  'L2-env': 'L2 · env-only',
  'L0-native': 'L0 · native',
};

/** Default state-directory variable per agent, shown as a hint in the form. */
const HOME_ENV_HINT = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  grok: 'GROK_HOME',
  gemini: 'GEMINI_CONFIG_DIR',
  shell: null,
};

export class AgentsUI {
  /**
   * @param {object} opts
   * @param {function} opts.onStartSession (profileId) => void
   * @param {function} opts.onLog          (message, type) => void
   * @param {object} [opts.api]
   */
  constructor({ onStartSession, onLog, api } = {}) {
    this._onStartSession = onStartSession || (() => {});
    this._onLog = onLog || (() => {});
    this._api = api || window.api;
    this._state = { local: [], routed: [], routedError: null, entrypointFound: false, agentKinds: [] };
    this._editing = null;
  }

  init() {
    const modal = document.getElementById('agents-modal');
    const editModal = document.getElementById('agent-edit-modal');

    this.open = async () => {
      modal?.classList.remove('hidden');
      await Promise.all([this._loadEntrypointSetting(), this.refresh()]);
    };
    const close = () => modal?.classList.add('hidden');
    const closeEdit = () => editModal?.classList.add('hidden');

    document.getElementById('btn-agents')?.addEventListener('click', () => this.open());
    document.getElementById('btn-add-session')?.addEventListener('click', () => this.open());
    document.getElementById('btn-close-agents')?.addEventListener('click', close);
    modal?.addEventListener('click', (e) => { if (e.target === modal) close(); });

    document.getElementById('btn-refresh-agents')?.addEventListener('click', () => this.refresh({ force: true }));
    document.getElementById('btn-new-agent')?.addEventListener('click', () => this._openEditor(null));
    document.getElementById('btn-browse-entrypoint')?.addEventListener('click', async () => {
      const dir = await this._api.selectDirectory();
      if (dir) document.getElementById('agents-entrypoint-path').value = dir;
    });
    document.getElementById('btn-save-entrypoint')?.addEventListener('click', () => this._saveEntrypointSetting());
    document.getElementById('agents-entrypoint-path')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._saveEntrypointSetting();
      }
    });

    document.getElementById('btn-close-agent-edit')?.addEventListener('click', closeEdit);
    document.getElementById('btn-cancel-agent')?.addEventListener('click', closeEdit);
    editModal?.addEventListener('click', (e) => { if (e.target === editModal) closeEdit(); });
    document.getElementById('btn-save-agent')?.addEventListener('click', () => this._save());
    document.getElementById('agent-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._save();
    });

    // Keep the state-directory hint in step with the chosen agent.
    document.getElementById('agent-field-kind')?.addEventListener('change', (e) => {
      this._updateHomeHint(e.target.value);
      const cmd = document.getElementById('agent-field-command');
      const kind = this._state.agentKinds.find(k => k.key === e.target.value);
      if (cmd && !cmd.value.trim() && kind) cmd.value = kind.command || '';
    });

    for (const [btnId, fieldId] of [['btn-browse-home', 'agent-field-home'], ['btn-browse-cwd', 'agent-field-cwd']]) {
      document.getElementById(btnId)?.addEventListener('click', async () => {
        const dir = await this._api.selectDirectory();
        if (dir) document.getElementById(fieldId).value = dir;
      });
    }

    // Row actions for both lists.
    document.getElementById('agents-body')?.addEventListener('click', async (e) => {
      const edit = e.target.closest('[data-edit-profile]');
      if (edit) {
        e.stopPropagation();
        this._openEditor(this._state.local.find(p => p.id === edit.dataset.editProfile) || null);
        return;
      }
      const del = e.target.closest('[data-delete-profile]');
      if (del) {
        e.stopPropagation();
        await this._delete(del.dataset.deleteProfile, del.dataset.name);
        return;
      }
      const row = e.target.closest('[data-profile-id]');
      if (row && !row.classList.contains('unavailable')) {
        document.getElementById('agents-modal')?.classList.add('hidden');
        this._onStartSession(row.dataset.profileId);
      }
    });
  }

  // ── Data ─────────────────────────────────────────────────

  async refresh({ force = false } = {}) {
    try {
      this._state = await this._api.listAgents({ force });
    } catch (err) {
      this._onLog(`❌ Could not load agent accounts: ${err.message}`, 'stderr');
      return;
    }
    this.render();
  }

  async _loadEntrypointSetting() {
    const input = document.getElementById('agents-entrypoint-path');
    if (!input) return;
    try {
      const settings = await this._api.getSettings();
      input.value = settings?.entrypointPath || '';
      this._setEntrypointStatus(null);
    } catch (err) {
      this._setEntrypointStatus(`Could not load the saved path: ${err.message}`, true);
    }
  }

  async _saveEntrypointSetting() {
    const input = document.getElementById('agents-entrypoint-path');
    const button = document.getElementById('btn-save-entrypoint');
    if (!input || !button) return;

    const entrypointPath = input.value.trim();
    button.disabled = true;
    this._setEntrypointStatus('Saving and refreshing routed accounts…');
    try {
      await this._api.updateSettings({ entrypointPath });
      await this.refresh({ force: true });
      this._setEntrypointStatus(entrypointPath
        ? 'Saved. Routed account discovery now uses this folder.'
        : 'Saved. Routed account discovery now uses sibling auto-detection.');
      this._onLog('🤖 Updated the routed account source', 'system');
    } catch (err) {
      this._setEntrypointStatus(`Could not save the path: ${err.message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  _setEntrypointStatus(message, isError = false) {
    const status = document.getElementById('agents-entrypoint-status');
    if (!status) return;
    status.textContent = message || 'Leave blank to auto-detect a sibling checkout. This stores a machine-local path only.';
    status.classList.toggle('error', isError);
  }

  /** Every startable profile, routed first. Used by the block param dropdown. */
  allProfiles() {
    return [...this._state.routed, ...this._state.local];
  }

  // ── Rendering ────────────────────────────────────────────

  render() {
    const badge = document.getElementById('agents-badge');
    if (badge) badge.textContent = String(this.allProfiles().length);

    this._renderRouted();
    this._renderLocal();
  }

  _renderRouted() {
    const list = document.getElementById('agents-routed-list');
    if (!list) return;

    const { routed, routedError, entrypointFound } = this._state;

    if (routedError || !entrypointFound) {
      // Fail closed and say why: a routed account must never quietly become
      // a native login just because discovery failed.
      list.innerHTML = `
        <div class="agents-empty error">
          <div>⚠ Routed accounts unavailable.</div>
          <div class="agents-empty-detail">${esc(routedError || 'ai-agent-entrypoint was not found next to this app.')}</div>
          <div class="agents-empty-detail">Codex accounts stay hidden rather than falling back to the native login.</div>
        </div>`;
      return;
    }

    if (routed.length === 0) {
      list.innerHTML = `<div class="agents-empty">No Codex aliases in the entrypoint manifest.</div>`;
      return;
    }

    list.innerHTML = routed.map(p => {
      const bad = p.status === 'error';
      const health = bad
        ? `⚠ ${esc(p.errors[0] || 'account has an error')}`
        : (p.authenticated ? 'signed in' : 'not signed in — run /login inside the session');
      return `
        <div class="agent-row ${bad ? 'unavailable' : ''}" data-profile-id="${esc(p.id)}"
             title="${bad ? 'Fix this account with ai-agent-entrypoint doctor' : 'Start a session'}">
          <span class="agent-icon">${esc(p.icon)}</span>
          <div class="agent-main">
            <div class="agent-name">${esc(p.displayName)} <span class="agent-alias">${esc(p.id)}</span></div>
            <div class="agent-sub">${esc(health)}</div>
          </div>
          <span class="assurance-chip ${esc(p.assurance)}">${esc(ASSURANCE_CHIP[p.assurance] || p.assurance)}</span>
        </div>`;
    }).join('');
  }

  _renderLocal() {
    const list = document.getElementById('agents-local-list');
    if (!list) return;

    if (this._state.local.length === 0) {
      list.innerHTML = `<div class="agents-empty">No local profiles yet. Add one per account — e.g. “Claude · work” and “Claude · personal”, each with its own state directory.</div>`;
      return;
    }

    list.innerHTML = this._state.local.map(p => {
      // Show which variable is set, never its value: it is a machine-local path.
      const envSummary = p.envKeys.length
        ? p.envKeys.join(', ')
        : 'no state directory set — uses the agent’s default login';
      return `
        <div class="agent-row" data-profile-id="${esc(p.id)}" title="Start a session">
          <span class="agent-icon">${esc(p.icon)}</span>
          <div class="agent-main">
            <div class="agent-name">${esc(p.displayName)} <span class="agent-alias">${esc(p.id)}</span></div>
            <div class="agent-sub">${esc(p.agentLabel)} · ${esc(envSummary)}</div>
          </div>
          <span class="assurance-chip ${esc(p.assurance)}">${esc(ASSURANCE_CHIP[p.assurance] || p.assurance)}</span>
          <span class="agent-actions">
            <button class="btn btn-icon btn-sm" data-edit-profile="${esc(p.id)}" title="Edit">✎</button>
            <button class="btn btn-icon btn-sm" data-delete-profile="${esc(p.id)}" data-name="${esc(p.displayName)}" title="Delete">🗑️</button>
          </span>
        </div>`;
    }).join('');
  }

  // ── Editor ───────────────────────────────────────────────

  _openEditor(profile) {
    this._editing = profile;
    const kindSelect = document.getElementById('agent-field-kind');
    if (kindSelect) {
      kindSelect.innerHTML = this._state.agentKinds
        .map(k => `<option value="${esc(k.key)}">${esc(k.icon)} ${esc(k.label)}</option>`)
        .join('');
      kindSelect.value = profile?.agent || 'claude';
    }

    document.getElementById('agent-edit-title').textContent = profile ? '✎ Edit profile' : '＋ New profile';
    document.getElementById('agent-field-name').value = profile?.displayName || '';
    document.getElementById('agent-field-id').value = profile?.id || '';
    document.getElementById('agent-field-id').disabled = !!profile;
    document.getElementById('agent-field-command').value = profile?.command || '';
    document.getElementById('agent-field-cwd').value = profile?.cwd || '';
    // Existing env values are not sent to the renderer, so editing a profile
    // starts this field blank; leaving it blank keeps the stored value.
    document.getElementById('agent-field-home').value = '';
    document.getElementById('agent-field-home').placeholder = profile?.envKeys?.length
      ? `unchanged (${profile.envKeys.join(', ')} is set)`
      : 'Pick a folder for this account…';

    this._updateHomeHint(kindSelect?.value || 'claude');
    this._showFormError(null);
    document.getElementById('agent-edit-modal')?.classList.remove('hidden');
    document.getElementById('agent-field-name')?.focus();
  }

  _updateHomeHint(agentKey) {
    const hint = document.getElementById('agent-field-home-hint');
    if (!hint) return;
    const variable = HOME_ENV_HINT[agentKey];
    hint.textContent = variable
      ? `Sets ${variable} for this session only. Give each account its own folder, then log in inside the session.`
      : 'This agent has no state-directory variable; the session runs with the inherited environment.';
  }

  async _save() {
    const agent = document.getElementById('agent-field-kind').value;
    const displayName = document.getElementById('agent-field-name').value.trim();
    const id = document.getElementById('agent-field-id').value.trim() || slugify(displayName);
    const home = document.getElementById('agent-field-home').value.trim();
    const command = document.getElementById('agent-field-command').value.trim();
    const cwd = document.getElementById('agent-field-cwd').value.trim();

    const payload = { id, agent, displayName, command, cwd };
    const homeEnv = HOME_ENV_HINT[agent];
    if (home && homeEnv) {
      payload.env = { [homeEnv]: home };
    } else if (!this._editing) {
      payload.env = {};
    }
    // Editing an existing profile without touching the folder field omits
    // `env` entirely, which the store reads as "keep what is stored". Env
    // values never reach the renderer, so we cannot echo them back here.

    try {
      await this._api.saveAgentProfile(payload);
      document.getElementById('agent-edit-modal')?.classList.add('hidden');
      this._onLog(`🤖 Saved agent profile: ${displayName}`, 'system');
      await this.refresh();
    } catch (err) {
      this._showFormError(err.message);
    }
  }

  async _delete(id, name) {
    if (!confirm(`Delete the profile "${name}"?\n\nThis only removes the profile from this app. The agent's state directory and its login are left untouched.`)) return;
    try {
      await this._api.deleteAgentProfile(id);
      this._onLog(`🗑️ Deleted agent profile: ${name}`, 'system');
      await this.refresh();
    } catch (err) {
      this._onLog(`❌ Delete failed: ${err.message}`, 'stderr');
    }
  }

  _showFormError(message) {
    const box = document.getElementById('agent-form-error');
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('hidden', !message);
  }
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || `profile-${Date.now()}`;
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = String(str ?? '');
  return el.innerHTML;
}
