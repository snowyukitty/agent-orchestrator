# Changelog

Every notable change to Agent Orchestrator, newest first. The README keeps only
the product story; this file keeps the history.

## Unreleased (Indexed History + Deep Resume Preflight)

- **Proof-first repository front page**: the README now opens on the real
  editor capture and reads as a product page. The 180-line release history moved
  to this file, the feature reference to `docs/features.md`, and the stated
  boundaries to `docs/limitations.md`.
- **Retired the conceptual key art**: the README hero, `og:image`, and Twitter
  card are the authentic `01-workflow-editor.png` capture. The AI-generated key
  art and its provenance sidecars were deleted; `npm run check` now fails if
  either surface drifts away from the verified frame.
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
  actually implements.
- **Authentic product capture**: `npm run promo:capture --
  --promo-output=docs/assets/promo` now creates three deterministic 1600×1000
  frames from the real renderer using an inert fixture. It starts no account,
  agent, or PTY, reads no production data, stamps every frame with that
  disclosure, and writes a hashed manifest checked by the documentation gate.
- **Trilingual promo masters, still gated**: the product overview, five-hour
  explainer, and new 50.6-second functional hero use clean English spoken
  masters with selectable English (default), Japanese, and Traditional Chinese
  SRT/VTT tracks. The functional hero replaces a rejected generic-office
  candidate with editor → Join → explicit handoff → protected-journal proof.
  All remain local, unrendered, and unpublished until a human passes
  pronunciation, pacing, readability, and every subtitle track.

## v0.4.0 (Durable Run Journal + Result Handoff + Singular Identity)
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

## v0.3.0 (Signal-aware Team Stages)
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

## v0.2.0 (multi-account agents)
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

## v0.1.9 (review & fixes)
- **Fixed: opening a saved workflow disarmed its schedule.** Opening or importing a workflow wrongly marked its next scheduled occurrence as already-fired (a suppression only meant for freshly-created/template schedules that default to "now"). Saved workflows with a future schedule now stay armed when opened.
- **Escape closes any open modal** (Templates / My Workflows / Schedules), not just the Schedules dialog.
- **Robust delete detection**: deleting the on-disk copy of the currently-open workflow now flags it unsaved even when its id needed sanitizing for the filename.

## v0.1.8
- **My Workflows manager**: The **📂 Load** button now opens an in-app **My Workflows** browser that lists every saved workflow (with block count and any schedule time), instead of a bare file dialog. Click a row to open it, delete one from disk with its 🗑️ button, start a blank one with **＋ New**, or pull a `.json` from anywhere with **📥 Import file…**. The schedule board stays in sync after deletes.
- **Unsaved-changes safety**: An amber dot appears next to the workflow name whenever there are unsaved edits, and switching away (opening another workflow, New, a template, or importing a file) now asks before discarding them. Saving, loading, and scheduled runs clear the flag.

## v0.1.7
- **Testable scheduling core**: The trigger/countdown time math (next-run for `once`/`cron`, the due-window check, and countdown formatting) is extracted into a pure, dependency-free `schedule.js` that takes `now` as an argument. Behavior is unchanged, but it's now deterministically covered by the headless self-test — `once` returns the absolute time, `cron` rolls forward exactly 24h once today's window passes, the grace window fires late-but-not-stale ticks, and countdown formatting clamps/pads/prefixes days. Scheduling regressions now fail `npm test`.

## v0.1.6
- **Live loop progress**: While a workflow runs, the active Loop block shows a live iteration badge (e.g. `2/3`) that turns green when the loop finishes, and the status line reads `🔄 Loop 2/3`. Driven by a new `onLoopIteration` engine hook, covered by the self-test.
- **Loop grouping visuals**: Loop / End Loop markers share a tinted background so the pair reads as brackets, and the connector lines between nested blocks are indented to form a continuous nesting rail down the loop body.
- **Drop-to-position**: Dragging a block from the palette now inserts it where you drop it (a glowing insertion line previews the spot) instead of always appending to the end. Dropping a Loop still seeds its matching End Loop at that position.

## v0.1.5
- **Loop structure validation in the editor**: Unbalanced loop markers (a Loop with no End Loop, or a stray End Loop) are now flagged inline with a dashed warning outline and an explanatory tooltip, plus a summary banner above the block list. The run still proceeds safely (the engine skips broken markers) — the warnings just make the structure obvious while editing.
- **Self-test coverage**: The headless `npm test` now also verifies every shipped template is structurally sound (balanced loops) and checks the unmatched-marker index reporting, so a malformed template or loop-analysis regression fails the build.

## v0.1.4
- **Real Loop block**: The `loop` block now actually repeats. It pairs with a new **End Loop** (`loopEnd`) block — every block between a Loop and its matching End Loop runs `count` times. Adding a Loop auto-seeds its End Loop, nested loops are supported, and the loop body is visually indented by nesting depth. Unbalanced markers (a Loop with no End, or a stray End) are skipped with a warning instead of breaking the run.
- **Workflow Templates**: A new **🧩 Templates** picker offers pre-built starting points (Claude Auto Session, a Loop example, a nightly run + hibernate, and a quick command). Selecting one replaces the current workflow; directory/time placeholders are filled with sensible local defaults and never auto-fire on load.
- **Headless engine self-test**: `npm test` (`electron . --self-test`) runs the engine's loop control flow in a dry-run mode with no real PTYs, asserts simple/nested/zero-count/unbalanced loop behavior plus the pure loop helpers, and exits non-zero on any regression.

## v0.1.3
- Added a one-click current-time control beside Schedule datetime fields.
- Marked default/current-minute Schedule targets as handled in the countdown board so they do not appear as immediately due.
- Preserved manual scheduling behavior: editing a Schedule to a future time still arms it normally.

## v0.1.2
- Default/demo Schedule blocks now display the current local system time immediately.
- Newly-created Schedule blocks still suppress the just-created current-minute target once, preventing accidental immediate auto-runs while keeping future edits schedulable.

## v0.1.1
- Hardened app shutdown: quitting from the tray now stops the scheduler heartbeat, detaches power monitor listeners, cancels pending hibernate timers, releases the keep-awake blocker, tears down the tray, and terminates tracked PTYs through one idempotent cleanup path.
- Guarded main-to-renderer IPC sends so process output, process exit, sleep-state, and scheduler heartbeat events do not throw while the renderer is closing.
- New Schedule blocks now default their `datetime-local` value to the current local system time at the moment the block is created.
- Fixed a startup Content Security Policy console error by explicitly allowing local `data:` images used by CSS controls.
- Added renderer-side IPC rejection handling for terminal input and resize calls during process teardown.
- Prevented overlapping scheduled workflow refreshes when renderer ticks and main-process heartbeat ticks arrive close together.
- Added `npm run smoke` for a quick Electron startup/shutdown smoke test that exercises the normal quit cleanup path.
- Ignored local `mcps/` tool descriptor caches in Git and packaged builds.
