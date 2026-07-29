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

import { WORKFLOW_AGENT_TARGET } from './agent-targets.js';

export const TEMPLATES = [
  {
    id: 'tpl-claude-session',
    name: 'Claude Auto Session',
    description: 'Open Claude, send a prompt, then exit. The original quick-start demo.',
    blocks: [
      { type: 'schedule', params: { datetime: '', mode: 'once' } },
      { type: 'directory', params: { path: '' } },
      { type: 'command', params: { command: 'claude --permission-mode bypassPermissions' } },
      { type: 'agentWait', params: { profileId: '', idleMs: 1000, pattern: '', timeoutMs: 20000 } },
      { type: 'input', params: { text: 'ping. reply ok only.', pressEnter: true } },
      { type: 'agentWait', params: { profileId: '', idleMs: 2000, pattern: '', timeoutMs: 60000 } },
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
      { type: 'agentWait', params: { profileId: '', idleMs: 1000, pattern: '', timeoutMs: 20000 } },
      { type: 'loop', params: { count: 3 } },
      { type: 'log', params: { message: 'Loop iteration starting' } },
      { type: 'input', params: { text: 'continue. one short step only.', pressEnter: true } },
      { type: 'agentWait', params: { profileId: '', idleMs: 2000, pattern: '', timeoutMs: 45000 } },
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
      { type: 'agentWait', params: { profileId: '', idleMs: 1000, pattern: '', timeoutMs: 20000 } },
      { type: 'input', params: { text: 'run the nightly task.', pressEnter: true } },
      { type: 'agentWait', params: { profileId: '', idleMs: 2000, pattern: '', timeoutMs: 300000 } },
      { type: 'input', params: { text: '/exit', pressEnter: true } },
      { type: 'sleep', params: { delay: 2, unit: 'minutes' } },
    ],
  },
  {
    id: 'tpl-multi-account',
    name: 'Parallel pair + join',
    description: 'Open two accounts, broadcast one independent prompt before waiting, then join on a shared completion signal. Account fields stay blank so the template remains portable.',
    blocks: [
      { type: 'directory', params: { path: '' } },
      { type: 'agentStart', params: { profileId: '', settleMs: 8000 } },
      { type: 'agentStart', params: { profileId: '', settleMs: 8000 } },
      { type: 'agentSend', params: { profileId: WORKFLOW_AGENT_TARGET, text: 'Work independently on your lane. End your response with TEAM_READY.', pressEnter: true } },
      { type: 'agentJoin', params: { idleMs: 0, pattern: 'TEAM_READY', timeoutMs: 120000, onIncomplete: 'stop' } },
      { type: 'log', params: { message: 'Both agent lanes reached the team barrier.' } },
    ],
  },
  {
    id: 'tpl-quick-command',
    name: 'Quick command',
    description: 'A minimal workflow: pick a directory and run a single command.',
    blocks: [
      { type: 'directory', params: { path: '' } },
      { type: 'command', params: { command: 'echo Hello from Agent Orchestrator' } },
    ],
  },
];

/** Find a template by id, or null. */
export function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}
