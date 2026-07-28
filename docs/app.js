(() => {
  'use strict';

  const topologySelect = document.getElementById('topology-select');
  const markerInput = document.getElementById('marker-input');
  const idleInput = document.getElementById('idle-input');
  const timeoutInput = document.getElementById('timeout-input');
  const recipeTitle = document.getElementById('recipe-title');
  const recipeLanes = document.getElementById('recipe-lanes');
  const recipeSummary = document.getElementById('recipe-summary');
  const runSimulationButton = document.getElementById('run-simulation');
  const simulationLog = document.getElementById('simulation-log');
  const simulationClock = document.getElementById('simulation-clock');
  const simulationResult = document.getElementById('simulation-result');
  const waitConsole = document.querySelector('.wait-console');
  const currentYear = document.getElementById('current-year');

  const topologies = {
    pair: {
      title: 'Builder + reviewer',
      roles: [
        { name: 'Builder', prompt: 'Implement the scoped change' },
        { name: 'Reviewer', prompt: 'Review behavior and boundaries' },
      ],
    },
    triad: {
      title: 'Builder + reviewer + verifier',
      roles: [
        { name: 'Builder', prompt: 'Implement the scoped change' },
        { name: 'Reviewer', prompt: 'Review behavior and boundaries' },
        { name: 'Verifier', prompt: 'Run checks and report evidence' },
      ],
    },
    compare: {
      title: 'Two proposals + synthesizer',
      roles: [
        { name: 'Proposal A', prompt: 'Develop one solution direction' },
        { name: 'Proposal B', prompt: 'Develop an independent direction' },
        { name: 'Synthesizer', prompt: 'Compare evidence and synthesize' },
      ],
    },
  };

  let simulationTimers = [];

  function clampNumber(input, fallback, minimum, maximum) {
    const parsed = Number.parseInt(input.value, 10);
    const value = Number.isFinite(parsed)
      ? Math.min(maximum, Math.max(minimum, parsed))
      : fallback;
    input.value = String(value);
    return value;
  }

  function cleanMarker() {
    const value = markerInput.value.trim().slice(0, 64);
    return value || 'REVIEW_COMPLETE';
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function renderRecipe() {
    const topology = topologies[topologySelect.value] || topologies.pair;
    const marker = cleanMarker();
    const idleMs = clampNumber(idleInput, 3000, 100, 600000);
    const timeoutMs = clampNumber(timeoutInput, 90000, 100, 3600000);

    recipeTitle.textContent = topology.title;
    recipeLanes.replaceChildren();

    topology.roles.forEach((role, index) => {
      const lane = makeElement('div', 'recipe-lane');
      const roleLabel = makeElement('div', 'recipe-role');
      roleLabel.append(
        makeElement('span', 'role-index', String(index + 1).padStart(2, '0')),
        makeElement('span', '', role.name),
      );
      lane.append(
        roleLabel,
        makeElement('span', 'recipe-block', 'Agent Session'),
        makeElement('span', 'recipe-block', 'Send to Agent'),
        makeElement('span', 'recipe-block block-wait', `Wait · ${marker}`),
      );
      recipeLanes.append(lane);
    });

    const lines = [
      `${topology.title}`,
      ...topology.roles.map((role, index) => (
        `${index + 1}. ${role.name}: Agent Session → Send “${role.prompt}” → Wait for “${marker}”`
      )),
      `Join policy: pattern "${marker}" (literal, case-insensitive) OR ${idleMs} ms idle; ${timeoutMs} ms timeout backstop.`,
      'Profile IDs: choose locally in Agent Accounts; do not bake machine-specific IDs into a shared template.',
    ];
    recipeSummary.textContent = lines.join('\n');
  }

  function activateAssuranceTab(tab) {
    const tabs = Array.from(document.querySelectorAll('[role="tab"][data-tab-target]'));
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.classList.toggle('is-active', selected);
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(candidate.dataset.tabTarget);
      if (panel) panel.hidden = !selected;
    }
  }

  function setupAssuranceTabs() {
    const tabs = Array.from(document.querySelectorAll('[role="tab"][data-tab-target]'));
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activateAssuranceTab(tab));
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let nextIndex = index;
        if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        activateAssuranceTab(tabs[nextIndex]);
        tabs[nextIndex].focus();
      });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }

    return new Promise((resolve, reject) => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.className = 'copy-fallback';
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      if (copied) resolve();
      else reject(new Error('Clipboard unavailable'));
    });
  }

  function setupCopyButtons() {
    for (const button of document.querySelectorAll('[data-copy-target]')) {
      const originalLabel = button.textContent;
      button.addEventListener('click', async () => {
        const source = document.getElementById(button.dataset.copyTarget);
        if (!source) return;
        try {
          await copyText(source.textContent.trim());
          button.textContent = 'Copied';
        } catch (_error) {
          button.textContent = 'Select text to copy';
          source.focus();
          if (window.getSelection) {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(source);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        }
        window.setTimeout(() => {
          button.textContent = originalLabel;
        }, 1800);
      });
    }
  }

  function clearSimulation() {
    for (const timer of simulationTimers) window.clearTimeout(timer);
    simulationTimers = [];
    waitConsole.classList.remove('is-running');
    simulationResult.classList.remove('is-match');
  }

  function appendSimulationLine(sequence, text, className = '') {
    const line = makeElement('p', className);
    line.append(makeElement('span', '', sequence), document.createTextNode(text));
    simulationLog.append(line);
  }

  function scheduleSimulation(delay, action) {
    simulationTimers.push(window.setTimeout(action, delay));
  }

  function runSimulation() {
    clearSimulation();
    const marker = cleanMarker();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pace = reducedMotion ? 0.08 : 1;

    simulationLog.replaceChildren();
    simulationClock.textContent = 't + 0 ms';
    simulationResult.textContent = 'Checkpoint captured';
    appendSimulationLine('01', 'checkpoint → output sequence 1842', 'log-dim');

    void waitConsole.offsetWidth;
    waitConsole.classList.add('is-running');
    runSimulationButton.disabled = true;

    scheduleSimulation(320 * pace, () => {
      simulationClock.textContent = 't + 320 ms';
      appendSimulationLine('02', 'Enter submitted to review session', 'log-dim');
      simulationResult.textContent = 'Observing new output';
    });

    scheduleSimulation(680 * pace, () => {
      simulationClock.textContent = 't + 680 ms';
      appendSimulationLine('03', 'Reviewing changed files…', 'log-output');
    });

    scheduleSimulation(1050 * pace, () => {
      simulationClock.textContent = 't + 1050 ms';
      appendSimulationLine('04', `Agent: ${marker}`, 'log-marker');
    });

    scheduleSimulation(1420 * pace, () => {
      simulationClock.textContent = 't + 1420 ms';
      appendSimulationLine('05', 'matched from sequence 1842 → continue', 'log-match');
      simulationResult.textContent = 'Output text matched';
      simulationResult.classList.add('is-match');
    });

    scheduleSimulation(1800 * pace, () => {
      runSimulationButton.disabled = false;
      waitConsole.classList.remove('is-running');
    });
  }

  function setupSectionObserver() {
    if (!('IntersectionObserver' in window)) return;
    const links = Array.from(document.querySelectorAll('.site-nav a'));
    const sections = links
      .map((link) => document.querySelector(link.getAttribute('href')))
      .filter(Boolean);
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      links.forEach((link) => {
        link.classList.toggle('is-active', link.getAttribute('href') === `#${visible.target.id}`);
      });
    }, { rootMargin: '-25% 0px -60%', threshold: [0.1, 0.4, 0.7] });
    sections.forEach((section) => observer.observe(section));
  }

  topologySelect.addEventListener('change', renderRecipe);
  markerInput.addEventListener('input', renderRecipe);
  idleInput.addEventListener('change', renderRecipe);
  timeoutInput.addEventListener('change', renderRecipe);
  runSimulationButton.addEventListener('click', runSimulation);

  setupAssuranceTabs();
  setupCopyButtons();
  setupSectionObserver();
  renderRecipe();
  currentYear.textContent = String(new Date().getFullYear());
})();
