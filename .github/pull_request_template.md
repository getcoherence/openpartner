## What

<!-- One or two sentences on the change. Link the issue if there is one. -->

## Why

<!-- The motivation. Skip if it's obvious from the issue. -->

## How to verify

<!-- Steps a reviewer can run locally, or what CI covers. -->

## Checklist

- [ ] Tests added / updated (or an explicit note about why not)
- [ ] `pnpm typecheck` + `pnpm test` green locally
- [ ] No edits to already-applied migrations — new migration file instead
- [ ] No new dependencies without justification
- [ ] Architectural principles in CLAUDE.md still hold (raw-data immutability, data portability, sidecar tables for hosted-only fields)
