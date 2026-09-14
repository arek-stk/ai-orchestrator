## Summary

<!-- What changes and why. Link issues with "Closes #123". -->

## Type

<!-- The PR title must follow Conventional Commits, e.g. "feat(core): add council timeout". -->

- [ ] feat
- [ ] fix
- [ ] refactor / perf
- [ ] docs
- [ ] ci / chore

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes and new behaviour is covered by tests
- [ ] Architectural changes are recorded as an ADR in `docs/DECISIONS.md`
- [ ] New side effects go through the tool router with guards and a minimum autonomy level
- [ ] No secrets, tokens or real credentials in code, tests or logs
