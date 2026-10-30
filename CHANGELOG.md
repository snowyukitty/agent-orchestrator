# Changelog

Every notable change to Agent Orchestrator, newest first. The README keeps only
the product story; this file keeps the history.

## Unreleased (Journal v2 + Evidence-First Field Guide)

- **The task host is ready, on its side, to start tasks with nobody at the
  target** (W2b gates, [policy](docs/w2b-unattended-policy.md)). Session
  lock state, AC power, and the account SID are read from Windows by a small
  helper instead of from Electron (whose views fail open), and
  a locked workstation admits only a provider qualified while locked
  (`npm run qualify:task-host -- --confirm-live --await-locked`). Tasks start
  only on AC power; the machine is kept from suspending while one is active,
  and going on battery stops them without host checks. Evidence is frozen
  only once nothing the provider started survives: the provider and each host
  check run in their own Windows Job Object, children created outside it
  (PowerShell 7 starts native commands that way) are adopted, and the job is
  terminated and must be empty. A per-host `policy.json` picks a `primary`,
  `secondary` or `light` profile (concurrency, turn limit, starts per day)
  and enables `remote-start`, whose authorization must name this host and the
  exact request and expires within 60 seconds. `list` shows recent launches
  without content, and task windows open without taking focus under a
  neutral title. Three rounds of independent Codex review via ATD found
  fail-open session and power views, owner matching by name, a check
  surviving battery, and, repeatedly, unsound pid-and-time reasoning about
  which processes belonged to a task; that reasoning was replaced by Job
  Objects. Codex 0.165.0 was re-qualified under the stricter boundary;
  its locked-session qualification is still to be run with nobody at the
  console. The relay from another machine and the controller view are not
  built yet.

- **The task host runs real Codex tasks after a live qualification**:
  `npm run qualify:task-host -- --confirm-live` runs one harmless,
  owner-authorized Codex turn through the real ingress, window, receipt, and
  evidence pipeline, and only when every axis holds writes a receipt bound to
  the adapter contract and the exact Codex version; each launch re-probes the
  version and refuses a changed one. Codex 0.165.0 qualified on 2026-10-30
  after five refused turns, each of which fixed something real: Codex project
  trust is now a default-deny per-workspace opt-in granted for one
  invocation; Codex reports through a private outbox file because its TUI
  damages printed frames; the host ends the provider before freezing
  evidence; and lifecycle receipts are correlated with the task's own input,
  because Codex's title-generation side turn completes first. An independent
  Codex review via ATD then found that evidence could be frozen while the
  provider might still be writing; collection stability is now a
  qualification axis, and the receipt was re-earned on a seventh turn. No
  containment is claimed: the sandbox stays the account's own policy.

- **Desktop task host, W2a (fixture-verified, off by default)**: one typed,
  digest-bound launch request now becomes one fresh agent in its own new
  window and its own Git worktree, through a loopback-only ingress with a
  user-private capability token and fixed operations. The instruction travels
  in a private file the provider is pointed at, never in argv or an existing
  terminal; a per-launch nonce shows the provider read it. The result joins
  separate axes — delivery, an authenticated turn-complete receipt, the AI's
  framed report, checks the host ran itself (with disagreement called out),
  and a complete diff from base that includes staged, unstaged, untracked,
  binary, and renamed files without touching the task's index. Double starts
  return the same launch, conflicting bytes are refused, a restart reports
  rather than respawns, closing a task window only detaches it, and Stop still
  collects evidence. Only the fixture provider runs; Codex is built but refused
  until a separately authorized live turn qualifies it. `npm run
  verify:task-host` drives the real ingress, windows, and PTYs end to end.

- **The task host has a fault-acceptance matrix** ([task-host.md](docs/task-host.md#fault-acceptance)):
  every W2 fault from the remote-work design is mapped to the behaviour and
  the test that proves it, or marked as needing W2b or a live turn. New tests
  cover a client that drops the connection before or after acceptance (one
  task, one window, and a retry finds it), stale and absent hosts (the old
  token no longer authenticates; the client says the host is not running),
  and partial output — a result frame that began but never ended is now
  `truncated` rather than `missing`.

- **The task host recognizes a workspace however its path is spelled**: the
  work-tree-root check compared Git's `--show-toplevel` with the registered
  path as strings, so an 8.3 short name (hosted Windows runners use
  `RUNNER~1`), a junction, or a different spelling refused the workspace.
  Git now answers directly: the root is where `--show-cdup` is empty.

- **Stopping a terminal right after it starts no longer crashes on Windows**:
  when tree termination was unavailable, the registry closed the root PTY with
  `SIGTERM`, which node-pty's Windows terminal rejects. Before the first output
  node-pty defers that call, so the rejection escaped as an uncaught exception
  instead of reaching the fallback. The root is now closed without a signal on
  Windows. Found by the new transport-loss test, which stops a task
  immediately after spawn.

- **Electron 43.8.4**: the lockfile moves from Electron 43.4.1, `undici`
  7.29.0, and `brace-expansion` 5.0.11, which had high-severity advisories, to
  their fixed releases in the same major versions, and `package.json` no
  longer admits the vulnerable Electron range. `npm audit` is clean again, so
  the full `npm run verify` gate passes.

- **An Agent Session block now proves its provider came up**: the fixed
  `settleMs` sleep after launching an agent was a guess, and it hid two
  different failures behind a completed block. A provider that booted more
  slowly than the constant let the next block type into a shell that had not
  handed over yet; a provider that never started at all (the routed account
  shell falls through to `exit`) left a dead lane that only failed later, at
  the wrong block, with an error describing the symptom. `settleMs` is now the
  idle threshold of a bounded output wait, so a slow provider is waited for
  instead of raced, and liveness is a hard requirement: a lane that exits while
  starting fails its own Agent Session block, by name, and never reaches a
  downstream Send. Output still arriving at the timeout is not a failure — the
  lane is alive, which is what later blocks depend on — but it is logged. A
  fan-out that finds a lane gone between resolving its targets and writing to
  them now says so instead of surfacing an unexplained typing failure.
- **A run resolves its whole cast before it opens anything**: every Agent
  Session account is checked against live discovery first, so a workflow that
  outlived an alias rename or a deleted local profile fails immediately and by
  name instead of half-running and stranding open sessions — the difference
  between one clear message and a surprise found the next morning. The check
  is provider-neutral: routed Codex aliases and local Claude/Grok/Gemini
  profiles are resolved the same way. A lane left unset by a half-finished
  edit is caught here too, and a failure of the check itself never blocks a
  run, because an unverifiable cast is not a failed one.
- **Headless workflow authoring** (`npm run workflow`): `where`, `list`,
  `validate`, `check`, and `install`, so a workflow written outside the editor
  — by a script, or by an agent acting for you — is validated by the app's own
  loader, has its accounts resolved against real discovery, and lands in the
  right directory. `check` and `install` exit non-zero, so they gate a script.
  `install` also encodes the user-data rule that a hand-rolled `mkdir` gets
  wrong: creating the canonical directory early cancels the pending migration
  and strands the real settings and workflows in the pre-rename one. New
  `docs/authoring-workflows.md` carries the schema, the block catalog, and the
  verification steps a document cannot promise on its own.
- **`schedule` follows the repository's module convention**: the implementation
  moved to `schedule.mjs` with `schedule.js` re-exporting it, matching
  `blocks` and `workflow-document`, so Node can import the scheduling clock
  without a module-type warning and the tool shares one clock with the editor.
- **Usage-window pre-warm for two accounts** ships as a template: one lane per
  account, one `Send to All`, one `Join Agents`, defaulting to a daily cron,
  because a missed one-shot pre-warm is simply lost. Its barrier continues on
  incomplete so one slow account cannot stop the others from finishing.
- **Durable exact-session prompts**: a routed Codex session can now be started
  in an explicit direct-agent mode and scheduled for a one-shot or repeating
  prompt. Each record binds the exact session id, a random non-reusable PTY
  incarnation, and its main-owned profile/agent identity. The app never
  retargets the record or falls back to launching new work.
- **At-most-once unattended delivery**: the main process serializes every store
  mutation, persists a unique occurrence claim before touching the PTY, and
  rechecks identity, provider-confirmed readiness, quiet time, and input
  revision between one bracketed paste and one Enter. Busy or temporarily
  unavailable sessions remain due; any possible partial write consumes the
  occurrence; stale crash claims are consumed without replay. The renderer
  locks the displayed session id/incarnation while a prompt is composed, and
  main rejects the create request if that exact target changed. Direct Codex
  mode removes all lifecycle routing values from ordinary shell-tool environments.
  Delivery also requires an observed DECSET 2004 protected-paste mode; a
  post-paste race never sends a cleanup key that could erase human input and is
  surfaced as an error requiring composer inspection. Possibly partial paste
  or submit writes leave a sticky draft lock that provider receipts cannot
  clear, preventing later repeats from stacking onto uncertain composer text.
  Lifecycle receipts are bound to one provider-thread digest, deduplicated by
  turn digest, and matched against main-owned pending submissions so an older
  completion cannot idle a newer turn. Bracketed multiline paste and text after
  a submit are tracked conservatively as composer state.
  Consumed one-shots cannot be resumed, and paused repeats skip missed slots
  rather than replaying them when resumed.
- **Fail-closed restart and corruption behavior**: schedules survive app exit,
  but a restarted app cannot prove the vanished PTY incarnation, so affected
  rows become `session_changed` evidence and require recreation. An unreadable
  or future schedule store is preserved and disables delivery instead of being
  replaced with an empty file. Mutations and v1-to-v2 migration also enforce
  the exact serialized byte bound before atomic replacement. Prompt text is deliberately local plaintext and
  the UI warns never to include secrets.
- **Authority-preserving continuation backends**: exact-session scheduling now
  routes through a provider-neutral main-process core. Schema v2 durably adds
  the backend namespace, with an explicit atomic and idempotent migration of
  existing app-owned rows to `orchestrator-pty`. A backend is eligible only
  when it owns exact identity, agent-readiness, protected-input, and
  claim-bound delivery proofs. Missing, partial, timed-out, or failed adapters
  remain `unavailable`; only the owning backend may declare `session_changed`,
  and the core never falls back to a same-named session in another transport.

- **Deliberate Run Journal v2 migration**: startup validates each v1 record,
  preserves a rollback copy, and atomically writes an explicit v2 record rather
  than reinterpreting old data. Migration is idempotent across crashes before
  and after the backup, replacement, and legacy-index cleanup writes. Corrupt
  or future records are preserved and reported without blocking valid upgrades;
  the recovery health gate still blocks new journal/session admission while
  any durable record remains unknowable.
- **Lineage and review groundwork without replay**: v2 records expose root run,
  parent run, and attempt identities; retain encrypted, visit-bound control
  checkpoints with no plaintext fallback; and audit an explicit `abort`,
  `skip`, or `retry` disposition for an uncertain boundary. No confirmation
  receipt, child-run creation, or resume execution path ships with this layer.
- **Crash-recoverable retention**: destructive previews now come from validated
  canonical run records rather than the derived index. The short-lived preview
  token is opaque and process-local. Confirmation first writes a path-free
  retention intent; startup can idempotently finish that exact deletion after
  a crash at any record, backup, commit, or receipt boundary. Bounded durable
  receipts preserve operation replay across later prunes and restarts.
  Individual deletion uses the same recoverable record-first ordering.
  Descendants are removed before ancestors, and retained descendants protect
  their lineage from pruning or individual deletion.
- **Truthful truncated-mode identities**: capacity-degraded block/result calls
  return deterministic, explicitly non-durable identities for the exact call.
  A changed payload produces a different synthetic identity instead of a
  durable replay claim. Dropped result bodies no longer pretend to have
  memory-backed journal storage, and truncated runs cannot accept protected
  control checkpoints.

- **Readable UI text**: the smallest interface labels moved off a 9px floor.
  Block type labels, parameter labels, run statuses, buttons, and the security
  warning now sit at 11-12px, with the parameter label column and the palette
  widened so nothing collides or truncates further than before.
- **Legible product frames**: `npm run promo:capture` now takes `--promo-scale`,
  `--promo-zoom`, and `--promo-details`, and publishes at 2x with the UI at
  1.25 plus a focus crop per frame. Crops are cut from each frame using the
  focus element's own bounding rect, so they stay reproducible and hashed.
  `npm run check` fails if a published capture drops below that floor.
- **Fixed the capture fixture's target**: the join-state scripts matched
  `[data-type="agentJoin"]`, which the block palette also carries, so the badge
  and running state were being applied to the sidebar entry instead of the
  workflow block. Frames now show the barrier they claim to show.
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
