(() => {
  'use strict';

  const topologySelect = document.getElementById('topology-select');
  const markerInput = document.getElementById('marker-input');
  const idleInput = document.getElementById('idle-input');
  const timeoutInput = document.getElementById('timeout-input');
  const failurePolicySelect = document.getElementById('failure-policy-select');
  const recipeTitle = document.getElementById('recipe-title');
  const recipeLanes = document.getElementById('recipe-lanes');
  const recipeSummary = document.getElementById('recipe-summary');
  const recipeStatus = document.getElementById('recipe-status');
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
      title: 'Three independent proposals',
      roles: [
        { name: 'Proposal A', prompt: 'Develop one solution direction' },
        { name: 'Proposal B', prompt: 'Develop an independent direction' },
        { name: 'Proposal C', prompt: 'Develop a third solution direction' },
      ],
    },
  };

  let simulationTimers = [];
  let recipeAnnouncementTimer = 0;

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
    const idleMs = clampNumber(idleInput, 2000, 0, 3600000);
    const timeoutMs = clampNumber(timeoutInput, 120000, 1, 86400000);
    const continueOnFailure = failurePolicySelect.value === 'continue';

    recipeTitle.textContent = topology.title;
    recipeLanes.replaceChildren();

    const stages = [
      {
        label: '01 · OPEN EVERY SESSION',
        blocks: topology.roles.map((role) => ({
          title: 'Agent Session',
          detail: role.name,
        })),
      },
      {
        label: '02 · SEND EVERY PROMPT',
        blocks: topology.roles.map((role) => ({
          title: 'Send to Agent',
          detail: role.name,
        })),
      },
    ];

    for (const stage of stages) {
      const stageElement = makeElement('div', 'recipe-stage');
      stageElement.append(makeElement('div', 'recipe-stage-label', stage.label));
      const blockRow = makeElement('div', 'recipe-stage-blocks');
      for (const block of stage.blocks) {
        const blockElement = makeElement('div', 'recipe-block');
        blockElement.append(
          makeElement('strong', '', block.title),
          makeElement('small', '', block.detail),
        );
        blockRow.append(blockElement);
      }
      stageElement.append(blockRow);
      recipeLanes.append(stageElement);
    }

    const joinStage = makeElement('div', 'recipe-stage recipe-stage-join');
    joinStage.append(makeElement('div', 'recipe-stage-label', '03 · JOIN ONCE'));
    const joinBlock = makeElement('div', 'recipe-join-block');
    const joinIdentity = makeElement('div', 'recipe-join-identity');
    joinIdentity.append(
      makeElement('span', 'recipe-join-mark', '◇'),
      makeElement('strong', '', 'Join Agents'),
      makeElement('small', '', `marker “${marker}” or ${idleMs} ms new-output idle`),
    );
    joinBlock.append(
      joinIdentity,
      makeElement('span', 'recipe-ready', `0 / ${topology.roles.length} ready`),
    );
    joinStage.append(joinBlock);
    recipeLanes.append(joinStage);

    let stepNumber = 1;
    const lines = [
      `${topology.title}`,
      'Open every session:',
      ...topology.roles.map((role) => `${stepNumber++}. Agent Session → ${role.name}`),
      'Send every prompt before joining:',
      ...topology.roles.map((role) => (
        `${stepNumber++}. Send to Agent → ${role.name}: “${role.prompt}”`
      )),
      `${stepNumber}. Join Agents → all ${topology.roles.length} workflow-owned sessions prompted in this stage`,
      `   Ready: each session matches "${marker}" (literal, case-insensitive) OR reaches ${idleMs} ms new-output idle.`,
      continueOnFailure
        ? `   Failure: continue with a warning after ${timeoutMs} ms timeout or premature session exit.`
        : `   Failure: stop downstream execution after ${timeoutMs} ms timeout or premature session exit; leave remaining sessions open.`,
      'Profile IDs: choose locally in Agent Accounts; do not bake machine-specific IDs into a shared template.',
    ];
    recipeSummary.textContent = lines.join('\n');
  }

  function renderRecipeWithAnnouncement() {
    renderRecipe();
    window.clearTimeout(recipeAnnouncementTimer);
    recipeAnnouncementTimer = window.setTimeout(() => {
      const topology = topologies[topologySelect.value] || topologies.pair;
      recipeStatus.textContent = `Recipe preview updated: ${topology.title}; marker ${cleanMarker()}.`;
    }, 350);
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
    const tablist = document.querySelector('[role="tablist"]');
    const narrowLayout = window.matchMedia('(max-width: 780px)');
    const syncOrientation = () => {
      tablist.setAttribute('aria-orientation', narrowLayout.matches ? 'horizontal' : 'vertical');
    };
    syncOrientation();
    narrowLayout.addEventListener('change', syncOrientation);

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activateAssuranceTab(tab));
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let nextIndex = index;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          nextIndex = (index - 1 + tabs.length) % tabs.length;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          nextIndex = (index + 1) % tabs.length;
        }
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
    simulationResult.textContent = '0 / 3 ready';
    appendSimulationLine('01', 'stage scope → 3 prompted workflow sessions', 'log-dim');

    void waitConsole.offsetWidth;
    waitConsole.classList.add('is-running');
    runSimulationButton.disabled = true;

    scheduleSimulation(320 * pace, () => {
      simulationClock.textContent = 't + 320 ms';
      appendSimulationLine('02', `Builder marker “${marker}” found from its prompt checkpoint`, 'log-marker');
      simulationResult.textContent = '1 / 3 ready';
    });

    scheduleSimulation(680 * pace, () => {
      simulationClock.textContent = 't + 680 ms';
      appendSimulationLine('03', 'Reviewer reaches new-output idle', 'log-output');
      simulationResult.textContent = '2 / 3 ready';
    });

    scheduleSimulation(1050 * pace, () => {
      simulationClock.textContent = 't + 1050 ms';
      appendSimulationLine('04', `Verifier marker “${marker}” found`, 'log-marker');
      simulationResult.textContent = '3 / 3 ready';
    });

    scheduleSimulation(1420 * pace, () => {
      simulationClock.textContent = 't + 1420 ms';
      appendSimulationLine('05', 'shared barrier complete → continue', 'log-match');
      simulationResult.textContent = 'Team stage ready';
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
        const active = link.getAttribute('href') === `#${visible.target.id}`;
        link.classList.toggle('is-active', active);
        if (active) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-25% 0px -60%', threshold: [0, 0.1, 0.4, 0.7] });
    sections.forEach((section) => observer.observe(section));
  }

  function setupProofViewports() {
    const viewports = Array.from(document.querySelectorAll('.proof-viewport'));
    const records = viewports.map((viewport) => ({
      viewport,
      userPositioned: false,
      userFocusRatio: null,
      programmaticLeft: null,
    }));

    function isScrollable(viewport) {
      return viewport.scrollWidth > viewport.clientWidth + 1;
    }

    function setScrollLeft(record, left) {
      const { viewport } = record;
      const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      record.programmaticLeft = Math.max(0, Math.min(left, maximum));
      viewport.scrollLeft = record.programmaticLeft;
    }

    function focusViewport(record) {
      const { viewport } = record;
      if (!isScrollable(viewport)) {
        viewport.removeAttribute('tabindex');
        record.userPositioned = false;
        record.userFocusRatio = null;
        setScrollLeft(record, 0);
        return;
      }

      viewport.tabIndex = 0;
      const defaultRatio = Number.parseFloat(viewport.dataset.focusX) || 0.5;
      const focusRatio = record.userPositioned && record.userFocusRatio !== null
        ? record.userFocusRatio
        : defaultRatio;
      const target = (viewport.scrollWidth * focusRatio) - (viewport.clientWidth / 2);
      setScrollLeft(record, target);
    }

    function rememberUserPosition(record) {
      const { viewport } = record;
      if (!isScrollable(viewport)) return;
      record.userPositioned = true;
      record.userFocusRatio = (viewport.scrollLeft + (viewport.clientWidth / 2)) / viewport.scrollWidth;
    }

    records.forEach((record) => {
      const { viewport } = record;
      const image = viewport.querySelector('img');
      const focusAfterLayout = () => window.requestAnimationFrame(() => focusViewport(record));

      viewport.addEventListener('scroll', () => {
        if (record.programmaticLeft !== null
          && Math.abs(viewport.scrollLeft - record.programmaticLeft) <= 1) {
          record.programmaticLeft = null;
          return;
        }
        record.programmaticLeft = null;
        rememberUserPosition(record);
      }, { passive: true });

      viewport.addEventListener('keydown', (event) => {
        if (!isScrollable(viewport)) return;
        const step = Math.max(72, viewport.clientWidth * 0.75);
        let nextLeft = null;
        if (event.key === 'ArrowLeft') nextLeft = viewport.scrollLeft - step;
        if (event.key === 'ArrowRight') nextLeft = viewport.scrollLeft + step;
        if (event.key === 'Home') nextLeft = 0;
        if (event.key === 'End') nextLeft = viewport.scrollWidth - viewport.clientWidth;
        if (nextLeft === null) return;

        event.preventDefault();
        record.programmaticLeft = null;
        viewport.scrollLeft = nextLeft;
        rememberUserPosition(record);
      });

      if (!image || image.complete) focusAfterLayout();
      else {
        image.addEventListener('load', focusAfterLayout, { once: true });
        image.addEventListener('error', focusAfterLayout, { once: true });
      }
    });

    let resizeFrame = 0;
    window.addEventListener('resize', () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        records.forEach(focusViewport);
      });
    }, { passive: true });
  }

  topologySelect.addEventListener('change', renderRecipeWithAnnouncement);
  markerInput.addEventListener('input', renderRecipeWithAnnouncement);
  idleInput.addEventListener('change', renderRecipeWithAnnouncement);
  timeoutInput.addEventListener('change', renderRecipeWithAnnouncement);
  failurePolicySelect.addEventListener('change', renderRecipeWithAnnouncement);
  runSimulationButton.addEventListener('click', runSimulation);

  setupAssuranceTabs();
  setupCopyButtons();
  setupSectionObserver();
  setupProofViewports();
  renderRecipe();
  currentYear.textContent = String(new Date().getFullYear());
})();
