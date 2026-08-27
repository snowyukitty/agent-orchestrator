// ============================================================
// Agent Orchestrator — Preload Script
// Bridges main process APIs to renderer via contextBridge
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

// Main mints one opaque token for each committed top-level document and sends
// it at dom-ready. It stays in this isolated preload closure; page JavaScript
// receives only the fixed API methods below.
//
// Delivery must not be a single fire-and-forget message: dom-ready can race a
// navigation that clears main's committed token, and a lost message would
// otherwise leave every window.api call awaiting forever with no error. So
// the listener is persistent, the preload re-requests the token until it
// arrives, and callers get a visible rejection instead of a silent hang.
const TOKEN_REQUEST_INTERVAL_MS = 2000;
const TOKEN_WAIT_LIMIT_MS = 30000;

let resolveDocumentToken;
const documentToken = new Promise((resolve) => { resolveDocumentToken = resolve; });
let tokenDelivered = false;
ipcRenderer.on('renderer-document-token', (_event, token) => {
  if (tokenDelivered) return;
  if (typeof token === 'string' && token.length >= 16) {
    tokenDelivered = true;
    resolveDocumentToken(token);
  }
});
const tokenRequestTimer = setInterval(() => {
  if (tokenDelivered) {
    clearInterval(tokenRequestTimer);
    return;
  }
  ipcRenderer.send('renderer-document-token-request');
}, TOKEN_REQUEST_INTERVAL_MS);
setTimeout(() => clearInterval(tokenRequestTimer), TOKEN_WAIT_LIMIT_MS);

const documentTokenOrFail = () => Promise.race([
  documentToken,
  new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error(
        'The renderer never received its document token from the main process; reload the window'
      ));
    }, TOKEN_WAIT_LIMIT_MS);
  }),
]);

const invokeTrusted = async (channel, ...args) => (
  ipcRenderer.invoke(channel, ...args, await (tokenDelivered ? documentToken : documentTokenOrFail()))
);

const api = {
  // Process management
  executeCommand: (params) => invokeTrusted('execute-command', params),
  sendInput: (params) => invokeTrusted('send-input', params),
  sendStructuredInput: (params) => invokeTrusted('session:send-structured', params),
  killProcess: (params) => invokeTrusted('kill-process', params),
  killAllProcesses: () => invokeTrusted('kill-all-processes'),
  setKeepAwake: (on) => invokeTrusted('set-keep-awake', { on }),
  resizeProcess: (params) => invokeTrusted('resize-process', params),
  getDefaultDirectory: () => invokeTrusted('get-default-directory'),
  getVersion: () => invokeTrusted('get-app-version'),
  listSessions: () => invokeTrusted('list-sessions'),
  sessionCheckpoint: (params) => invokeTrusted('session:checkpoint', params),
  waitForSession: (params) => invokeTrusted('session:wait', params),
  cancelSessionWait: (params) => invokeTrusted('session:cancel-wait', params),

  // Agent profiles: local (env-only) profiles plus routed accounts
  // discovered from ai-agent-entrypoint.
  listAgents: (params) => invokeTrusted('agents:list', params || {}),
  saveAgentProfile: (profile) => invokeTrusted('agents:save', { profile }),
  deleteAgentProfile: (id) => invokeTrusted('agents:delete', { id }),
  createSession: (params) => invokeTrusted('session:create', params),

  // Persisted preferences (theme, window/panel geometry, entrypoint path).
  getSettings: () => invokeTrusted('get-settings'),
  updateSettings: (patch) => invokeTrusted('update-settings', patch),

  // Delayed system hibernate
  armSleep: (params) => invokeTrusted('arm-sleep', params),
  cancelSleep: () => invokeTrusted('cancel-sleep'),
  getSleepState: () => invokeTrusted('get-sleep-state'),
  onSleepState: (callback) => {
    ipcRenderer.on('sleep-state', (_event, data) => callback(data));
  },

  // Workflow persistence
  saveWorkflow: (params) => invokeTrusted('save-workflow', params),
  loadWorkflow: (params) => invokeTrusted('load-workflow', params),
  deleteWorkflow: (params) => invokeTrusted('delete-workflow', params),

  // Durable run metadata and explicit, encrypted result artifacts.
  // List/detail calls omit result bodies; one body is decrypted only when the
  // renderer explicitly requests that result.
  startRunJournal: (params) => invokeTrusted('journal:start', params),
  startRunBlock: (params) => invokeTrusted('journal:block-start', params),
  finishRunBlock: (params) => invokeTrusted('journal:block-finish', params),
  storeRunResult: (params) => invokeTrusted('journal:result-store', params),
  finishRunJournal: (params) => invokeTrusted('journal:finish', params),
  listRunJournal: (params) => invokeTrusted('journal:list', params || {}),
  getRunJournal: (params) => invokeTrusted('journal:get', params),
  getRunResult: (params) => invokeTrusted('journal:result-get', params),
  deleteRunJournal: (params) => invokeTrusted('journal:delete', params),
  pruneRunJournal: (params) => invokeTrusted('journal:prune', params),

  // File/Directory dialogs
  selectDirectory: () => invokeTrusted('select-directory'),
  openFileDialog: () => invokeTrusted('open-file-dialog'),
  saveFileDialog: () => invokeTrusted('save-file-dialog'),

  // Event listeners for process output streaming
  onProcessOutput: (callback) => {
    ipcRenderer.on('process-output', (_event, data) => callback(data));
  },
  onProcessExit: (callback) => {
    ipcRenderer.on('process-exit', (_event, data) => callback(data));
  },
  onProcessError: (callback) => {
    ipcRenderer.on('process-error', (_event, data) => callback(data));
  },

  // Session lifecycle metadata (started / exited), one event per change.
  onSessionStatus: (callback) => {
    ipcRenderer.on('session-status', (_event, data) => callback(data));
  },

  // Main-process scheduler heartbeat (fires even when hidden/locked)
  onSchedulerTick: (callback) => {
    ipcRenderer.on('scheduler-tick', () => callback());
  },

  // Cleanup
  removeAllListeners: (channel) => {
    const allowed = new Set([
      'process-output',
      'process-exit',
      'process-error',
      'session-status',
      'scheduler-tick',
      'sleep-state',
    ]);
    if (allowed.has(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  }
};

// Production renderers never receive an app-exit capability. main.js adds
// this marker only to the BrowserWindow created for `npm run test:app`.
if (process.argv.includes('--orchestrator-self-test')) {
  api.selfTestResult = (result) => invokeTrusted('self-test-result', result);
}

contextBridge.exposeInMainWorld('api', api);
