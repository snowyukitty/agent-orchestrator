# Static field guide

`docs/index.html` is the zero-build, zero-backend product guide for Agents
Orchestrator. It is intentionally plain HTML, CSS, and JavaScript:

- no package install or build step;
- no API calls, analytics, forms, cookies, or remote runtime assets;
- a restrictive Content Security Policy with `connect-src 'none'`;
- usable directly from the filesystem and ready for a future `/docs` static
  hosting source;
- interactive examples are planning aids only and never read application data.

Open `docs/index.html` in a browser to review it. Run `npm run check` to validate
its local references, anchor targets, security boundary, and JavaScript syntax.

GitHub Pages is not enabled by this directory. Enabling or changing a public
publication surface remains an explicit repository-owner action.
