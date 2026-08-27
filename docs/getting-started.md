# Getting started

From zero to your first automated agent run in about ten minutes.

## Prerequisites

- **Windows 10/11 x64** (the only packaged platform today; the app relies on
  Windows ConPTY for its terminals).
- **Node.js 22 or newer** with npm.
- At least one **CLI AI agent** installed and logged in — e.g. Claude Code
  (`claude`), Codex (`codex`), Grok, or Gemini CLI. The orchestrator drives
  the CLIs you already use; it does not replace their logins.

## Install and launch

```bash
git clone https://github.com/snowyukitty/agent-orchestrator.git
cd agent-orchestrator
npm ci
npm start
```

The app starts into a block editor on the left, terminal tabs on the right,
and lives in the system tray — closing the window hides it; quit from the
tray icon.

## Your first workflow (2 minutes)

1. Click **🧩 Templates** and pick **Claude Auto Session**.
2. Press **▶ Run**. Watch the terminal: the workflow opens Claude, waits for
   the prompt to be ready, types a ping, waits for the reply, and exits.
3. Open the **Log** pane to see the same run as a step-by-step timeline.

Every template is an ordinary editable workflow — drag blocks from the
palette, reorder them by their handles, and tweak parameters in place.

## The blocks in one paragraph

**Schedule** makes the workflow fire at a time (once, or daily with `cron`).
**Directory** sets the working directory. **Command** launches anything in the
terminal. **Agent Session** opens a session for a specific account.
**Send to Agent** types a prompt into one session, every session of one
agent, or all workflow sessions at once. **Wait for Agent** and
**Join Agents** watch real output (idle time and/or an "output contains"
pattern) instead of guessing with fixed delays — Join is the team barrier
that waits for *every* prompted session. **Loop / End Loop** repeats a
section. **Sleep** hibernates the PC.

## Adding accounts

Open the **Agents** panel:

- **Local profiles (L2)** — for Claude Code, Grok, Gemini: create a profile
  that points the CLI at its own state directory (e.g. `CLAUDE_CONFIG_DIR`).
  Launch it once and log in inside that tab; the login sticks to that profile.
  Profiles accept paths and flags only — anything that looks like a
  credential is rejected by design.
- **Routed accounts (L1)** — if you use `ai-agent-entrypoint` to manage Codex
  accounts, they are discovered automatically and launch fail-closed: an
  unresolvable alias refuses to start rather than falling back to the wrong
  identity.

Each session gets its own tab; all sessions keep running and buffering while
hidden. The **quick-send bar** under the terminal broadcasts an ad-hoc prompt
to the current session, one agent's sessions, or everything at once.

## Two things worth automating on day one

- **[The 5-hour-window pre-warm](five-hour-window.md)** — schedule a trivial
  early-morning ping so your metered usage window rolls over mid-morning and
  one working session spans two windows. Template: **Usage-window pre-warm**.
- **Parallel research → synthesis** — fan one question out to two accounts,
  collect one explicit framed result from each with a named **Join Agents**,
  and hand the complete bundle to a synthesis prompt. Template of the same
  name; results are journaled and inspectable under **📖 Runs**.

## Where things live

- Workflows: `%APPDATA%/agent-orchestrator/workflows/` (atomic writes,
  versioned format).
- Run journal: encrypted with the OS keychain via Electron `safeStorage`,
  inspectable in-app under **📖 Runs**. History loads in stable cursor pages.
  Retention by terminal-run count and/or age is previewed before confirmation;
  it never runs automatically and never deletes an active run. Interrupted-run
  detail reports whether evidence is blocked, ambiguous, or a recorded boundary.
  When the cheap gate passes, **Inspect protected evidence** asks main to decrypt
  the captured snapshot locally, prove its control-flow prefix, verify protected
  results, classify runtime reconstruction, and re-resolve profiles. Only
  redacted facts return to the Runs view, and no workflow is executed. See the
  [resume design](resume-design.md).
- Settings: `%APPDATA%/agent-orchestrator/settings.json`.

No telemetry, no analytics, no network calls of its own — the only processes
it talks to are the terminals you launch.

## Troubleshooting

- **Session opens then instantly dies** — the working directory doesn't
  exist, or the CLI isn't on `PATH` for the spawned shell.
- **Scheduled run missed while minimized** — the machine was asleep. The
  in-app heartbeat survives tray/lock but not sleep; disable sleep for the
  scheduled window or use a wake timer.
- **First Enter swallowed by an interactive CLI** — expected; typed
  submission deliberately double-taps Enter.
- **Waits that never finish** — prefer **Output contains** over idle-only
  completion when the agent streams slowly; idle observes silence, not
  success.
