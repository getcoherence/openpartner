# Production deploy runbook

Step-by-step for the first launch of OpenPartner on DigitalOcean App Platform
plus matching Stripe live-mode setup. Reading time ~10 min, end-to-end execution
~60 min once you have credentials in hand.

> Self-hosters: see `docs/deploy.md` for the docker-compose path. This runbook
> is for the OpenPartner-as-a-service deploy.

## What you'll provision

- 1 DO App Platform app with three components: api (Express), router (Hono), portal (static SPA)
- 1 DO Managed Postgres (production tier, daily backups)
- 1 set of live-mode Stripe products + prices + meters
- 2 Stripe webhook destinations (platform + connect events)
- 1+ custom domains pointed at the app

## Prerequisites

- [ ] DO account with billing set up
- [ ] `doctl` installed and authenticated (`doctl auth init`)
- [ ] GitHub repo `getcoherence/openpartner` accessible to your DO account
- [ ] Stripe account fully activated for live mode (Connect Standard enabled)
- [ ] DNS access to `openpartner.dev` (or whatever apex you'll use)
- [ ] One-time generated `SECRETS_ENCRYPTION_KEY` and `ADMIN_API_KEY`

Generate the secrets locally:

```bash
echo "SECRETS_ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "ADMIN_API_KEY=op_$(openssl rand -hex 24)"
```

Paste those into a password manager — you'll set them as DO env secrets in
step 4. They never go in git.

---

## 1. Create the App Platform app

```bash
cd /path/to/openpartner
doctl apps create --spec .do/app.yaml
```

Output prints an app ID like `12345678-aaaa-bbbb-cccc-dddddddddddd`. Save it as
`OP_APP_ID` for the rest of this runbook:

```bash
export OP_APP_ID=12345678-aaaa-bbbb-cccc-dddddddddddd
```

The first deploy will fail with "missing secrets" — expected. You'll set them
in step 4 and re-deploy.

## 2. Confirm the database is provisioned

```bash
doctl apps list-databases $OP_APP_ID
```

Wait until status is `online`. A managed Postgres takes ~5–10 minutes the first
time. The connection string is automatically injected into the api/router
services as `${openpartner-db.DATABASE_URL}` — no manual wiring needed.

## 3. Provision live Stripe resources

Run the setup script with your **live** key:

```bash
cd apps/api
STRIPE_SECRET_KEY=sk_live_... node scripts/setup-stripe.mjs
```

Save the printed Price IDs — you'll use them in step 4. The script creates:

- Products: OpenPartner Flex, Network access, Revshare
- Monthly recurring prices
- Metered prices linked to two Stripe Meters (`openpartner_attributed_gmv`,
  `openpartner_network_payouts`)

It's idempotent, so safe to re-run.

## 4. Set encrypted env secrets

In the DO App Platform UI: your app → **Settings** → for the api component
→ **App-Level Environment Variables** (or **Component-Level** for api-only).
Set each value with **Encrypt** checked:

| Variable | Value |
| --- | --- |
| `ADMIN_API_KEY` | `op_...` from step prerequisites |
| `SECRETS_ENCRYPTION_KEY` | 64-char hex from prerequisites |
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | (leave empty for now — you'll set it in step 6) |
| `STRIPE_FLAT_PRICE_ID` | from step 3 |
| `STRIPE_FLAT_USAGE_PRICE_ID` | from step 3 |
| `STRIPE_REVSHARE_USAGE_PRICE_ID` | from step 3 |
| `STRIPE_NETWORK_PRICE_ID` | from step 3 |
| `STRIPE_NETWORK_USAGE_PRICE_ID` | from step 3 |
| `MAIL_FROM` | `notifications@openpartner.dev` |
| `POSTMARK_SERVER_TOKEN` | from your Postmark dashboard |
| `PORTAL_URL` | `https://app.openpartner.dev` (or your chosen domain) |
| `METRICS_TOKEN` | random token if you want to gate /metrics; otherwise generate one |
| `OPENPARTNER_APP_DB_PASSWORD` | random 32+ char string — provisions the openpartner_app role |
| `DATABASE_URL_APP` | same host/db as DATABASE_URL but `user=openpartner_app` and `password=` the value above |

For the **router** component, set:

| Variable | Value |
| --- | --- |
| `COOKIE_DOMAIN` | `.openpartner.dev` (leading dot — covers subdomains) |

Click **Save** and let DO redeploy.

## 5. Wire DNS and custom domains

Pick a domain layout. Recommended:

- `app.openpartner.dev` — portal (also serves api at `/api/*`)
- `r.openpartner.dev` — click router (separate component)

In DO App Platform: **Settings → Domains → Add Domain**. Add both, point them
at the appropriate components, and DO will give you DNS records to add.

In Cloudflare / your DNS host:

```
CNAME  app.openpartner.dev  →  <app>.ondigitalocean.app
CNAME  r.openpartner.dev    →  <app>.ondigitalocean.app
```

Wait for SSL cert provisioning (~5 min). Verify both URLs serve.

## 6. Configure Stripe webhook destinations

In Stripe Dashboard (live mode toggle on): **Developers → Webhooks → Add endpoint**.

You need **two** destinations because Stripe splits platform-account events
from connected-account events:

### Destination A — platform events

- URL: `https://app.openpartner.dev/api/webhooks/stripe`
- Events: `checkout.session.completed`, `customer.created`, `customer.subscription.created`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`
- Save → copy the **Signing secret** (`whsec_...`)

### Destination B — connected accounts

- URL: same — `https://app.openpartner.dev/api/webhooks/stripe`
- Type: **Connected accounts**
- Events: `account.updated`, `transfer.updated`, `transfer.reversed`
- Save → copy the **Signing secret**

Set the two **family-bound** signing-secret vars (recommended — binds each
secret to its destination so a Connect secret can't authorize a platform
event, and vice versa):

```
STRIPE_WEBHOOK_SECRET_PLATFORM=whsec_AAA...   # Destination A
STRIPE_WEBHOOK_SECRET_CONNECT=whsec_BBB...    # Destination B
```

> The legacy single var `STRIPE_WEBHOOK_SECRET=whsec_AAA...,whsec_BBB...`
> still works but verifies both families with either secret (enforcement
> OFF). Migrate to the split vars above; an event arriving on the wrong
> destination for its type is then rejected (`secret_family_mismatch`).

Re-deploy via the DO UI ("Force Rebuild and Deploy").

## 7. First-run install wizard

Visit `https://app.openpartner.dev`. The portal will redirect to `/install`
(first-run wizard). Complete:

- **You** — admin name + email
- **Program** — your brand name + support email
- **Email delivery** — confirm Postmark or paste SMTP

Submit. You'll get a magic link in your inbox. Sign in.

## 8. Verify end-to-end

A short smoke checklist after sign-in:

- [ ] Can create a partner via the admin UI
- [ ] Magic-link invite to that partner arrives
- [ ] Partner can complete Stripe Connect onboarding
- [ ] `/billing/checkout` redirects to a real Stripe Checkout
- [ ] Stripe webhooks deliver successfully (Stripe Dashboard → Webhooks → recent deliveries → all 200)
- [ ] `POST /api/billing/report-usage` returns `reported: true` after a real conversion

Once all six pass, you're live.

---

## Operational notes

### Multi-tenant rollout

`OPENPARTNER_TENANCY=multi` switches the api from single-tenant
self-host mode to hosted multi-tenant mode:

- **URL routing.** Tenant-scoped routes live under `/t/<slug>/...`.
  Set `app.openpartner.dev` to the api component and the portal SPA
  reads the slug from `location.pathname`. The catch-all rewrite in
  `static_sites.catchall_document` keeps SPA routing working under any
  `/t/<slug>/...` path.
- **Tenant provisioning.** Public `POST /signup` creates a tenant +
  first admin and emails the magic link. No payment gate at v1; add
  one downstream of `/signup` if you want to require a card on file
  before activation.
- **RLS engagement.** With `DATABASE_URL_APP` set to the
  openpartner_app role, every tenant-scoped request runs in a
  transaction with `app.tenant_id` pinned, and Row-Level Security
  policies (see migration `20260507010000_rls_policies.ts`) drop any
  query that crosses tenants. Without `DATABASE_URL_APP`, tenant
  isolation falls back to app-level filtering only — fine for
  bootstrap, not safe for production multi-tenant.
- **Stripe webhooks.** A single `/webhooks/stripe` endpoint covers all
  tenants. Each event resolves its tenant from `metadata.openpartner_tenant_id`
  (every Stripe object we create is stamped with this); the handler
  then runs in an `appDb.transaction` with `app.tenant_id` pinned. No
  per-tenant webhook destinations needed.
- **Reserved slugs.** `default`, `www`, `api`, `app`, `admin`,
  `signup`, `login`, `auth`, `docs`, `help`, `support`, `status`,
  `network`, `static`, `public`, `platform` cannot be claimed.
  `apps/api/src/tenancy.ts` has the full list — extend it before
  introducing any new top-level URL space.
- **Scheduler.** `usage-report` and `payouts` iterate active tenants
  per tick; each tenant runs in its own transaction with
  `app.tenant_id` pinned. A single failing tenant doesn't stop the
  others.

To migrate an existing single-tenant deploy to multi:

1. Run the multi-tenant migrations (already part of `pnpm migrate` —
   they backfill every existing row to `tenantId='default'`).
2. Set `OPENPARTNER_APP_DB_PASSWORD`, `DATABASE_URL_APP`, and flip
   `OPENPARTNER_TENANCY=multi`.
3. Redeploy. The default tenant remains accessible at `/t/default/`;
   new tenants come in via `/signup`.

### Scheduled jobs

The api process runs an in-process scheduler (`OPENPARTNER_ENABLE_SCHEDULER=1`):

- **Daily 03:15 UTC** — usage reporting to Stripe meters
- **Monday 09:00 UTC** — payout run (Stripe Connect transfers)

If you ever scale to `instance_count > 1`, set `OPENPARTNER_ENABLE_SCHEDULER=0`
on the replicas — only the primary should fire scheduled jobs. App Platform's
deployment topology doesn't currently surface a "primary" flag, so for now
pick a single instance and don't horizontally scale the api until you've
moved scheduled jobs to a dedicated worker component.

### Manual triggers

Both jobs have admin-only HTTP endpoints in case you need to fire ad-hoc:

```bash
curl -X POST https://app.openpartner.dev/api/billing/report-usage \
  -H "Authorization: Bearer $ADMIN_API_KEY"

# Payouts are run via the standard payouts route — see /docs/payouts
```

### Database backups

DO Managed Postgres takes daily automated backups, retained for 7 days on the
basic production tier. For longer retention or point-in-time recovery, upgrade
the database tier or pipe `pg_dump` to your own object storage.

### Updating

Push to `main` → DO auto-deploys. Migrations run automatically on each api boot.
For schema changes that need a manual data migration, write a one-shot script
under `packages/db/scripts/`, run it once via `doctl apps console $OP_APP_ID
api` after the deploy lands.

### Rollback

```bash
doctl apps list-deployments $OP_APP_ID
doctl apps create-deployment $OP_APP_ID --force-rebuild=false --rollback <prior-deployment-id>
```

Schema rollbacks must be done via knex manually — automatic schema rollback on
deploy rollback is not configured.

### Costs (rough)

| Component | Tier | Monthly |
| --- | --- | --- |
| api (basic-xs) | 1 instance | ~$12 |
| router (basic-xxs) | 1 instance | ~$5 |
| portal (static site) | included | $0 |
| Postgres (production tier) | basic 1GB | ~$15 |
| **Total** | | **~$32** |

Scales to ~3-5x at meaningful traffic.

---

## Troubleshooting

**"Migration failed" on first boot.**
The migration script uses an advisory lock. If a previous deploy crashed
mid-migration, the lock can persist. SSH in via `doctl apps console`, run
`SELECT pg_advisory_unlock_all();` from psql.

**"Customer Portal is not configured."**
Stripe → Settings → Billing → Customer portal → **Activate test link** in test
mode, **Activate live link** in live mode. The first activation is a one-time
toggle.

**Webhooks delivering but events not appearing in /events.**
Likely a signature mismatch. Verify `STRIPE_WEBHOOK_SECRET` is the **comma-
separated** combination of both destination secrets — a single value covers
only one destination.

**Partner Connect onboarding completes but `payoutsEnabled` stays false.**
Stripe runs async verification. Wait 30–120 seconds, then re-check
`/api/partners/:id/connect/status`. If still false after several minutes,
check Stripe → Connect → that account → Requirements for missing fields.

**Refunded transactions still showing accrued commissions.**
The refund handler reverses non-paid commissions automatically. Already-paid
ones are surfaced on the corrective Event's `metadata.alreadyPaidCommissions`
count for admin review. There is no automated clawback in v1.
