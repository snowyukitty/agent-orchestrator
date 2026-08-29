# Website plan — `agentorch.pages.dev` (future work)

Status: **v1 live as a mirror with authentic product proof; the dedicated
landing page below is future work.** The GitHub Pages field guide is the primary product page, live at
<https://snowyukitty.github.io/agent-orchestrator/>. The same `docs/` artifact
is mirrored on Cloudflare Pages at
<https://agentorch.pages.dev/>. The bare `agent-orchestrator` and
`orchestrator` pages.dev subdomains are held by unrelated accounts — creating a
project under either name returns a suffixed subdomain — so `agentorch` is the
short name this project owns. A custom domain on one of the account's zones
remains available if a branded URL is wanted later. The dedicated marketing landing (v2) below waits
for human approval and Release publication of the promo video assets; the
English masters and trilingual sidecars themselves are generated.

Deploy command for the mirror (established portfolio flow):

```bash
wrangler pages deploy docs --project-name=agentorch --branch=main
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
| Functional hero (50.6 s, narrated) | HyperFrames (`snowy-hyperframes` pipeline) | real editor → 2/3 barrier → 3/3 explicit handoff → protected journal; English voice + en/ja/zh-Hant sidecars; human gate pending |
| Product-proof stills | `npm run promo:capture` | shipped in field guide and README; deterministic real-renderer fixture captures at 2× with the UI at 1.25, each with a focus crop, disclosure, and hashed manifest |
| Product overview (89.7 s, narrated) | HyperFrames + Edge-TTS | clean English master; English/default + Japanese + Traditional Chinese SRT/VTT; human gate pending |
| 5-hour-window explainer (87.8 s, narrated) | HyperFrames + Edge-TTS | same trilingual contract; flagship promo candidate; human gate pending |
| Fan-out/join clip | Screen capture of the real app | authenticity beats composition here |
| Social card / poster | `npm run promo:capture` | `01-workflow-editor.png` is the README hero, the `og:image`, and the video poster. The earlier AI-generated key art was retired on 2026-08-29: abstract, off-product, and weaker than a screenshot |
| Optional cinematic punctuation | Google Flow (`web-flow` skill) | never substitutes for product proof; costs real credits and needs explicit go-ahead |

## Technical shape

- Static only, no build step — same discipline as `docs/`: hand-written HTML,
  CSS, JS; CSP with `connect-src 'none'`; no analytics, cookies, or forms.
- Deploy with the established `wrangler pages deploy` flow (see the
  `cloudflare-pages` skill); project name `agentorch`, production
  branch `main`, site source in a new `site/` directory so `docs/` stays the
  GitHub Pages root.
- Keep videos out of the Pages bundle: host reviewed renders as GitHub Release
  assets and reference them by URL. The 1600×1000 capture frames are the
  bundled social and poster images, so the page still reads correctly with
  videos blocked.
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
