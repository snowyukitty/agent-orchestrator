// Task window renderer: one terminal for one task, plus its state and Stop.
// Everything privileged goes through window.taskWindow, which main binds to
// this window's own launch.
(() => {
  const api = window.taskWindow;
  const $ = id => document.getElementById(id);
  const term = new window.Terminal({
    convertEol: false,
    cursorBlink: true,
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 13,
    theme: { background: '#0a0a0f' },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('terminal'));

  // Output that arrives before attach() resolves is buffered, then written
  // after the replay so the order on screen matches the PTY.
  let attached = false;
  const pending = [];
  api.onOutput((data) => {
    if (attached) term.write(data);
    else pending.push(data);
  });

  const STATE_TEXT = {
    'needs-review': 'needs review',
    'failed-to-start': 'failed to start',
    'window-open': 'starting',
  };
  let stopEnabled = true;
  function renderState(state) {
    if (!state) return;
    $('task-id').textContent = state.taskId;
    $('task-route').textContent = `${state.provider}:${state.route}`;
    const label = STATE_TEXT[state.state] || state.state;
    $('task-state').textContent = state.reason ? `${label} (${state.reason})` : label;
    $('task-turn').textContent = state.turnComplete ? 'observed' : 'not observed';
    const proc = $('task-process');
    if (state.processRunning) {
      proc.textContent = state.stopRequested ? 'stopping' : 'running';
      proc.removeAttribute('data-tone');
    } else if (state.exitCode !== null && state.exitCode !== undefined) {
      proc.textContent = `exited (${state.exitCode})`;
      proc.dataset.tone = state.exitCode === 0 ? '' : 'warn';
    } else {
      proc.textContent = 'not running';
    }
    stopEnabled = state.processRunning && !state.stopRequested;
    $('task-stop').disabled = !stopEnabled;
  }
  api.onState(renderState);

  // Stop asks twice in place rather than opening a modal dialog.
  const stop = $('task-stop');
  let armTimer = null;
  stop.addEventListener('click', async () => {
    if (!stopEnabled) return;
    if (stop.dataset.armed !== 'true') {
      stop.dataset.armed = 'true';
      stop.textContent = 'Confirm stop';
      armTimer = setTimeout(() => { stop.dataset.armed = 'false'; stop.textContent = 'Stop task'; }, 4000);
      return;
    }
    clearTimeout(armTimer);
    stop.dataset.armed = 'false';
    stop.textContent = 'Stop task';
    stop.disabled = true;
    await api.stop();
  });

  term.onData(data => { api.input(data); });
  const resize = () => {
    try { fit.fit(); } catch (_error) { return; }
    api.resize(term.cols, term.rows);
  };
  window.addEventListener('resize', resize);

  api.attach().then((view) => {
    if (view?.replay) term.write(view.replay);
    for (const data of pending.splice(0)) term.write(data);
    attached = true;
    renderState(view?.state);
    resize();
    term.focus();
  });
})();
