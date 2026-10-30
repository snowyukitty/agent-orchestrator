# Unattended remote starts (W2b policy)

Status: **decided, not implemented.** This records when a target's task host
may start a task requested from another of the owner's machines, with nobody
at the target. It extends the [task host](task-host.md) contract; nothing here
is enabled until the gates in [Before the first unattended start](#before-the-first-unattended-start)
are demonstrated.

## Owner decisions (2026-10-30)

- **Machines.** `snowy-atlas` and `snowy-npc` are twin primary workstations.
  `snowy-legacy` is a third work machine with lower privileges.
  `snowy-campus` is a laptop with similar privileges to legacy but weak
  hardware, for simple work only.
- **Providers.** A target accepts Codex and Antigravity first, then Grok and
  Claude. Each needs its own adapter qualification on each target.
- **No target confirmation.** The controller's request is the authorization;
  the owner is often away, so a start never waits for a person at the target.
- **The session-state policy** below was delegated to the implementer and
  settled with an independent analysis by `codex:default` through ATD
  (advisory, 2026-10-30), adopted except where [Deviations](#deviations-from-the-advice)
  says otherwise.

The first direction is **atlas → npc**. npc → atlas is a separate enrollment on
atlas under the same rules.

## Session states

The host starts tasks only in the session it runs in: the owner's logged-in
interactive session. It never unlocks, switches sessions, logs anyone in,
moves to Session 0, or queues a request for later. A refused request is never
retried by the host.

| State at the target | Start | Running tasks |
|---|---|---|
| Unlocked, owner at the console or over RDP | admitted | continue |
| Locked, secure screen saver, display off | admitted **only for an adapter qualified in a locked session**; otherwise `provider-session-unqualified` | continue, nothing unlocks or wakes the display |
| Owner's RDP session disconnected, or switched away by fast user switching | same as locked | continue in the original session |
| Another user on the physical console | admitted in the owner's session only, under the locked rule; never on the active console | continue |
| Host's own session cannot be identified, or its state query fails | `session-state-unknown`; never guessed as unlocked | continue to their deadline |
| Host not running in an interactive session, or not as the enrolled owner | `session-not-interactive` / `session-owner-mismatch` | — |
| Owner logged off, app not running | nothing listens; the controller sees `host-unavailable` | ended with the session |
| Suspend in progress | `host-suspending` | sleep is respected, never vetoed |
| Asleep or unreachable | no answer; acceptance unknown if a request was in flight | resume checks the deadline before any further work |

**Observation.** The lock flag is read from Windows at admission
(`WTSQuerySessionInformation` for the host's own session: connection state
and lock flag), not from an event-only boolean that starts out "unlocked".
Electron's lock and power events invalidate the snapshot. A host started while
already locked must work without ever seeing a lock event.

## Power

| Condition | Start | Running tasks |
|---|---|---|
| On AC (any charge) | admitted | the host holds `prevent-app-suspension` while a task prepares, runs, or is checked, released on every exit path; the display may sleep, deliberate sleep still works |
| On battery | `battery-disallowed` | Stop, then evidence collection without host checks |
| Power state unknown | `power-state-unknown` | Stop |

There is no battery opt-in in the first version; the campus laptop simply
works when plugged in.

## Per-host profiles

An owner-controlled, versioned `remoteTaskPolicy` in each host's settings
holds the enrolled owner, the machine profile, the provider/route/workspace
allowlists, and the limits. A request can never select or weaken a profile,
and the hostname never implies one.

| Setting | atlas, npc | legacy | campus |
|---|---|---|---|
| Remote starts on a fresh install | off | off | off |
| Concurrent tasks (one per repository) | 2 | 1 | 1 |
| Task deadline, including checks | 2 h | 1 h | 20 min |
| New tasks per rolling 24 h | 24 | 12 | 4 |
| Battery starts | no | no | no |

The daily count is a runaway brake, not a cost cap. Accepted launches reserve
their slot durably before the acknowledgement; a duplicate launch ID reserves
nothing.

## Before the first unattended start

Each is required and must be demonstrated, in this order of importance:

1. **Authenticated, fresh, target-bound requests.** The W2b envelope binds
   the exact launch digest and the destination host, and is valid for at most
   60 seconds; an expired request is `authorization-expired` and never held.
   A retry of an accepted launch ID returns its observation even after expiry
   and never authorizes a new spawn.
2. **Process ownership at the collection boundary.** Before evidence is
   frozen, the host snapshots the provider's descendants, ends the tree, and
   requires that none of them survive; root exit alone no longer makes a
   collection stable. Host checks run in their own bounded tree.
3. **Session observation** as above, plus a **locked-session qualification**
   per adapter: one live turn started and completed while the target is
   locked.
4. **Power policy** as above, with the suspension blocker released on every
   path.
5. **Owner-visible activity**: a `list` operation and a controller view show
   accepted, running, failed, and needs-review launches without terminal
   content, and survive transport loss.
6. **Quiet windows**: task windows open without taking focus, and their title
   carries no route alias or instruction text.

## Deviations from the advice

- **Network cost (metered, roaming) is not a first-version gate.** The
  machines are on unmetered home networks and the providers bill by plan, not
  by traffic; reading Windows' connection cost from Electron needs a native
  bridge. It is recorded here as a known gap, to revisit for the laptop.
- **Process ownership uses a descendant snapshot and verified tree end, not
  Job Objects.** Assigning a ConPTY child to a job at creation needs a native
  module under node-pty. The snapshot still makes "stable" mean "no surviving
  descendants", which is the property that matters for evidence; Job Objects
  stay the stronger later option.
- **Limits are larger on the twin primaries** (2 h, 24/day, 2 concurrent
  instead of 30 min, 8/day, 1) because real tasks there are full development
  work; the smaller machines keep the advice's conservative shape.
- **No content-reveal step in the task window.** The machines are the owner's
  own, and a locked session already hides the window; the title is made
  neutral instead.

## What stays true

Unattended starts change who is present, not what is claimed. No containment,
no rollback, `needs-review` only, `effectReconciliation: not-performed` after
Stop, and evidence that is evidence, not proof that anyone saw the window.
