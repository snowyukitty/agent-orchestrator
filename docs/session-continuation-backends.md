# Session continuation backend contract

Agent Orchestrator treats exact-session continuation as an orchestration
capability, not as a terminal-emulator feature. The main process owns one
provider-neutral continuation core. Backends remain the authority for the
sessions and PTY transports they created.

The first and currently only eligible backend is `orchestrator-pty`. It adapts
the app's private `SessionRegistry` and preserves the existing guarded
`node-pty` delivery path. The core has no wmux, WezTerm, shell-focus, clipboard,
or machine-level scheduling dependency.

## Why the backend namespace is durable

A reusable terminal or pane id is not an identity. Schedule schema v2 binds
each row to all of the following:

- continuation backend id;
- backend-scoped session id;
- non-reusable session incarnation UUID;
- expected profile and agent identity;
- the existing occurrence, prompt, state, timestamp, result, and claim facts.

The backend id is part of every binding comparison. If two backends expose the
same session id, neither can receive the other's schedule. The core never
searches other backends, guesses from a tab title or PID, or falls back by
session id.

Existing schema-v1 rows have an unambiguous origin: they were created by
`SessionRegistry` before external backends existed. Startup therefore performs
one explicit, atomic, idempotent migration that adds `orchestrator-pty` and
writes schema v2. An invalid, oversized, corrupt, or future store is preserved
unchanged and remains unavailable with a safe diagnostic. The migration checks
the exact UTF-8 bytes the atomic writer would emit before replacing v1 evidence.

## Capability gate

Registration is an internal code boundary, not a runtime plugin marketplace.
A backend is scheduling-eligible only when reviewed main-process code declares
and implements every capability below:

| Capability | Required proof |
|---|---|
| `exactSessionIdentity` | A non-reusable incarnation and exact backend-scoped session binding |
| `agentReadinessProof` | Positive agent lifecycle/readiness evidence, including running and approval states |
| `protectedPromptDelivery` | Bounded terminal-safe input with a provider-tested submit contract |
| `claimBoundDelivery` | Delivery locked to the durable claim with pre-write and post-write identity/input revalidation |

A partial adapter may be described by the core, but none of its target,
inspection, or delivery functions are called for unattended scheduling. This
allows a future terminal integration to expose discovery or focus elsewhere
without accidentally implying that pane control proves agent readiness.

## Authority-preserving routing

The core exposes three narrow operations:

1. Resolve a creation target through the explicitly selected backend.
2. Inspect an existing durable schedule through the backend named in the row.
3. Route an already-claimed occurrence to that same backend for guarded
   delivery.

Creation-target and inspection methods may be synchronous or asynchronous, so
a future daemon adapter does not need to pretend that RPC is local. The core
bounds these read-only calls to two seconds and treats timeout or failure as
`unavailable`. Claimed delivery is deliberately not detached by a generic core
timeout: once an adapter may have crossed its write boundary, it must resolve
only after the submit guard is closed and the occurrence has an at-most-once
result. Read-side adapter methods must never write to a PTY or mutate durable
backend state, because a timed-out promise is ignored rather than cancelled.
One store tick starts eligible row inspections concurrently, so its read-side
delay is bounded by the slowest adapter call rather than multiplied by the
100-row store limit; durable reconciliation still runs under one serialized
mutation.

Inspection has three outcomes:

| Outcome | Meaning | Durable behavior |
|---|---|---|
| `matched` | The backend proves the exact current binding | Continue eligibility checks |
| `unavailable` | The backend or its proof channel cannot currently answer | Keep the occurrence due; never rebind |
| `session_changed` | The session authority proves the original incarnation is gone or replaced | Disable permanently and require recreation |

Only the owning backend may return `session_changed`. A missing adapter,
transport outage, thrown inspection, or incomplete capability set is
`unavailable`, because absence of proof is not proof of replacement.

After a durable claim, an unknown result or backend exception is consumed as
`error`: the backend may already have crossed a partial-write boundary. A
backend known to be missing before its delivery method is invoked returns
`unavailable`. This preserves the existing at-most-once rule.

## Native backend

`orchestrator-pty-continuation-backend.js` is deliberately thin. It delegates:

- creation eligibility to `SessionRegistry.scheduleTarget()`;
- binding reconciliation to `SessionRegistry.scheduleBinding()`;
- claimed delivery to the existing guarded `deliverScheduledPrompt()` path.

`SessionRegistry` remains the only code with the private `node-pty` handle,
input revision, draft state, lifecycle receipt, bracketed-paste mode, and
per-session delivery guard. The adapter does not reproduce or weaken those
checks. Backend target metadata is reduced to the exact public binding fields;
environment values, executable paths, account homes, prompts, and PTY text
cannot escape through the core.

## Future adapters

A wmux integration should leave PTY identity and input authority in the wmux
daemon. Agent Orchestrator may become a control surface, but it must submit an
opaque backend-scoped target and let the daemon perform claim-bound identity,
readiness, input-revision, and protected-submit checks. Two independent
schedulers must never own the same occurrence.

A WezTerm integration is not eligible merely because `wezterm cli list` can
return a pane id or `send-text` can paste into it. It remains partial until a
cooperative authority supplies non-reusable incarnation, agent lifecycle,
approval/running state, concurrent-input revision, and guarded submission
proof. Arbitrary existing PowerShell, Windows Terminal, WezTerm, or wmux panes
are never adopted through PID, focus, title, liveness, or output heuristics.

## Adapter review checklist

Before enabling scheduling for another backend, add deterministic tests that
prove:

- capability loss never calls target, inspection, or delivery code;
- backend outage remains due and never becomes `session_changed` by inference;
- the same session id in another backend is never a fallback;
- private backend metadata is reduced to the public binding shape;
- identity is rechecked before paste and before submit;
- concurrent input and session replacement after paste prevent submit;
- partial writes and malformed post-claim results consume without replay;
- backend restart, id reuse, stale claims, and mixed versions fail closed;
- shutdown joins claimed work before the backend session is torn down.

This contract extends the app's strongest property: orchestration decisions are
backed by inspectable evidence, while input authority stays with the component
that can actually prove the target.
