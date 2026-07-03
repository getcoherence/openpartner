# White-Label Custom Domain — Onboarding Runbook

Ops sequence for putting a hosted tenant's portal on their own domain
(first customer: **xispark** → `portal.xispark.com`). MVP edge is
**DO App-Platform-native** (spec §6.3): DigitalOcean terminates TLS and the
API resolves the tenant from the Host header. There is no self-serve UI for
this yet (Phase 3) — the OpenPartner half is curl/SQL.

Throughout: `<SLUG>` = tenant slug (`xispark`), `<DOMAIN>` = customer host
(`portal.xispark.com`), `<APP-ALIAS>` = the DO app's
`<app-id>.ondigitalocean.app` hostname.

---

## 0. One-time platform preconditions (already done — verify, don't redo)

| Check | How |
|---|---|
| `app.openpartner.dev` is a PRIMARY domain on the DO app | DO console → app → Settings → Domains |
| `PORTAL_URL=https://app.openpartner.dev` on the api component | DO console → api component → env vars |
| `DO_API_TOKEN` (apps read/write) + `DO_APP_ID` on the api component | Same place. Enables automatic DO domain sync: verify registers the domain on the app, revocation removes it, and the customer CNAME target is derived from the API. Without them every DO-side step in this runbook is manual (console → Settings → Domains) and the API responses say `edge: "skipped"` |
| `DO_APP_DOMAIN_ALIAS` — optional | Only needed to override the derived `<APP-ALIAS>` CNAME target (e.g. no DO token configured) |
| `EDGE_TRUST_SECRET` **unset** | DO-native path trusts only the genuine Host header; the secret exists for the Phase-3 droplet edge |
| `PortalCustomDomain` migration applied | Api entrypoint migrates on boot; confirm the deploy after PR #29 succeeded |

> **Never declare `domains:` in `.do/app.yaml`.** `doctl apps update --spec`
> replaces the whole spec — a spec-managed domain list would wipe every
> dynamically-added customer domain (see the comment in `.do/app.yaml`).

## 1. Entitle the tenant

White-label endpoints refuse (`402`) unless the tenant is **effectively**
entitled: `whiteLabel=true` AND (active Stripe subscription OR in-trial OR
enterprise). Confirm the billing side first (a lapsed trial without a
subscription will 402), then provision the flag:

```sql
update "Tenant" set "whiteLabel" = true, "updatedAt" = now()
where slug = '<SLUG>';
```

Sanity-check the *effective* state (as an admin of the tenant):

```bash
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://app.openpartner.dev/api/t/<SLUG>/config/program | jq .whiteLabel
# → true  (false = billing state is not entitling; fix billing first)
```

## 2. Network isolation assertion (spec §7.4 — before the domain goes live)

A white-label tenant must not be discoverable on the Network. The code
suppresses federation at the source, but assert there's no pre-existing
`Vendor` row:

```sql
select value from "Config" where "tenantId" = (select id from "Tenant" where slug = '<SLUG>')
  and key = 'network_membership';
-- expect: no row, or enabled=false. If a vendorId exists, hide/remove the
-- vendor on the Network side before proceeding.
```

## 3. Register the domain in OpenPartner

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"domain":"<DOMAIN>"}' \
  https://app.openpartner.dev/api/t/<SLUG>/config/domain | jq .
```

Response includes `dnsInstructions` — send both records to the customer:

| Record | Name | Value |
|---|---|---|
| CNAME | `<DOMAIN>` | `<APP-ALIAS>` |
| TXT | `_openpartner.<DOMAIN>` | `openpartner-verify=<token>` |

Tell the customer explicitly: **the TXT record is permanent ownership
proof.** A daily job re-checks it; deleting it disables the domain (§7.6).

Subdomains only in v1 — an apex (`xispark.com`) is rejected with
`subdomain_required`.

## 4. Verify in OpenPartner (auto-registers the domain on the DO app)

Once both DNS records resolve:

```bash
# id = the domain row id from step 3 (or GET /config/domain to list)
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://app.openpartner.dev/api/t/<SLUG>/config/domain/<id>/verify \
  | jq '{status, edge}'
# → { "status": "verified", "edge": "added" }
#   422 verification_failed = TXT not visible yet; the token ROTATES on
#   failure — re-read dnsInstructions from the response and make sure the
#   customer published the CURRENT value.
```

Success stamps `Tenant.customDomain` (host-based tenant resolution,
custom-domain CORS, custom-domain magic-link URLs) **and registers the
domain on the DO app** via the API, after which DO validates via the
customer's CNAME and provisions/renews the Let's Encrypt cert. Wait until
the domain shows **Active** in the DO console.

`edge` values other than `added`/`exists` mean the DO side needs a hand:
`skipped` = `DO_API_TOKEN`/`DO_APP_ID` not configured, `failed` = DO API
error (see api logs). In either case add `<DOMAIN>` manually: DO console →
app → Settings → Domains → **Add Domain**, "You manage your domain" (type
ALIAS, no DO zone). Verification itself still stands — re-running verify
later retries the DO registration (it's idempotent).

## 5. Header-capture check (launch-blocking, spec §6.3/§9)

Confirms DO forwards the public host as `Host` and strips client-supplied
`X-Forwarded-Host`:

```bash
# 1. Resolves the tenant from the genuine Host:
curl -s https://<DOMAIN>/api/branding | jq .tenantSlug        # → "<SLUG>"

# 2. Spoof guard — a forged XFH against the platform origin must NOT resolve:
curl -s -H 'X-Forwarded-Host: <DOMAIN>' \
  https://app.openpartner.dev/api/branding | jq .tenantSlug   # → null

# 3. SPA + brand: open https://<DOMAIN>/ — expect the tenant-branded login
#    (no OpenPartner branding), not the platform landing page.
```

## 6. End-to-end login (the §4.3+§4.4 atomic pair)

Request a magic link from `https://<DOMAIN>/login` for a tenant admin.
Verify the emailed link points at `https://<DOMAIN>/auth/magic?...` (not
`app.openpartner.dev`), click it, and confirm you land signed-in on the
custom domain. Sessions are host-only by design: being signed in on
`<DOMAIN>` does not sign you in on `app.openpartner.dev`, and vice versa.

## 7. Post-launch behavior

- **Daily jobs** (api scheduler): `portal-domain-reverify` (04:45 UTC)
  demotes the domain if the TXT proof disappears;
  `white-label-entitlement-sweep` (04:55 UTC) clears routing when billing
  entitlement lapses (incl. trials that expire without subscribing).
- **Revocation is automatic** when `DO_API_TOKEN`/`DO_APP_ID` are set:
  both jobs (and admin domain deletion) remove the domain from the DO app
  so the cert stops renewing. Watch api logs for
  `[white-label] custom domain ... revoked` — a line ending in
  `DO edge skipped/failed: remove it ... manually` means the automation
  couldn't reach DO and an operator must remove the domain in the console.
- **Cancellation UX is graceful:** while the cert lives, the portal keeps
  working on the custom domain but reverts to platform branding; the
  domain stops resolving only after revocation removes it.
