# OpenPartner

**Open-source partner attribution and payouts.** Run your own partner program: track every click through to revenue, pay partners out via Stripe Connect, export your data whenever you want.

> The open alternative to Dub Partners, Rewardful, and Impact.

## Why OpenPartner

Existing partner platforms have two problems:

1. **They stop at the click.** Most tools track who clicked a link. Few reliably track which partner drove which dollar of revenue, 60 days later, across devices, through Safari's cookie blocks.
2. **They lock your data in.** Once two years of attribution history are baked into Impact or Partnerize, switching means starting over.

OpenPartner fixes both.

### Full attribution

- Tracks `click → signup → revenue` — not just clicks
- Works on Safari / iOS via first-party cookie + server-side stitching
- Handles multi-session and delayed conversions (60-day default, configurable)
- Works across devices by stitching to logged-in user identity
- Answers the questions that matter: *which creator drove this revenue?* *which content actually converted?*

### Pricing

Pick the tier that fits your business — at signup, not at year-three renewal. You can move between hosted tiers anytime.

| Tier | Price | Best for |
| --- | --- | --- |
| **Self-hosted** | Free | Teams who want to own their infra. Run the core on your own box. |
| **Self-hosted + Network** | $29/mo + 3% on Network-originated payouts | Self-hosters who want creator-marketplace discovery on top of the core. |
| **Hosted — Flex** | $49/mo + 1.5% of attributed GMV | Teams who want predictable pricing + the Network bundled in. |
| **Hosted — Revshare** | 3% of attributed GMV, no monthly | Teams who want to start cheap and only pay when partners drive revenue. |
| **Enterprise** | Custom | Larger programs that need dedicated infra, SLAs, or procurement support. |

Self-hosted is the GitHub repo you're reading. Hosted tiers run the same code on OpenPartner infra. Full pricing details: [openpartner.dev/pricing](https://openpartner.dev/pricing).

### Your data stays yours

- **One-click export** — partners, programs, attribution and the commission/payout ledger, as CSV + JSON + SQL. On demand or scheduled to your own S3. ([what's in the bundle, and what isn't](./docs/data-portability.md))
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

Open `http://localhost:5673/install` — a three-step wizard collects your admin account, program name + support email, and mail transport (SMTP or Postmark). Accept the magic-link email and you're signed in as the first admin.

See [docs/quickstart.md](./docs/quickstart.md) for the end-to-end walkthrough, or [docs/deploy.md](./docs/deploy.md) for DigitalOcean App Platform and single-host Docker deployments.

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

**Attribution + payouts**

- Edge click router with first-party cookie and SHA-256-hashed IP
- Identity stitching (`POST /attribution/identify`) with late-binding backlog attribution
- Event ingest (`POST /attribution/events`) and Stripe webhook mapping (idempotent on retries)
- Four attribution models — `last_click`, `first_click`, `linear`, `position` — per-campaign, re-derivable from raw tables
- Commission accrual + review queue (approve / reverse) + Stripe Connect Standard payouts with idempotent transfers
- Click velocity limits with an admin fraud-review queue that replays skipped attributions on unflag
- Outbound webhooks with HMAC-SHA256 signing and per-event redelivery

**Auth + personas**

- WordPress-style first-run `/install` wizard — admin account, program name, mail transport in one flow
- Admin accounts as first-class personas (not a shared token) — magic-link signin, invite/revoke/reinstate, last-active-admin guard
- Partner accounts via admin-invited magic-link — no admin-visible credentials, partners create their own API keys
- `ADMIN_API_KEY` env stays as bootstrap / headless / CI path
- Revoke flow for both admins and partners: sessions killed, reason stored, optional email notification

**Configuration**

- Program name + support email editable from the admin Settings UI (not env)
- Mail transport (SMTP / Postmark / console) editable from the UI, SMTP passwords + Postmark tokens encrypted at rest with `SECRETS_ENCRYPTION_KEY`
- Env vars (`SMTP_*`, `POSTMARK_*`, `MAIL_FROM`) remain as deploy-time fallbacks
- Three deployment modes gated by `OPENPARTNER_MODE`: `selfhost`, `flat` (Hosted Flex — $49/mo + 1.5% metered), `revshare` (Hosted Revshare — 3% metered, no monthly)

**Integration surface**

- Scoped API keys (`partners:write`, `links:write`, `commissions:read`, …) — the federation contract that lets an external creator-network service provision Partner + Link rows on this instance over REST
- `@openpartner/sdk` on npm with browser and server entries
- Portable JSON + CSV + SQL export per table; full bundle round-trippable via `POST /import`, or restore the SQL dump straight into a self-hosted instance with `psql -v tenant_id=<destination tenant id> -f openpartner-export.sql`

**Operations**

- Partner dashboard + admin overview + fraud review + partner funnel analytics in the portal
- Prometheus `/metrics` + X-Request-Id correlation
- Deployment: DigitalOcean App Platform spec + single-host `docker-compose.prod.yml` behind Caddy

### Not in this repo

A creator-discovery / two-sided network layer (vendors publish offerings, creators apply, federation provisions partnerships into vendor instances) lives in a separate private repo. OpenPartner OSS instances integrate with it via the scoped-API-key federation contract described above.
