# Authoring a workflow without the editor

The block editor is the normal way to build a workflow. It is not the only
way. A scheduled pre-warm, a nightly job, or anything an agent sets up on your
behalf ends up as one JSON document in the app's workflow store, and writing
that document directly is a supported path.

Three things are easy to get wrong by hand: the document schema, whether the
accounts it names still exist, and which directory the app is actually
reading. One tool answers all three, using the app's own loader, the app's own
account discovery, and the app's own user-data rule — not a second copy of any
of them.

```powershell
npm run workflow -- where               # the store the app reads today
npm run workflow -- list                # stored workflows and their schedules
npm run workflow -- validate <file>     # parse with the real loader
npm run workflow -- check    <file>     # validate + resolve accounts + next trigger
npm run workflow -- install  <file>     # check, then write it into the store
```

It never launches an agent, never consumes a provider turn, and never starts
the app. `check` and `install` exit non-zero when something is wrong, so they
work as a gate in a script.

## The document

```jsonc
{
  "formatVersion": 2,
  "id": "wf-nightly-review",        // [A-Za-z0-9_-]{1,128}; also the filename
  "name": "Nightly review",         // ≤ 128 characters
  "defaultDirectory": "D:\\work\\repo",
  "blocks": [
    { "id": "blk-1", "type": "schedule", "params": { "datetime": "2026-09-09T05:15", "mode": "cron" } }
  ]
}
```

Blocks run top to bottom. Every block is `{ id, type, params }`, and **unknown
fields are rejected** rather than ignored — both on the document and on each
block's `params`. That is deliberate: a typo silently dropping a parameter
would be discovered by an unattended run at 05:15. Omitted parameters take
their documented default.

`datetime` is a local-time `YYYY-MM-DDTHH:MM` string, exactly as an
`<input type="datetime-local">` produces it. `once` fires at that absolute
moment; `cron` takes only the time of day and repeats daily.

## Block types

| `type` | Block | `params` |
|---|---|---|
| `schedule` | Schedule | `datetime`, `mode`: `once` \| `cron` |
| `directory` | Directory | `path` |
| `agentStart` | Agent Session | `profileId`, `settleMs` |
| `agentSend` | Send to Agent(s) | `profileId`, `text`, `pressEnter`, `expectResult`, `handoffFrom` |
| `agentWait` | Wait for Agent | `profileId`, `idleMs`, `pattern`, `timeoutMs` |
| `agentJoin` | Join Agents | `idleMs`, `pattern`, `timeoutMs`, `onIncomplete`: `stop` \| `continue`, `resultName` |
| `command` | Command | `command` |
| `wait` | Wait | `duration`, `unit`: `seconds` \| `minutes` \| `hours` |
| `input` | Send Input | `text`, `pressEnter` |
| `keypress` | Keypress | `key`: `enter` \| `ctrl+c` \| `ctrl+d` \| `escape` \| `tab` |
| `loop` / `loopEnd` | Loop / End Loop | `count` (on `loop`) |
| `log` | Log | `message` |
| `sleep` | Hibernate PC | `delay`, `unit` |

`npm run workflow` with no arguments prints this list from the running code,
which is the authority if this table ever drifts.

### Targeting accounts

`profileId` is an account id, not a display name:

- **Routed Codex** — `codex:<alias>`, discovered from `ai-agent-entrypoint`.
  This app never invents one; `npm run workflow -- check` lists the ones that
  resolve right now.
- **Local profile** — the id you gave it in the Agents panel, covering the
  CLIs that routing does not manage yet.
- **`@workflow-agents`** — on `agentSend` only: every agent lane this run
  opened. This is how one prompt fans out to several accounts.
- **`""`** — on `agentSend` / `agentWait`, the current session.

An `agentStart` with an empty `profileId` is an error, not a default. The run
refuses to start rather than opening an unintended account.

## What runs before anything launches

A run resolves its whole cast first. Every `agentStart` account is checked
against live discovery, and a workflow naming an account that no longer exists
fails immediately, naming it, with nothing opened. A renamed alias or a
deleted profile is therefore a startup error rather than a half-finished run
discovered the next morning. If the *check* itself cannot run, the run
proceeds — an unverifiable cast is not a failed one.

Each `agentStart` then waits for its provider's output to settle (`settleMs`
is the idle threshold, not a fixed sleep) and requires the session to still be
running. A lane whose agent exited while starting fails its own block, by
name, instead of being handed to a later Send.

That is liveness, not readiness. An agent sitting on a trust prompt, a login
screen, or a quota notice is alive and quiet. Start each account by hand once
in the directory the schedule uses, so an unattended run has nothing left to
ask, and use `pattern` (**Output contains**) on `agentWait` / `agentJoin` when
a stage genuinely depends on a semantic reply.

## Where the store lives

`npm run workflow -- where` prints it. On Windows it is normally:

```text
%APPDATA%\agent-orchestrator\workflows\<workflow id>.json
```

One trap is worth stating plainly, because it silently destroys data. The app
was renamed from a plural directory, and it migrates the old one on its first
launch **only if the canonical directory does not exist yet**. Creating that
directory by hand — an innocent `mkdir` before writing a file — cancels the
migration and strands the real settings and workflows in the old location.

So never guess the path. `where` and `install` resolve it the way the app
does, write to whichever directory the app is reading today, and say when a
migration is still pending.

The filename is the workflow's `id`, which is also how the editor names its
own saves; keeping them equal means a later Save from the GUI updates the same
record instead of creating a second copy.

## Installing and verifying

```powershell
npm run workflow -- check   .\prewarm.json     # gate
npm run workflow -- install .\prewarm.json     # atomic write into the store
```

A running app re-reads its workflow store every ten seconds, so an installed
schedule appears in the **Schedules** panel without a restart.

Then check the two things the document cannot promise:

- **The app has to be running when the time comes.** There is no Windows Task
  Scheduler bridge, nothing wakes the machine, and nothing relaunches the app
  after a reboot. Closing the window hides it to the tray, which is the
  intended state; while a run is pending the app holds off system sleep and
  releases that hold once nothing is scheduled. A missed one-shot is lost
  after a five-minute grace and never catches up — which is why a recurring
  job should use `cron`.
- **A completed block is not proof the work happened.** It means the engine
  got past it. Verify the effect where it actually lands: for a usage-window
  pre-warm, that is the account's own fresh 5-hour rate-limit window, not the
  Run Journal. See [the five-hour-window guide](five-hour-window.md).

## Worked example

Two accounts pre-warmed on the same clock minute — the shape the
**Usage-window pre-warm (two accounts)** template loads:

```json
{
  "formatVersion": 2,
  "id": "wf-prewarm-two-accounts",
  "name": "Pre-warm two accounts",
  "defaultDirectory": "D:\\work\\repo",
  "blocks": [
    { "id": "b-schedule", "type": "schedule",
      "params": { "datetime": "2026-09-09T05:15", "mode": "cron" } },
    { "id": "b-dir", "type": "directory",
      "params": { "path": "D:\\work\\repo" } },
    { "id": "b-lane-1", "type": "agentStart",
      "params": { "profileId": "codex:work", "settleMs": 2500 } },
    { "id": "b-lane-2", "type": "agentStart",
      "params": { "profileId": "codex:personal", "settleMs": 2500 } },
    { "id": "b-ping", "type": "agentSend",
      "params": { "profileId": "@workflow-agents",
                  "text": "ping. reply ok only. (usage-window pre-warm)",
                  "pressEnter": true, "expectResult": false, "handoffFrom": "" } },
    { "id": "b-join", "type": "agentJoin",
      "params": { "idleMs": 2000, "pattern": "", "timeoutMs": 180000,
                  "onIncomplete": "continue", "resultName": "" } },
    { "id": "b-exit", "type": "agentSend",
      "params": { "profileId": "@workflow-agents", "text": "/exit",
                  "pressEnter": true, "expectResult": false, "handoffFrom": "" } }
  ]
}
```

Put every account in **one** workflow rather than one workflow per account:
only a single workflow runs at a time, so two schedules set to the same minute
queue behind each other.

`/exit` is Codex and Claude Code syntax. Adjust the last block for whatever
the account's CLI actually uses, or drop it and close the tabs by hand.
