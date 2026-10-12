// UI verification fixture only. Never uses production IPC, PTYs, or account homes.
const { contextBridge } = require('electron');
let workflows = [];
let failSave = false;
let profiles = [{ id: 'codex:demo', displayName: 'Codex · Demo', icon: '◇', agent: 'codex', assurance: 'L1-routed', authenticated: true, status: 'ready', errors: [] }];
const calls = { executeCommand: 0, createSession: 0, sendInput: 0 };
contextBridge.exposeInMainWorld('api', {
  getVersion: async () => '0.4.0',
  getDefaultDirectory: async () => '.',
  getSettings: async () => ({ theme: 'dark' }),
  updateSettings: async () => ({}),
  listAgents: async () => ({ routed: profiles, local: [], entrypointFound: true, routedError: null, agentKinds: [] }),
  loadWorkflow: async () => JSON.parse(JSON.stringify(workflows)),
  saveWorkflow: async ({ workflow }) => {
    if (failSave) throw new Error('Fixture save failure');
    workflows = [...workflows.filter(w => w.id !== workflow.id), { ...JSON.parse(JSON.stringify(workflow)), file: `${workflow.id}.json` }];
    return 'Saved workflow';
  },
  executeCommand: async ({ id }) => { calls.executeCommand++; return { id }; },
  createSession: async () => { calls.createSession++; throw new Error('Real sessions forbidden in UI verification'); },
  sendInput: async () => { calls.sendInput++; throw new Error('Real input forbidden in UI verification'); },
  resizeProcess: async () => {},
  killProcess: async () => {},
  setKeepAwake: async () => {},
  getSleepState: async () => ({ target: null }),
  onProcessOutput: () => {}, onProcessExit: () => {}, onProcessError: () => {},
  onSessionStatus: () => {}, onSchedulerTick: () => {}, onSleepState: () => {},
  testFixture: {
    setSaveFailure: async value => { failSave = value; },
    setProfiles: async value => { profiles = value; },
    snapshot: async () => ({ workflows: JSON.parse(JSON.stringify(workflows)), calls: { ...calls } }),
  },
});
