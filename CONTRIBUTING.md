# Contributing

Small, focused changes are welcome. For a substantial feature or a change to
account routing, persistence, scheduling, or process cleanup, open an issue
first so the boundary and migration plan can be reviewed.

## Development setup

Agent Orchestrator targets Windows and uses ConPTY through `node-pty`.

```powershell
npm ci
npm start
```

Use Node.js 22 for the same baseline as CI.

## Before submitting a change

```powershell
npm run verify
npm run smoke
```

`npm run verify` checks syntax and static docs, runs unit and Electron self-tests,
audits dependencies, builds the Windows package, and verifies its identity and
privacy boundary. `npm run smoke` separately exercises normal startup and quit
cleanup.

Please also:

- add a regression test for behavior changes;
- keep code, identifiers, comments, logs, and developer docs in English;
- use synthetic paths and account names in tests and examples;
- never commit credentials, account state, terminal transcripts, or `mcps/`;
- preserve legacy workflow IPC unless the change includes a migration;
- keep managed routing in `ai-agent-entrypoint`, not this application;
- describe checks actually run and any manual verification still required.

Security-sensitive reports belong in a private vulnerability report, not a
public issue. This repository does not currently declare an open-source license;
do not assume public visibility grants reuse rights.
