// ============================================================
// Workflow Templates
// Pre-built starting points users can load from the Templates picker.
//
// Conventions kept by the app when a template is applied:
//   • directory blocks with path === ''   → filled with the default directory
//   • schedule blocks with datetime === '' → filled with the current local time
//     (and marked "handled" so loading a template never auto-fires a run)
// Most block ids are omitted; the app assigns them while normalizing. A
// template may use stable, template-local ids when later blocks need to
// reference an earlier result producer.
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
    name: 'Parallel research → synthesis',
    description: 'Open two accounts, collect one explicit result from each, then attach the complete bundle to a synthesis prompt. Account fields stay blank so the template remains portable.',
    blocks: [
      { type: 'directory', params: { path: '' } },
      { type: 'agentStart', params: { profileId: '', settleMs: 8000 } },
      { type: 'agentStart', params: { profileId: '', settleMs: 8000 } },
      {
        type: 'agentSend',
        params: {
          profileId: WORKFLOW_AGENT_TARGET,
          text: 'Research this task independently. Return concise evidence, risks, and a recommendation.',
          pressEnter: true,
          expectResult: true,
          handoffFrom: '',
        },
      },
      {
        id: 'parallel-research-results',
        type: 'agentJoin',
        params: {
          idleMs: 0,
          pattern: '',
          timeoutMs: 120000,
          onIncomplete: 'stop',
          resultName: 'research',
        },
      },
      {
        type: 'agentSend',
        params: {
          profileId: '',
          text: 'Synthesize the attached research into one decision-ready answer. Reconcile disagreements and name remaining uncertainty.',
          pressEnter: true,
          expectResult: false,
          handoffFrom: 'parallel-research-results',
        },
      },
      { type: 'agentWait', params: { profileId: '', idleMs: 2000, pattern: '', timeoutMs: 120000 } },
    ],
  },
  {
    id: 'tpl-usage-window-prewarm',
    name: 'Usage-window pre-warm',
    description: 'Daily early-morning ping that starts your metered 5-hour usage window before you sit down, so the window rolls over soon after you start working. Set the schedule time to ~4–5 hours before your work start.',
    blocks: [
      // Example: work starts at 09:00 → schedule this at 05:00. The provider's
      // rolling 5-hour window then spans 05:00–10:00, so a fresh window opens
      // at 10:00 — two windows' worth of usage across one working morning.
      { type: 'schedule', params: { datetime: '', mode: 'cron' } },
      { type: 'directory', params: { path: '' } },
      { type: 'command', params: { command: 'claude --permission-mode bypassPermissions' } },
      { type: 'agentWait', params: { profileId: '', idleMs: 1000, pattern: '', timeoutMs: 20000 } },
      { type: 'input', params: { text: 'ping. reply ok only. (usage-window pre-warm)', pressEnter: true } },
      { type: 'agentWait', params: { profileId: '', idleMs: 2000, pattern: '', timeoutMs: 60000 } },
      { type: 'input', params: { text: '/exit', pressEnter: true } },
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
