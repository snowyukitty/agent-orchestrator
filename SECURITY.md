# Security policy

## Supported version

Security fixes are made against the current `0.4.x` line. Older preview builds
should be upgraded before a report is reproduced.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/snowyukitty/agent-orchestrator/security/advisories/new)
for this repository. Do not open a public issue for a credential leak,
account-routing error, path disclosure, command-injection possibility, or
process-termination escape.

Before submitting evidence:

- replace account aliases and local paths with synthetic values;
- remove tokens, cookies, API keys, environment values, and login state;
- include only the smallest terminal excerpt needed to explain the behavior;
- say whether the issue affects `L1-routed`, `L2-env`, or `L0-native` sessions;
- include the application version and Windows version.

If a real credential may have been exposed, revoke or rotate it first. Making a
report private does not invalidate a leaked credential.

## Security boundaries

Agent Orchestrator is designed to preserve these invariants:

- managed Codex routes come from `ai-agent-entrypoint` and fail closed;
- profile storage rejects credential-shaped environment keys;
- renderer-visible session metadata excludes environment values, PTY output,
  resolved executables, and account-home paths;
- renderer input crosses only the preload bridge and validated IPC handlers;
- deleting a workflow cannot escape the workflow storage directory;
- closing a session terminates its complete child process tree;
- packaged output excludes tests, development docs, logs, local MCP caches,
  repository metadata, and machine-specific absolute paths.

Ordinary reproducible bugs that do not cross a security boundary may use the
public bug-report form.
