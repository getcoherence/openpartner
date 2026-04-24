# Contributing to OpenPartner

Thanks for the interest. This doc is the short version.

## Development setup

```bash
git clone https://github.com/getcoherence/openpartner
cd openpartner
pnpm install
docker compose up -d postgres        # Postgres 16 on :5433
pnpm migrate
pnpm dev:api                         # terminal 1
pnpm dev:router                      # terminal 2
pnpm dev:portal                      # terminal 3 (:5673)
```

Requirements: Node 20+, pnpm 9, Docker.

Copy `.env.example` to `.env` and fill in the bits you need. `OPENPARTNER_MODE=selfhost` is the zero-config path; Stripe and Postmark tokens are only required if you're working on billing or mail.

## Before opening a PR

```bash
pnpm typecheck    # tsc --noEmit across all workspaces
pnpm test         # vitest run — needs DATABASE_URL set for integration tests
pnpm lint         # same as typecheck today
```

All three run in CI. PRs with failing CI are unlikely to get reviewed quickly.

## What we merge

- **Bugs with tests.** If you're fixing something, add a test that would have caught it.
- **Features discussed in an issue first.** Drive-by features tend to collide with in-flight work. Open an issue so we can agree on shape before you build.
- **Schema changes via a new migration file.** Never edit a committed migration. See `packages/db/migrations/` for examples.

## What we don't merge

- Dependencies added without a clear reason — prefer stdlib / existing deps.
- Reformat-the-world PRs. Keep diffs tight to the change.
- Anything that breaks the architectural principles in [CLAUDE.md](./CLAUDE.md) — notably, raw-data immutability and data portability are non-negotiable. Hosted-only features go in sidecar tables, not core tables.
- ToS changes to enable shortcuts. If a feature would require ingesting customer data into a shared pool, or making export lossy, find another way.

## Reporting security issues

Please do **not** open public issues for security problems. Email `security@getcoherence.io` with details — we'll respond within two business days.

## License

By contributing, you agree your changes are licensed under the project's [MIT license](./LICENSE).
