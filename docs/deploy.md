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
   - `NETWORK_ENCRYPTION_KEY` — 32 hex bytes for AES-256-GCM. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - `POSTMARK_SERVER_TOKEN`, `MAIL_FROM` — your Postmark creds + verified sender.
   - `PORTAL_URL` — e.g. `https://partners.yourdomain.com`. Magic-link emails link to this.
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_FLAT_PRICE_ID` — only if running `flat` or `revshare` mode.
   - `COOKIE_DOMAIN` — `.yourdomain.com` so the router's `_cref` cookie covers your landing pages.
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
#   NETWORK_ENCRYPTION_KEY, POSTMARK_SERVER_TOKEN, MAIL_FROM, etc.
docker compose -f docker-compose.prod.yml up -d
```

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

1. **Create a partner** (Admin → Partners → New partner).
2. **Create a campaign** with a commission rule.
3. **Create a link** for the partner.
4. **Embed the SDK** in your product — see [`packages/sdk/README.md`](../packages/sdk/README.md).
5. Optional: **join the Network** (Admin → Network → Vendors) to start getting creator applications.
