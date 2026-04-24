# Architecture

A user-facing map of how OpenPartner works. If you're contributing code, read [CLAUDE.md](./CLAUDE.md) instead — it covers the invariants we hold ourselves to. This doc is for people evaluating or integrating.

## The pipeline

```
click  →  identity  →  event  →  attribution  →  commission  →  payout
(raw)    (stitched)   (raw)     (derived)        (derived)      (derived)
```

Each arrow is a discrete table and a discrete step. The left two columns are raw, immutable data. The right three are derived — computed from the raw layers on demand, or whenever new events land.

| Table | What's in it |
| --- | --- |
| `Click` | One row per link hit. `clickId` (ULID), `linkKey`, `partnerId`, `campaignId`, `landingUrl`, hashed IP, UA, `fraudFlag`. |
| `Identity` | Links `clickId` → `userId` when the user signs up or logs in with an active `cref` cookie. One row per `(clickId, userId)` pair — multi-touch is preserved. |
| `Event` | Conversion events. `userId`, `type` (`signup`, `invoice_paid`, etc.), `value`, `currency`. Merchant's server-to-server events OR mapped Stripe webhook events. |
| `Attribution` | For an Event, the partner(s) credited under a given attribution model. Unique on `(eventId, model, clickId)`. |
| `Commission` | Money owed to a partner for an Attribution, priced via the campaign's commission rule. Ledger with immutable status transitions: `accrued → approved → paid` (or `reversed`). |
| `Payout` | Groups approved commissions by partner + currency. `method = stripe_connect | manual`. In Stripe Connect mode carries the transfer id. |

## Why event-sourced?

Raw data is immutable. Attribution is a view — you can re-run it with a different model (last-click, first-click, linear, position) without re-collecting data. You can also correct an attribution model retroactively over historical events. And because raw data is the only load-bearing layer, export is simple: dump the six raw + derived tables, re-import on another instance, re-derive from there. Nothing lossy.

Concretely this buys you:

- **Change your attribution model later.** Switch from last-click to linear in six months and re-derive history, because every click and event is still there.
- **Lossless migration.** A one-click JSON bundle round-trips into a self-hosted instance.
- **Reproducibility.** Given the same click log + event log, two instances will derive identical attributions + commissions.

The cost is storage — six growing tables instead of one — and a small runtime cost to recompute when re-attributing historical events. Worth it.

## Click routing

`apps/router` is a Hono service that owns the `/r/:linkKey` hot path. A click does three things:

1. Write a `Click` row (with hashed IP, UA, referer, optional `fraudFlag` from velocity check).
2. Set a first-party `_cref` cookie scoped to `COOKIE_DOMAIN` — 90 day max-age, `SameSite=Lax`.
3. 302 to the landing URL with `?cref=<clickId>` appended, so the SDK can also pick it up when the cookie gets dropped by ITP.

Portability: Hono runs on Node and on Cloudflare Workers unchanged. Self-hosters who want to run the click router at the edge can.

## Identity stitching

The hard part of attribution is surviving Safari (ITP caps first-party cookies to 7 days), multi-device, and delayed signup (someone clicks on Monday, signs up on Friday). OpenPartner's stitch is a simple state machine:

1. SDK on the landing page reads `?cref=…` and the `_cref` cookie, stores both in `localStorage` (immune to ITP).
2. When the user authenticates, the SDK calls `POST /attribution/identify { cref, userId }`.
3. The API writes an `Identity` row and re-runs attribution for any prior events that user has already generated (the "backlog" path — matters when webhook order is weird).

A user who clicks on their phone, opens the landing page, doesn't sign up, then signs up on their laptop a month later: the cref travels through `localStorage` if the tab stays open, or the click is lost. A user who clicks, signs up in the same browser session, and returns weeks later: stitched. Cross-device without login is explicitly out of scope — we rely on the login being the identity bridge.

## Attribution models

Four models ship. Each Event, when ingested, writes one or more `Attribution` rows:

- **last_click** — the most recent click within the window. One attribution row.
- **first_click** — the oldest click within the window. One attribution row.
- **linear** — every click in the window gets equal credit. N attribution rows, weight `1/N`.
- **position** — first + last click get 40% each, middle clicks split the remaining 20%.

Model is per-campaign (`Campaign.attributionModel`). Change it and the next re-attribution run picks up the new setting. The attribution window is also per-campaign (default 60 days).

## Commissions + payouts

Commission = attribution + pricing rule. Rules live on the Campaign:

- **percent** — percentage of the event's `value`. `recurring: true` means every recurring invoice counts, not just the first.
- **fixed** — flat amount per event (signup bounties).

Commissions enter `accrued` state. An admin (or approval webhook flow) moves them to `approved`. The payouts runner groups approved commissions by `(partnerId, currency)` and writes a Payout row plus a Stripe transfer (Connect mode) or leaves it `pending` for the operator to clear out-of-band (manual mode).

Idempotency: each Payout gets a ULID up front, used as the Stripe idempotency key. A retry after a crash doesn't double-transfer.

## Deployment modes

One codebase, three behaviors, flipped by `OPENPARTNER_MODE`:

| Mode | Merchant billing | Partner payouts |
| --- | --- | --- |
| `selfhost` | — | Operator manages out-of-band. |
| `flat` | Stripe Checkout subscription (`STRIPE_FLAT_PRICE_ID`). | Stripe Connect Standard. |
| `revshare` | 3% of each payout retained as platform fee, recorded on `Payout.metadata.platformFee`. | Stripe Connect Standard. |

The core product — attribution, events, commissions — is identical across modes. Only the billing + payout layer changes.

## The Network

OpenPartner has a built-in two-sided marketplace (`NetworkVendor`, `NetworkCreator`, `NetworkOffering`, `NetworkRequest`). Vendors publish offerings (commission terms, assets, description). Creators apply. On acceptance, the vendor instance provisions a `Partner` row via federation — the creator gets a share link like `go.vendor.com/r/<their-slug>`.

Federation credentials are scoped API keys (vendor's key for vendor → hosted network, hosted network's key for network → vendor on provisioning). Keys at rest are AES-256-GCM encrypted with `NETWORK_ENCRYPTION_KEY`.

Self-hosted instances opt in by publishing their instance URL + scoped key. Skipping the Network entirely is supported — the vendor-direct flow (manually create Partners through the admin portal) is the original path.

## Data portability

Every core table round-trips through `GET /export.json`. Two guarantees:

1. **Stable schema.** Column shapes don't change within a major version. Additions are allowed; renames or removals are migrations with explicit export-compat handling.
2. **No hosted-only fields on core tables.** If the hosted version needs metadata (billing customer IDs, rate-limit tokens), it goes in a sidecar table clearly labeled as optional. Self-host imports ignore it.

Import is `POST /import` (selfhost-only — importing into a shared hosted DB would collide primary keys). Each table uses `onConflict('id').ignore()`, so partial-then-resumed imports and re-imports of the same bundle are no-ops.

## Observability

- **Structured logs.** Pino, JSON. Every log line carries the request's `reqId`, correlated with the `X-Request-Id` response header (echoed from inbound if the client sends one, ULID otherwise).
- **Metrics.** `GET /metrics` — Prometheus text, open by default. Set `METRICS_TOKEN` to require a Bearer token.
- **Health.** `GET /health` on each service, no auth.

## What this isn't

- **Not a link shortener.** Dub's best in class for that.
- **Not a CRM.** Partner roster is minimal; integrate with your existing CRM for rich partner profiles.
- **Not a fraud detection platform.** Basic velocity + review queue. Enterprise fraud ML is post-Series-A territory.
- **Not a merchant of record.** Merchants keep their own Stripe accounts; we never process consumer purchases.
