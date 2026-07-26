// ============================================================
// Workflow Templates
// Pre-built starting points users can load from the Templates picker.
//
// Conventions kept by the app when a template is applied:
//   • directory blocks with path === ''   → filled with the default directory
//   • schedule blocks with datetime === '' → filled with the current local time
//     (and marked "handled" so loading a template never auto-fires a run)
// Block ids are omitted here; the app normalizes each template, which assigns
// fresh ids so multiple instances never collide.
// ============================================================

export const TEMPLATES = [
  {
    id: 'tpl-claude-session',
    name: 'Claude Auto Session',
    description: 'Open Claude, send a prompt, then exit. The original quick-start demo.',
    blocks: [
      { type: 'schedule', params: { datetime: '', mode: 'once' } },
      { type: 'directory', params: { path: '' } },
      { type: 'command', params: { command: 'claude --permission-mode bypassPermissions' } },
      { type: 'wait', params: { duration: 20, unit: 'seconds' } },
      { type: 'input', params: { text: 'ping. reply ok only.', pressEnter: true } },
      { type: 'wait', params: { duration: 60, unit: 'seconds' } },
      { type: 'input', params: { text: '/exit', pressEnter: true } },
    ],
  },
  {
    id: 'tpl-loop-pings',
    name: 'Loop: repeated prompts',
    description: 'Start an agent, then loop a prompt/wait pair N times before exiting. Shows the Loop block.',
    blocks: [
      { type: 'directory', params: { path: '' } },
      { type: 'command', params: { command: 'claude --permission-mode bypassPermissions' } },
      { type: 'wait', params: { duration: 20, unit: 'seconds' } },
      { type: 'loop', params: { count: 3 } },
      { type: 'log', params: { message: 'Loop iteration starting' } },
      { type: 'input', params: { text: 'continue. one short step only.', pressEnter: true } },
      { type: 'wait', params: { duration: 45, unit: 'seconds' } },
      { type: 'loopEnd', params: {} },
      { type: 'input', params: { text: '/exit', pressEnter: true } },
    ],
  },
  {
    id: 'tpl-nightly-hibernate',
    name: 'Nightly run + hibernate',
    description: 'Run daily at a set time, do the work, then hibernate the PC to save power.',
    blocks: [
      { type: 'schedule', params: { datetime: '', mode: 'cron' } },
      { type: 'directory', params: { path: '' } },
      { type: 'command', params: { command: 'claude --permission-mode bypassPermissions' } },
      { type: 'wait', params: { duration: 20, unit: 'seconds' } },
      { type: 'input', params: { text: 'run the nightly task.', pressEnter: true } },
      { type: 'wait', params: { duration: 5, unit: 'minutes' } },
      { type: 'input', params: { text: '/exit', pressEnter: true } },
      { type: 'sleep', params: { delay: 2, unit: 'minutes' } },
    ],
  },
  {
    id: 'tpl-multi-account',
    name: 'Two accounts, one workflow',
    description: 'Open two agent accounts side by side and prompt each one. Pick the accounts in the Agent Session blocks.',
    blocks: [
      { type: 'directory', params: { path: '' } },
      { type: 'agentStart', params: { profileId: '', settleMs: 8000 } },
      { type: 'agentSend', params: { profileId: '', text: 'ping. reply ok only.', pressEnter: true } },
      { type: 'agentStart', params: { profileId: '', settleMs: 8000 } },
      { type: 'agentSend', params: { profileId: '', text: 'ping. reply ok only.', pressEnter: true } },
      { type: 'wait', params: { duration: 60, unit: 'seconds' } },
      { type: 'log', params: { message: 'Both accounts have been prompted.' } },
    ],
  },
  {
    id: 'tpl-quick-command',
    name: 'Quick command',
    description: 'A minimal workflow: pick a directory and run a single command.',
    blocks: [
      { type: 'directory', params: { path: '' } },
      { type: 'command', params: { command: 'echo Hello from Agents Orchestrator' } },
    ],
  },
];

/** Find a template by id, or null. */
export function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}
