# White-Label Custom Domain — Onboarding Runbook

Sequence for putting a hosted tenant's portal on their own domain (first
customer: **xispark** → `portal.xispark.com`). MVP edge is
**DO App-Platform-native** (spec §6.3): DigitalOcean terminates TLS and the
API resolves the tenant from the Host header.

**Preferred path (Phase 3, self-serve):** the tenant admin does steps 1–4
themselves in **admin → White label** — enable the add-on (attaches the
Stripe price to their subscription), register the domain, publish the two
DNS records, hit Verify. The curl/SQL commands below hit the SAME
endpoints and exist for concierge onboarding and debugging.

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
| `STRIPE_WHITELABEL_ADD_ON_PRICE_ID` on the api component | Monthly recurring price created in Stripe (proposed $99/mo, intro coupon separate). Required for the self-serve add-on toggle; without it the enable endpoint 500s `stripe_price_not_configured` |
| `EDGE_TRUST_SECRET` **unset** | DO-native path trusts only the genuine Host header; the secret exists for the Phase-3 droplet edge |
| `PortalCustomDomain` migration applied | Api entrypoint migrates on boot; confirm the deploy after PR #29 succeeded |

> **Never declare `domains:` in `.do/app.yaml`.** `doctl apps update --spec`
> replaces the whole spec — a spec-managed domain list would wipe every
> dynamically-added customer domain (see the comment in `.do/app.yaml`).

## 1. Enable the add-on (Stripe-billed)

Precondition: the tenant has an **active plan subscription** (Flex or
RevShare — the add-on attaches to it; `STRIPE_WHITELABEL_ADD_ON_PRICE_ID`
must be set on the api component).

**Self-serve:** tenant admin → **White label** → *Enable white-label
add-on*. This adds the add-on price to their subscription as a prorated
line item and flips `Tenant.whiteLabel`; the `customer.subscription.updated`
webhook re-confirms it. (A brand that hasn't subscribed yet gets a
`subscription_required` nudge to Billing first — or bundles the add-on
into plan checkout via `whiteLabel: true` on `/billing/checkout`.)

**Concierge equivalent:**

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://app.openpartner.dev/api/t/<SLUG>/billing/white-label | jq .
# → { ok: true, provisioned: true, billedVia: "subscription_item_added" }
```

Sanity-check the *effective* state:

```bash
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://app.openpartner.dev/api/t/<SLUG>/billing/white-label | jq '{provisioned, effective}'
# → both true  (effective=false = billing state is not entitling)
```

Enterprise tenants: same endpoint sets the flag directly — no Stripe item,
the add-on is encoded in the negotiated contract (§8.3). Disabling
(`DELETE /billing/white-label`, or the UI's *Disable add-on*) removes the
subscription item with a prorated credit AND revokes custom-domain
routing + the DO edge. Cancelling the whole subscription or letting the
add-on lapse does the same via webhook/sweep — nobody keeps white-label
without paying for it.

## 2. Network isolation assertion (spec §7.4 — before the domain goes live)

A white-label tenant must not be discoverable on the Network. Enabling the
add-on now does this automatically: it **unpublishes every Network
offering** the brand had (immediate marketplace removal), and ongoing
pushes/heartbeats are suppressed while the entitlement is live. Program
saves can't re-publish (guard in the marketplace sync). Watch api logs for
`marketplace withdraw incomplete` — that means a Network call failed and
the listed offerings must be hidden on the Network side by hand.

Belt-and-suspenders assert (mandatory for SQL-provisioned tenants, cheap
for everyone):

```sql
select value from "Config" where "tenantId" = (select id from "Tenant" where slug = '<SLUG>')
  and key = 'network_membership';
-- expect: no row, or enabled=false. If a vendorId exists, hide/remove the
-- vendor on the Network side before proceeding.
```

## 3. Register the domain in OpenPartner

**Self-serve:** admin → White label → *Custom domain* → enter the
subdomain → Register. The page shows both DNS records with copy buttons.

**Concierge equivalent:**

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

## 4. Verify (auto-registers the domain on the DO app)

**Self-serve:** the *Verify* button on the White label page.
**Concierge equivalent**, once both DNS records resolve:

```bash
# id = the domain row id from step 3 (or GET /config/domain to list)
curl -s -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://app.openpartner.dev/api/t/<SLUG>/config/domain/<id>/verify \
  | jq '{status, edge}'
# → { "status": "verified", "edge": "added" }
#   422 verification_failed = TXT not visible yet. Retry-safe: the token
#   does NOT change on a failed attempt (rotation only happens when the
#   daily job demotes a previously-verified domain, §7.6), so just wait
#   for DNS propagation and retry with the same published records.
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
