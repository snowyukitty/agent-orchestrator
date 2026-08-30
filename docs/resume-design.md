# Interrupted-run resume design

Status: accepted design; metadata gate, protected deep-inspection preflight,
and Journal v2 persistence groundwork implemented; confirmation and execution
not implemented.

## Decision

Agent Orchestrator will treat restart-from-evidence as a new run derived from
an interrupted run, never as continuation of the old process. The source run
remains immutable. A resume attempt must pass a main-owned preflight, show an
exact preview, receive explicit confirmation, and create a new journal run
with lineage back to its source.

An `interrupted` status alone is not permission to resume. A process may have
completed an external side effect immediately before the journal lost the
chance to record completion. Retrying that visit automatically could submit a
prompt twice, run a command twice, or arm hibernate twice.

The current build therefore starts with a conservative, metadata-only evidence
assessment. When that gate is not blocked, **📖 Runs** exposes **Inspect
protected evidence**: an explicit, revision-bound main-process preflight that
decrypts locally and returns redacted facts. It deliberately exposes no Resume
button and always reports `executionAvailable: false`.

## Non-negotiable invariants

1. **No implicit replay.** A visit recovered as `interrupted` is never retried
   automatically, regardless of block type.
2. **Completed side effects stay completed.** Resume skips completed visits;
   it may reconstruct local engine state without re-emitting their external
   effects.
3. **Fail closed on missing evidence.** Truncated journals, memory-only
   snapshots, required memory-only results, unsupported formats, and ambiguous
   control addresses cannot become executable plans.
4. **Use the captured workflow.** Resume never reads the current editor or a
   newer saved workflow as its program.
5. **Re-resolve account authority.** Managed Codex profiles are resolved again
   through `ai-agent-entrypoint`; local profiles retain their honest `L2-env`
   assurance. Missing or changed profiles stop preflight.
6. **Do not adopt arbitrary sessions.** Manual sessions remain untouched.
   Runtime reconstruction may create new workflow-owned sessions, but it does
   not attach to a pre-existing PTY.
7. **Never expose protected bodies by inspection.** Run listing and detail
   remain metadata-only. Snapshot/result plaintext is decrypted only inside an
   explicit, trusted preflight and never enters the metadata index or logs.
8. **A resume is a child run.** The interrupted source record is never changed
   back to `running`; retention, audit, and failure history remain truthful.

## Evidence states shipped now

`src/main/resume-evidence.js` is a pure first gate over public journal
metadata. Its result is included in run detail but is not persisted as another
source of truth.

| State | Meaning | Execution |
|---|---|---|
| `not-applicable` | The run is not interrupted. | unavailable |
| `blocked` | Known evidence loss or incompatibility exists. | unavailable |
| `review-required` | Evidence is durable, but a visit/result has an ambiguous or non-complete outcome. | unavailable |
| `recorded-boundary` | The cheap gate found a durable, untruncated visit boundary. Deep preflight has not run. | unavailable |

The blocker set currently includes an unsupported journal version, memory-only
workflow snapshot, journal truncation, a visit without a block index, a
memory-only result body, and structurally invalid evidence. Workflow format
compatibility belongs to the shared versioned loader in deep preflight rather
than a duplicated metadata allowlist. An
interrupted visit, a failed/cancelled prior visit, or a partial result requires
review. Reasons are stable machine-readable codes with renderer-owned copy.

`recorded-boundary` is intentionally narrower than “resumable.” It means the
cheap gate has enough durable metadata to offer protected inspection. Until the
user runs that inspection it does not prove that protected bytes can still be
decrypted, that the loop cursor can be reconstructed, that a prior team stage
can be rebuilt, or that referenced profiles still resolve.

## Deep-inspection states shipped now

`src/main/resume-preflight.js` is the second gate. It runs only after an
explicit renderer request and re-reads the source under its journal lock. The
request must name the exact displayed revision; a stale request fails before
decryption.

| State | Meaning | Execution |
|---|---|---|
| `blocked` | A protected snapshot/result, legal trace, runtime recipe, directory, or current profile check failed. | unavailable |
| `decision-required` | The trace is valid, but its final visit or result evidence remains non-complete or ambiguous. | unavailable |
| `boundary-verified` | All implemented inspection stages passed and visits remain. This is evidence, not authority. | unavailable |
| `no-remaining-work` | The legal visit prefix already reaches workflow end. | unavailable |

The report returns stage states and counts plus a redacted boundary/next visit:
block index, block type, and loop iteration numbers. It does not return block
IDs, profile IDs, paths, prompts, commands, result bodies, raw validator
messages, or session data. The snapshot and result plaintext exist only within
the main-process call.

## Why ordered visits are necessary but insufficient

The v1 journal already retains the immutable workflow identity, ordered block
visits, block indices, loop iteration paths, terminal states, and explicit
result bindings. This is enough to distinguish a clean between-block boundary
from a crash during a block.

It does not persist all volatile engine state:

- the exact next program counter and loop-frame stack;
- the current workflow-owned session graph;
- which agent lanes are pending at a future Join;
- main-process output checkpoints and result-capture tokens;
- whether an unrecorded external effect completed just before a crash.

Reconstructing those values by guessing from the last visit would be unsafe,
especially inside nested loops or between `Send to Agent` and `Join Agents`.
The first executable version therefore needs a protected control checkpoint or
a deterministic reconstruction proof, not merely “last block index + 1.”

## Block policy

The deep preflight classifies the interrupted boundary by semantics, not just
position.

| Class | Blocks | Policy |
|---|---|---|
| Control state | Schedule, Directory, Loop, End Loop | Recompute state from the immutable snapshot and completed trace; do not emit an external action. |
| Local observation | Log, Wait | Skip completed visits. An interrupted wait/log still follows the explicit-decision rule. |
| Runtime construction | Agent Session | Recreate a new workflow-owned session only after profile re-resolution; never adopt a manual session. |
| External effect | Command, Send to Agent, Send Input, Keypress, Hibernate PC | Skip completed visits. An interrupted visit is ambiguous and defaults to abort; future UI may offer explicit skip or retry with a warning. |
| Session observation | Wait for Agent, Join Agents | Old PTY signals are not durable. Continue only from a proven durable result/checkpoint; otherwise restart the whole team stage or block. |

This table is a minimum policy. A block may impose a stricter rule after the
snapshot is inspected—for example, a future Send that references an
unavailable result cannot proceed even if the visit boundary itself is clean.

## Main-owned preflight

An executable implementation must complete these steps in order:

1. Re-read the source record under its journal lock and bind the request to its
   run ID and revision.
2. Re-run the metadata evidence gate. Do not decrypt if the cheap gate is
   already blocked.
3. Ask OS-backed storage to decrypt the workflow envelope; verify its bound
   context, canonical byte length, and supported format.
4. Validate every block and parameter using the same versioned workflow rules
   as a normal load. Unknown future blocks fail closed.
5. Reconstruct the program counter and loop frames from a protected checkpoint
   or prove them by deterministically replaying control-only transitions
   against the ordered visits.
6. Rebuild result bindings from independently protected, complete results.
   Never substitute raw PTY history.
7. Classify runtime state. Recreate safe workflow-owned session recipes;
   reject an unresolved pending team stage or uncertain external-effect visit.
8. Resolve every referenced profile against current main-process authority.
   Surface assurance changes without exposing environment values or paths.
9. Return a redacted preview: visits skipped, boundary decision, next block,
   result availability, sessions to recreate, assurance changes, and blockers.
10. Require a fresh confirmation token bound to the source revision and
    preflight facts. On confirmation, atomically create a child run with a new
    operation ID and immutable lineage, then execute that child snapshot.

If the source is deleted, its revision changes, a profile changes, decryption
availability changes, or the preview expires, confirmation fails and a new
preflight is required.

### Current implementation boundary

| Step | Current build |
|---|---|
| Source lock + revision binding | Implemented; stale requests stop before decryption. |
| Metadata gate | Implemented; blocked evidence is returned without decrypting. |
| Snapshot protection/integrity | Implemented; context, canonical bytes, byte length, and public metadata are checked. |
| Versioned workflow validation | Implemented by the same Node-compatible ESM loader used by the renderer; current v2 and migratable v1 identities are covered. |
| Control cursor proof | Implemented by reproducing `WorkflowEngine._drive` visit addresses through nested loops under the same one-million-step limit. |
| Result bindings | Every protected body is decrypted and length-checked internally; every future handoff must have the latest verified complete producer result. |
| Runtime reconstruction | Conservative classification implemented. Directory state and session recipes can be derived; a pending team stage or an opaque prior session dependency blocks. Journal v2 can persist and verify a narrow protected checkpoint, but preflight does not consume it and actual session creation remains pending. |
| Profile authority | Every explicit referenced profile is resolved again by main. Missing profiles and observable assurance changes block. Historical full-identity fingerprints do not exist in journal v1; the report counts profiles without a baseline instead of pretending it proved identity continuity. |
| Redacted preview | Implemented as five stage cards plus boundary/next visit. No confirmation token is issued. |
| Confirmation, lineage, execution | Public root/parent/attempt fields are present, but no child-run creation, confirmation receipt, or execution path is implemented. `executionAvailable` is false in every report. |

## Journal evolution

The Journal v2 data layer introduces a deliberate schema migration rather than
silently reinterpreting v1 records. It implements these persistence additions;
the main-memory preflight receipt remains deliberately deferred:

- public lineage IDs: root run, parent run, and attempt number;
- a protected control checkpoint bound to the source run and last committed
  visit, containing only the state that cannot be proved from the trace;
- a one-time preflight token/fingerprint held in main memory, never persisted
  as authority (**not implemented in this milestone**);
- an explicit boundary disposition (`abort`, `skip`, or `retry`) when a human
  reviews an uncertain visit.

The implemented source-side disposition is a one-time, append-only audit fact,
not execution authority. Recording it advances the source revision and thereby
invalidates an older preflight. A future receipt-authorized child must still
record its own chosen disposition under the confirmation contract below.

The same data-layer checkpoint hardens evidence retention before any child can
exist. Destructive previews are derived from a complete validation of canonical
run records, not the public index. A confirmed multi-record prune persists one
path-free intent and replays descendant-first deletion after a crash; retained
descendants protect their ancestors. Cross-record lineage validation rejects a
missing root, a missing or wrong-attempt parent, duplicate attempt siblings, and
descendants of an invalid parent. The preview token is random, process-local,
and expires after ten minutes; durable, bounded retention receipts carry no
execution authority. Individual deletion also records a recoverable intent and
removes canonical evidence before its migration backup. Capacity-degraded calls
expose deterministic `durable: false` identities, never label a dropped result
body as stored evidence, and cannot add a protected control checkpoint.

Machine-local paths, environment values, commands, prompts, result bodies,
session output, and account homes stay out of public checkpoint metadata.
Checkpoint protection uses the same context-bound encrypted envelope pattern
as workflow and result bodies. No plaintext fallback is added.

### Confirmation receipt contract (next implementation)

The confirmation boundary is now specified tightly enough to implement without
inventing authority in the renderer. A successful deep preflight may create one
short-lived, main-memory receipt with these bindings:

- source run ID and exact journal revision;
- hash of the validated workflow snapshot and protected control checkpoint;
- hash of the proven visit prefix, result bindings, and redacted plan facts;
- current profile-resolution fingerprint, including assurance level;
- the allowed boundary dispositions (`skip` or `retry`) when a human decision
  is required; an unambiguous between-block boundary allows only `continue`;
- renderer document epoch, creation/expiry time, and a cryptographically random
  one-time token.

The renderer receives only the opaque token, expiry, allowed dispositions, and
the already-redacted preview. It cannot alter a snapshot hash, block address,
profile identity, or session recipe. A confirmation request contains the token,
source run ID, displayed revision, and one allowed disposition; all other facts
come from the main-memory receipt.

Main handles confirmation under the journal's source/creation lock:

1. Reject an absent, expired, previously consumed, or wrong-document token.
2. Re-read the source and require the same revision and protected-envelope
   hashes; re-resolve every profile and require the same fingerprint.
3. Recompute the plan fingerprint from protected evidence and compare it in
   constant time. Any mismatch destroys the receipt and requires a new
   preflight.
4. Validate the requested disposition against the receipt. Uncertainty defaults
   to `abort`; omission is never treated as `skip` or `retry`.
5. Reserve a unique operation ID and atomically persist a new child journal
   record with `rootRunId`, `parentRunId`, `attempt`, source revision, chosen
   disposition, and protected checkpoint before admitting any session or
   external effect.
6. Consume the token exactly once. If later session construction or execution
   fails, the child run records that failure; the same token cannot be retried.

Renderer navigation, app shutdown, source deletion, revision change, profile
change, and expiry invalidate receipts. Receipts are never restored after a
restart and never enter the public index, logs, exports, or journal ciphertext.
Token consumption and child creation must be crash-tested around every durable
write: a crash may leave no child or one truthful non-running child, never an
unrecorded execution and never two children with the same operation ID.

## UX contract

The Runs detail card is evidence, not an execution call to action:

- **Evidence blocked** names every cheap-gate reason.
- **Decision required** explains that an external effect may already have
  happened.
- **Boundary recorded** offers **Inspect protected evidence** and names which
  deeper checks have not run.
- **Boundary verified** means the implemented protected checks passed; it still
  offers no retry/skip choice and no execution action.
- every state explicitly says resume execution is unavailable in this build.

The future Resume action appears only after deep preflight succeeds. Its
confirmation must name the source run, show the next block and loop iteration,
list any sessions that will be recreated, and make an uncertain visit's
`skip`/`retry` choice impossible to overlook. The default for uncertainty is
always Abort.

## Verification required before execution ships

- crash injection before and after every journal mutation for every block
  class;
- nested-loop boundaries, zero-count loops, and maximum visit histories;
- duplicate operation IDs and concurrent/stale resume confirmation;
- unavailable/corrupt OS decryption and memory-only source data;
- deleted, renamed, assurance-changed, and unresolved profiles;
- pending fan-out/join stages and complete/partial/missing result bundles;
- proof that completed external-effect visits are never emitted twice;
- process cleanup proving a failed resume leaves no orphaned PTY;
- renderer containment proving a navigation cannot reuse an old preflight;
- package/privacy inspection proving no protected body or path enters public
  metadata, logs, exports, or the rebuildable index.

Until those cases are green, `executionAvailable` remains false.
