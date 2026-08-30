# Exact-session prompt scheduling

Agent Orchestrator supports two deliberately different scheduling operations:

| Operation | Target | If the target disappears |
|---|---|---|
| **Continue this exact live session** | One currently live, lifecycle-confirmed routed Codex direct-agent PTY | Disable the row as `session_changed`; never retarget or launch |
| **Launch new work** | A saved workflow and its selected profiles | Start a new workflow operation through the existing scheduler |

Use exact-session continuation when later work depends on the current agent's
conversation. Use a scheduled workflow when work should start fresh after a
quota reset. There is no automatic fallback between them.

## User contract

- Choose **Direct agent** for a routed Codex profile. Account shells remain
  interactive shells and are not eligible.
- Complete at least one Codex turn. The schedule button remains disabled until
  main receives a capability-validated Codex turn-complete notification and
  observes the TUI enable protected bracketed-paste mode. The session must also
  currently be idle with no unsent draft when the row is created.
- Choose a future local date and time, or use **+1h**, **+5h**, or **+24h**.
- Optionally set a whole-minute repeat interval. A repeat skips missed slots
  and advances directly to its next future occurrence.
- The **Schedules** panel lists rows for every session. A row can be paused,
  resumed, or deleted unless a delivery claim is currently in flight.
- Keep Agent Orchestrator running. This feature does not register a Windows
  Scheduled Task, wake the machine, or start the app.

> **Plaintext warning:** prompt text is stored locally in plaintext in the
> app-owned schedule file. Never include passwords, tokens, credentials,
> private keys, or other secrets.

Deleting a row removes its stored prompt. Closing its session does not delete
the row: the next reconciliation preserves it as disabled `session_changed`
evidence. Ordinary app shutdown also preserves every record. Because PTYs do
not survive restart, enabled rows from a previous process cannot prove their
incarnation and become `session_changed` on the next launch.

Shutdown deliberately stops the scheduler before it tears down PTYs and does
not rewrite rows merely because the app itself is closing. The next process is
the authority that observes no matching incarnation and persists
`session_changed`. This keeps shutdown from masquerading as an explicit user
pause/delete while still preventing any later delivery.

## Why direct-agent mode exists

A routed account shell proves account selection, not provider presence. When a
provider launched inside that shell exits, the PTY can remain alive at an
ordinary PowerShell prompt. A profile label, process ID, tab title, quiet
terminal, and PTY liveness would all still look plausible. None is sufficient
for unattended input.

Direct-agent mode launches routed Codex through ai-agent-entrypoint's public
contract:

```text
agent-entrypoint target run codex:<alias> -- <codex arguments>
```

ai-agent-entrypoint remains the account-routing authority. Agent Orchestrator
does not read its manifest, derive account homes, or construct credentials.
The direct target exits with Codex, so it cannot silently fall back to a shell.

Codex receives a per-process `notify` command. After Codex reports
`agent-turn-complete`, a bundled helper sends a minimal receipt over an
app-owned Windows named pipe. The pipe registration is guarded by a random
capability token and the session incarnation. Direct mode explicitly enables
Codex's default secret-name filter, and every routing variable uses a
secret-shaped name. The pipe, token, and incarnation are therefore removed
from ordinary Codex shell-tool environments while the Codex-owned legacy notify hook retains
its launch-time environment snapshot. The receipt contains only:

- the capability token;
- the session incarnation UUID;
- the fixed `agent-turn-complete` event type.

No provider output, prompt, command, path, account home, environment value, or
credential is forwarded. The pipe and capability stay out of renderer session
metadata, and all three routing values stay out of ordinary tool-command
environments.
The PowerShell helper is only this lifecycle bridge; scheduling, timing,
identity decisions, and prompt delivery remain in Electron main.

This proof is currently provider-specific. Other providers and local profiles
remain unsupported until they offer an equally strong app-owned lifecycle
signal and a direct launch that cannot fall back to a shell. Output-idle regexes
are intentionally not used.

This is an operational safety boundary, not isolation from malicious software
already running as the same Windows user. A same-user process with process
memory access could attack any in-process app secret, including this capability.
Do not treat a direct session as a sandbox for untrusted local executables.

## Durable identity and storage

`SessionRegistry` mints a fresh cryptographically random UUID every time it
creates a PTY. It is independent of the PID, session id, timestamp, tab order,
and profile. A renderer may display the UUID, but it cannot choose it.

The bounded schedule record stores:

- schedule UUID;
- exact session id and incarnation UUID;
- expected profile and agent identities captured by main;
- plaintext prompt;
- next occurrence and optional repeat interval;
- enabled, created, and updated timestamps;
- last delivery result;
- optional claim UUID, occurrence time, and claim start time.

The renderer supplies only the session id, prompt, time, and optional interval.
It also echoes the displayed incarnation as a stale-target guard. Validated
main-process IPC resolves every authoritative identity from the live registry
and requires that guard to match. Delivery claim tokens never cross IPC; the
renderer receives only a `deliveryInFlight` fact. The store
allows at most 100 records, 16,000 characters per prompt, and a 2 MiB file. It
rejects unknown fields, invalid identities, unsupported schemas, duplicate
schedule ids, unsafe terminal controls, and out-of-range values.

All read-modify-write operations share one serialized queue, including create,
pause, resume, delete, reconciliation, claim, and finalization. Writes use the
app's temp-file, `fsync`, and rename path. A corrupt, oversized, or future store
fails closed: delivery stops, the UI receives a path-free diagnostic, and the
original file is preserved rather than overwritten with an empty store.

A legacy row with no incarnation is never rebound. It remains visible as
disabled `session_changed` evidence and must be explicitly recreated.

## Readiness and delivery proof

Immediately before a write, main proves every condition below:

1. the exact session exists and its PTY is running;
2. the random incarnation matches;
3. the expected profile and agent match;
4. the mode is direct-agent and the provider is supported;
5. a valid capability-matching Codex turn-complete notification has been
   observed;
6. the TUI has most recently enabled DEC private mode 2004 (bracketed paste);
7. the provider state is idle, not running or awaiting approval;
8. there is no unsent human draft;
9. no human or workflow input occurred within the 30-second quiet period;
10. no scheduled delivery is already in flight for that session.

Every renderer, workflow, and quick-send PTY write advances a main-owned input
revision. Submission marks a direct agent running. It cannot become idle again
until another capability-matching Codex notification arrives. An approval prompt
therefore remains busy rather than being inferred idle from quiet output.
A lifecycle notification never clears an app-observed draft: only an explicit
submit observed by main can do that. This prevents late or duplicate provider
receipts from turning foreign composer text into unattended input.
Exact bounded response sequences generated by the bundled xterm.js (device,
mode, size, colour, status-string, cursor-position, and focus reports) are
forwarded without impersonating composer input. Arbitrary terminal controls and
mouse/user data are not exempt and still invalidate a pending submit.

After the occurrence claim is durable, main validates and normalizes the prompt.
It rejects ESC, C0/C1 controls other than newline and tab, and bounds the body.
Main tracks the TUI's DECSET/DECRST 2004 output across PTY chunks; if protected
paste is not positively enabled, even a lifecycle-confirmed session remains
`unavailable`. This keeps a multiline body from becoming several submissions.
Then it:

1. writes the whole body between bracketed-paste delimiters through the private
   `node-pty` handle as one main-process operation;
2. waits 100 ms without releasing the per-session delivery guard;
3. revalidates incarnation, profile, agent, provider state, claim, and the exact
   post-paste input revision;
4. sends one carriage return only if every proof still holds.

Any intervening human/workflow input, session replacement, lifecycle change,
or native write error prevents Enter. Delivery never uses SendKeys, SendInput,
AttachConsole, clipboard automation, window focus, a renderer timer, or a
PowerShell timer/delivery broker. It also does not reuse the ordinary
human-paced double-Enter sequence: unattended delivery sends exactly one Enter
so it cannot answer a confirmation that appears after submission.

There is one unavoidable fail-closed residue: if human/workflow input wins the
100 ms post-paste race, main must not send Enter and cannot safely send Ctrl-U,
Escape, or backspaces without destroying the other input. The scheduled body
can therefore remain unsubmitted in the target composer. The occurrence is
consumed as `error`, and the row says **error — inspect target composer**. The
operator must inspect and clear or deliberately submit that draft. The app
never guesses which text it is safe to erase. Main keeps a sticky draft lock
after any possibly partial paste or submit, so a later provider receipt or
repeating occurrence cannot paste over the residue. A human submit clears that
lock; closing the session also makes its schedules permanently
`session_changed`.

## At-most-once outcomes

Main persists a new random claim before the first PTY write. The claim binds
one schedule occurrence and makes the crash boundary explicit.

| Result | Occurrence behavior |
|---|---|
| `busy` | Keep enabled and due; retry on a later tick |
| `unavailable` | Keep enabled and due; retry on a later tick |
| `sent` | Disable a one-shot, or advance a repeat directly to the next future slot |
| `session_changed` | Permanently disable; require recreation |
| `error` | Consume the occurrence; disable a one-shot or advance a repeat |

A consumed one-shot (`sent` or `error`) cannot be resumed. Repeating rows have
already advanced to a future slot; if a repeat stayed paused across additional
slots, Resume advances it directly to the next future slot instead of firing a
catch-up occurrence. Re-sending a consumed one-shot requires an explicit new
schedule and future time.

If the process crashes after claiming, the next process does not know whether
the PTY accepted part or all of the body. It waits for the bounded stale-claim
timeout, records `error`, and consumes the occurrence without replay. The same
rule applies to any exception after a write could have accepted a prefix.
Sending nothing is preferable to duplicating or misdirecting input.
The live store instance remembers the claims it minted, so a long-running
in-process delivery is never mistaken for crash residue by another mutation.
Only a newly started process, which owns no old tokens, performs stale recovery.

There is intentionally no lateness cut-off for `busy` or `unavailable`. If the
same proven PTY survives, an overdue occurrence remains due until it becomes
eligible, however late. Pause or delete it when that is no longer desired.

The scheduler loop is main-owned, idempotent to start/stop, and globally
non-overlapping. A second tick returns without competing for claims. App
shutdown clears the timer and joins any in-flight tick before PTY teardown. A
claimed occurrence therefore finishes its at-most-once result before shutdown
can remove its binding; a real crash still leaves durable evidence and follows
stale-claim recovery on the next launch.

## Verification boundary

Automated tests use fake PTYs and synthetic lifecycle receipts. They cover
incarnation and PID/session-id reuse, identity drift, lifecycle loss, running
and approval states, quiet time and drafts, simultaneous deliveries, durable
claims, stale claims, pause/delete races, post-paste input and replacement
races, sticky residual drafts, partial paste/submit writes, shutdown joining,
recurrence, corrupt/future stores, IPC validation, renderer controls, package
contents, and existing workflow tests without starting a real account.

`npm run verify:direct-argv` is a separate credential-free manual gate. It uses
the real `node-pty`/ConPTY/Pwsh boundary with a disposable echo script and a
helper path containing spaces, then proves that both Codex `-c` values arrive
byte-identically. It does not launch ai-agent-entrypoint, Codex, an account, or
a network request.

The remaining manual provider check is intentionally live and credential-safe:
start one routed Codex direct-agent session, complete a harmless turn, confirm
the UI becomes eligible only after its receipt, and schedule a harmless prompt
after the quiet period. Recheck this whenever Codex changes the semantics or
shape of its `notify` `agent-turn-complete` contract. Automated tests must not
touch a real account home or consume a live account turn.

## Design evidence

The durable claim, incarnation, post-paste revalidation, and no-replay crash
rules were adapted from the safety invariants reviewed in wmux
[PR #1083](https://github.com/openwong2kim/wmux/pull/1083) and
[PR #1099](https://github.com/openwong2kim/wmux/pull/1099), without taking a
runtime dependency on wmux or its daemon.

For the installed Codex `0.150.1` contract, the exact tagged source confirms
that the legacy notify hook receives a snapshot of the Codex process
environment while shell-tool environments independently apply the configured
secret-name filters: [hook environment snapshot](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/hooks/src/registry.rs) and
[shell environment policy](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/protocol/src/config_types.rs).
The app also probes the two `-c` overrides with the installed Codex config
parser during manual verification; this does not start an account or a turn.
