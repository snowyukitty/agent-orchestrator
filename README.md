# Agent Orchestrator

A desktop orchestrator application built with Electron, allowing users to automate interactions with command-line AI agents (such as Claude and Codex) through a drag-and-drop block interface and embedded pseudo-terminals (PTYs).

Several agents can run at once — one session per account — with a tab per
session, concurrent prompt broadcasts, and a signal-aware team barrier for
continuing only after every prompted workflow session is ready.

[![Agent Orchestrator key art: one routed workflow fans out across three agent lanes, converges at a join, and enters a protected journal boundary.](docs/assets/agent-orchestrator-key-art.png)](https://snowyukitty.github.io/agent-orchestrator/)

## Project Status

**Version**: 0.4.0 · **Platform**: Windows x64 · **Runtime**: Electron 43

Project references:

- [Getting started](docs/getting-started.md)
- [Architecture and safety model](docs/architecture.md)
- [Interrupted-run resume design](docs/resume-design.md)
- **[Interactive field guide — live](https://snowyukitty.github.io/agent-orchestrator/)** ([source](docs/README.md))
- [Getting two usage windows out of one morning](docs/five-hour-window.md)
- [Roadmap](docs/roadmap.md)
- [Website plan (future)](docs/website-plan.md)
- [Security policy](SECURITY.md)
- [Contribution and verification guide](CONTRIBUTING.md)

## Why schedule an agent? The 5-hour-window trick

Subscription CLI agents meter usage in a rolling 5-hour window that starts at
your **first message**. Schedule a trivial ping at 05:00 and the window spans
05:00–10:00 — so when you sit down at 09:00, a *fresh* window opens at 10:00
and one working morning spans two windows' worth of usage. The
**Usage-window pre-warm** template ships this pattern ready to run; see the
[full walkthrough](docs/five-hour-window.md) for tuning the ping time to your
burn rate and pre-warming several accounts at once with a single
`Send to All → Join Agents` stage.

## Field guide

The field guide turns the account model, first-run recovery path, team-stage
recipe, signal-aware joining, workflow integrity, and privacy boundaries into
a responsive, interactive walkthrough. It is plain HTML, CSS, and JavaScript:
no build step, backend, analytics, remote runtime assets, or account data
access.

Read it live at **<https://snowyukitty.github.io/agent-orchestrator/>**
(mirrored at <https://agent-orchestrator-855.pages.dev/>), or open
[`docs/index.html`](docs/README.md) directly in a browser.

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
- **Workflow and manual launches intentionally differ after routing.** The
  Agents panel leaves an L1 session at its account shell for interactive use.
  An `Agent Session` workflow block waits for that shell's readiness signal,
  invokes its session-local `codex` wrapper with a fixed trailing shell exit,
  then continues only after the configured settle period. Local workflow
  sessions likewise omit PowerShell's `-NoExit`, so their wrapper closes when
  the direct agent command returns; manual tabs retain their interactive shell.

Sessions appear as tabs above the terminal; all of them keep running and
buffering while hidden. The quick-send bar targets the current session, every
session of one agent, or all of them at once. Multi-session sends are typed
concurrently, so one slow typing target does not serialize the rest of the
broadcast.

### Release Notes

#### Unreleased (Indexed History + Deep Resume Preflight)

- **Cursor-paged run history**: **📖 Runs** reads a rebuildable public-metadata
  index and loads 50 entries at a time. Newer runs do not shift an issued
  cursor, and ordinary refreshes no longer parse every protected run record.
- **Preview-first retention**: choose a terminal-run count, an age limit, or
  both, then preview the exact match count before confirming deletion. Active
  runs are always excluded and no policy runs automatically.
- **Crash-safe derived state**: run files remain the source of truth. A durable
  dirty marker makes an interrupted index update rebuild from those records;
  corrupt indexes are reported and replaced without exposing result bodies,
  ciphertext, or machine-local paths.
- **Protected resume preflight, without replay**: interrupted-run detail first
  applies the cheap metadata gate, then offers an explicit local inspection.
  Main binds the request to the source revision, decrypts the captured snapshot,
  reuses the editor's exact versioned validator, proves the ordered visit trace
  (including nested-loop iteration paths), verifies protected result bindings,
  classifies reconstructable runtime state, and re-resolves referenced profiles.
  The renderer receives only redacted stage facts and never a prompt, command,
  path, profile ID, block ID, or execution capability.
- **Current-format evidence fixed at the contract boundary**: workflow format
  compatibility now belongs to the shared deep validator. The metadata gate no
  longer hard-codes v1 and incorrectly blocks the v2 documents the editor writes.
- **One-shot social key art**: the field guide and README now share a verified
  1731×909 browser-generated visual, with exact prompt and integrity sidecars.
  It depicts the same route → fan-out → join → protected-journal story the app
  actually implements; no video candidate crossed its human review gate.

#### v0.4.0 (Durable Run Journal + Result Handoff + Singular Identity)
- **One canonical name everywhere**: repository, npm package, checkout, AppData, documentation, and build artifact now use `agent-orchestrator` / **Agent Orchestrator**.
- **Safe user-data migration**: the first singular build validates and copies app-owned JSON (`settings.json`, local agent profiles, workflows, and any run journal) from the historical plural AppData directory through a staging directory, then atomically promotes it.
- **Rollback remains possible**: the historical AppData directory is retained as a read-only backup. Chromium caches are not migrated, and pre-existing data on both sides is never silently merged.
- **Test storage isolation**: smoke and Electron self-tests use a temporary user-data directory and cannot modify production settings or workflows.
- **Run Journal**: every run starts from an immutable workflow snapshot and
  records an ordered block-visit timeline with terminal states. Runs left
  active by an app restart become `interrupted`, providing durable evidence
  for a future resume design without claiming automatic resume today.
- **Explicit agent results**: `Send to Agent` can ask each targeted lane to
  publish one framed result. A named `Join Agents` block captures only those
  bounded payloads; ordinary PTY history is never copied into the journal.
- **Bounded downstream handoff**: a later `Send to Agent` block can attach a
  complete result bundle from an earlier named Join in the same run. Missing,
  partial, or truncated lanes stop the handoff by default, and results never
  interpolate into command, path, or environment fields. The opt-in control
  visibly warns that untrusted prose may still contain prompt injection.
- **Protected local storage**: workflow snapshots and explicit result bodies
  use Electron's OS-backed `safeStorage` when available. If it is unavailable,
  the current run remains usable in memory and is clearly non-durable; there is
  no plaintext fallback. Every record is hard-bounded, and an active record
  must reserve enough capacity for terminal recovery before it reaches disk.
- **Run inspection**: the new **📖 Runs** view lists run metadata, block visits,
  and explicit result summaries. A result body is decrypted only when selected.
- **Workflow-ready routed Codex**: an L1 `Agent Session` block waits for the
  routed account shell, invokes its session-local `codex` wrapper once with a
  fixed trailing `exit`, and fails clearly if readiness never arrives.
  Sessions opened by hand still stop at the account shell.
- **Bounded structured prompts**: generated result contracts and handoffs use
  bracketed-paste chunks with delimiter rejection and a post-paste output
  checkpoint. Every generated chunk and Enter crosses a separate main-process
  capability check. Shell profiles and composite custom commands cannot receive
  structured result input; ordinary workflow input and Quick Send remain
  human-paced.
- **Verified routed lifecycle**: an opt-in `npm run verify:routed --
  --confirm-live` check opens two real routed Codex accounts, verifies both
  `codex doctor` identity invariants, stops them, and asserts that no routed
  child processes remain. Its first run exposed and fixed a Windows tree-kill
  race by requesting `/T /F` before the outer ConPTY root can exit.
- **Renderer-loss containment**: production reload shortcuts are blocked. If
  the renderer nevertheless reloads or crashes, main drains every PTY,
  including now-invisible manual sessions, marks active journal runs
  `interrupted`, and admits no new session or journal mutation until cleanup
  succeeds.
- **Workflow format v2**: result references use stable block IDs and are
  validated as backward-only references to named Join blocks. The shipped
  **Parallel research → synthesis** template demonstrates the complete flow.

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
  serves stable cursor pages without copying ciphertext or result bodies.
  Interrupted-run detail derives a metadata-only evidence assessment; an
  explicit deep preflight can then validate protected snapshot/result bytes,
  prove the control prefix, classify runtime reconstruction, and re-resolve
  profiles while returning only redacted facts. Resume execution remains
  explicitly unavailable.
- **Explicit Journal Retention**: **📖 Runs** can preview and apply a count
  limit, an age limit, or both to terminal runs. Active runs are never selected,
  history is never pruned automatically, and a changed preview must be reviewed
  again before deletion.
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
- **Schedule Defaults**: Default and newly added Schedule blocks use the current local system time as their trigger time, with a one-click control to reset back to now. Loaded workflows preserve their saved schedule values.
- **Delayed Hibernate (power saving)**: A **💤 Hibernate PC** block arms a delayed system hibernate (`shutdown /h`) after a configurable delay — e.g. ping an agent, then hibernate to save power once it's done. The timer lives in the main process so it fires reliably even when the window is minimized to the tray or the screen is locked. While armed, a top banner shows a **live countdown** with a **✕ Cancel hibernate** button to force-abort it. Arming is non-blocking, so it can sit at the end of a workflow.
- **Timestamped Logs**: Every renderer Log line and every main-process console line is prefixed with an `HH:MM:SS.mmm` timestamp.
- **Custom App Icon**: A real snowflake icon (PNG + multi-size Windows `.ico`) is used for the window, taskbar, tray, and packaged `.exe` — no default Electron icon. Regenerate from `src/assets/icon-source.png` with `npm run icons`.

### Architecture Notes
- **Account routing is delegated, not reimplemented.** `ai-agent-entrypoint` owns the Codex account manifest and child-environment construction; this app discovers its aliases and launches through it. Bringing another CLI under managed routing is a decision for that repository. `AGENTS.md` records the boundary and the rules the code enforces.
- **The routed shell remains the launch boundary.** Main still launches
  `codex shell <alias>` and never constructs account homes. Only the workflow
  engine waits for the fixed account-shell readiness signal and enters the
  session-local `codex` wrapper with a trailing `exit`; opening the same profile
  from the Agents panel remains an interactive account shell.
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
  in-memory store when OS protection is unavailable.
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

### Known Issues & Unfinished Work
- **Results are explicit, not transcript capture**: ordinary `Wait for Agent`
  and readiness-only `Join Agents` still observe bounded activity without
  creating a result. Only the opt-in framed payload is journaled or handed off;
  raw PTY history remains outside workflow values and the journal.
- **Handoff framing is not prompt-injection isolation**: prior-stage result
  bodies are labelled untrusted and delimiter-escaped, but they still enter the
  downstream agent's user prompt. Treat web, issue, and other third-party
  content as hostile; restrict downstream tools or require human review before
  a sensitive stage. v0.4 does not enforce an agent-native data channel.
- **Journal evidence is not automatic resume**: interrupted runs and their
  completed visits now receive a deterministic metadata assessment: blocked,
  review required, or recorded boundary. Even a recorded boundary is not an
  executable plan; snapshot decryption, control-state reconstruction, runtime
  rebuilding, and profile re-resolution remain future preflight work. See the
  [accepted design](docs/resume-design.md). Workflows remain ordered block
  programs with structured Loop / End Loop pairs, not a general-purpose DAG.
- **Journal retention is explicit**: encrypted journal files are never pruned
  automatically. Individual deletion remains available, while preview-first
  retention can match terminal runs by count and/or age; active runs are always
  kept. Cursor-paged listing reads a derived metadata index. Startup recovery
  still validates retained source records so an unknowable active run fails
  containment closed, and a dirty or corrupt index is rebuilt from those files.
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

# Open the normal UI with disposable resume-evidence scenarios for visual QA
npm run visual

# Run both suites: main-process unit tests + the headless renderer self-test
npm test

# Opt-in live gate: two real routed accounts, doctor identity, Stop/orphans
npm run verify:routed -- --confirm-live

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
