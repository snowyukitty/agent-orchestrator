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
  executable plan; snapshot decryption, control-state reconstruction, runtime
  rebuilding, and profile re-resolution remain future preflight work. See the
  [accepted design](docs/resume-design.md). Workflows remain ordered block
  programs with structured Loop / End Loop pairs, not a general-purpose DAG.
- **Journal retention is explicit**: encrypted journal files are never pruned
  automatically. Individual deletion remains available, while preview-first
  retention can match terminal runs by count and/or age; active runs are always
  kept. Cursor-paged listing reads a derived metadata index. Startup recovery
  still validates retained source records so an unknowable active run fails
  containment closed, and a dirty or corrupt index is rebuilt from those files.
- **CLI-specific prompt controls**: Highly interactive CLIs can consume the first Enter, so typed submission still uses a deliberate double-tap. When a workflow needs proof of a semantic response, configure `Wait for Agent` or `Join Agents` with **Output contains**; idle-only completion observes silence, not success.
- **Terminal Layout Shifts**: Xterm dimensions may occasionally desync with the internal PTY dimensions if the window is resized very rapidly while a process is initializing.

Planned work lives in the [roadmap](roadmap.md); the accepted resume safety
contract is in [`resume-design.md`](resume-design.md).
