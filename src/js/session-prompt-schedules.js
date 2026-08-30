// Renderer-only management UI for durable prompts owned by the main process.

export function shortcutTarget(now, hours) {
  if (!Number.isFinite(now) || ![1, 5, 24].includes(hours)) return 0;
  return now + hours * 60 * 60 * 1000;
}

export function datetimeLocalValue(epochMs) {
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduleState(schedule) {
  if (schedule?.lastResult?.status === 'session_changed') return 'session changed — recreate';
  if (schedule?.deliveryInFlight) return 'delivery claimed';
  if (schedule?.lastResult?.status === 'error') return 'error — inspect target composer';
  if (!schedule?.enabled && schedule?.lastResult?.status === 'sent') return 'sent';
  if (!schedule?.enabled) return 'paused';
  return schedule?.lastResult?.status || 'scheduled';
}

export function canResumeSchedule(schedule) {
  if (!schedule || schedule.enabled || schedule.deliveryInFlight) return false;
  if (schedule.lastResult?.status === 'session_changed') return false;
  return !!schedule.repeatIntervalMinutes ||
    !['sent', 'error'].includes(schedule.lastResult?.status);
}

export class SessionPromptSchedulesUI {
  constructor({ api, getActiveSession, getSession, onLog, now = Date.now, confirmFn = globalThis.confirm } = {}) {
    this._api = api || window.api;
    this._getActiveSession = getActiveSession || (() => null);
    this._getSession = getSession || (() => null);
    this._onLog = onLog || (() => {});
    this._now = now;
    this._confirm = confirmFn || (() => true);
    this._schedules = [];
    this._diagnostic = null;
    this._refreshing = null;
    this._target = null;
  }

  init() {
    document.getElementById('btn-create-session-prompt')?.addEventListener('click', () => this.create());
    document.getElementById('btn-use-active-session')?.addEventListener('click', () => {
      this.selectActiveTarget();
    });
    document.querySelectorAll('[data-session-prompt-shortcut]').forEach(button => {
      button.addEventListener('click', () => {
        const hours = Number(button.dataset.sessionPromptShortcut);
        const input = document.getElementById('session-prompt-datetime');
        if (input) input.value = datetimeLocalValue(shortcutTarget(this._now(), hours));
      });
    });
    document.getElementById('session-prompt-list')?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-session-prompt-action]');
      if (!button) return;
      const id = button.dataset.scheduleId;
      const action = button.dataset.sessionPromptAction;
      if (action === 'delete') {
        if (!this._confirm('Delete this scheduled prompt? The stored plaintext prompt will be removed.')) return;
        await this._runAction(() => this._api.deleteSessionPrompt(id), 'Deleted scheduled prompt');
      } else {
        await this._runAction(
          () => this._api.setSessionPromptEnabled(id, action === 'resume'),
          action === 'resume' ? 'Resumed scheduled prompt' : 'Paused scheduled prompt'
        );
      }
    });
    this._api.onSessionPromptsChanged?.(() => this.refresh());
    this.refresh();
  }

  selectActiveTarget() {
    const session = this._getActiveSession();
    this._target = session?.id && session?.incarnationId
      ? { sessionId: session.id, incarnationId: session.incarnationId, label: session.label }
      : null;
    this.render();
    return !!this._target;
  }

  async _runAction(action, success) {
    try {
      await action();
      this._onLog(`⏱ ${success}`, 'system');
    } catch (error) {
      this._onLog(`❌ Scheduled prompt action failed: ${error.message}`, 'stderr');
    }
    await this.refresh();
  }

  async create() {
    const target = this._target;
    const session = target ? this._getSession(target.sessionId) : null;
    const prompt = document.getElementById('session-prompt-text')?.value ?? '';
    const datetime = document.getElementById('session-prompt-datetime')?.value ?? '';
    const repeatRaw = document.getElementById('session-prompt-repeat')?.value ?? '';
    const nextOccurrenceAt = new Date(datetime).getTime();
    const errorBox = document.getElementById('session-prompt-error');
    const setError = message => {
      if (!errorBox) return;
      errorBox.textContent = message || '';
      errorBox.classList.toggle('hidden', !message);
    };

    if (
      !target || !session || session.incarnationId !== target.incarnationId ||
      session.status !== 'running' ||
      !session?.scheduledPrompt?.supported || !session.scheduledPrompt.confirmed ||
      !session.scheduledPrompt.bracketedPaste || !session.scheduledPrompt.ready
    ) {
      setError('Lock a lifecycle-confirmed routed Codex direct-agent session before scheduling.');
      return false;
    }
    if (!prompt.trim()) {
      setError('Enter a prompt. Do not include secrets.');
      return false;
    }
    if (!Number.isFinite(nextOccurrenceAt) || nextOccurrenceAt <= this._now()) {
      setError('Choose a future local date and time.');
      return false;
    }
    const repeatIntervalMinutes = repeatRaw === '' ? null : Number(repeatRaw);
    if (repeatIntervalMinutes !== null && (!Number.isInteger(repeatIntervalMinutes) || repeatIntervalMinutes < 1)) {
      setError('Repeat interval must be a positive whole number of minutes.');
      return false;
    }

    setError(null);
    try {
      await this._api.createSessionPrompt({
        sessionId: session.id,
        sessionIncarnationId: target.incarnationId,
        prompt,
        nextOccurrenceAt,
        repeatIntervalMinutes,
      });
      document.getElementById('session-prompt-text').value = '';
      this._onLog(`⏱ Scheduled a prompt for ${session.label}`, 'system');
      await this.refresh();
      return true;
    } catch (error) {
      setError(error.message);
      return false;
    }
  }

  async refresh() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      try {
        const result = await this._api.listSessionPrompts();
        this._schedules = Array.isArray(result?.schedules) ? result.schedules : [];
        this._diagnostic = result?.diagnostic || null;
      } catch (error) {
        this._schedules = [];
        this._diagnostic = { message: error.message };
      } finally {
        this.render();
        this._refreshing = null;
      }
    })();
    return this._refreshing;
  }

  render() {
    this._renderTarget();
    const list = document.getElementById('session-prompt-list');
    if (!list) return;
    if (this._diagnostic) {
      list.innerHTML = `<div class="sched-empty error">${escapeHtml(this._diagnostic.message)}</div>`;
      return;
    }
    if (!this._schedules.length) {
      list.innerHTML = '<div class="sched-empty">No exact-session prompts are stored.</div>';
      return;
    }
    const sorted = [...this._schedules].sort((a, b) => a.nextOccurrenceAt - b.nextOccurrenceAt);
    list.innerHTML = sorted.map(schedule => {
      const changed = schedule.lastResult?.status === 'session_changed';
      const resumable = canResumeSchedule(schedule);
      const repeat = schedule.repeatIntervalMinutes
        ? `every ${schedule.repeatIntervalMinutes} min`
        : 'one shot';
      const prompt = escapeHtml(schedule.prompt);
      return `<article class="sched-row session-prompt-row" data-session-prompt-id="${escapeAttribute(schedule.id)}">
        <div class="sched-info">
          <div class="sched-name">${escapeHtml(schedule.expectedAgent)} · ${escapeHtml(schedule.expectedProfileId)}</div>
          <div class="sched-time">${escapeHtml(new Date(schedule.nextOccurrenceAt).toLocaleString())} · ${repeat}</div>
          <div class="session-prompt-binding">Exact session ${escapeHtml(schedule.sessionId)} · ${escapeHtml(schedule.sessionIncarnationId || 'legacy/unbound')}</div>
          <pre class="session-prompt-preview">${prompt}</pre>
        </div>
        <div class="sched-right">
          <span class="sched-countdown ${changed ? 'passed' : ''}">${escapeHtml(scheduleState(schedule))}</span>
          <span class="session-prompt-actions">
            ${schedule.enabled
              ? `<button class="btn btn-secondary btn-sm" data-session-prompt-action="pause" data-schedule-id="${escapeAttribute(schedule.id)}" ${schedule.deliveryInFlight ? 'disabled' : ''}>Pause</button>`
              : `<button class="btn btn-secondary btn-sm" data-session-prompt-action="resume" data-schedule-id="${escapeAttribute(schedule.id)}" ${resumable ? '' : 'disabled'}>Resume</button>`}
            <button class="btn btn-danger btn-sm" data-session-prompt-action="delete" data-schedule-id="${escapeAttribute(schedule.id)}" ${schedule.deliveryInFlight ? 'disabled' : ''}>Delete</button>
          </span>
        </div>
      </article>`;
    }).join('');
  }

  _renderTarget() {
    const target = document.getElementById('session-prompt-target');
    const button = document.getElementById('btn-create-session-prompt');
    if (!target) return;
    const selected = this._target;
    const session = selected ? this._getSession(selected.sessionId) : null;
    const exactMatch = !!session && session.incarnationId === selected?.incarnationId;
    let message = 'No target locked. Activate a session, then choose Use active session.';
    let available = false;
    if (selected && !exactMatch) {
      message = `${selected.label || selected.sessionId} changed or exited. Choose a live target again.`;
    } else if (selected && session?.status !== 'running') {
      message = `${session?.label || selected?.sessionId} exited. Choose a live target again.`;
    } else if (session?.scheduledPrompt?.supported) {
      if (session.scheduledPrompt.ready) {
        available = true;
        message = `Locked: ${session.label} · exact incarnation ${session.incarnationId}`;
      } else {
        message = `${session.label} · waiting for idle, no draft, provider completion, and protected-paste mode`;
      }
    } else if (session) {
      message = `${session.label} is an account shell or unsupported provider; it cannot receive unattended prompts.`;
    }
    target.textContent = message;
    if (button) button.disabled = !available || !!this._diagnostic;
  }
}

function escapeHtml(value) {
  const element = document.createElement('span');
  element.textContent = String(value ?? '');
  return element.innerHTML;
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
