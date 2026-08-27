# Interrupted-run resume design

Status: accepted design; metadata evidence gate implemented; execution not
implemented.

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

The current build therefore adds only a conservative, metadata-only evidence
assessment. **📖 Runs** can explain why an interrupted record is blocked, needs
a decision, or contains a recorded boundary. It deliberately exposes no
Resume button and always reports `executionAvailable: false`.

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

The blocker set currently includes an unsupported journal/workflow version,
memory-only workflow snapshot, journal truncation, a visit without a block
index, a memory-only result body, and structurally invalid evidence. An
interrupted visit, a failed/cancelled prior visit, or a partial result requires
review. Reasons are stable machine-readable codes with renderer-owned copy.

`recorded-boundary` is intentionally narrower than “resumable.” It does not
prove that protected bytes can still be decrypted, that the loop cursor can be
reconstructed, that a prior team stage can be rebuilt, or that referenced
profiles still resolve.

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

## Journal evolution

The executable phase should introduce a deliberate journal schema migration,
not silently reinterpret v1 records. The minimum additions are:

- public lineage IDs: root run, parent run, and attempt number;
- a protected control checkpoint bound to the source run and last committed
  visit, containing only the state that cannot be proved from the trace;
- a one-time preflight token/fingerprint held in main memory, never persisted
  as authority;
- an explicit boundary disposition (`abort`, `skip`, or `retry`) when a human
  reviews an uncertain visit.

Machine-local paths, environment values, commands, prompts, result bodies,
session output, and account homes stay out of public checkpoint metadata.
Checkpoint protection uses the same context-bound encrypted envelope pattern
as workflow and result bodies. No plaintext fallback is added.

## UX contract

The Runs detail card is evidence, not a call to action:

- **Evidence blocked** names every cheap-gate reason.
- **Decision required** explains that an external effect may already have
  happened.
- **Boundary recorded** says exactly which deeper checks remain undone.
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
