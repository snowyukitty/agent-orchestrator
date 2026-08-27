# Roadmap

Where Agent Orchestrator is heading, in order of intent. Dates are absent on
purpose — items land when they are verified, not when a calendar says so.

## Now (v0.4.x polish)

- **Truncation visibility** — the 📖 Runs view surfaces a journal-truncated
  run with the exhausted budget named (shipped).
- **Field guide live** — GitHub Pages at
  <https://snowyukitty.github.io/agent-orchestrator/>, mirrored on Cloudflare
  Pages (shipped).
- **Journal scale and retention** — stable cursor pages now read a rebuildable
  public-metadata index; count/age pruning is preview-first, user-confirmed,
  and excludes active runs (implemented on `main`, unreleased).
- **Protected resume preflight** — interrupted-run detail now advances from a
  cheap metadata gate to an explicit, revision-bound main-process inspection.
  It decrypts and validates the captured snapshot, proves nested-loop visit
  order, verifies protected results, classifies safe runtime reconstruction,
  and re-resolves profiles while returning only redacted facts. Execution is
  still absent (implemented on `main`, unreleased).
- **Promo media** — two HyperFrames explainers (product overview, 5-hour
  window) and a 30 s cinematic hero b-roll exist as candidates behind their
  human review gates; they attach to the README and website once reviewed. A
  one-shot verified key art image now fronts the README and social metadata.

## Next (v0.5)

- **Resume confirmation contract** — evolve the journal with protected runtime
  checkpoints and full profile-identity fingerprints, then add immutable child
  lineage plus a short-lived confirmation token bound to the source revision,
  verified facts, and an explicit `abort` / `skip` / `retry` disposition.
  Execution stays gated until the [resume design](resume-design.md)'s crash and
  no-double-effect matrix passes.
- **Licensing decision** — the repository is public but carries no license,
  which legally means "all rights reserved" and blocks adoption. Choosing one
  (MIT/Apache-2.0 vs. something protective) is an owner decision.
- **First tagged release** — a versioned GitHub Release with the packaged
  Windows build, once the license question is settled.

## Later

- **Website v2** — the dedicated marketing landing described in
  [website-plan.md](website-plan.md), unblocked by the promo media above.
- **More routed agents** — Claude Code / Grok / Gemini under managed (L1)
  routing is an ai-agent-entrypoint decision this app would consume, never
  implement itself.
- **Cross-platform** — the PTY layer is ConPTY-specific today; macOS/Linux
  support is a real port, not a build flag.

## Non-goals

A general DAG editor, transcript scraping into workflow values, storing
credentials, and becoming a source of account truth all stay out — the
[architecture doc](architecture.md) says why.
