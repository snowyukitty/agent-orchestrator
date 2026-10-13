# Compact UI checkpoint

## Scope and accepted outcome

Branch: `ui/refined-workspace`. Application version: 0.4.0; this is a source
checkpoint, not a tagged release.

The original compact visuals are restored while retaining guided scheduled
hello, disabled drafts, persistent schedule pause, searchable blocks, and
keyboard accessibility. The owner accepted the restored direction. The
[design principles](ui-design.md) and [comparison evidence](ui-comparison/README.md)
record that decision for future changes.

Implementation is concentrated in `src/index.html`, `src/styles/`,
`src/js/app.js`, `blocks.js`, `starters.js`, and `accessibility.js`. Verification
and reproducible capture helpers live in `scripts/`; synthetic screenshots
and layout measurements live in `docs/ui-comparison/`.

## Verification

Checkpoint checks on 2026-10-13:

- `npm run check`: 32 JavaScript files and the static guide passed.
- `npm test`: 78 unit tests, renderer self-tests, and mocked Chromium UI checks passed.
- `npm audit --audit-level=moderate`: zero reported vulnerabilities.
- `npm run verify:package`: installed package identity/privacy checks passed;
  packaged Electron matches installed 43.7.9.
- The restored Windows package was built, smoke-tested, and installed during
  the preceding restoration step. The desktop shortcut targets that package.

Closing edits affect documentation only. The app is running, so the closing
pass does not rebuild over its executable. `npm run verify` was not rerun as
one combined command; the current check/test/audit/package checks supplement
the already completed staged build and packaged smoke check.

UI automation uses synthetic accounts and mock process APIs. Live provider
authentication, concurrent account identity, provider responses, and real
process-tree shutdown were not exercised by those checks.

## GitHub integration boundary

The branch began at `e0cca66`. At checkpoint time, remote `main` was `ab55155`
and contained substantial subsequent work on run journals, protected resume,
exact-session scheduling, agent readiness, and workflow authoring. It also
changed the editor and documentation. This checkpoint is published as its own
branch; it is not integrated into `main`.

For the next milestone, start an integration branch from current `main` and
port the compact design and applicable workflow improvements deliberately.
Preserve new block types when grouping the palette, reconcile workflow
normalization and schedule state, extend the mock API for new IPC, and retain
the latest docs and package resources. Run the current mainline checkpoint
gate plus updated density comparisons before merging. Do not copy entire
older renderer files over the newer runtime.

No release, tag, hosting change, or live provider operation is part of this
checkpoint. No implementation work remains for the accepted restoration;
mainline integration is the next separately scoped milestone. The checkpoint
coordination lease is released after the push is verified.
