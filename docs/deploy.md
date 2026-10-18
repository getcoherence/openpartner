# Deploying OpenPartner

Two supported paths: **DigitalOcean App Platform** (managed, git-deploy, recommended) and **any Docker host** (DigitalOcean Droplet, EC2, bare metal — `docker-compose.prod.yml` is ready).

## DigitalOcean App Platform (recommended)

### What gets deployed

The spec at `.do/app.yaml` declares four components:

| Component | Kind | Purpose |
| --- | --- | --- |
| `api` | Service (Dockerfile) | Node/Express — attribution, auth, network, webhooks |
| `router` | Service (Dockerfile) | Hono click redirect — the `/r/<key>` hot path |
| `portal` | Static site | Vite SPA, served from DO's CDN |
| `openpartner-db` | Managed Postgres | App-owned Postgres 16 |

Ingress rules fan incoming traffic out: `/api/*` → `api`, everything else → `portal`. The router runs on its own subdomain.

### First deploy

1. **Push the repo to GitHub** (private is fine).
2. **Create the app**, either via the DO dashboard (App Platform → Create App → GitHub → pick this repo → App Platform will detect `.do/app.yaml`) or via `doctl`:
   ```bash
   doctl apps create --spec .do/app.yaml
   ```
3. **Set the secrets** App Platform marked as `SECRET` in the spec:
   - `ADMIN_API_KEY` — bootstrap admin token. Generate with `node -e "console.log('op_' + require('crypto').randomBytes(24).toString('hex'))"`.
   - `PORTAL_URL` — e.g. `https://partners.yourdomain.com`. Required in production (CORS allowlist + invite email links).
   - `SECRETS_ENCRYPTION_KEY` — 32 bytes (hex or base64) used to encrypt SMTP passwords / Postmark tokens stored in the Config table. **Required in production.** Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - `POSTMARK_SERVER_TOKEN`, `MAIL_FROM` (or `SMTP_HOST` + SMTP vars, or neither) — mail provider fallback. You can skip these entirely and let the admin configure mail from the Settings UI after install; these env vars win only when UI settings are empty.
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_FLAT_PRICE_ID`, `STRIPE_FLAT_USAGE_PRICE_ID`, `STRIPE_REVSHARE_USAGE_PRICE_ID` — only if running `flat` or `revshare` mode. `STRIPE_SECRET_KEY=sk_... node apps/api/scripts/setup-stripe.mjs` creates the prices and prints their ids. Flex Checkout needs `STRIPE_FLAT_PRICE_ID` and bills only that base price unless `STRIPE_FLAT_USAGE_PRICE_ID` is also set. Revshare Checkout fails without `STRIPE_REVSHARE_USAGE_PRICE_ID`. To bind each webhook signing secret to its Stripe destination, set `STRIPE_WEBHOOK_SECRET_PLATFORM` and `STRIPE_WEBHOOK_SECRET_CONNECT` instead of the legacy `STRIPE_WEBHOOK_SECRET`. The spec doesn't declare those two, so add them as encrypted env vars ([deploy-production.md §6](./deploy-production.md#6-configure-stripe-webhook-destinations)).
   - `COOKIE_DOMAIN` — `.yourdomain.com` so the router's `_cref` cookie covers your landing pages.
   - `METRICS_TOKEN` — optional; set to require Bearer auth on `/metrics`.
   - `OPENPARTNER_APP_DB_PASSWORD` and `DATABASE_URL_APP`. The spec runs `OPENPARTNER_TENANCY=multi`, and a multi-tenant API **refuses to boot** unless its app connection is the non-privileged `openpartner_app` role, so Postgres row-level security keeps tenants apart. Set the password to a random 32+ character string (the entrypoint provisions the role with it), and `DATABASE_URL_APP` to the managed database's connection string with `openpartner_app` and that password in place of the admin credentials. See [deploy-production.md: tenant isolation](./deploy-production.md#tenant-isolation-the-app-role). A single-tenant deploy (`OPENPARTNER_TENANCY=single`) can skip both.
4. **Deploy.** The API container runs migrations on first boot via `apps/api/docker-entrypoint.sh`, so an empty Postgres bootstraps automatically. Subsequent deploys re-run and are idempotent against `knex_migrations`.
5. **Wire custom domains.** In the App Platform UI → Settings → Domains:
   - Primary: `partners.yourdomain.com` → `portal` component.
   - Alias: `go.yourdomain.com` → `router` component.

### Secrets & rotation

Every `SECRET` env var lives in App Platform's secret store (encrypted at rest). Rotate via UI or:
```bash
doctl apps update <APP_ID> --spec .do/app.yaml
```

`DATABASE_URL` is injected automatically from the managed Postgres component — don't set it manually.

### Postgres

The spec defaults to `production: false` (dev-tier Postgres). For real traffic:
- Edit `.do/app.yaml`: set `production: true`, bump `num_nodes`, pick a bigger size.
- Redeploy. DO migrates the dataset.

Or attach an externally-managed Postgres by removing the `databases` block and hard-coding `DATABASE_URL` as a secret.

### Observability

- **Logs**: DO dashboard → Runtime Logs, or `doctl apps logs <APP_ID> --component api`.
- **Metrics**: built-in CPU / memory / req-rate panels per component.
- **Health**: every component has an HTTP healthcheck wired into the spec.

## Docker anywhere (Droplet / bare metal)

If you'd rather run the full stack on a single box:

```bash
# On your target host (Ubuntu 22.04+ assumed):
git clone https://github.com/<you>/openpartner
cd openpartner
cp .env.example .env
# Edit .env — set:
#   OPENPARTNER_DOMAIN, CADDY_EMAIL, ADMIN_API_KEY,
#   PORTAL_HOST, API_HOST, ROUTER_HOST, etc.
docker compose -f docker-compose.prod.yml up -d
```

### Scheduled jobs

Scheduled payouts, Connect transfer retries, commission auto-approval, usage reporting, and the reminder and cleanup sweeps run on the API's in-process scheduler. It starts only when `OPENPARTNER_ENABLE_SCHEDULER=1`. Any other value, or none, leaves it off. Nothing then runs on a timer: you approve commissions and run payouts by hand (the **Payouts** page, or `POST /payouts/run`).

**`docker-compose.prod.yml` turns the scheduler on by default.** It passes `OPENPARTNER_ENABLE_SCHEDULER` through from `.env` and defaults it to `1`. Set it to `0` in `.env` to keep the scheduler off. `.do/app.yaml` sets it to `1` for App Platform.

**Upgrading a compose deploy from an earlier release turns the scheduler on**, because earlier compose files didn't pass the variable at all, so it was always off. Before you upgrade, check the list below against your setup, or set `OPENPARTNER_ENABLE_SCHEDULER=0` in `.env` first.

With the scheduler on, the API does all of the following unattended:

- **Pays partners, Mondays 09:00 UTC.** Each tenant runs on its **Settings → Payouts → Payout cadence**: weekly unless you changed it, never if it's **Manual**. Each run batches every approved, unpaid commission per partner and currency, above the **Minimum payout**.
  - **Stripe Connect rail:** partners with a connected, payouts-enabled Stripe account get a **real Stripe transfer** from the Stripe account behind `STRIPE_SECRET_KEY`. In `selfhost` mode that's your own balance, and no funding check stands in front of it. A job every 15 minutes retries transfers that didn't complete. **Payout rail** decides who is on this rail: `Auto`, the default, uses Connect for every partner who has a connected account. In `flat` and `revshare` modes, Connect payouts that hosted funding doesn't cover are refused and their commissions stay approved.
  - **Manual rail:** the run records a pending payout and marks its commissions `paid`. You send the money yourself.
- **Approves commissions after holdback, daily 05:15 UTC.** An accrued commission is approved once its holdback has elapsed, when that holdback (the partner's override, else the program's) is above 0 days. That includes any backlog already past its holdback, which the next payout run then pays. Commissions with no holdback still wait for manual approval.
- **Reports usage to Stripe, daily 03:15 UTC (`flat` and `revshare` only).** For each tenant subscribed through `/billing/checkout`, attributed GMV not yet billed goes to the Stripe usage meter. A tenant that has never been reported has no starting point, so its first report covers all attributed GMV to date.
  - **What counts.** Billable GMV is the value of revenue events (`invoice_paid`, `subscription_created`, plus `OPENPARTNER_BILLABLE_EVENT_TYPES_EXTRA`) that a partner was credited for, less refunds. Refunds come from `POST /attribution/refunds` and from Stripe `charge.refunded`. A partial refund counts in proportion, and a chargeback counts as a refund. A conversion stops counting entirely once every commission it earned has been reversed, whether by a refund or an admin reverse (fraud, self-referral, terms breach). A Stripe dispute on its own changes nothing, because a dispute can still be won. Reverse the commission or report a chargeback once it's lost.
  - **Refunds after a report.** The `UsageLedger` table records what each conversion has been billed. Every report bills the difference between a conversion's billable value now and what it was billed: new revenue is billed, and refunded or reversed revenue is credited. A credit is converted at the rate its conversion was billed at. Stripe meters reject negative usage, so the report sends the net. A credit larger than that day's new GMV carries forward (the `stripe.merchant.usageCarryUsd` Config row) until later GMV covers it. Credit still carried when a tenant leaves a metered plan is never applied, so refund it by hand.
  - **The first run after upgrading** opens the ledger at each conversion's billable value at that moment. Refunds and reversals recorded before the upgrade are not credited automatically. [usage-refund-credit-audit.sql](./usage-refund-credit-audit.sql) lists them.
  - **Currencies.** The metered prices are in USD. GMV is summed per currency, and anything that isn't USD is converted at the European Central Bank's daily euro reference rates ([eurofxref-daily.xml](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml)), crossed through EUR. The rates and their reference date are saved with the report, and returned by `POST /billing/report-usage`. Two cases log an `[usage] ALERT` line instead of billing at a guessed rate. If the ECB doesn't publish a currency (AED, for example), that GMV is left off the meter and the window moves on, so invoice it yourself. If the rate feed can't be read, the run is skipped and the window stays open, so the next run bills it. The Network payouts report (self-hosted tenants on the Network) converts payouts the same way.
- **Housekeeping**, including campaign-end emails 7 days before a program ends, hard-deleting tenants 30 days after a deletion request, Network sync for tenants connected to the Network, and (outside `selfhost`) Stripe subscription reconciliation.

To keep paying partners by hand while the other jobs run, set **Payout cadence** to **Manual** before you turn the scheduler on.

**Run it on exactly one API process.** Each job runs under a Postgres advisory lock keyed on its name, so two processes can't run the same job at the same time. They can still run it twice back to back, when one process's tick lands after the other's run has finished. Don't `docker compose up --scale api=N` with the scheduler on. If you need more API replicas, run the extra ones as a separate service with `OPENPARTNER_ENABLE_SCHEDULER=0`. See [deploy-production.md](./deploy-production.md#scheduled-jobs).

### Skipping the build — prebuilt images

Every push to `main` publishes three images to GitHub Container Registry:

- `ghcr.io/getcoherence/openpartner-api:edge`
- `ghcr.io/getcoherence/openpartner-router:edge`
- `ghcr.io/getcoherence/openpartner-portal:edge`

Tagged releases (`v1.2.3`) publish `1.2.3`, `1.2`, `1`, and `latest`. To run
those instead of building locally, swap each service's `build:` block in
`docker-compose.prod.yml` for `image: ghcr.io/getcoherence/openpartner-<service>:edge`
and `docker compose pull` before `up -d`. Fork users: replace `getcoherence`
with your GitHub username / org.

Caddy terminates TLS via Let's Encrypt automatically and reverse-proxies three subdomains (`portal.`, `api.`, `go.`) at the three services. Point their DNS at the box's IP and Caddy handles the rest.

```bash
# Follow the API's first-boot migrations:
docker compose -f docker-compose.prod.yml logs -f api
```

### Upgrading

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations run again on the API's next boot — zero-downtime per-service restart as each container cycles.

### Backups

Point a cron at `pg_dump` against the Postgres service, or mount the `postgres-data` volume on block storage you back up. For anything bigger than a hobby deploy, use DO Managed Postgres (or any managed offering) instead of the bundled container.

## Domains

Whichever host you pick:

| Subdomain | What it serves | Example |
| --- | --- | --- |
| Portal | Partner + admin UI | `partners.yourdomain.com` |
| API | JSON HTTP API — webhooks, SDK, portal fetches | `api.yourdomain.com` |
| Router | Partner share links resolve here | `go.yourdomain.com` |

The portal's fetches go to `/api/*` relatively; App Platform's ingress rules and the compose's Caddyfile both route that to the API. You don't configure the portal's API URL separately.

The router URL is what creators embed in their promo content (`go.yourdomain.com/r/graciefindsdeals`), so pick something short and branded.

## Bootstrap

On first successful boot, sign in at `https://partners.yourdomain.com/login` with the API key tab, paste your `ADMIN_API_KEY`. From there:

1. **Create a partner** (Admin → Partners → Invite partner).
2. **Create a program** with a commission rule (Admin → Programs).
3. **Create a link** for the partner.
4. **Embed the SDK** in your product — see [`packages/sdk/README.md`](../packages/sdk/README.md).
5. Optional: **join the Network** (Admin → Network → Vendors) to start getting creator applications.
