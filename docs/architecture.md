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
        | target run codex:<alias> --          | continuation core
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
- `codex-lifecycle.js` owns the capability-authenticated, process-local receipt channel
  used to prove that a direct Codex turn completed;
- `session-continuation-core.js` routes exact-session operations by durable
  backend namespace and gates adapters on explicit proof capabilities;
- `orchestrator-pty-continuation-backend.js` preserves `SessionRegistry` as
  the identity, readiness, and PTY-input authority for app-owned sessions;
- `session-prompt-schedules.js` validates the bounded durable record and
  serializes every read-modify-write mutation;
- `session-prompt-scheduler.js` owns the non-overlapping due loop;
- `scheduled-prompt-delivery.js` owns the guarded bracketed-paste and single
  submit sequence;
- `session-prompt-ipc.js` binds renderer requests to main-owned session
  identity rather than accepting identity claims from the renderer;
- `run-journal.js` owns protected run records, deliberate schema migration,
  public lineage and boundary-review facts, encrypted control checkpoints, the
  rebuildable public-metadata index, stable cursor pages, and canonical-source,
  crash-recoverable terminal-run retention;
- `resume-evidence.js` classifies whether interrupted-run metadata is blocked,
  needs a decision, or contains a recorded boundary; it never authorizes
  execution;
- `resume-preflight.js` performs explicit, revision-bound protected inspection:
  shared workflow validation, deterministic visit-prefix proof, result/runtime
  checks, and a redacted report whose execution capability is always false;
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

### Exact-session continuation

Account shells and direct-agent sessions are intentionally distinct. A routed
account shell may return to ordinary PowerShell when its provider exits, so its
profile label and live PTY are not agent-active proof. It is never eligible for
unattended delivery. An explicit routed Codex direct-agent session instead uses
ai-agent-entrypoint's public `target run codex:<alias> --` contract. The PTY
ends with the provider rather than falling back to a shell.

Every PTY creation receives a fresh random incarnation UUID. A schedule binds
the durable backend namespace, that incarnation, and the exact session,
profile, and agent identities. Main
also gives each direct Codex child a random capability for an app-owned named
pipe. Codex's provider `notify` callback reports only
`agent-turn-complete`; the helper forwards only the capability, incarnation,
and event type. Prompt/output data, routes, paths, and credentials never cross
that channel. Direct mode gives the pipe, token, and incarnation variables
secret-shaped names and enables Codex's default secret-name filter, so those
routing values are absent from ordinary shell-tool environments while the internal
notify hook retains it. Until a valid receipt arrives, readiness is unknown and delivery
fails closed. A new input moves the state to running; without another receipt,
an approval wait remains busy.

Main separately tracks DEC private mode 2004 from raw PTY output. A lifecycle
receipt does not make the session eligible until bracketed paste is positively
enabled, and a later DECRST disables delivery again. This protocol fact is not
used as agent-idle proof; it only prevents multiline prompt bytes from becoming
multiple submissions.

The durable scheduler first reconciles identity, then atomically persists a
unique claim for the due occurrence. Delivery begins only when main proves the
exact live incarnation and identity, provider-confirmed idle state, a
conservative input-quiet period, and no in-flight delivery. Main writes a
bounded control-character-free body inside bracketed-paste delimiters as one
PTY operation, waits briefly, and rechecks the binding, readiness, and input
revision before sending one carriage return. It never uses PowerShell,
SendKeys, the clipboard, window focus, or renderer typing for prompt delivery.
The small PowerShell `notify` helper is only a one-way lifecycle receipt bridge;
it contains no timer or delivery path.

If revalidation fails after the paste because other input arrived, main sends
no cleanup key: Ctrl-U, Escape, or backspaces could erase the human's input.
The occurrence is consumed as an error and the renderer tells the operator to
inspect the possibly residual composer draft. Main latches that draft as
occupied before the native paste boundary and clears it only after an
app-observed successful submit. Provider lifecycle receipts cannot clear the
lock, so a later repeat cannot paste over uncertain residue.

Claims make occurrences at-most-once. Busy and temporarily unavailable jobs
remain due. A successful submit consumes a one-shot or advances a repeat
directly to its next future occurrence. Identity loss permanently disables the
row. Any error after a possible partial PTY write consumes the occurrence. A
claim left by a crash is held for a bounded recovery period and then consumed
as an error, never replayed. See
[`session-prompt-scheduling.md`](session-prompt-scheduling.md) for the complete
contract. Consumed one-shots cannot be resumed, and a paused repeat skips
directly over missed slots when it is resumed.

## Persistence and identity migration

App-owned data lives under `%APPDATA%/agent-orchestrator`:

- `agents.json` for local, non-secret profiles;
- `settings.json` for UI and window preferences;
- `session-prompt-schedules.json` for bounded exact-session records, including
  local plaintext prompt bodies and durable delivery claims;
- `run-journal/*.json` for one bounded protected record per run;
- `run-journal/.index/` for rebuildable public summaries and its crash-dirty
  marker (never ciphertext or result bodies);
- `run-journal/.migration/v1/` for rollback copies retained by the explicit,
  idempotent v1-to-v2 journal migration;
- `run-journal/.retention/prune-v1.json` for one bounded, path-free confirmed
  prune intent and its latest terminal state;
- `run-journal/.retention/receipts-v1.json` for a bounded history of public-safe
  prune operation receipts;
- `run-journal/.retention/delete-v1.json` for one recoverable individual-delete
  intent and its terminal state;
- `workflows/*.json` for saved workflows.

Listing may trust the rebuildable index, but destructive retention never does.
It scans and validates every canonical run, rejects an unknowable record, and
protects the ancestors of every retained descendant. A preview token is random,
short-lived, and held only by the current main process. Confirmation atomically
persists the exact candidate IDs, revisions, policy, and plan digest before the
first deletion. Records are then removed descendant-first, migration backups
second, and durable operation receipts last; startup can replay an accepted
transaction idempotently. Individual deletion likewise persists intent before
removing the canonical record, then removes its migration backup. Invalid
transaction state fails journal admission closed; invalid receipt state fails
retention closed. Neither is automatically quarantined because an unreadable
coordination file may represent a human-confirmed deletion still in progress.

On the first singular build, valid app-owned JSON is copied from the historical
plural directory through a staging directory and atomically promoted. Chromium
caches are excluded, invalid JSON remains in the backup, canonical data is
never overwritten or silently merged, and the historical directory is retained
for rollback.

Smoke and self-test modes use temporary user data and cannot touch production
settings, workflows, or scheduled prompts.

## Interrupted-run evidence

Crash recovery changes active runs and visits to terminal `interrupted` states.
Migration and recovery are separate startup passes. A malformed or future
record does not prevent valid v1 records from upgrading, but any record whose
active/terminal disposition remains unknowable latches the existing containment
gate: new journal mutations and session admission stay blocked until a complete
recovery pass succeeds.
The public detail projection adds a derived resume-evidence assessment without
decrypting the workflow or result bodies. `recorded-boundary` means only that
the metadata gate found a durable, untruncated boundary; it is not a resume
capability. Interrupted visits require a human decision because their external
effects may have completed before the crash.

After that cheap gate passes, the user may explicitly run a main-owned deep
preflight. Main re-reads the record under its run lock and binds the request to
the displayed revision before decrypting anything. It verifies the protected
snapshot's context, canonical bytes, and public metadata; loads it through the
same versioned ESM validator used by the renderer; reproduces the engine's
ordered control visits through nested loops; decrypts every protected result;
classifies working-directory, session-recipe, opaque-runtime, and pending-team
state; and resolves current profiles through main-process authority. Current
format v2 and migratable v1 snapshots share this one validator, so the cheap
metadata gate no longer carries a second format allowlist.

Only counts, stage states, block type/index, and loop iteration numbers cross
IPC. Workflow names aside from the already-public run summary, block IDs,
profile IDs, paths, prompts, commands, result bodies, and validator errors stay
inside main. A missing directory/profile/result, changed assurance, illegal
visit prefix, pending team stage, or opaque session dependency blocks the
report. An interrupted effect remains an explicit decision boundary.

Journal v2 now has public root/parent/attempt identities, a narrow encrypted
checkpoint format for control state that trace proof cannot establish, and an
append-only `abort` / `skip` / `retry` review fact for uncertain visits. A
source visit accepts that review fact once; recording it advances the source
revision so an older protected inspection becomes stale, but the fact grants
no execution authority. The
deep preflight does not consume those checkpoints yet, and no code creates a
child run. The accepted [resume design](resume-design.md) still requires full
profile-identity fingerprints, a stale-safe confirmation receipt, child-run
creation, and the crash/no-double-effect matrix before execution can ship. The
current build exposes no execution path.

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
