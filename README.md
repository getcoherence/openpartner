# OpenPartner

**Open-source partner attribution and payouts.** Full attribution from click to revenue, three-tier pricing, your data stays yours.

> The open alternative to Dub Partners, Rewardful, and Impact.

## Why OpenPartner

Existing partner platforms have two problems:

1. **They stop at the click.** Most tools track who clicked a link. Few reliably track which creator drove which dollar of revenue, 60 days later, across devices, through Safari's cookie blocks.
2. **They lock your data in.** Once two years of attribution history are baked into Impact or Partnerize, switching means starting over.

OpenPartner fixes both.

### Full attribution

- Tracks `click → signup → revenue` — not just clicks
- Works on Safari / iOS via first-party cookie + server-side stitching
- Handles multi-session and delayed conversions (60-day default, configurable)
- Works across devices by stitching to logged-in user identity
- Answers the questions that matter: *which creator drove this revenue?* *which content actually converted?*

### Three-tier pricing

Pick the model that fits your business — at signup, not at year-three renewal:

| Tier | Price | Best for |
| --- | --- | --- |
| **Self-hosted** | Free forever | Teams who want to own their infra |
| **Hosted — flat** | $99–$499/mo | Teams who want predictability |
| **Hosted — revenue share** | 3% of GMV, no monthly | Teams who want to start cheaply and scale |

### Your data stays yours

- **One-click export** — every table, CSV + JSON + SQL. On demand or scheduled to your own S3.
- **Open schema, open API** — documented, versioned, stable.
- **Round-trip portability** — exports from the hosted version re-import cleanly into the self-hosted version.
- **No resale, no training** — your partner attribution data is not a product.

## Quickstart (self-hosted)

```bash
git clone https://github.com/openpartner/openpartner
cd openpartner
pnpm install
docker compose up -d postgres
pnpm migrate
pnpm dev:api       # terminal 1 — main API
pnpm dev:router    # terminal 2 — click router
pnpm dev:portal    # terminal 3 — partner dashboard
```

See [docs/quickstart.md](./docs/quickstart.md) for full setup including Stripe Connect.

## Architecture

```
clicks  →  identities  →  events  →  attributions  →  payouts
(raw)     (stitched)     (raw)      (derived)        (derived)
```

Event-sourced by design. Raw data is immutable, attribution is a view — so you can change attribution models without re-collecting history. See [CLAUDE.md](./CLAUDE.md) for the architectural decisions behind this.

## Repository

- `apps/router` — edge click redirect service (Hono, deployable to Node or Cloudflare Workers)
- `apps/api` — main API: events, identity stitching, attribution, payouts (Express)
- `apps/portal` — partner dashboard (Vite + React)
- `packages/sdk` — customer-embedded client SDK (`@openpartner/sdk`)
- `packages/db` — shared Knex migrations and TypeScript types

## License

MIT. See [LICENSE](./LICENSE).

## Status

v1. End-to-end attribution, payouts, and export are working; API surface is stable but unversioned. See [docs/quickstart.md](./docs/quickstart.md) for the walk-through.

### What's implemented

- Edge click router with first-party cookie and SHA-256-hashed IP
- Identity stitching (`POST /attribution/identify`) with late-binding backlog attribution
- Event ingest (`POST /attribution/events`) and Stripe webhook mapping
- Last-click attribution within configurable window, re-derivable from raw tables
- Commission accrual + review queue (approve / reverse) + Stripe Connect Standard payouts with idempotent transfers
- Three deployment modes gated by `OPENPARTNER_MODE`: `selfhost`, `flat` (Stripe subscription), `revshare` (3% platform fee)
- Click velocity limits (flagged clicks are kept as audit, excluded from attribution)
- API-key auth with admin and partner-scoped tokens
- Portable JSON + CSV export per table; full bundle export round-trippable into self-hosted via `POST /import`
- Partner dashboard in the portal (clicks, attributed revenue, commission by status, links)

### Deferred

- Multi-touch attribution models (scaffolded in the schema; only `last_click` wired)
- Fraud detection beyond velocity
- Historical merchant billing reconciliation for revshare mode
- OAuth-based partner portal login (currently API-key only)
