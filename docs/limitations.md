# Limits and unfinished work

Agent Orchestrator states its boundaries rather than implying capabilities it
does not have. Everything below is current for v0.4.0.

- **Results are explicit, not transcript capture**: ordinary `Wait for Agent`
  and readiness-only `Join Agents` still observe bounded activity without
  creating a result. Only the opt-in framed payload is journaled or handed off;
  raw PTY history remains outside workflow values and the journal.
- **Handoff framing is not prompt-injection isolation**: prior-stage result
  bodies are labelled untrusted and delimiter-escaped, but they still enter the
  downstream agent's user prompt. Treat web, issue, and other third-party
  content as hostile; restrict downstream tools or require human review before
  a sensitive stage. v0.4 does not enforce an agent-native data channel.
- **Journal evidence is not automatic resume**: interrupted runs and their
  completed visits now receive a deterministic metadata assessment: blocked,
  review required, or recorded boundary. Even a recorded boundary is not an
  executable plan. Explicit protected inspection can decrypt and validate the
  captured snapshot and results, prove the visit prefix, classify runtime
  reconstruction, and re-resolve profiles. Journal v2 can persist protected
  control checkpoints and reviewed boundary dispositions, but preflight does
  not yet consume those checkpoints, issue confirmation receipts, create child
  runs, or execute a resume. See the [accepted design](resume-design.md).
  Workflows remain ordered block programs with structured Loop / End Loop
  pairs, not a general-purpose DAG.
- **Journal retention is explicit**: encrypted journal files are never pruned
  automatically. Individual deletion remains available, while preview-first
  retention can match terminal runs by count and/or age; active runs are always
  kept. A confirmed multi-record deletion has a durable recovery intent, but no
  policy confirms itself. Its opaque preview expires after ten minutes and an
  app restart. Cursor-paged listing reads a derived metadata index; destructive
  planning instead validates every canonical record. Startup recovery fails
  containment closed if active-run disposition, lineage, an accepted retention
  transaction, or an individual-delete transaction remains unknowable. Corrupt
  source records and coordination files are preserved for operator inspection
  rather than automatically quarantined or deleted; an unknowable accepted
  deletion can therefore keep journal admission disabled until it is repaired.
  Durable prune replay history is deliberately bounded.
- **CLI-specific prompt controls**: Highly interactive CLIs can consume the
  first Enter, so ordinary human-paced workflow/Quick Send submission still
  uses a deliberate double-tap. Guarded exact-session delivery is different:
  it sends one bracketed paste and exactly one Enter after revalidation. When a
  workflow needs proof of a semantic response, configure `Wait for Agent` or
  `Join Agents` with **Output contains**; idle-only completion observes silence,
  not success.
- **Exact-session prompts currently require routed Codex direct mode**: account
  shells are deliberately ineligible because a provider can exit back to
  PowerShell while the PTY remains alive. Claude Code, Grok, Antigravity, local
  profiles, and ordinary routed shells do not yet expose an app-owned,
  capability-validated provider lifecycle contract strong enough for unattended
  delivery. They fail closed rather than using output-idle heuristics. Codex
  readiness is still provider-specific and should be manually rechecked when
  its `notify` lifecycle contract changes.
- **The continuation core is pluggable, but only one backend is eligible**:
  `orchestrator-pty` is currently the sole adapter with exact identity,
  lifecycle readiness, protected input, and claim-bound delivery authority.
  No wmux or WezTerm runtime dependency is present. A pane id plus `send-text`
  is insufficient, so external PowerShell or terminal panes cannot be adopted
  or scheduled through focus, PID, title, liveness, or output heuristics.
- **Same-user malicious code is outside the lifecycle capability boundary**:
  direct mode excludes the pipe, random capability, and incarnation routing
  values from ordinary Codex shell-tool environments, but Windows processes
  already able to read another same-user
  process's memory are not isolated by this app. Do not run untrusted local
  executables in a direct session and treat the schedule as a malware boundary.
- **The app must remain running**: exact-session scheduling has no Windows Task
  Scheduler bridge and does not wake or relaunch the app. Ordinary app shutdown
  preserves rows but ends their PTYs; on next launch those vanished
  incarnations become disabled `session_changed` evidence and cannot resume.
  Recreate the schedule against a new direct session, or use a saved workflow
  under **Launch new work** when a new operation is intended.
- **Scheduled prompt bodies are plaintext**: unlike journal snapshots and
  explicit result bodies, exact-session prompts are intentionally stored in
  local app-owned JSON so they remain inspectable and manageable. Never put a
  password, token, credential, private key, or other secret in one. The store
  is bounded and atomically replaced, but it is not encrypted.
- **A post-paste race may leave an unsubmitted draft**: if another input arrives
  during the guarded 100 ms gap, the app follows the stronger rule and does not
  press Enter. It also does not guess at a cleanup key that could erase the
  human's text. The occurrence is consumed as an error and its row says to
  inspect the target composer before using that session again. A sticky
  main-owned draft lock blocks later schedules even if another provider
  completion receipt arrives. Explicitly submit the inspected composer text or
  close the session; the app never tries to erase it unattended.
- **Protected-paste proof follows terminal state**: main mirrors the raw
  DECSET/DECRST 2004 controls processed by xterm.js and also requires a
  provider lifecycle receipt. This positively proves the terminal's current
  paste mode, but the provider-side parser contract remains Codex-specific.
  Re-run the documented direct-session manual check when Codex changes its TUI
  input or `notify` behavior; unsupported providers remain fail-closed.
- **Terminal Layout Shifts**: Xterm dimensions may occasionally desync with the internal PTY dimensions if the window is resized very rapidly while a process is initializing.

Planned work lives in the [roadmap](roadmap.md); the accepted resume safety
contract is in [`resume-design.md`](resume-design.md).
