# Static field guide

`docs/index.html` is the zero-build, zero-backend product guide for Agent
Orchestrator. The current guide covers assurance-aware account launch, true
fan-out-before-join team stages, explicit result handoff, the durable Run
Journal, immutable run snapshots, non-destructive scheduled execution, and
versioned workflow loading. It is intentionally plain HTML, CSS, and
JavaScript:

- no package install or build step;
- no API calls, analytics, forms, cookies, or remote runtime assets;
- a restrictive Content Security Policy with `connect-src 'none'`;
- usable directly from the filesystem and ready for a future `/docs` static
  hosting source;
- interactive examples are planning aids only and never read application data.

The recipe composer always places every role-specific send before one shared
`Join Agents` barrier. Its simulation demonstrates stage readiness. Result
handoff is a separate explicit mode: only bounded, framed results are kept,
while raw terminal history remains ephemeral. Interrupted records first receive
a conservative metadata-only evidence assessment. An explicit protected
preflight can then decrypt and validate the captured snapshot in main, prove
the nested-loop visit prefix, verify result bindings, classify runtime state,
and re-resolve current account authority. Its report is redacted and still
never enables execution; the guide does not claim automatic resume or general
DAG execution. The accepted safety contract lives in
[`resume-design.md`](resume-design.md). Framing preserves boundaries; it does
not neutralize indirect prompt injection. Results derived from untrusted
sources still require restricted downstream tools or human review before a sensitive stage. For
routed Codex accounts, an Agent Session workflow block waits for the
account-shell readiness signal and invokes the session-local `codex` wrapper
with a fixed trailing shell exit; opening the same account manually still
leaves you at its interactive shell. Generated result contracts and handoffs
use a separate main-process input capability: shell profiles, manual tabs, and
composite custom commands cannot receive them. Retained journal records are
individually size-bounded and remain the source of truth. Listing uses stable
cursor pages from a rebuildable public-metadata index; preview-first count/age
retention is never automatic and never selects active runs. Startup recovery
still validates source records because an unknowable active run must fail
containment closed.

The `assets/promo/` frames carry the whole outward face: the field guide's
proof section, the README hero, and the `og:image` / Twitter card are all
`01-workflow-editor.png`. They are deterministic captures of the real renderer
using an inert fixture. The capture launches no account,
agent, or PTY and reads no production data. `assets/promo/manifest.json`
records exact dimensions and hashes, and `npm run check` verifies those receipts
against the PNGs, their field-guide references, the social metadata, and the
README hero. The earlier AI-generated key art was removed on 2026-08-29: it was
abstract, off-product, and strictly worse than showing the app. The creative and
publication boundary lives in [`promo-creative-brief.md`](promo-creative-brief.md).

Three local HyperFrames candidates now use one clean English spoken master per
film with selectable English, Japanese, and Traditional Chinese SRT/VTT tracks:
the 89.7 s overview, 87.8 s five-hour explainer, and 50.6 s proof-first
functional hero. Their human gates remain pending, so this field guide embeds
the authentic stills but neither a video nor a placeholder Release URL. After
approval, the reviewed clean MP4 belongs in GitHub Releases and the guide should
reference all three WebVTT sidecars with native `<track>` elements, with the
editor capture as the poster frame.

Open `docs/index.html` in a browser to review it. Run `npm run check` to validate
its local references, anchor targets, security boundary, and JavaScript syntax.

For the maintainer-facing process model, routing boundary, persistence rules,
and verification layers, see [`architecture.md`](architecture.md).

GitHub Pages publishes this directory at
<https://snowyukitty.github.io/agent-orchestrator/>, and the same static
artifact is mirrored at <https://agentorch.pages.dev/>. Changing
either publication surface remains an explicit repository-owner action.
