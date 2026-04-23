# OpenPartner — Development Guide

Open-source partner attribution and payouts. Full attribution from click → signup → revenue, with three-tier pricing (self-hosted, flat SaaS, revenue share) and data portability as a first-class guarantee.

## Product thesis

The competitors (Dub, Rewardful, Impact, Partnerize, Tolt) all have two problems: (1) they stop tracking at the click or at best a fragile cookie-based signup, and (2) they lock your attribution history into their platform. OpenPartner's wedge:

1. **Full attribution** — click → identity → revenue, surviving Safari/ITP, multi-session gaps of 30-90 days, and cross-device via logged-in stitching
2. **Three-tier pricing** — self-host OSS (free), hosted flat fee (predictability), or hosted revenue share (3% of GMV, no monthly). Customers pick at signup.
3. **Data portability as architecture** — one-click export in a format the self-hosted version can re-import. No vendor lock-in.

## Architectural principles (load-bearing — do not violate)

### 1. Raw data is immutable, attribution is derived
The core data model is event-sourced:

```
clicks  →  identities  →  events  →  attributions  →  payouts
(raw)     (stitched)     (raw)      (derived)        (derived)
```

**Never collapse raw data into an attribution decision.** Attribution is a view over the raw click/identity/event log. This is what lets you re-run with different models (last-click, first-touch, linear) without re-collecting data. This is also what makes portability possible — export the raw layers, and any system can re-derive.

### 2. Data portability is a first-class commitment
Every table must be exportable to CSV + JSON + SQL dump. The schema must be documented and stable. The self-hosted OSS version must accept exports from the hosted version as imports — migrating off is a supported path, not a reluctant concession.

Practical implication: **never add hosted-only fields to core tables.** Hosted-specific metadata goes in sidecar tables that are clearly optional.

### 3. One codebase, three deployment shapes
- **Self-hosted OSS**: drop-in Docker Compose, runs on customer infra
- **Hosted flat fee**: same codebase on OpenPartner infra, subscription billed via Stripe
- **Hosted revenue share**: same codebase + Stripe Connect Standard accounts + 3% platform fee

All three must work from the same `main` branch. Feature flags (`OPENPARTNER_MODE=selfhost|flat|revshare`) gate the billing/payout layer, not the core product.

### 4. Stripe Connect Standard accounts only
For hosted revenue share tier, use **Stripe Connect Standard accounts**. Partners own their Stripe account; we just facilitate transfers and take a platform fee. This keeps us out of money-transmission licensing and limits platform liability. Do not use Express or Custom accounts without explicit sign-off.

### 5. No ToS changes to support engineering shortcuts
"Your data stays yours" is a hard architectural constraint. If a feature would require ingesting customer data into a shared pool, training models on partner attribution, or making export lossy — it doesn't ship. Find another way.

## Tech stack

- **Runtime**: Node 20+, TypeScript 5.4
- **Package manager**: pnpm 9 workspaces
- **Router (edge)**: Hono — portable between Node and Cloudflare Workers so customers can deploy the click router at the edge if they want
- **API**: Express — matches author familiarity, rich middleware ecosystem
- **DB**: PostgreSQL, Knex migrations
- **Portal**: Vite + React + TanStack Query + Tailwind
- **SDK**: TypeScript, published to npm as `@openpartner/sdk`
- **Payments**: Stripe + Stripe Connect (revenue share tier only)

## Repository layout

```
openpartner/
├── apps/
│   ├── router/       # Edge click redirect service (Hono)
│   ├── api/          # Main API: events, identity, attribution, payouts (Express)
│   └── portal/       # Partner dashboard (Vite + React)
├── packages/
│   ├── sdk/          # Customer-embedded TS client — first-party cookie stitch + identify
│   └── db/           # Shared Knex migrations + TypeScript types
├── .claude/          # Claude Code autonomous operation settings
├── CLAUDE.md         # This file
└── README.md         # Public-facing positioning + quickstart
```

## Data model (core tables)

Designed for portability — all fields exportable, no opaque references.

### `Click` (raw, immutable)
Every click on a partner link. Includes partner ID, campaign, landing URL, IP hash, UA, referer, timestamp. Primary key: `clickId` (ULID).

### `Identity` (derived via stitching)
Links a `clickId` to an authenticated user. Written when a user signs up or logs in with an active `cref` cookie/param. Enables surviving Safari ITP and cross-device via login handoff.

### `Event` (raw, immutable)
Conversion events — `signup`, `trial_started`, `subscription_created`, `invoice_paid`, custom types. References the `userId` (via Identity, which chains back to Click).

### `Attribution` (derived view)
Applied attribution model (last-click 60d default). Walks `Event → Identity → Click` and stamps the attributed partner + model used + computed at. Re-derivable from raw tables.

### `Commission` / `Payout` (derived + immutable ledger)
Computed from Attribution + merchant's program rules. Immutable ledger for auditability. Payouts executed via Stripe Connect transfers (revenue share tier) or tracked as "owed externally" (flat-fee / self-hosted tiers).

## Commands

```bash
# Install
pnpm install

# Dev
pnpm dev:router      # Edge click router
pnpm dev:api         # Main API
pnpm dev:portal      # Partner dashboard

# Database
pnpm migrate                      # Apply all migrations
pnpm migrate:rollback             # Rollback last
pnpm migrate:make <name>          # New migration

# Quality
pnpm typecheck
pnpm lint
pnpm test
```

## Environment

See `.env.example` in each app. Core vars:

```
DATABASE_URL=postgres://...
OPENPARTNER_MODE=selfhost|flat|revshare
STRIPE_SECRET_KEY=              # hosted tiers only
STRIPE_CONNECT_CLIENT_ID=       # revshare tier only
COOKIE_DOMAIN=                  # first-party cookie scope
```

## Non-goals (things we explicitly don't do)

- **Not a link shortener.** Dub is a good link shortener. We're an attribution platform that happens to have a link router. Don't build Dub features.
- **Not a CRM.** Partner roster is minimal. If the customer wants rich partner profiles, they integrate with their existing CRM (Coherence XRM is one option).
- **Not a fraud detection platform.** Basic velocity limits + manual review queue. Enterprise fraud ML is post-Series-A territory.
- **Not a merchant of record.** Merchants keep their own Stripe accounts. We never process consumer purchases.
