## Summary

Describe the user-visible outcome and the boundary it changes.

## Verification

- [ ] `npm run verify`
- [ ] `npm run smoke`, or the reason it is not applicable is stated below
- [ ] Behavior changes include regression coverage
- [ ] Manual account or process checks are named explicitly

## Safety and compatibility

- [ ] Examples and fixtures use synthetic account names and paths
- [ ] No credentials, terminal transcripts, account state, or `mcps/` content are included
- [ ] Managed routing remains owned by `ai-agent-entrypoint`
- [ ] Legacy workflow IPC remains compatible, or a migration is documented
- [ ] Packaged contents and external side effects were reviewed
