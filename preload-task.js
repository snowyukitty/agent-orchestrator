// ============================================================
// Agent Orchestrator — Task Window Preload
// The only bridge a task window has. Main binds every call to the window
// that made it, so the page never names a launch, a path, or a session.
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskWindow', {
  attach: () => ipcRenderer.invoke('task-window:attach'),
  input: text => ipcRenderer.invoke('task-window:input', String(text)),
  resize: (cols, rows) => ipcRenderer.invoke('task-window:resize', { cols, rows }),
  stop: () => ipcRenderer.invoke('task-window:stop'),
  onOutput: (listener) => {
    ipcRenderer.on('task-window:output', (_event, data) => listener(String(data)));
  },
  onState: (listener) => {
    ipcRenderer.on('task-window:state', (_event, state) => listener(state));
  },
});
