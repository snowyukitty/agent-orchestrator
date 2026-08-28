# Product-proof promo standard

The job of Agent Orchestrator media is not to decorate the project. It should
move a viewer through four states: **notice → understand → trust → act**.

## Creative thesis

Agent Orchestrator is strongest when its control loop is visible. Show a real
workflow fan out, stop at an incomplete barrier, cross the barrier with an
explicit result bundle, and leave protected evidence. A viewer should be able
to explain the product after one watch without relying on the narration.

The proof hierarchy is:

1. real renderer state from a deterministic, disclosed fixture;
2. a real live run captured with private data removed and owner approval;
3. code-native diagrams or verified conceptual key art;
4. generated atmosphere used only as brief punctuation.

Generic terminals, dark offices, empty monitors, synthetic dashboards, and
human actors are not evidence of product behavior. They must never dominate a
functional product film or imply a feature the app did not demonstrate.

## Current functional hero

The 50.6-second review master has one English narration timeline and three
selectable subtitle tracks: English (default), Japanese, and Traditional
Chinese.

| Beat | Visual proof | Viewer takeaway |
| --- | --- | --- |
| Compose | Real editor, parallel research → synthesis | One desktop makes the team visible |
| Wait | Join Agents at `2 / 3` | Downstream work stops until the stage is complete |
| Handoff | Join at `3 / 3`, bundle attached | Results move explicitly, not through transcript scraping |
| Evidence | Protected Run Journal | Interrupted work is inspectable but never auto-replayed |
| Act | Verified conceptual key art + GitHub CTA | Try the public project |

The rejected `2026-08-27-agent-orchestrator-hero-30s-1088p.mp4` is not a
publication candidate. Its generic office imagery did not explain any product
behavior and has been superseded by the sequence above.

## Reproducible capture

```powershell
npm run promo:capture -- --promo-output=docs/assets/promo
```

The command requires an explicit output directory, fixes the content viewport
and device scale to 1600×1000, and uses a disposable Electron user-data root.
Renderer startup skips account discovery, profile loading, and the default PTY.
The fixture opens implemented UI states only, stamps every frame
`PRODUCT UI · INERT CAPTURE FIXTURE`, and writes `manifest.json` with dimensions
and SHA-256 receipts.

`npm run check` rejects missing, device-scaled, stale, re-ordered, or unreferenced
frames and validates the disclosure. The capture itself also refuses to write a
frame whose physical dimensions differ from the declared viewport.

## Language and delivery contract

- English voice and English captions are the semantic master.
- Japanese and Traditional Chinese are subtitle-only tracks sharing the exact
  measured English cue timeline.
- Every locale has its own human readability gate; one approval never passes
  another language.
- Keep one clean MP4. Publish English/default, Japanese, and Traditional Chinese
  WebVTT tracks for the browser and matching SRT downloads.
- Do not burn English captions into the only master.

## Publication gate

Review must pass product meaning, claim accuracy, narration, pacing, UI
legibility, and all three subtitle tracks. Approval authorizes a render only.
Creating a GitHub Release, uploading assets, or embedding a Release URL still
requires explicit owner approval. Until then, the field guide uses the verified
stills and key-art poster without a placeholder video.
