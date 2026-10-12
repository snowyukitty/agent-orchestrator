// Centralized dialog focus and keyboard access; no process IPC listeners.
export function initAccessibility() {
  const stack = [];
  const focusable = modal => [...modal.querySelectorAll('button, input, select, textarea, [tabindex="0"]')]
    .filter(el => !el.disabled && el.getClientRects().length > 0);
  for (const overlay of document.querySelectorAll('.modal-overlay')) {
    const card = overlay.querySelector('.modal-card');
    const heading = card.querySelector('h2');
    heading.id ||= `${overlay.id}-title`;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', heading.id);
    card.tabIndex = -1;
    new MutationObserver(() => {
      const index = stack.findIndex(entry => entry.overlay === overlay);
      if (!overlay.classList.contains('hidden') && index < 0) {
        const entry = { overlay, opener: document.activeElement };
        stack.push(entry);
        overlay.style.zIndex = String(1000 + stack.length);
        (focusable(overlay)[0] || card).focus();
      } else if (overlay.classList.contains('hidden') && index >= 0) {
        const [entry] = stack.splice(index, 1);
        if (!stack.length || stack.at(-1).overlay.contains(entry.opener)) entry.opener?.focus();
      }
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('keydown', e => {
    const modal = stack.at(-1)?.overlay;
    if (!modal) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      modal.classList.add('hidden');
    } else if (e.key === 'Tab') {
      const items = focusable(modal);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    }
  });
  document.getElementById('status-text').setAttribute('role', 'status');
  // Existing delegated click handlers remain the one path for row actions.
  document.addEventListener('keydown', e => {
    const row = e.target.closest?.('.wf-row, .agent-row, .session-tab');
    if (!row || e.target !== row || !['Enter', ' '].includes(e.key)) return;
    e.preventDefault(); row.click();
  });
  const rows = new MutationObserver(() => {
    for (const row of document.querySelectorAll('.wf-row, .agent-row:not(.unavailable), .session-tab')) {
      row.tabIndex = 0;
      row.setAttribute('role', 'group');
    }
  });
  rows.observe(document.body, { childList: true, subtree: true });
  const group = document.querySelector('.tab-group');
  group.setAttribute('role', 'tablist');
  group.setAttribute('aria-label', 'Output view');
  for (const tab of group.querySelectorAll('.tab-btn')) {
    tab.setAttribute('role', 'tab');
    const update = () => {
      for (const t of group.children) t.setAttribute('aria-selected', String(t.classList.contains('active')));
    };
    tab.addEventListener('click', update);
    tab.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const other = [...group.children].find(t => t !== tab);
      other.click(); other.focus();
    });
    update();
  }
  for (const [id, orientation, label] of [['resizer', 'vertical', 'Terminal panel width'], ['resizer-h', 'horizontal', 'Activity panel height']]) {
    const handle = document.getElementById(id);
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', orientation);
    handle.setAttribute('aria-label', label);
    handle.addEventListener('keydown', e => {
      const vertical = orientation === 'vertical';
      const keys = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowDown', 'ArrowUp'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const change = e.key === keys[0] ? 20 : -20;
      const panel = document.getElementById(vertical ? 'terminal-panel' : 'output-log');
      const value = vertical ? Math.max(220, Math.min(window.innerWidth * .42, panel.offsetWidth + change))
        : Math.max(80, Math.min(document.getElementById('terminal-panel').offsetHeight - 220, panel.offsetHeight + change));
      if (vertical) panel.style.width = `${value}px`;
      else panel.style.flex = `0 0 ${value}px`;
      window.app?.sessions?.fitActive();
      window.api.updateSettings?.({ [vertical ? 'terminalPanelWidth' : 'logPaneHeight']: value }).catch(() => {});
    });
  }
}
