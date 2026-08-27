# Architecture and safety model

Agent Orchestrator is a Windows desktop launch surface for local CLI AI agents.
It combines a visual workflow editor with concurrent pseudo-terminal (PTY)
sessions, but it deliberately does not own account credentials or managed
account routing.

## System boundary

```text
ai-agent-entrypoint                 Agent Orchestrator
(managed route authority)          (workflow and session UX)
        |                                      |
        | doctor --all --json                  | local env-only profiles
        | codex shell <alias>                  | native shell
        v                                      v
  routed child shell  <-----------  main-process SessionRegistry
                                               |
                                               v
                                  preload / validated IPC
                                               |
                                               v
                                  renderer workflow engine
```

`ai-agent-entrypoint` is the source of truth for managed Codex routes. This app
discovers those routes and launches through them. It never reads, rewrites, or
repairs the entrypoint manifest, and it never constructs managed account homes.

## Process boundaries

### Electron main process

`main.js` owns application lifecycle, the single-instance lock, the tray,
scheduler heartbeats, hibernate timers, persistence IPC, and shutdown cleanup.
The modules under `src/main/` keep security-sensitive behavior independently
testable:

- `agents.js` validates local profiles, discovers routed profiles, and builds
  launch specifications;
- `sessions.js` owns PTY creation, bounded output activity, process-tree
  termination, and public session metadata;
- `run-journal.js` owns protected run records, the rebuildable public-metadata
  index, stable cursor pages, and preview-first terminal-run retention;
- `store.js` provides atomic JSON persistence;
- `settings.js` normalizes machine-local preferences;
- `user-data.js` performs the one-time singular identity migration;
- `validate.js` constrains renderer-supplied IPC payloads.

### Preload boundary

`preload.js` exposes the intentionally small `contextBridge` API. The renderer
has no direct Node.js access. New privileged behavior belongs behind validated
IPC rather than in renderer code.

### Renderer

The renderer owns presentation, workflow editing, session tabs, and orchestration
decisions. It receives redacted session descriptions and opaque output
checkpoints; PTY buffers, environment values, resolved executables, and account
home paths stay in the main process.

## Profile assurance levels

| Level | Source | Guarantee |
|---|---|---|
| `L1-routed` | Route discovered from `ai-agent-entrypoint` | Launch uses the exact managed route and fails closed if it cannot resolve |
| `L2-env` | Local profile with state-home environment keys | Overrides affect only the child process; this is not claimed as isolation |
| `L0-native` | No account profile | Starts the machine's ordinary PowerShell environment |

Credential-shaped environment keys are rejected. Local profiles may select
state directories and flags, but secrets remain inside each CLI's own account
state and login flow.

## Session and workflow lifecycle

Each agent account receives its own PTY and renderer terminal. A workflow uses
opaque output checkpoints so `Wait for Agent` can observe output that arrives
between sending and registering a wait. Matching uses a bounded, main-process
buffer that is never persisted or included in session metadata.

Starting a workflow closes only sessions opened by the previous workflow run.
Manually opened sessions survive. Closing a session first requests graceful
termination, then force-kills that exact process tree after a grace period.
Application shutdown serializes native PTY exits to avoid ConPTY teardown races.

## Persistence and identity migration

App-owned data lives under `%APPDATA%/agent-orchestrator`:

- `agents.json` for local, non-secret profiles;
- `settings.json` for UI and window preferences;
- `run-journal/*.json` for one bounded protected record per run;
- `run-journal/.index/` for rebuildable public summaries and its crash-dirty
  marker (never ciphertext or result bodies);
- `workflows/*.json` for saved workflows.

On the first singular build, valid app-owned JSON is copied from the historical
plural directory through a staging directory and atomically promoted. Chromium
caches are excluded, invalid JSON remains in the backup, canonical data is
never overwritten or silently merged, and the historical directory is retained
for rollback.

Smoke and self-test modes use temporary user data and cannot touch production
settings or workflows.

## Verification layers

`npm run verify` is the checkpoint gate:

1. syntax-check application and documentation JavaScript;
2. validate field-guide links, anchors, and static security constraints;
3. run main-process unit tests;
4. run the Electron renderer self-test without real accounts or PTYs;
5. audit installed dependencies at moderate severity or above;
6. build the Windows package and inspect its identity, contents, privacy
   boundary, and unpacked native PTY module.

Real account login separation, routed in-session identity, and orphan-process
checks remain manual because automated tests must never touch account homes or
live credentials.
