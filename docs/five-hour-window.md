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
4. Save the workflow, then leave Agent Orchestrator running — closing its
   window hides it to the tray rather than quitting. A main-process heartbeat
   keeps the schedule firing while the app sits in the tray with the screen
   locked, because a Node timer is not subject to Chromium's throttling of
   hidden renderers.

While any future run is pending, the app holds off system sleep for you, and
releases that hold as soon as nothing is scheduled. The display is still
allowed to turn off. What it does **not** do is register a wake timer, start
itself, or survive a reboot: it cannot bring back a machine you put to sleep by
hand, and after a restart you have to open it again. (The **Nightly run +
hibernate** template shows the reverse trick: work, then power down.)

## Pre-warming several accounts at once

Each account meters its own window, so pre-warm them in **one** workflow rather
than one workflow per account: only a single workflow runs at a time, and two
schedules set to the same minute would queue behind each other.

Open **🧩 Templates** and load **Usage-window pre-warm (two accounts)**. It is
the shape above with a second lane:

```text
⏰ Schedule        05:15 · cron
📁 Directory       a folder the agent is already trusted in
🤖 Agent Session   account A
🤖 Agent Session   account B
📨 Send to Agent   All workflow agents · "ping. reply ok only."
◇ Join Agents      continue on incomplete
📨 Send to Agent   All workflow agents · "/exit"
```

Add a lane per extra account. Every account's window then rolls over on the
same clock.

Two defaults in that template are deliberate:

- **cron, not once.** A one-shot pre-warm that misses its five-minute grace
  window — the app was closed, the machine was asleep — is simply lost, and
  you find out at 09:00. A daily cron gets the next morning back.
- **The barrier continues on incomplete.** A pre-warm exists to touch every
  account; one slow lane should not stop the others from finishing and exiting.
  Use *stop* instead when later blocks depend on every lane having answered.

You do not need a `Wait for Agent` between the lanes and the ping. Each
`Agent Session` block already waits for its provider's output to settle and
proves the session is still alive before the workflow moves on — a lane whose
agent never came up fails that block by name instead of silently handing a dead
session to the ping.

## Honest limits

- This does not create free usage; it shifts when a window you already pay
  for begins. Weekly and monthly caps are unaffected.
- Providers can change their metering rules at any time; verify the current
  behavior of your plan.
- A pre-warm ping is real usage on your account — keep the prompt trivial.
- The ping lands in whatever the agent shows first. An account that opens onto
  a trust prompt, a login screen, or a quota notice looks started and settled,
  so the ping goes into that screen and no window opens. Start each account by
  hand once in the directory the schedule uses, clear whatever it asks for, and
  the unattended run will have nothing left to ask.
- Check the result rather than assuming it: a pre-warmed account reports
  `used 0%` against a fresh 5-hour window, and the **Run Journal** shows the
  scheduled run's terminal status.
