# AGENTS.md — `agent-orchestrator`

Local contract for agents working in this repository. The workspace-root
`AGENTS.md` still applies and outranks this file for cross-project behavior.

## Mission

A desktop orchestrator for CLI AI agents: a block-based workflow editor, a
scheduler, and concurrent PTY sessions — one per agent account — with a
quick-send bar for ad-hoc prompts.

## Authority boundary: this app is a launch surface

`ai-agent-entrypoint` owns AI-agent account routing and child-environment
construction for this workspace. This project **consumes** it. It is a launch
surface in the same sense as PowerShell, WezTerm, and wmux — never an
independent source of account truth.

Concretely:

- Codex accounts are **discovered**, not declared here. `src/main/agents.js`
  runs `agent-entrypoint.ps1 codex doctor --all --json` and launches with
  `codex shell <alias>`.
- This app never reads, writes, or repairs the entrypoint manifest, and never
  constructs `CODEX_HOME` / `CODEX_SQLITE_HOME` itself.
- Changes here never authorize a write to `ai-agent-entrypoint`. Bringing
  Claude Code, Grok, or Antigravity under managed (L1) routing is an ADR in
  **that** repository, not a feature here.

## Assurance levels

Every session carries one, and the UI shows it. The wording matters: an
env-only session is weaker than a routed one and must never be described as
account-isolated.

| Level | Meaning | Launch |
|---|---|---|
| `L1-routed` | Codex alias resolved by ai-agent-entrypoint | `pwsh … agent-entrypoint.ps1 codex shell <alias>` |
| `L2-env` | Local profile setting a state-home variable on the child only | `powershell.exe` + env overrides |
| `L0-native` | No account selected | plain `powershell.exe` |

Rules the code enforces, with tests:

1. **Fail closed.** A routed profile that cannot be resolved throws. It never
   degrades to the native login — that would hand the wrong identity to
   whatever runs next. See `buildLaunchSpec` and its tests.
2. **No credentials.** Profile `env` accepts paths and flags only. Keys
   matching `SECRET_KEY_PATTERN` (`TOKEN`, `API_KEY`, `SECRET`, `PASSWORD`,
   `CREDENTIAL`, …) are rejected at save time with an explanation. Credentials
   belong in the agent's own state directory, reached by logging in inside the
   session.
3. **No secret-adjacent paths escape.** `codex doctor` output contains
   canonical account-home paths and the manifest path.
   `sanitizeDoctorReport` strips them, `SessionRegistry.describe` omits env
   and the resolved executable, and `describeProfile` returns env *keys* only.
   Nothing path-shaped reaches the renderer, the Log pane, a workflow file, or
   an export.
4. **Never say "isolated" about L2.** `ASSURANCE_LABEL` is the single source
   of that wording and a test asserts it.

## Layout

```text
main.js              Electron main: lifecycle, tray, scheduler heartbeat, hibernate, IPC
preload.js           contextBridge surface (the only renderer→main path)
src/main/            Main-process modules, CommonJS, unit-tested with node --test
  agents.js            profile model, entrypoint discovery, launch specs
  sessions.js          PTY session registry (spawn, route, kill-tree)
  codex-lifecycle.js    authenticated direct-agent turn-complete receipts
  session-continuation-core.js backend capability and authority routing
  orchestrator-pty-continuation-backend.js app-owned PTY adapter
  session-prompt-*.js  durable exact-session schedules, IPC, and scheduler
  scheduled-prompt-delivery.js guarded main-owned PTY prompt delivery
  settings.js          persisted preferences
  store.js             atomic JSON read/write
  validate.js          IPC payload validation
  promo-capture.js     inert real-renderer capture fixture + hashed receipts
  user-data.js         canonical/legacy user-data location and one-time migration
  task-host/           W2a desktop task host (docs/task-host.md): strict request
                       and loopback ingress, host lifecycle, adapters, worktree,
                       diff and check evidence, per-task windows, fixture run
preload-task.js      task-window bridge; main binds each call to its window
src/task-window.html one task's terminal, state, and Stop
src/js/              Renderer, ES modules, tested by the Electron self-test
  app.js               wiring: editor, toolbar, scheduler, workflow storage
  sessions.js          SessionManager: one xterm per session, tabs, quick-send
  agents-ui.js         agent account lists and the profile editor
  session-prompt-schedules.js exact-session schedule management UI
  engine.js            workflow execution, loops, block executors
  blocks.js            block registry and parameter rendering
  typing.js            human-paced typing, shared by engine and quick-send
  schedule.js          pure scheduling time math
  selftest.js          the renderer regression suite
scripts/
  workflow-tool.mjs    headless workflow authoring: validate, resolve accounts, install
tests/               node --test suites for src/main/
```

## Verification

```powershell
npm run check       # syntax-check every JS file under the source roots
npm test            # test:unit (node --test) + test:app (Electron self-test)
npm run smoke       # Electron startup/shutdown cleanup path
npm run verify:task-host   # task host end to end with the fixture provider only
npm run verify      # complete checkpoint gate: check, tests, audit, build/package verification
npm run workflow -- check <file>   # headless: validate a workflow, resolve its accounts, show its next trigger
npm run verify:direct-live -- --confirm-live  # opt-in real-provider acceptance; never automated
```

If the default account is usage-limited, a maintainer can select another
entry from the filtered authenticated-and-healthy list with
`--account-number=N`. This is test selection only and never changes product
delivery identity.

Add a case with the behavior. Pure logic goes in `src/main/` (CommonJS,
`tests/*.test.js`) or a pure `src/js/` module (`selftest.js`). Anything
touching a real PTY, a real account home, or a live login is a manual check —
never a test.

Manual checks that the suites cannot cover:

- two accounts of one agent keep separate logins across concurrent sessions;
- `codex doctor <alias>` inside a routed tab reports
  `activeHomeMatches=True activeSqliteMatches=True`;
- Stop mid-run leaves no orphaned `pwsh` / agent process;
- an unattended run's *effect* is verified at the provider, not in the Run
  Journal. A block reaching `completed` means the engine got past it. For a
  usage-window pre-warm that means reading the account's own fresh
  `window_minutes: 300` / `used_percent: 0` rate-limit block; a lane that came
  up onto a trust, login, or quota screen is alive, quiet, and did no work.
  Block-error detail lives in an encrypted journal proof and is readable only
  through protected-evidence inspection in the app.

## Desktop task host

The task host (`docs/task-host.md`) is off unless `taskHostEnabled` is set.
Keep these properties, each covered by a test:

- the ingress binds loopback only, authenticates with the token in the
  user-private discovery file, and accepts only the fixed typed operations —
  never a command line, executable, path, environment, or raw PTY input;
- admission is synchronous and the accepted record is durable before the ack;
  a restart reports unfinished launches and never respawns or re-adopts;
- the task window exists before the provider starts; closing it detaches;
- delivery, lifecycle receipt, AI-reported result, host-observed checks, and
  diff stay separate axes, and nothing reports success — only `needs-review`;
- a provider is admitted only when its adapter is qualified. Codex is not yet:
  qualifying it needs a separately authorized live turn, never a test;
- the fault-acceptance matrix in `docs/task-host.md` stays true: a new fault
  class gets a row and the test that proves it, or says why only W2b or a live
  turn can.

## Conventions

- English for code, comments, commits, and docs.
- The renderer owns the single, persistent set of process IPC listeners; the
  engine reacts through hooks rather than registering its own.
- Legacy IPC channels (`execute-command`, `send-input`, `kill-process`) are
  kept as wrappers over the session registry so workflows saved by earlier
  versions keep running. Don't break that without a migration.
- The canonical user-data directory is `agent-orchestrator`. The historical
  plural directory is a read-only migration source and rollback backup; never
  delete or silently merge it.
- A workflow run closes only the sessions a *previous run* opened. Sessions
  started by hand from the Agents panel are left alone.
- `mcps/` is a generated descriptor cache: not edited, reviewed, committed, or
  packaged.
