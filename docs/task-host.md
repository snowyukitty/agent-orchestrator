# Desktop task host (W2a)

Status: **W2a local qualification, fixture-verified only.** No provider is
qualified for this path, the ingress is off unless the owner enables it, and no
cross-machine carrier exists. This document is the host contract the remote-work
design asked for before launch code; the
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
- **Fixed operations.** `capabilities`, `start`, `status`, `result`, `diff`,
  `stop`, `show`. There is no operation that takes a command line, an
  executable, a path, environment overrides, or raw PTY input. Errors are fixed
  codes; no exception text, path, or provider output crosses the ingress.

The ingress is **disabled by default**. It starts only when
`settings.json` has `taskHost.enabled: true`, or in the fixture verification
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
  is a Git work tree, and verifies `baseRevision` names a commit there.
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
| screen locked (Electron `lock-screen`) | refused `session-locked`; never queued |
| provider unknown, or known but unqualified | refused `provider-unavailable` / `provider-unqualified` |
| workspace label not registered | refused `unknown-workspace` |
| a task already active in that workspace | refused `workspace-busy` |
| two tasks already active on this host | refused `host-busy` |
| otherwise | `accepted`, after the accepted record is durably written |

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
- Quitting the app marks every active task `interrupted` before its PTY is
  drained. Tasks do not survive the host.

## Provider adapters and instruction delivery

An adapter declares how the instruction reaches a **fresh** provider and what
lifecycle evidence it can produce. W2a defines one delivery mechanism:

**argv pointer.** The full instruction is written to `prompt.md` in the
private launch directory, outside the worktree. The provider is started with a
fixed short sentence naming that file as its initial prompt; the task text
never appears in argv, the clipboard, or an existing PTY. The start counts as
one submitted turn, so the first authenticated turn-complete receipt from the
existing lifecycle broker completes it.

The prompt file also contains a per-launch random nonce and the result frame
markers, which appear nowhere else. A result frame echoing the nonce is
evidence the provider read the file; it is still AI-reported content.

| Adapter | Status | Notes |
|---|---|---|
| `fixture` | qualified **for fixtures only** | `tests/fixtures/task-host/fixture-agent.js`; never packaged |
| `codex` | implemented, **unqualified**, refused at admission | builds the existing routed direct-agent spec and appends the pointer prompt; needs a separately authorized live turn |

Turn-started is not observable for either adapter and is recorded as
`unavailable`. Waiting-for-input is never inferred from silence; the task shows
`running` until a receipt, an exit, or a stop.

## Evidence

`result` returns the record's evidence. The axes are independent and none
implies another:

| Axis | Source | What it can say |
|---|---|---|
| `delivery` | host | prompt digest and size, mechanism, handed-at time; `providerRead` = nonce echoed / not observed / mismatch |
| `lifecycle` | lifecycle broker | authenticated turn-complete observed or not; turn-started unavailable |
| `process` | PTY | root PID, host spawn time, exit code and time, still running |
| `window` | Electron | created, shown, detached, reopened counts; never "seen by a person" |
| `result` | PTY framed capture | `complete` / `missing` / `truncated` / `invalid`; the AI's summary and **claimed** checks, bounded and untrusted |
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
  launches/<launchId>/
    record.json           state, request digest, observations, evidence
    prompt.md             the instruction, nonce, result markers
    result.txt            the captured frame body
    checks/<n>.log        bounded host-observed check output
    diff.patch            the complete patch
  worktrees/<launchId>/   the task worktree, retained until review
```

Nothing here is pruned automatically. Prompt text, results, and diffs never go
to the main window, the Log pane, the run journal, or the ingress `status`.

## Verification

- `npm run test:unit` covers strict JSON, request validation and digest, the
  ingress (real loopback sockets), Git evidence (real repositories in a temp
  directory), checks, and the host end to end with real PTYs and the fixture
  agent: completion, AI-claimed vs host-observed disagreement, nonzero exit,
  missing receipt and Stop, duplicate and conflicting starts, busy admission,
  and restart recovery.
- `npm run verify:task-host` starts Electron with throwaway user data, drives
  the real ingress through the client, and requires a real task window per
  task. It runs only fixture providers.

A provider turn against a real account is a separate, owner-authorized manual
step and is not part of either command.
