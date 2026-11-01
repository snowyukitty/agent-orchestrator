# Desktop task host (W2a)

Status: **W2a, fixture-verified, with a live Codex qualification path.**
Codex is admitted only on a machine that holds a qualification receipt from an
owner-authorized live turn ([Qualification](#qualification)), and only for the
exact Codex version that turn observed. The ingress is off unless the owner
enables it, and no cross-machine carrier exists. This document is the host
contract the remote-work design asked for before launch code; the
[limitations](limitations.md#desktop-task-host) say what it does not prove.

## What it is

A task host turns one typed, digest-bound launch request into one fresh agent
running in **its own new window** on this desktop, inside a fresh Git worktree,
and then joins the independent evidence a reviewer needs:

1. the instruction was handed to the provider, and the provider read it;
2. the provider reported its turn complete;
3. the provider's framed result;
4. checks the host ran itself, kept apart from checks the agent claims;
5. a complete diff from the chosen base.

None of these is a success verdict. A finished task ends in `needs-review`.

```text
local client (scripts/task-host-client.mjs)       later: Matrix-carried adapter (W2b)
        |  one JSON line, loopback TCP, capability token
        v
TaskIngress  -- strict parse, size limits, fixed ops, fixed error codes
        v
TaskHost     -- admission, private launch records, worktree, evidence
        |------------------------------|
        v                              v
task window (BrowserWindow)       task SessionRegistry (own PTYs)
  output view, input, Stop          -> provider adapter -> fresh agent
                                    <- lifecycle receipt (existing broker)
```

## Ingress

- **Loopback only.** The server binds `127.0.0.1` on an OS-assigned ephemeral
  port, refuses to start if the bound address is anything else, and drops any
  connection whose peer is not loopback. No fixed port is allocated, no
  firewall rule is needed, and nothing listens on another interface.
- **Capability.** A random 256-bit token and the port are written atomically
  to `task-host/ingress.json` in the app's user-data directory, which only the
  owning Windows user can read by default. Every request carries the token; it
  is compared in constant time. The file is removed on shutdown if it still
  names this host incarnation.
- **Why not a named pipe.** The design preferred a pipe with an explicit DACL
  and `PIPE_REJECT_REMOTE_CLIENTS`. Node's pipe server (libuv) cannot set
  either, so a Node pipe carries the default ACL and is reachable by the same
  user over SMB. Loopback TCP plus a user-private token is the stronger choice
  available without a native module. Neither stops malicious code already
  running as the same user.
- **Framing and limits.** One newline-terminated JSON request per connection,
  one JSON response, then close. At most 160 KiB per request (the 128 KiB
  launch request plus its envelope), 8 concurrent connections, 5 s per
  connection. Duplicate JSON keys, unknown keys, and wrong types are rejected
  as a whole.
- **Fixed operations.** `capabilities`, `start`, `remote-start`, `list`,
  `status`, `result`, `diff`, `stop`, `show`. `remote-start` is `start` plus
  an authorization for a request relayed from another machine (see
  [Unattended remote starts](#unattended-remote-starts)); `list` returns the
  most recent 50 launches as public status only. There is no operation that takes a command line, an
  executable, a path, environment overrides, or raw PTY input. Errors are fixed
  codes; no exception text, path, or provider output crosses the ingress.

The ingress is **disabled by default**. It starts only when
`settings.json` has `"taskHostEnabled": true` (read at startup), or in the fixture verification
mode, which uses throwaway user data.

## Launch request

```json
{
  "schema": 1,
  "kind": "agent-orchestrator.task-launch",
  "launchId": "<uuid v4>",
  "taskId": "<label>",
  "provider": "fixture",
  "route": "<label>",
  "workspace": "<label registered on this host>",
  "baseRevision": "<40-hex commit>",
  "presentation": "task-window",
  "instruction": "<text, at most 64 KiB>",
  "checks": [{ "kind": "npm-script", "name": "test" }],
  "gitEffects": "edits-only"
}
```

`start` carries `{ request, digest }`, where `digest` is the SHA-256 of the
request's canonical JSON (keys sorted, no whitespace). The host recomputes it;
a mismatch is refused. The digest is an integrity binding, not authority.

- **No paths cross the ingress.** `workspace` is a label the owner registered
  in `task-host/workspaces.json` on this host. The host resolves it, checks it
  is a Git work tree, and verifies `baseRevision` names a commit there:

  ```json
  { "schema": 1, "workspaces": {
      "notes": "D:\\Work\\notes",
      "site": { "path": "D:\\Work\\site", "codexProjectTrust": "allow" } } }
  ```

  `codexProjectTrust: "allow"` is a separate, default-deny opt-in. Codex
  refuses to start in a folder that is not a trusted project, and trusting one
  lets Codex load that repository's own project settings, which can run code
  without a model request. Only a workspace the owner opted in admits Codex;
  the host then grants that trust for the one invocation and never writes
  Codex's configuration.
- `route` selects an account route (for Codex) or a fixture scenario. The
  host never constructs an account environment; a routed provider is launched
  through ai-agent-entrypoint exactly as direct sessions are today.
- `gitEffects` accepts only `edits-only` in W2a. Commit and push are refused as
  unsupported, not silently ignored.
- `checks` name scripts in the worktree's `package.json` (at most 8). The name
  pattern excludes every shell metacharacter. Arbitrary commands are not
  accepted.

## Admission

`start` is decided synchronously, before any asynchronous work, so a
double-click cannot create two tasks:

| Condition | Answer |
|---|---|
| same `launchId`, same digest | the existing observation (`duplicate: true`) |
| same `launchId`, different digest | refused `launch-id-conflict` |
| host shutting down | refused `host-closing` |
| the system is suspending | refused `host-suspending` |
| on battery, or the power source cannot be read | refused `battery-disallowed` / `power-state-unknown` |
| the session state cannot be read | refused `session-state-unknown`; never assumed unlocked |
| the host is not in an interactive session (Session 0) | refused `session-not-interactive` |
| provider unknown, or known but unqualified | refused `provider-unavailable` / `provider-unqualified` |
| session locked, and the provider was not qualified in a locked session | refused `provider-session-unqualified` |
| workspace label not registered | refused `unknown-workspace` |
| provider needs project trust the workspace did not grant | refused `workspace-trust-not-granted` |
| a task already active in that workspace | refused `workspace-busy` |
| the profile's concurrent tasks already active on this host | refused `host-busy` |
| the profile's starts in the last 24 hours already accepted | refused `daily-limit-reached` |
| otherwise | `accepted`, after the accepted record is durably written |

Session, power, and account come from Windows itself, not from Electron:
Chromium caches the lock state and answers "unlocked" when its query fails,
and reports AC when the power status is unknown. A long-lived PowerShell
helper (`system-state.ps1`, a child of the host) answers every 5 seconds and
on every lock, unlock, power, and resume event with
`WTSQuerySessionInformation` for the host's own session (connection state and
lock flag), `GetSystemPowerStatus`, and the process token's user SID.
Admission reads the latest answer; one that is missing, failed, or older than
15 seconds is unknown and refused. A disconnected session counts as locked,
and so does a running screen saver that Electron reports. When an answer shows
the machine off AC, active tasks are stopped. The record keeps the session and
power state observed at admission and the policy revision that applied.

Limits come from the owner's per-host `policy.json` profile; without one the
host keeps two concurrent tasks, a two-hour turn limit, and 24 starts a day,
and an invalid policy applies the smallest profile. The daily count is taken
from the durable launch records, so a restart does not reset it.

`accepted` is an acknowledgement only. The client polls `status`. There is no
offline queue: a refused request is not retried by the host.

## Task lifecycle

```text
accepted -> preparing -> window-open -> spawning -> running -> collecting -> needs-review
    |           |             |            |           |
    |      failed-to-start    |       uncertain     stopped / exited / interrupted
    |                         |                       (all still collect evidence)
interrupted (host restart before any spawn intent)
```

- The worktree is created at `task-host/worktrees/<launchId>` on a new branch
  `task/<first 12 hex of launchId>` from the requested base. The owner's
  working tree and index are never touched and their dirty state never
  travels; the repository does gain that branch and a worktree registration,
  which stay until the owner removes them after review.
- The window is created **before** the provider starts. If no window can be
  created, nothing is spawned (`failed-to-start: window-unavailable`).
- The record is written with `spawnIntentAt` immediately before the PTY is
  created, then with the root PID and host clock once it exists. A record left
  in `spawning` after a crash becomes `uncertain`: a process may exist. A host
  restart never re-adopts, signals, or respawns anything.
- Closing a task window only detaches the view. The task continues; `show`
  reopens a window onto it. **Stop** (window button or `stop` op) kills the
  task's process tree, records the request and the observed root exit
  separately, and then still collects evidence. Stop is not rollback.
- **Collection boundary.** However the turn ends, the host ends the provider's
  process tree and closes window input *before* it reads the report, runs
  checks, and takes the diff, so nothing the task started is still writing
  while the evidence is frozen. Membership is kept by Windows, not inferred:
  right after the provider spawns, a long-lived helper (`process-jobs.ps1`)
  opens it, checks it was created after the spawn began, and puts it in a new
  **Job Object**, adopting any child it already started. Everything started
  afterwards joins the job by itself, detached processes included, and the
  helper keeps the root's handle open so its pid is never reused while the job
  exists, and jobs are kill-on-close, so they never outlive the helper. A
  process can still be created outside its parent's job: PowerShell 7
  installed from the Microsoft Store is a packaged (MSIX) app, whose children
  break away from every job. Routed sessions therefore start through the MSI
  install (`%ProgramFiles%\PowerShell\7\pwsh.exe`) whenever it exists,
  whatever PATH finds first, and `remote-start` is refused on a host without
  it. As a backstop, every 2
  seconds while the task runs, and again at
  the boundary, the helper adopts any live child of a live member that is
  outside the job. At the boundary the host counts what is in the job and what
  could not be adopted, ends the provider, and terminates the whole job,
  waiting up to 10 seconds for it to empty. `collection.ownership` records
  whether the job was held, how many processes were in it and outside it at
  the boundary, and how many survived. The collection is `stable` only when
  the root exited, nothing was left outside the job, and the job is empty;
  without a job (the helper failed, or another platform) it is never stable,
  and an unstable collection never qualifies a provider. This is adoption
  after spawn, not ownership from creation: a child started outside the job
  and gone, or started by an intermediate that exited between two sweeps, is
  not seen, and stray adoption still relies on creation order. Making it
  sound needs the router off packaged PowerShell (see
  [the policy](w2b-unattended-policy.md#progress)). The terminal stays readable in
  the window (and in the private `terminal.log`); a follow-up conversation is
  a new task.
- **Power.** While any task prepares, runs, or is checked, the host holds
  `prevent-app-suspension`, released as soon as none is (the display may still
  sleep). When the machine goes on battery, every active task is stopped and
  its evidence is collected without host checks (`checks.skipped:
  "on-battery"`); a check already running is ended and recorded as
  `cancelled`, and one not yet started never starts. Each host check also runs
  in its own job, which is ended on every path, including a normal finish, so
  a background process the script left is ended too; a check whose output
  never closes is given up after 5 seconds.
- **Quiet windows.** A task window opens without taking focus, and its title
  and state line name the task and the provider, never the route alias or the
  instruction. Only an explicit `show` may bring a window forward.
- Quitting the app marks every active task `interrupted` before its PTY is
  drained. Tasks do not survive the host.

## Provider adapters and instruction delivery

An adapter declares how the instruction reaches a **fresh** provider and what
lifecycle evidence it can produce. W2a defines one delivery mechanism:

**argv pointer.** The full instruction is written to `prompt.md` in the
private launch directory, outside the worktree. The provider is started with a
fixed short sentence naming that file as its initial prompt; the task text
never appears in argv, the clipboard, or an existing PTY. The start counts as
one submitted turn, completed by the authenticated turn-complete receipt **for
that turn**.

**Receipt correlation.** A provider process can complete turns the host did
not start: Codex 0.165 runs a title-generation side turn that finishes first.
The notify helper therefore forwards a SHA-256 of each input message of the
completed turn, and a task registers the digest of its own pointer sentence
(which names its private prompt, so it is unique per launch). The broker
accepts, and binds the thread to, only a receipt whose input includes that
digest; any other is counted as `lifecycle.uncorrelatedReceipts` and changes
nothing. Message text never crosses the pipe.

The prompt file also contains a per-launch random nonce, which appears nowhere
else. A report echoing the nonce is evidence that something in the task's
execution context read the file; the report is still AI-reported content.

**Result channels.** An adapter declares how its report comes back:

- `pty-frame`: the agent prints one JSON line between per-launch markers and
  the host captures it from the terminal stream. Fine for a line-oriented
  agent such as the fixture.
- `file`: the agent writes one JSON object to `result.json` in a fresh,
  randomly named outbox beside the prompt, the only directory outside the
  worktree it is told to write. The host reads it once, after the collection
  boundary: a regular, single-link file whose opened handle is still the file
  inspected, read with a hard size bound, strict UTF-8 (a leading byte-order
  mark is accepted), and parsed exactly as written as strict JSON, with
  duplicate keys and duplicate check claims refused. A file that cannot be
  opened or read is an `invalid` report; the rest of the evidence is still
  collected. The bytes are copied into
  `result.txt` and their SHA-256 recorded, so later writes cannot change what
  was collected. Required for Codex: its full-screen TUI redraws with cursor
  movement, and the first live run showed a printed frame losing spaces and
  even a nonce character on the way through the terminal.

Either way the prompt names each check exactly (`test`, run as `npm run
test`), and the claim must use that name.

| Adapter | Status | Notes |
|---|---|---|
| `fixture` | qualified **for fixtures only** | `tests/fixtures/task-host/fixture-agent.js`; never packaged; either channel |
| `codex` | admitted **only with a qualification receipt** for its adapter contract, and only while the route reports the qualified version | routed direct-agent spec plus the task arguments below; `file` channel; needs workspace project trust |

**Codex task arguments.** The adapter takes the routed direct-agent spec from
ai-agent-entrypoint unchanged and appends only:

| Argument | Why |
|---|---|
| `--no-daemon` | the task gets its own backend, not a shared app-server daemon that Stop could not own |
| `-c approval_policy="never"` | nobody is there to approve; a request that needs approval is denied rather than awaited |
| `--add-dir <outbox>` | the report path stays writable even under a sandboxed account policy |
| `-c projects={'<repo root>'={trust_level="trusted"}}` | one-invocation project trust for the opted-in workspace. Codex's `-c` key splitter breaks on `.`, so the root travels as a TOML literal key inside the value; a root a literal key cannot hold (an apostrophe, a control character, no drive letter) is refused as `provider-trust-unexpressible`. The root is the parent of `git rev-parse --git-common-dir`, ASCII case-folded like Windows |
| the pointer sentence | the instruction itself never enters argv |

A routed spec that already carries one of these options is refused
(`route-policy-conflict`) rather than letting argument order decide.

**No containment is claimed.** The sandbox is the account's own policy. The
owner's default runs Codex without one, and on this machine Codex's
`workspace-write` sandbox could not start at all (`no writable root capability
SIDs`), so forcing it would break every task. `edits-only` is therefore an
instruction plus an observation (commits since base appear in the diff
evidence), not an enforcement.

Turn-started is not observable for either adapter and is recorded as
`unavailable`. Waiting-for-input is never inferred from silence; the task shows
`running` until a receipt, an exit, or a stop.

## Evidence

`result` returns the record's evidence. The axes are independent and none
implies another:

| Axis | Source | What it can say |
|---|---|---|
| `delivery` | host | prompt digest and size, mechanism, handed-at time; `providerRead` = nonce echoed / not observed / mismatch |
| `lifecycle` | lifecycle broker | authenticated, input-correlated turn-complete observed or not; how many receipts were for other turns; turn-started unavailable |
| `process` | PTY | root PID, host spawn time, exit code and time, still running |
| `window` | Electron | created, shown, detached, reopened counts; never "seen by a person" |
| `result` | the adapter's result channel | `complete` / `missing` (no report) / `truncated` (a frame began and never ended, or the file exceeded its bound) / `invalid`; the channel, the report digest, and the AI's summary and **claimed** checks, bounded and untrusted, only for a complete report |
| `checks` | host | each check run by the host after the turn: command, exit, outcome, duration, the tree it ran against, output digest; plus whether the script definition differs from the base; plus agreement with AI claims |
| `diff` | Git | see below |

**Diff.** The host stages the worktree into a *temporary* index (never the
worktree's own index), writes a tree, and diffs the base against it with rename
detection and binary patches. That covers commits made since the base, staged,
unstaged, and untracked-but-not-ignored files in one patch. Separately it
records the layers from `git status --porcelain=v2` (staged, unstaged,
untracked, unmerged), commits since base, binary files, renames, and submodule
state. The patch is kept privately in the launch directory; `result` carries
only counts and its SHA-256, and `diff` is the explicit, bounded retrieval.
Ignored files are never swept. Writes outside the worktree, global
configuration changes, and external effects are not detected, and the evidence
says so.

## Private state

```text
<userData>/task-host/
  ingress.json            port, token, host incarnation (user-private)
  workspaces.json         owner-registered workspace labels -> checkouts
  policy.json             the owner's per-host profile and remote-start switch
  launches/<launchId>/
    record.json           state, request digest, observations, evidence
    prompt.md             the instruction, nonce, result markers or outbox path
    outbox-<random>/      the only extra path a file-channel agent writes
    result.txt            the collected report snapshot
    checks/<n>.log        bounded host-observed check output
    diff.patch            the complete patch
  worktrees/<launchId>/   the task worktree, retained until review
  qualifications/<provider>.json   receipts from live qualification turns
```

Nothing here is pruned automatically. Prompt text, results, and diffs never go
to the main window, the Log pane, the run journal, or the ingress `status`.

## Qualification

A provider adapter is admitted for real tasks only after one owner-authorized
live turn has shown, end to end, what the fixture shows with a scripted agent:

```powershell
npm run qualify:task-host -- --confirm-live [--account-number=<n>]
```

The run uses throwaway user data and a throwaway repository, drives the real
ingress, a real task window, routed Codex, the real lifecycle receipt, and the
full evidence pipeline, and asks for one harmless edit that makes the
repository's own test pass. It prints aggregate facts only: no route alias,
path, prompt, or provider output. It refuses to run without `--confirm-live`
and in a packaged build.

With `--await-locked` it waits (up to 10 minutes) for the workstation to be
locked before starting the turn, and records a **locked-session**
qualification only when the session was locked both at admission and at
collection. The receipt lists the session states it covers; a locked
qualification survives a later unlocked one of the same version, and any
version change needs both again. Without a locked qualification a provider is
refused `provider-session-unqualified` while the workstation is locked.

Every axis must hold: window created, nonce echoed, authenticated and
input-correlated turn-complete receipt, complete report, the host-run check
passed and agrees with the claim, complete diff, owner checkout untouched, a
stable collection, and the provider version observed through the route. Only then does it write
`qualifications/codex.json` into the **production** task-host directory. A
turn that falls short writes nothing.

The receipt binds the adapter contract version (`CODEX_ADAPTER_CONTRACT`,
bumped whenever launch or delivery changes) and the exact `codex --version`
reported through the router's `target run <route> --` prefix. Each launch
probes that version again before spawning and refuses `provider-version-changed`
or `provider-version-unknown`. A Codex upgrade therefore needs a new
qualification turn; the host never starts one by itself.

**Recorded qualification (2026-10-30).** `codex-cli 0.165.0`, adapter
contract 1, qualified on the owner's machine. Five turns failed first; the
host refused each one correctly, and each changed the adapter:

| Turn | What happened | What changed |
|---|---|---|
| 1 | Codex waited at its folder-trust screen until the turn limit | opt-in project trust, passed per invocation |
| (diagnostic) | the printed result frame came back with lost spaces and a damaged nonce | the `file` result channel |
| (diagnostic) | forced `workspace-write` could not start any tool | the sandbox stays the account's |
| 2, 3 | a title-generation side turn's receipt ended the task after a few seconds | input-correlated receipts |
| 4, 5 | the account's configured model was not available on its plan; the turn errored and never completed | none: a provider-side failure, shown by the private transcript |
| 6 | every axis held, with one uncorrelated side-turn receipt ignored | receipt written |
| (review) | an independent review found a collection could be frozen while the provider might still write, and three smaller defects | collection stability became an axis, which invalidated receipt 6 |
| 7 | every axis held, including a stable collection | superseded by 8 |
| 8 | every axis held under the stricter collection (no surviving descendant) | the current receipt (unlocked session) |
| 9 (`--await-locked`) | admitted and started with the workstation locked; every axis held, and the boundary found and ended three Codex descendants; the workstation was unlocked before collection | no locked receipt: a locked qualification must stay locked to the end |
| 10–14 | provider ownership moved to Job Objects after three review rounds; the first job turns showed Codex itself outside the job (started by the PowerShell launcher), so the collection was unstable and no receipt was written | strays adopted every 2 s and at the boundary |
| 15 | every axis held; four processes in the job at the boundary, none outside, none surviving | receipt (unlocked session) |
| 16 | the router on the MSI PowerShell 7, Codex 0.166.0: every axis held; no process adopted late, six in the job at the boundary, none outside, none surviving | the current receipt (unlocked session) |

The locked-session qualification is still to be run with nobody at the
console: start it, lock the workstation, and leave it locked until the run
prints its result.

A qualification run also keeps, privately beside the receipts, a summary of
each notify payload (type, client, input length and first 80 characters,
digest) and, when it fails, the terminal transcript.

What a receipt does **not** cover: other repositories' toolchains, network or
dependency installation, hooks and project settings beyond the fixture's, an
executable that reports the same version string, account configuration changes
(writable roots, rules that bypass a sandbox), or a sandboxed account profile.
It is one exercised profile, not a reliability claim.

## Fault acceptance

The remote-work design lists the faults a W2 host must survive. Each row says
what the host does and which check proves it; after each case no extra task,
window, or launch record exists and the host keeps answering. Rows marked
*W2b* or *live* cannot be proven by a local fixture.

| Fault | Behaviour | Proof |
|---|---|---|
| Wrong user, or a request from another machine | No listener off loopback; non-loopback peers dropped; the token file is user-private | ingress unit test; [Ingress](#ingress) |
| Spoofed or oversize request | Unauthenticated requests learn only `unauthorized`; >160 KiB, duplicate keys, bad UTF-8, unknown ops refused as a whole | ingress unit test |
| Stale binding (host restarted or gone) | The old port refuses connections; a reused port rejects the old token; the client says the host is not running and does not retry | `an absent or replaced host fails closed…` |
| Absent host | No discovery file; the client fails closed | same test |
| Double-click / repeated start | Same bytes return the existing launch; different bytes are `launch-id-conflict` | host and fixture run |
| Transport loss before acceptance | An incomplete line is never dispatched; no record exists | `transport loss before or after acceptance…` |
| Transport loss after acceptance | The accepted record is durable before the ack; a retry of the same bytes gets `duplicate: true` and exactly one task, one window | same test |
| Unsupported or unqualified provider | `provider-unavailable` / `provider-unqualified` at admission | admission test, fixture run |
| Missing login, full quota | Not observable by the fixture; with a real provider the task ends without a receipt or frame and stays `needs-review` with that evidence | *live* |
| Locked console, or no window can be created | Admitted only for a provider qualified while locked (`provider-session-unqualified` otherwise); an unreadable session is `session-state-unknown`; no window means no spawn (`window-unavailable`) | admission test, locked qualification turn |
| Provider leaves a process behind | Still in the provider's job, and ended with it; a member's child outside the job is adopted, and one that cannot be adopted makes the collection unstable | `a detached process left behind…`, fixture run, live qualification |
| Machine goes on battery, or suspends | Active tasks stop and collect without host checks; new starts refused | power test |
| Host crash around spawn | `spawnIntentAt` precedes the PTY; recovery reports `uncertain` / `interrupted` and never respawns | restart recovery test |
| Nonzero child exit | `ending: process-exited` with exit code; evidence still collected; no completion claimed | host test |
| Partial output | A frame that began but never ended is `truncated`; no AI claims are taken from it | `partial output is a truncated frame…` |
| User input mid-task | Typing in the task window reaches only that task | host test (`ask` scenario) |
| Terminal (window) close | Detaches the view; the task continues; `show` reopens it | fixture run |
| Stop, including right after spawn | Stop request and observed root exit recorded separately; observed changes collected; whether anything outside the worktree happened is not assessed (`effectReconciliation: not-performed`) | host test, transport-loss test, fixture run |
| A side turn completes in the provider process first | Counted as uncorrelated; neither completes the task nor binds the receipt thread | `a side turn completing first…`, broker test, qualification turns 2 and 6 |
| The provider's turn errors (for example, a model the account cannot use) | No receipt, so the task shows `running` until the turn limit or Stop; never inferred complete | qualification turns 4 and 5 |
| Provider waits at an onboarding or approval screen | Untrusted folders are made trusted only per opted-in workspace; approval prompts are denied by policy; anything else shows in the window and ends at the turn timeout or Stop, never answered by injected keys | first live run (trust screen), qualification run |
| Session or route change mid-task, approved Matrix direction | — | *W2b* |

## Unattended remote starts

When and how a target may start a task requested from another machine with
nobody present (W2b) is decided in [w2b-unattended-policy.md](w2b-unattended-policy.md):
session states, power, per-host profiles, and the gates before the first
unattended start.

The host side is implemented. `remote-start` carries the request, its digest,
and an authorization:

```json
{ "destination": "snowy-npc", "requestDigest": "<sha256>",
  "issuedAt": "2026-10-30T12:00:00.000Z", "expiresAt": "2026-10-30T12:00:30.000Z" }
```

It is refused `remote-starts-disabled` unless `policy.json` enables remote
starts, `wrong-destination` unless it names this host's `hostId`,
`digest-mismatch` unless it binds the exact request, `invalid-authorization`
for any other shape or a validity longer than 60 seconds,
`authorization-expired` once expired (or issued more than 5 seconds in this
host's future), and `session-owner-mismatch` unless the host runs as the
enrolled account, compared by SID (two accounts can share a user name; an
unreadable SID never matches). A retry of an accepted launch ID returns that launch's
observation even after expiry and never starts another task. Who may send the
request is the transport's decision (the owner's approved route to the target
and the owner-only ingress token); the relay itself is not part of this
repository.

```json
{ "schema": 1, "kind": "agent-orchestrator.remote-task-policy", "revision": 1,
  "hostId": "snowy-npc", "profile": "primary", "ownerSid": "<S-1-5-21-…>",
  "remoteStarts": "enabled" }
```

Profiles are `primary` (2 concurrent, 2 h, 24 a day), `secondary` (1, 1 h, 12)
and `light` (1, 20 min, 4).

## Verification

- `npm run test:unit` covers strict JSON, request validation and digest, the
  ingress (real loopback sockets), Git evidence (real repositories in a temp
  directory), checks, and the host end to end with real PTYs and the fixture
  agent: completion, AI-claimed vs host-observed disagreement, nonzero exit,
  missing receipt and Stop, partial output, transport loss around acceptance,
  stale and absent hosts, duplicate and conflicting starts, busy admission,
  restart recovery, session and power admission, the host policy and remote
  authorization, profile limits, the awake hold, `list`, neutral titles, and
  process ownership (two tests use real Job Objects: one ends a detached
  process the fixture provider leaves behind, one ends a host check's job when
  power goes).
- `npm run verify:task-host` starts Electron with throwaway user data, drives
  the real ingress through the client, and requires a real task window per
  task, opened without taking focus. It also reads the real session and power
  state and requires a stable collection, including after a fixture provider
  that leaves a detached process behind. It runs only fixture providers.

A provider turn against a real account is a separate, owner-authorized manual
step and is not part of either command.
