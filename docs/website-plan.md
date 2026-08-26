# Website plan — `agent-orchestrator.pages.dev` (future work)

Status: **design only, deliberately not built yet.** The GitHub-hosted field
guide (`docs/index.html`, served by GitHub Pages) stays the primary product
page; the Cloudflare Pages site is a secondary marketing mirror we build when
the promo assets exist.

## Positioning

One sentence: *"Orchestrate every CLI AI agent account you own — schedule
them, fan prompts across them, and join their answers — from one desktop
app."*

Three pillars, in the order visitors should meet them:

1. **The 5-hour-window trick** — the concrete, money-shaped hook. Lead with
   the 05:00-ping → two-windows-per-morning timeline (see
   [`five-hour-window.md`](five-hour-window.md)). This is the headline demo.
2. **Multi-account fan-out → join** — several accounts typing concurrently,
   one barrier, explicit result handoff into a synthesis prompt.
3. **Safety posture** — fail-closed routing, no stored credentials, sandboxed
   renderer, journaled runs. Trust is the differentiator over ad-hoc scripts.

## Page structure (single page + guide links)

- **Hero**: product name, one-liner, a looping muted video (HyperFrames
  render) of the block editor firing a scheduled multi-account run. Buttons:
  "Get it on GitHub" (primary) → repo; "Field guide" → GitHub Pages guide.
- **The 5-hour-window section**: animated timeline graphic (05:00 ping →
  09:00 work → 10:00 rollover). One paragraph, one "how to set it up" link.
- **Fan-out demo**: short clip of `Send to All` typing into three terminals
  concurrently, then `Join Agents` progress `2 / 3 ready` → `3 / 3`.
- **Assurance table**: L1 routed / L2 env / L0 native, verbatim from README.
- **Run journal**: screenshot of the 📖 Runs view; one paragraph on immutable
  snapshots and interrupted-run evidence.
- **Footer**: GitHub, security policy, no analytics statement.

## Media assets to produce first (blockers for the build)

| Asset | Tool | Notes |
|---|---|---|
| Hero loop (10–20 s, no audio) | HyperFrames (`snowy-hyperframes` pipeline) | storyboard: schedule fires → sessions open → join completes |
| 5-hour-window explainer (60–90 s, narrated) | HyperFrames + Edge-TTS | the flagship promo video; also embedded in README via Release asset |
| Fan-out/join clip | Screen capture of the real app | authenticity beats composition here |
| Key art / social card | grok:a image gen or `/web-img` | 1200×630 OG image, block-editor motif |
| Optional cinematic teaser | Google Flow (`web-flow` skill) | costs real credits; only with explicit go-ahead |

## Technical shape

- Static only, no build step — same discipline as `docs/`: hand-written HTML,
  CSS, JS; CSP with `connect-src 'none'`; no analytics, cookies, or forms.
- Deploy with the established `wrangler pages deploy` flow (see the
  `cloudflare-pages` skill); project name `agent-orchestrator`, production
  branch `main`, site source in a new `site/` directory so `docs/` stays the
  GitHub Pages root.
- Videos are the only heavy assets: host them as GitHub Release assets and
  reference by URL, keeping the Pages bundle tiny; provide poster images so
  the page works with videos blocked.
- Reuse the field guide's design tokens (`docs/styles.css` palette) so the
  two surfaces read as one product.

## Explicitly out of scope for v1

Downloads/installers hosting, telemetry, a blog, localized copy (English
first; Traditional Chinese and Japanese only if the product itself localizes),
and any dynamic backend.
