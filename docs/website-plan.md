# Website plan — `agent-orchestrator.pages.dev` (future work)

Status: **v1 live as a mirror; the dedicated landing page below is future
work.** The GitHub Pages field guide is the primary product page, live at
<https://snowyukitty.github.io/agent-orchestrator/>. The same `docs/` artifact
is mirrored on Cloudflare Pages at
<https://agent-orchestrator-855.pages.dev/> (the bare `agent-orchestrator`
pages.dev subdomain was already taken globally; renaming or attaching a custom
domain is an open decision). The dedicated marketing landing (v2) below waits
for human approval and Release publication of the promo video assets; the
English masters and trilingual sidecars themselves are generated.

Deploy command for the mirror (established portfolio flow):

```bash
wrangler pages deploy docs --project-name=agent-orchestrator --branch=main
```

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
  snapshots, the explicit protected preflight, and why verified evidence still
  does not enable replay.
- **Footer**: GitHub, security policy, no analytics statement.

## Media assets to produce first (blockers for the build)

| Asset | Tool | Notes |
|---|---|---|
| Hero loop (10–20 s, no audio) | HyperFrames (`snowy-hyperframes` pipeline) | storyboard: schedule fires → sessions open → join completes |
| Product overview (89.7 s, narrated) | HyperFrames + Edge-TTS | clean English master; English/default + Japanese + Traditional Chinese SRT/VTT; human gate pending |
| 5-hour-window explainer (87.8 s, narrated) | HyperFrames + Edge-TTS | same trilingual contract; flagship promo candidate; human gate pending |
| Fan-out/join clip | Screen capture of the real app | authenticity beats composition here |
| Key art / social card | `/web-img` | shipped in the field guide: verified 1731×909 (40:21) route → fan-out → join → protected-journal motif, with prompt/integrity sidecars |
| Optional cinematic teaser | Google Flow (`web-flow` skill) | costs real credits; only with explicit go-ahead |

## Technical shape

- Static only, no build step — same discipline as `docs/`: hand-written HTML,
  CSS, JS; CSP with `connect-src 'none'`; no analytics, cookies, or forms.
- Deploy with the established `wrangler pages deploy` flow (see the
  `cloudflare-pages` skill); project name `agent-orchestrator`, production
  branch `main`, site source in a new `site/` directory so `docs/` stays the
  GitHub Pages root.
- Keep videos out of the Pages bundle: host reviewed renders as GitHub Release
  assets and reference them by URL. The verified 1.6 MB key art is the one
  bundled social image; provide lightweight poster images so the page still
  works with videos blocked.
- Use one clean English MP4 with native `<track kind="subtitles">` children:
  English is `default`, with Japanese (`ja`) and Traditional Chinese
  (`zh-Hant`) selectable. Publish matching SRT files as download assets, retain
  WebVTT for browsers, and never imply a language passed because another did.
  Do not bake English captions into the only video master.
- Reuse the field guide's design tokens (`docs/styles.css` palette) so the
  two surfaces read as one product.

## Explicitly out of scope for v1

Downloads/installers hosting, telemetry, a blog, localized page chrome (English
first; translated video sidecars are already in scope), and any dynamic backend.
