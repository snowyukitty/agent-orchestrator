# Agent Orchestrator

A desktop orchestrator application built with Electron, allowing users to automate interactions with command-line AI agents (such as Claude and Codex) through a drag-and-drop block interface and embedded pseudo-terminals (PTYs).

Several agents can run at once — one session per account — with a tab per
session, concurrent prompt broadcasts, and a signal-aware team barrier for
continuing only after every prompted workflow session is ready.

## Project Status

**Version**: 0.4.0 · **Platform**: Windows x64 · **Runtime**: Electron 43

Project references:

- [Architecture and safety model](docs/architecture.md)
- [Interactive field guide](docs/README.md)
- [Security policy](SECURITY.md)
- [Contribution and verification guide](CONTRIBUTING.md)

## Field guide

The [`docs/`](docs/README.md) field guide turns the account model, first-run
recovery path, team-stage recipe, signal-aware joining, workflow integrity, and
privacy boundaries into a responsive, interactive walkthrough. It is plain
HTML, CSS, and JavaScript: no build step, backend, analytics, remote runtime
assets, or account data access. Open `docs/index.html` directly in a browser.

## Multi-account agent control

Each session is "which agent, as which account", and the guarantee behind that
pairing is stated rather than implied:

| Level | What it means | How a session starts |
|---|---|---|
| **L1 · routed** | A Codex alias owned by [`ai-agent-entrypoint`](../ai-agent-entrypoint), which builds the child environment | `agent-entrypoint.ps1 codex shell <alias>` |
| **L2 · env-only** | A local profile that points the agent at its own state directory (`CLAUDE_CONFIG_DIR`, `GROK_HOME`, …) for that child process | `powershell.exe` with env overrides |
| **L0 · native** | No account selected | plain `powershell.exe` |

- **Routed accounts are discovered, not configured here.** The app asks
  `ai-agent-entrypoint` for its Codex aliases and launches through it. This app
  never reads or writes that manifest and is not a source of account truth.
- **Local profiles cover the CLIs nobody manages yet.** Claude Code, Grok, and
  Gemini have no managed routing layer, so a profile gives each account its own
  state directory and you log in once inside that session. This is a weaker
  guarantee than a routed account, and the UI says so — it is never described
  as isolation.
- **No credentials are stored by this app.** Profile environments accept paths
  and flags only; a key that looks like a token, API key, or password is
  rejected with an explanation. Discovery output containing canonical account
  paths is stripped before it reaches the UI, the log, or an exported workflow.
- **Routed launches fail closed.** If an alias cannot be resolved, the session
  refuses to start rather than quietly falling back to the native login.

Sessions appear as tabs above the terminal; all of them keep running and
buffering while hidden. The quick-send bar targets the current session, every
session of one agent, or all of them at once. Multi-session sends are typed
concurrently, so one slow typing target does not serialize the rest of the
broadcast.

### Release Notes

#### v0.4.0 (singular identity migration)
- **One canonical name everywhere**: repository, npm package, checkout, AppData, documentation, and build artifact now use `agent-orchestrator` / **Agent Orchestrator**.
- **Safe user-data migration**: the first singular build validates and copies app-owned JSON (`settings.json`, local agent profiles, workflows, and any run journal) from the historical plural AppData directory through a staging directory, then atomically promotes it.
- **Rollback remains possible**: the historical AppData directory is retained as a read-only backup. Chromium caches are not migrated, and pre-existing data on both sides is never silently merged.
- **Test storage isolation**: smoke and Electron self-tests use a temporary user-data directory and cannot modify production settings or workflows.

#### v0.3.0 (Signal-aware Team Stages)
- **New `◇ Join Agents` block**: one shared barrier waits concurrently for every
  workflow-owned agent session that received a prompt since the preceding
  `Wait for Agent` or `Join Agents`. Live `N / M ready` progress makes the team
  stage visible without turning it into a fixed delay.
- **Fail-safe stage boundaries**: timeout or premature session exit stops
  downstream execution by default and leaves the run's remaining sessions open
  for inspection. Choose **Continue with warning** only when later blocks are
  safe to run with an incomplete team.
- **Real fan-out targeting**: `Send to Agent` can target **All workflow
  agents**, and both multi-target workflow sends and quick-send broadcasts type
  into their target sessions concurrently.
- **Immutable run snapshots**: a manual or scheduled run executes the workflow
  state captured when that run begins. Editing blocks during a run changes the
  next run, not the active one.
- **Non-destructive scheduling**: a due saved workflow runs from its own
  snapshot without loading it into the editor, replacing the workflow being
  edited, or clearing that workflow's dirty state. Its persisted copy remains
  the schedule authority while an unsaved draft with the same id is open.
- **Versioned workflow files**: saved workflows carry an explicit format
  version. A workflow from a newer format, malformed structure, unknown block,
  or unrecognized field now fails visibly instead of silently dropping data.
- **Runtime trust gate**: the renderer is sandboxed, unexpected navigation and
  child views are denied, and privileged IPC accepts only the app's expected
  top-level local frame. The self-test bridge is absent from production.
- **Fail-closed account identity**: local profiles cannot claim the routed
  `codex` namespace or set Codex state-home variables. Routed discovery is
  cached against the exact entrypoint source and revalidated before launch.
- **Race-safe lifecycle**: shutdown closes session admission and drains every
  PTY termination before Electron exits. Duplicate or retiring session IDs are
  rejected so a stale exit cannot remove a replacement session.
- **Scope is deliberate**: joining observes readiness signals; it does not
  collect agent answers into block outputs, persist PTY output, provide a run
  journal or resume, or turn the linear block editor into a general DAG.

#### v0.2.0 (multi-account agents)
- **Multiple concurrent agent sessions**, one per account, each with its own terminal tab, status dot, and assurance badge. Background sessions keep rendering, so nothing is lost while you watch another one.
- **Agent accounts panel** listing routed Codex accounts discovered from `ai-agent-entrypoint` alongside local env-only profiles you manage here. Click one to open a session.
- **Quick-send bar** for ad-hoc prompts to one session, all sessions of one agent, or every session — using the same human-paced typing as the workflow engine.
- **New blocks**: `🤖 Agent Session` opens an account, `📨 Send to Agent` prompts a specific one, and `👂 Wait for Agent` continues when new PTY output goes idle or contains chosen text. Its timeout is a logged backstop, not the normal synchronization mechanism. Existing workflows keep working unchanged.
- **Output-aware waiting lives beside the PTY.** `SessionRegistry` keeps a bounded, main-process-only activity buffer; workflow sends take an opaque sequence checkpoint so a fast reply cannot disappear between blocks. Buffered output never crosses into workflow JSON or session metadata.
- **Routed account source setting**: the Agents panel can browse, save, or clear the machine-local `ai-agent-entrypoint` checkout path. A blank value keeps sibling auto-detection, so a machine without the sibling checkout now has an in-app recovery path.
- **A workflow run no longer kills every process.** It closes only the sessions the previous run opened; sessions you started by hand are left alone.
- **Killing a session kills its process tree** (SIGTERM, then `taskkill /T` after a grace window), so a routed `pwsh` with an agent child leaves nothing behind. Bulk closes and app shutdown serialize ConPTY exits to avoid a native `node-pty` baton-removal race.
- **Validated IPC.** Payloads are type- and range-checked; `send-input` previously threw on any non-string.
- **Persisted settings**: terminal theme, window geometry, and panel sizes survive a restart.
- **Real test suites**: `npm run test:unit` (`node --test` over the main-process modules) plus the Electron self-test, now covering typing, quick-send targeting, launch specs, the credential boundary, and the path-leak boundary.
- Fixed: declaration-order fragility in the panel resizers, two competing Escape handlers, and `keypress` "enter" sending LF where the input block sent CR.
- Replaced the deprecated `xterm` / `xterm-addon-fit` packages with `@xterm/xterm` and `@xterm/addon-fit`; the title-bar version is read from `package.json` instead of hardcoded.

#### v0.1.9 (review & fixes)
- **Fixed: opening a saved workflow disarmed its schedule.** Opening or importing a workflow wrongly marked its next scheduled occurrence as already-fired (a suppression only meant for freshly-created/template schedules that default to "now"). Saved workflows with a future schedule now stay armed when opened.
- **Escape closes any open modal** (Templates / My Workflows / Schedules), not just the Schedules dialog.
- **Robust delete detection**: deleting the on-disk copy of the currently-open workflow now flags it unsaved even when its id needed sanitizing for the filename.

#### v0.1.8
- **My Workflows manager**: The **📂 Load** button now opens an in-app **My Workflows** browser that lists every saved workflow (with block count and any schedule time), instead of a bare file dialog. Click a row to open it, delete one from disk with its 🗑️ button, start a blank one with **＋ New**, or pull a `.json` from anywhere with **📥 Import file…**. The schedule board stays in sync after deletes.
- **Unsaved-changes safety**: An amber dot appears next to the workflow name whenever there are unsaved edits, and switching away (opening another workflow, New, a template, or importing a file) now asks before discarding them. Saving, loading, and scheduled runs clear the flag.

#### v0.1.7
- **Testable scheduling core**: The trigger/countdown time math (next-run for `once`/`cron`, the due-window check, and countdown formatting) is extracted into a pure, dependency-free `schedule.js` that takes `now` as an argument. Behavior is unchanged, but it's now deterministically covered by the headless self-test — `once` returns the absolute time, `cron` rolls forward exactly 24h once today's window passes, the grace window fires late-but-not-stale ticks, and countdown formatting clamps/pads/prefixes days. Scheduling regressions now fail `npm test`.

#### v0.1.6
- **Live loop progress**: While a workflow runs, the active Loop block shows a live iteration badge (e.g. `2/3`) that turns green when the loop finishes, and the status line reads `🔄 Loop 2/3`. Driven by a new `onLoopIteration` engine hook, covered by the self-test.
- **Loop grouping visuals**: Loop / End Loop markers share a tinted background so the pair reads as brackets, and the connector lines between nested blocks are indented to form a continuous nesting rail down the loop body.
- **Drop-to-position**: Dragging a block from the palette now inserts it where you drop it (a glowing insertion line previews the spot) instead of always appending to the end. Dropping a Loop still seeds its matching End Loop at that position.

#### v0.1.5
- **Loop structure validation in the editor**: Unbalanced loop markers (a Loop with no End Loop, or a stray End Loop) are now flagged inline with a dashed warning outline and an explanatory tooltip, plus a summary banner above the block list. The run still proceeds safely (the engine skips broken markers) — the warnings just make the structure obvious while editing.
- **Self-test coverage**: The headless `npm test` now also verifies every shipped template is structurally sound (balanced loops) and checks the unmatched-marker index reporting, so a malformed template or loop-analysis regression fails the build.

#### v0.1.4
- **Real Loop block**: The `loop` block now actually repeats. It pairs with a new **End Loop** (`loopEnd`) block — every block between a Loop and its matching End Loop runs `count` times. Adding a Loop auto-seeds its End Loop, nested loops are supported, and the loop body is visually indented by nesting depth. Unbalanced markers (a Loop with no End, or a stray End) are skipped with a warning instead of breaking the run.
- **Workflow Templates**: A new **🧩 Templates** picker offers pre-built starting points (Claude Auto Session, a Loop example, a nightly run + hibernate, and a quick command). Selecting one replaces the current workflow; directory/time placeholders are filled with sensible local defaults and never auto-fire on load.
- **Headless engine self-test**: `npm test` (`electron . --self-test`) runs the engine's loop control flow in a dry-run mode with no real PTYs, asserts simple/nested/zero-count/unbalanced loop behavior plus the pure loop helpers, and exits non-zero on any regression.

#### v0.1.3
- Added a one-click current-time control beside Schedule datetime fields.
- Marked default/current-minute Schedule targets as handled in the countdown board so they do not appear as immediately due.
- Preserved manual scheduling behavior: editing a Schedule to a future time still arms it normally.

#### v0.1.2
- Default/demo Schedule blocks now display the current local system time immediately.
- Newly-created Schedule blocks still suppress the just-created current-minute target once, preventing accidental immediate auto-runs while keeping future edits schedulable.

#### v0.1.1
- Hardened app shutdown: quitting from the tray now stops the scheduler heartbeat, detaches power monitor listeners, cancels pending hibernate timers, releases the keep-awake blocker, tears down the tray, and terminates tracked PTYs through one idempotent cleanup path.
- Guarded main-to-renderer IPC sends so process output, process exit, sleep-state, and scheduler heartbeat events do not throw while the renderer is closing.
- New Schedule blocks now default their `datetime-local` value to the current local system time at the moment the block is created.
- Fixed a startup Content Security Policy console error by explicitly allowing local `data:` images used by CSS controls.
- Added renderer-side IPC rejection handling for terminal input and resize calls during process teardown.
- Prevented overlapping scheduled workflow refreshes when renderer ticks and main-process heartbeat ticks arrive close together.
- Added `npm run smoke` for a quick Electron startup/shutdown smoke test that exercises the normal quit cleanup path.
- Ignored local `mcps/` tool descriptor caches in Git and packaged builds.

### Completed Features
- **Multi-Account Agent Sessions**: Several agents run at once, one PTY per account, each with a terminal tab carrying its agent, account name, live status dot, and assurance badge. Hidden sessions keep running and buffering. Routed Codex accounts come from `ai-agent-entrypoint`; local env-only profiles cover the CLIs it does not manage yet. See "Multi-account agent control" above.
- **Quick Send**: A prompt bar under the terminal fires an ad-hoc command at the current session, every session of one agent, or all of them. Broadcast targets are typed concurrently using the same human-paced typing as the workflow engine.
- **Visual Workflow Builder**: Users can construct automation workflows by combining blocks (Schedule, Directory, Agent Session, Send to Agent, Wait for Agent, Join Agents, Command, Wait, Send Input, Keypress, Loop / End Loop, Log, Hibernate PC).
- **Signal-Aware Team Stages**: `Send to Agent` can prompt one session or all workflow-owned agent sessions. A single `Join Agents` barrier then tracks every workflow-owned session prompted since the previous wait/join and reports live `N / M ready` progress. Timeout and premature exit stop downstream blocks by default without closing the remaining sessions; an explicit continue policy keeps the warning-and-continue behavior when that is intentional.
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
- **Process Cleanup**: Starting a run closes only the sessions the *previous* run opened — sessions you started by hand are left alone. Aborting kills every PTY the run spawned, and each kill escalates from SIGTERM to a whole-tree `taskkill` after a grace window, so a routed shell with an agent child leaves nothing behind.
- **Single-Instance Guard**: Electron's single-instance lock prevents duplicate tray apps, duplicate scheduler ticks, and conflicting hibernate timers. Launching a second instance focuses the existing window instead.
- **Input Simulation**: Simulates human typing speeds for text input blocks to avoid characters being swallowed by async CLI UI redrawing loops.
- **Scheduled Countdown Board**: A **⏱ Schedules** panel lists every scheduled workflow (saved on disk + the one being edited), each with a **live countdown** to its next run. The bottom toolbar always shows "next in HH:MM:SS". Due `once` jobs auto-run at their time; `cron` mode repeats daily. A due saved workflow executes independently of the current editor state.
- **Schedule Defaults**: Default and newly added Schedule blocks use the current local system time as their trigger time, with a one-click control to reset back to now. Loaded workflows preserve their saved schedule values.
- **Delayed Hibernate (power saving)**: A **💤 Hibernate PC** block arms a delayed system hibernate (`shutdown /h`) after a configurable delay — e.g. ping an agent, then hibernate to save power once it's done. The timer lives in the main process so it fires reliably even when the window is minimized to the tray or the screen is locked. While armed, a top banner shows a **live countdown** with a **✕ Cancel hibernate** button to force-abort it. Arming is non-blocking, so it can sit at the end of a workflow.
- **Timestamped Logs**: Every renderer Log line and every main-process console line is prefixed with an `HH:MM:SS.mmm` timestamp.
- **Custom App Icon**: A real snowflake icon (PNG + multi-size Windows `.ico`) is used for the window, taskbar, tray, and packaged `.exe` — no default Electron icon. Regenerate from `src/assets/icon-source.png` with `npm run icons`.

### Architecture Notes
- **Account routing is delegated, not reimplemented.** `ai-agent-entrypoint` owns the Codex account manifest and child-environment construction; this app discovers its aliases and launches through it. Bringing another CLI under managed routing is a decision for that repository. `AGENTS.md` records the boundary and the rules the code enforces.
- **Sessions are first class.** `src/main/sessions.js` holds a registry of PTYs, each tagged with its profile and assurance level. It also owns output activity checkpoints and bounded matching buffers used by `Wait for Agent` and team readiness joins. Its `describe()` deliberately omits env, cwd, the resolved executable, and all PTY text, because a routed session's environment and output can contain machine-local paths.
- **Runs are isolated from editor mutation.** The engine receives an immutable
  workflow snapshot and tracks which workflow-owned sessions were prompted in
  the current team stage. Manual edits and scheduled workflow loading affect
  neither the active snapshot nor each other's editor state.
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
  checks on every privileged IPC route.
- `mcps/` is treated as a local tool descriptor cache. It is not part of the app source and is ignored by Git and packaged builds.
- Pure, side-effect-free logic is factored into dependency-free modules so it can be unit-tested deterministically: loop structure (`matchingLoopEnd` / `analyzeLoops` in `engine.js`) and scheduling time math (`schedule.js`). The headless `npm test` (`electron . --self-test`) exercises these with no real PTYs and exits non-zero on regression.

### Known Issues & Unfinished Work
- **Readiness is not result capture**: `Wait for Agent` and `Join Agents` observe
  bounded, in-memory PTY activity for idle or literal markers. The app does not
  turn an agent's answer into a downstream block value, persist terminal
  output, or merge one agent's response into another agent's prompt.
- **Runs are snapshots, not resumable journals**: Editing cannot alter the
  active run, but there is no persisted run journal, crash resume, or
  general-purpose DAG execution. Workflows remain ordered block programs with
  structured Loop / End Loop pairs.
- **CLI-specific prompt controls**: Highly interactive CLIs can consume the first Enter, so typed submission still uses a deliberate double-tap. When a workflow needs proof of a semantic response, configure `Wait for Agent` or `Join Agents` with **Output contains**; idle-only completion observes silence, not success.
- **Terminal Layout Shifts**: Xterm dimensions may occasionally desync with the internal PTY dimensions if the window is resized very rapidly while a process is initializing.

## Development

```bash
# Install dependencies
npm install

# Run locally
npm start

# Syntax-check every JavaScript file under the source roots
npm run check

# Run a quick Electron startup/shutdown smoke test
npm run smoke

# Run both suites: main-process unit tests + the headless renderer self-test
npm test

# Either half on its own
npm run test:unit   # node --test over src/main/
npm run test:app    # electron . --self-test

# Regenerate icon assets (icon.png + icon.ico) from src/assets/icon-source.png
npm run icons

# Build for Windows x64, then verify package identity and privacy
npm run build

# Run the complete checkpoint gate used by CI
npm run verify
```
