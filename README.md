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
git clone https://github.com/getcoherence/openpartner
cd openpartner
pnpm install
docker compose up -d postgres
pnpm migrate
pnpm dev:api       # terminal 1 — main API
pnpm dev:router    # terminal 2 — click router
pnpm dev:portal    # terminal 3 — partner dashboard
```

See [docs/quickstart.md](./docs/quickstart.md) for full local setup, or [docs/deploy.md](./docs/deploy.md) for DigitalOcean App Platform and single-host Docker deployments.

## Architecture

```
clicks  →  identities  →  events  →  attributions  →  payouts
(raw)     (stitched)     (raw)      (derived)        (derived)
```

Event-sourced by design. Raw data is immutable, attribution is a view — so you can change attribution models without re-collecting history. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full picture.

## Repository

- `apps/router` — edge click redirect service (Hono, deployable to Node or Cloudflare Workers)
- `apps/api` — main API: events, identity stitching, attribution, payouts (Express)
- `apps/portal` — partner dashboard (Vite + React)
- `packages/sdk` — customer-embedded client SDK (`@openpartner/sdk`)
- `packages/db` — shared Knex migrations and TypeScript types

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, PR expectations, and the short list of things that don't get merged. Code of conduct is the standard Contributor Covenant — [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](./LICENSE).

## Status

v1. End-to-end attribution, payouts, and export are working; API surface is stable but unversioned. See [docs/quickstart.md](./docs/quickstart.md) for the walk-through.

### What's implemented

- Edge click router with first-party cookie and SHA-256-hashed IP
- Identity stitching (`POST /attribution/identify`) with late-binding backlog attribution
- Event ingest (`POST /attribution/events`) and Stripe webhook mapping
- Four attribution models — `last_click`, `first_click`, `linear`, `position` — with per-campaign selection, re-derivable from raw tables
- Commission accrual + review queue (approve / reverse) + Stripe Connect Standard payouts with idempotent transfers
- Three deployment modes gated by `OPENPARTNER_MODE`: `selfhost`, `flat` (Stripe subscription), `revshare` (3% platform fee)
- Click velocity limits with an admin fraud-review queue that replays skipped attributions on unflag
- Scoped API keys (admin and partner tokens with granular `partners:write`, `links:write`, etc.) + magic-link auth for the portal
- Two-sided OpenPartner Network — vendors publish offerings, creators apply, federation provisions partner records on vendor instances with AES-256-GCM encrypted keys
- Creator-chosen share-link slugs (`go.yourdomain.com/r/<slug>`)
- Outbound webhooks with HMAC-SHA256 signing and per-event redelivery
- Portable JSON + CSV export per table; full bundle export round-trippable into self-hosted via `POST /import`
- Partner dashboard + admin overview + fraud review + partner funnel analytics in the portal
- `@openpartner/sdk` on npm with browser and server entries
- Transactional email via Postmark (magic links, vendor approval, creator signups)
- Deployment: DigitalOcean App Platform spec + single-host `docker-compose.prod.yml` behind Caddy
