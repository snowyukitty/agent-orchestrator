# Feature reference

What v0.4.0 actually ships, and the implementation decisions behind it. The
[README](../README.md) shows the product in three frames; this page is the long
form for people deciding whether a specific behavior exists.

- Release history: [`CHANGELOG.md`](../CHANGELOG.md)
- What it deliberately does not do: [`limitations.md`](limitations.md)
- Process, trust, and persistence model: [`architecture.md`](architecture.md)

## Shipped features

- **Multi-Account Agent Sessions**: Several agents run at once, one PTY per account, each with a terminal tab carrying its agent, account name, live status dot, and assurance badge. Hidden sessions keep running and buffering. Routed Codex accounts come from `ai-agent-entrypoint`; local env-only profiles cover the CLIs it does not manage yet. See "Multi-account agent control" above.
- **Quick Send**: A prompt bar under the terminal fires an ad-hoc command at the current session, every session of one agent, or all of them. Broadcast targets are typed concurrently using the same human-paced typing as the workflow engine.
- **Visual Workflow Builder**: Users can construct automation workflows by combining blocks (Schedule, Directory, Agent Session, Send to Agent, Wait for Agent, Join Agents, Command, Wait, Send Input, Keypress, Loop / End Loop, Log, Hibernate PC).
- **Signal-Aware Team Stages**: `Send to Agent` can prompt one session or all workflow-owned agent sessions. A single `Join Agents` barrier then tracks every workflow-owned session prompted since the previous wait/join and reports live `N / M ready` progress. Timeout and premature exit stop downstream blocks by default without closing the remaining sessions; an explicit continue policy keeps the warning-and-continue behavior when that is intentional.
- **Explicit Result Handoff**: A Send block can issue a unique bounded result
  contract to every targeted lane. A named Join captures complete framed
  payloads in stable lane order; a later Send may attach that bundle as clearly
  labelled untrusted reference data. Partial, empty, or truncated bundles do
  not reach a downstream agent by default.
- **Durable Run Journal**: **📖 Runs** shows immutable workflow identity,
  trigger, ordered block visits, terminal status, and explicit result metadata.
  Snapshots and result bodies are protected with Electron `safeStorage`; bodies
  are fetched and decrypted only on request. No-encryption environments fall
  back to bounded memory, never plaintext files. A rebuildable metadata index
  serves stable cursor pages without copying ciphertext or result bodies. An
  explicit, idempotent v1-to-v2 migration preserves a rollback record and adds
  public lineage identities, protected visit-bound control checkpoints, and
  auditable human boundary dispositions.
  Interrupted-run detail derives a metadata-only evidence assessment; an
  explicit deep preflight can then validate protected snapshot/result bytes,
  prove the control prefix, classify runtime reconstruction, and re-resolve
  profiles while returning only redacted facts. Resume execution remains
  explicitly unavailable.
- **Explicit Journal Retention**: **📖 Runs** can preview and apply a count
  limit, an age limit, or both to terminal runs. Active runs are never selected,
  history is never pruned automatically, and a changed preview must be reviewed
  again before deletion. The opaque preview token expires after ten minutes and
  does not survive an app restart. Destructive selection revalidates canonical
  run files, not the rebuildable index. Once confirmed, path-free durable intent
  and a bounded receipt history make multi-record deletion idempotently
  recoverable and replayable after a process crash. Individual deletion is also
  recoverable. Retained descendants protect every lineage ancestor.
- **Loops**: A **Loop** block repeats every block up to its matching **End Loop** a configurable number of times. Nested loops are supported and the loop body is indented (with a continuous nesting rail) so the structure is readable at a glance. A live iteration badge (`2/3`) tracks progress during a run, unbalanced loop markers are flagged inline (dashed outline + tooltip) and summarized in a banner, and the engine still runs safely by skipping broken markers.
- **Drag-to-Position Editing**: Blocks dragged from the palette land exactly where they are dropped (with a live insertion-line preview); they can still be reordered afterward by their drag handles.
- **Templates**: A **🧩 Templates** picker provides pre-built workflows (including a Loop example) as one-click starting points.
- **Persistent Storage**: Versioned workflows are saved to and loaded from `%APPDATA%/agent-orchestrator/workflows/`, with atomic writes and resilient listing so one malformed workflow file does not break the whole schedule list. Future formats, malformed structures, unknown block types, and unrecognized fields are rejected with a visible error rather than partially loaded. The first v0.4 launch copies valid app-owned data from the historical plural directory and leaves that source intact as a rollback backup.
- **Workflow Library**: A **📂 My Workflows** browser lists every saved workflow in-app — open, delete, start a new blank one, or import a `.json` from disk. An unsaved-changes indicator and a discard prompt prevent accidentally losing edits when switching between workflows. Runs use immutable snapshots, and a scheduled workflow runs without replacing or cleaning the workflow currently in the editor.
- **Automated PTY Execution**: The engine executes terminal applications in the background using `node-pty` with modern Windows `ConPTY` enabled, providing full ANSI color support and proper terminal layout.
- **Dual-Pane Output**: The UI features a horizontally resizable right panel split into:
  - **Log**: A clear visual timeline of automation steps and system messages.
  - **Terminal**: A tabbed stack of fully interactive `xterm.js` terminals, one per live session.
- **Theme Switcher**: Users can toggle between three terminal themes (PowerShell Blue, Hacker Dark, and Light Mode). The choice is remembered across restarts, along with window geometry and panel sizes.
- **Interactive Terminal**: Terminals stay fully interactive. Keystrokes are forwarded via IPC to the PTY behind the visible tab.
- **Process Cleanup**: Starting a run closes only the sessions the *previous* run opened — sessions you started by hand are left alone. Aborting kills every PTY the run spawned. On Windows it requests a whole-tree `taskkill /T /F` while the outer ConPTY root still exists, with the existing escalation path retained as fallback, so routed children cannot escape by reparenting.
- **Single-Instance Guard**: Electron's single-instance lock prevents duplicate tray apps, duplicate scheduler ticks, and conflicting hibernate timers. Launching a second instance focuses the existing window instead.
- **Input Simulation**: Ordinary workflow input and Quick Send use human-paced typing so async CLI redraw loops do not swallow characters. Generated result contracts and handoffs use bounded bracketed-paste chunks so large structured prompts do not take minutes to submit.
- **Scheduled Countdown Board**: A **⏱ Schedules** panel lists every scheduled workflow (saved on disk + the one being edited), each with a **live countdown** to its next run. The bottom toolbar always shows "next in HH:MM:SS". Due `once` jobs auto-run at their time; `cron` mode repeats daily. A due saved workflow executes independently of the current editor state.
- **Durable Exact-Session Prompts**: The same panel has a separate
  **Continue this exact live session** operation for one lifecycle-confirmed
  routed Codex direct-agent PTY. It supports one-shot local times, optional
  repeating intervals, +1h/+5h/+24h shortcuts, and list/pause/resume/delete
  controls across every session. A random incarnation binds each row to the
  original PTY, while a durable backend namespace prevents same-named sessions
  in other transports from becoming fallbacks. Restart, exit, identity drift, or reuse disables it as
  `session_changed` instead of retargeting or launching work. Prompt text is
  app-owned local plaintext and must not contain secrets. See the
  [delivery contract](session-prompt-scheduling.md) and
  [backend contract](session-continuation-backends.md).
- **Schedule Defaults**: Default and newly added Schedule blocks use the current local system time as their trigger time, with a one-click control to reset back to now. Loaded workflows preserve their saved schedule values.
- **Delayed Hibernate (power saving)**: A **💤 Hibernate PC** block arms a delayed system hibernate (`shutdown /h`) after a configurable delay — e.g. ping an agent, then hibernate to save power once it's done. The timer lives in the main process so it fires reliably even when the window is minimized to the tray or the screen is locked. While armed, a top banner shows a **live countdown** with a **✕ Cancel hibernate** button to force-abort it. Arming is non-blocking, so it can sit at the end of a workflow.
- **Timestamped Logs**: Every renderer Log line and every main-process console line is prefixed with an `HH:MM:SS.mmm` timestamp.
- **Custom App Icon**: A real snowflake icon (PNG + multi-size Windows `.ico`) is used for the window, taskbar, tray, and packaged `.exe` — no default Electron icon. Regenerate from `src/assets/icon-source.png` with `npm run icons`.

## Implementation notes

- **Account routing is delegated, not reimplemented.** `ai-agent-entrypoint` owns the Codex account manifest and child-environment construction; this app discovers its aliases and launches through it. Bringing another CLI under managed routing is a decision for that repository. `AGENTS.md` records the boundary and the rules the code enforces.
- **Routed shells and direct agents are different modes.** An account-shell
  button still launches `codex shell <alias>`. Workflow sessions keep their
  existing shell/bootstrap contract. The explicit **Direct agent** button uses
  ai-agent-entrypoint's public `target run codex:<alias> -- ...` contract so
  provider exit also ends the PTY instead of returning to a shell. Main never
  constructs account homes in either mode. Only direct mode can become eligible
  for exact-session prompts, and only after a capability-validated Codex
  turn-complete notification. Direct mode also removes the private lifecycle
  token from ordinary Codex shell-tool environments.
- **Scheduled delivery is a main-process capability.** The renderer manages
  rows through validated IPC but owns no due timer or PTY write. Main serializes
  store mutations, persists a unique delivery claim, and proves exact
  incarnation/profile/agent identity, provider-confirmed idle state, quiet
  time, and input revision. It sends one sanitized bracketed paste, revalidates,
  then sends exactly one Enter. A possible partial write consumes that
  occurrence; it is never blindly replayed.
- **Continuation backends preserve authority.** A provider-neutral main-process
  core routes a schedule only to its durable backend id. An adapter is eligible
  only when it proves exact identity, agent readiness, protected input, and
  claim-bound revalidation. Missing or partial adapters remain unavailable;
  the core never falls back to another terminal with the same session id.
- **Structured result input is a main-owned capability.** Main grants it only
  to routed Codex workflow sessions and local workflow sessions whose profile
  is one conservative direct invocation of its declared agent. Shell profiles,
  manual tabs, and PowerShell commands containing control syntax fail closed.
- **Sessions are first class.** `src/main/sessions.js` holds a registry of PTYs, each tagged with its profile, assurance level, and structured-result capability. It also owns output activity checkpoints and bounded matching buffers used by `Wait for Agent` and team readiness joins. Its `describe()` deliberately omits env, cwd, the resolved executable, and all PTY text, because a routed session's environment and output can contain machine-local paths.
- **Runs are isolated from editor mutation.** The engine receives an immutable
  workflow snapshot and tracks which workflow-owned sessions were prompted in
  the current team stage. Manual edits and scheduled workflow loading affect
  neither the active snapshot nor each other's editor state.
- **Journal metadata and bodies have different exposure.** Main-owned run,
  visit, result, revision, and event IDs are persisted atomically and may be
  listed in the renderer. Snapshot/result plaintext is never placed in those
  public objects: it is independently encrypted, or held only in a bounded
  in-memory store when OS protection is unavailable. Control checkpoints are
  stricter: their narrow state schema is always context-bound and encrypted,
  with no memory or plaintext fallback.
- **Workflow loading is schema-aware.** The pure workflow-document module
  validates the format version and every block type before normalizing known
  parameters. Unsupported future data is reported instead of being normalized
  away.
- **Main-process modules are CommonJS and unit-tested** (`src/main/`, `tests/*.test.js`); renderer modules are ES modules covered by the Electron self-test. Pure logic lives in whichever half can test it deterministically.
- The renderer (`app.js`) owns the single, persistent set of process IPC listeners (output/exit/error); the engine reacts via `handleProcessExit` / `handleProcessError` hooks rather than registering its own listeners. This avoids the terminal listener being torn down between runs and prevents double-rendered output.
- Main-process lifecycle cleanup is centralized and idempotent. The first
  `before-quit` closes session admission, tears down non-process state, and
  prevents exit while PTY terminations drain sequentially; only the second
  internally requested quit may proceed.
- The BrowserWindow is a narrow local capability boundary: sandboxed preload,
  denied unexpected navigation and child views, and top-level renderer identity
  checks on every privileged IPC route. A cross-document load immediately
  invalidates the old renderer's session/journal authority; the replacement
  document is admitted only after navigation commits and containment has
  drained hidden PTYs and recovered active journal records.
- `mcps/` is treated as a local tool descriptor cache. It is not part of the app source and is ignored by Git and packaged builds.
- Pure, side-effect-free logic is factored into dependency-free modules so it can be unit-tested deterministically: loop structure (`matchingLoopEnd` / `analyzeLoops` in `engine.js`) and scheduling time math (`schedule.js`). The headless `npm test` (`electron . --self-test`) exercises these with no real PTYs and exits non-zero on regression.
