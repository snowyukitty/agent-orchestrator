# Getting two usage windows out of one working morning

Most subscription CLI agents (Claude Code, Codex, and similar plans) meter
usage in a **rolling 5-hour window** that starts at your *first message*, not
at a fixed clock hour. If you sit down at 09:00 and send your first prompt,
your window runs 09:00–14:00 — and a heavy morning can exhaust it before
lunch.

Agent Orchestrator's scheduler turns that rule to your advantage.

## The pre-warm pattern

Schedule a trivial "ping" a few hours before you start working:

```text
05:00  scheduled workflow opens the agent, sends "ping", exits
       → the provider's 5-hour window is now 05:00–10:00
09:00  you sit down and work — inside the tail of that window
10:00  the window rolls over; your next prompt opens a fresh 5-hour window
       → 10:00–15:00
```

You worked from 09:00, but by 10:00 you are already on your **second**
window. Without the pre-warm, the first window would have lasted until 14:00
and the same budget would have arrived four hours later.

Tune the ping time to your own burn rate:

- Start work at 09:00, burn tokens fast → ping at **04:30–05:00** so the
  rollover lands 60–90 minutes into your session.
- Lighter usage → ping at **06:00** and the rollover arrives at 11:00, when a
  fast start would actually need it.
- The ping itself costs a few tokens — one short prompt and an exit.

## Setting it up

1. Open **🧩 Templates** and load **Usage-window pre-warm**.
2. Set the **Schedule** block's time to your chosen ping time and leave mode
   as **cron** (repeats daily at that clock time).
3. Point the **Command** block at the agent you want to pre-warm (the default
   opens Claude Code; swap in your Codex launch or a routed account session).
4. Save the workflow. Agent Orchestrator's main-process heartbeat keeps the
   schedule firing even while the app sits in the tray with the screen locked
   — the machine only has to be awake.

To keep the machine awake overnight, either disable sleep for that period or
combine this with your platform's wake timers; the app deliberately does not
change power settings behind your back. (The **Nightly run + hibernate**
template shows the reverse trick: work, then power down.)

## Pre-warming several accounts at once

Each account meters its own window. With multi-account sessions you can
pre-warm all of them in a single scheduled workflow: add one `Agent Session`
block per account, then a `Send to Agent → All workflow agents` ping, and a
`Join Agents` barrier so the run only ends after every account has answered.
Every account's window then rolls over on the same clock.

## Honest limits

- This does not create free usage; it shifts when a window you already pay
  for begins. Weekly and monthly caps are unaffected.
- Providers can change their metering rules at any time; verify the current
  behavior of your plan.
- A pre-warm ping is real usage on your account — keep the prompt trivial.
