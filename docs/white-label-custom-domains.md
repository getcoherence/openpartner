# White-Label Custom Domains — Implementation Spec (FINAL, post-review)

**Status:** Reviewed & corrected · **Author:** Lead architect · **Reviewers:** Infra/TLS, Auth/CORS/Cookie, Security/Abuse/Billing · **Date:** 2026-06-28
**Target branch:** `multi-tenant` (with branding migrations cherry-picked in — see §9 Phase 0)
**First customer:** xispark (slug `xispark`, jsbizltd) → `portal.xispark.com`

> This revision integrates three adversarial reviews. The load-bearing changes from the original draft: (1) the edge is pinned to **one** path for MVP — **DO App-Platform-native custom domains** (§6.3) — and the "second listener IP on one droplet" mechanism is **retracted as unworkable** (§6.1); (2) `X-Forwarded-Host` is **never trusted on its own** — tenant resolution is deployment-aware and gated by a shared-secret edge header (§4.3, §7.5); (3) verification is **not terminal** — an ongoing re-verification job closes the dangling-CNAME takeover window (§4.2, §7.6); (4) the cert/entitlement gate enforces **billing state**, not just a boolean, and a trial-expiry sweep revokes routing (§4.1, §8); (5) Network federation suppression is **launch-minimal**, not Phase 3 (§7.4, §9). A change-log of every caught risk is in §11.

---

## 1. Summary & approach

We ship white-label custom domains as a **billing-gated `whiteLabel` entitlement** on the existing multi-tenant foundation. For the **first customer and the MVP**, the edge is **DigitalOcean App-Platform-native custom domains** (`doctl apps` / `.do/app.yaml` domains): DO terminates TLS for `portal.xispark.com`, provisions/renews the cert, and forwards to the `api`/`portal` components of the existing `openpartner` app — **no droplet, no Caddy, no Host-rewrite, no single point of failure on the critical path**. The OpenPartner API resolves the tenant **by inbound host** (extending `resolveTenant` in `apps/api/src/tenancy.ts`), all partner-facing branding falls back to per-tenant brand config, Network/Discover surfaces are hidden, and federation to the Network is suppressed at the source so a white-label tenant is never publicly discoverable.

The three genuine correctness hazards — magic-link/invite URLs, CORS, and session-cookie scope — are solved by a single per-tenant `getPortalBaseUrl(tenant)` helper routed through the **one** magic-link chokepoint (`buildMagicLinkUrl`), plus the fact (verified below) that the production proxy makes the SPA and API **same-origin under the custom domain**, which collapses most of the CORS/cookie risk. The three *security* hazards the review surfaced — `X-Forwarded-Host` spoofing from the shared origin, stale-verification domain takeover, and free white-label after an unpaid trial lapses — are closed by an edge-trust secret, an ongoing re-verification job, and billing-state enforcement in the cert/entitlement gate.

A **productized self-serve** path (Phase 3) adds a **dedicated white-label droplet** running Caddy `on_demand_tls` with its **own** global `ask` gate, its **own** ACME account, and its **own** public IP — fully isolated from the existing creator-share droplet so it never touches live creator cert issuance.

> **Findings verified that shape the plan** (do not skip):
> 1. **Session cookies are already host-only.** `sessionCookieOptions()` (`apps/api/src/auth-sessions.ts:160-167`, `multi-tenant`) sets `{ httpOnly, secure, sameSite:'lax', path:'/', maxAge }` with **no `domain`**. Host-only is exactly what we want — sessions self-isolate per domain. **We must NOT add a `Domain` attribute.** Signout (`partner-auth.ts` `clearCookie(name,{path:'/'})`) is likewise domain-less, which correctly matches a host-only set — keep it that way (§7.3).
> 2. **The portal upstream must NOT replicate the Network's `rewrite * /api{uri}`.** The App Platform app serves **SPA at `/` and API at `/api` under the same host**. Any white-label edge must **preserve the path**.
> 3. **Branding and tenancy are on different branches.** The brand-aware `mailer.ts` (`via OpenPartner` From), `brand-name.ts`, and `email-templates.ts` brand helpers exist on `main`/`feat/mobile-responsive`; tenant resolution + RLS exist on `multi-tenant`. **On `multi-tenant` today, `mailer.ts` is the simpler `RoutingMailer` with no `via OpenPartner` block and `brand-name.ts` does not exist.** Phase 0 reconciles this by cherry-picking branding into `multi-tenant` (never the reverse). The mailer/brand edits in §4.6 are therefore a **Phase-0 cherry-pick prerequisite**, not in-place edits to current `multi-tenant`.
> 4. **The original draft's claim that the verification token "rotates on every re-verify" was wrong.** The cited Network template mints the token once and short-circuits re-verify with `{already:true}` — it never rotates and never re-checks DNS. We now implement **real rotation + ongoing re-verification** (§4.2, §7.6).

---

## 2. Architecture diagram

### 2.1 MVP edge — DO App-Platform-native (no droplet, no SPOF)

```
              DNS: portal.xispark.com  CNAME → <app-id>.ondigitalocean.app   (DO app alias)
                   (PLUS  _openpartner.portal.xispark.com TXT = openpartner-verify=<token>
                          — OpenPartner's own ownership proof, used for re-verification §7.6)
                                          │
                                          ▼
  ┌────────────┐   TLS (DO-managed LE cert; DO validates ownership via the CNAME)
  │  Browser   │ ─────────────────────────────────────────────────────────────┐
  │ portal.    │                                                               │
  │ xispark.com│                                                               ▼
  └────────────┘                       ┌─────────────────────────────────────────────────────┐
        ▲   same-origin https          │  DO App Platform app "openpartner"                   │
        │   (SPA + /api)               │  custom domain portal.xispark.com registered on app  │
        │                              │  ingress:  /→portal (static SPA + CDN)               │
        │                              │            /api→api (Express)                        │
        │                              │            /r→router (Hono click redirect)           │
        │                              └───────────────────────┬─────────────────────────────┘
        │                                                      ▼  (PRECONDITION §6.3/§9:
        │                              ┌───────────────────────────────────────────────────────┐
        │                              │  Express API   (NO X-OP-Edge-Token on this path)       │
        │                              │  resolveTenant: host = GENUINE Host header             │
        │                              │    (verified by header-capture precondition that DO    │
        │                              │     forwards the public domain as Host and strips       │
        │                              │     client-supplied X-Forwarded-Host)                   │
        │                              │  Tenant WHERE lower(customDomain)=host AND status=active│
        │                              │    → SET LOCAL app.tenant_id = <id>  (RLS)             │
        │                              │  effectiveWhiteLabel = whiteLabel && billingActive      │
        │                              │  getPortalBaseUrl(tenant) → https://portal.xispark.com  │
        │                              │  effectiveWhiteLabel ⇒ hide Network/Discover, drop      │
        │                              │    "via OpenPartner", brand From/Reply-To              │
        │                              └───────────────────────────────────────────────────────┘
        └─ Everything is https://portal.xispark.com ⇒ SPA fetch('/api/..') is SAME-ORIGIN.
           No CORS, no cross-domain cookie. Session cookie host-only on portal.xispark.com.
```

### 2.2 Phase-3 self-serve edge — dedicated white-label droplet (isolated from creator shares)

```
   DNS: portal.<tenant>.com  CNAME → portal-router.openpartner.dev  (NEW droplet, own public IP)
        + _openpartner.<host> TXT = openpartner-verify=<token>
                                          │  TLS via on_demand_tls
                                          ▼
  ┌─────────────────────────────────────────────────────────────────────────────────┐
  │  NEW White-Label Caddy droplet (separate box, own public IP, own ACME account)    │
  │   global on_demand_tls { ask GET app.openpartner.dev/api/portal-domain-allowed }  │
  │     → 200 only if domain verified, NOT stale, AND tenant white-label-ENTITLED      │
  │   reverse_proxy https://app.openpartner.dev {                                      │
  │     header_up Host app.openpartner.dev          # DO edge accepts only this Host   │
  │     header_up X-Forwarded-Host portal.<tenant>.com                                │
  │     header_up X-OP-Edge-Token {env.EDGE_TRUST_SECRET}   # proves request is ours   │
  │     # NO `rewrite * /api{uri}` — path preserved                                    │
  │   }                                                                                │
  └─────────────────────────────────────────────────────────────────────────────────┘
        │  Host: app.openpartner.dev · X-Forwarded-Host: portal.<tenant>.com · X-OP-Edge-Token: ***
        ▼
   DO App Platform "openpartner" → Express API
     resolveTenant: X-OP-Edge-Token valid ⇒ trust X-Forwarded-Host; else genuine Host
```

The creator-share droplet (`138.197.86.37`, `router.openpartner.dev`) is **untouched** — its global `ask` keeps pointing at `network.openpartner.dev/api/share-domain-allowed`. The two classes share no Caddy instance, no ACME account, no cert storage, and no Let's Encrypt rate-limit pool.

---

## 3. Data model changes

All changes land as new migrations in `packages/db/migrations/` on `multi-tenant`. `Tenant.customDomain` already exists (`20260507000000_multi_tenant.ts:36`, `unique`, nullable). We add the entitlement flag and the verification sidecar.

### 3.1 `whiteLabel` entitlement — **S**

`packages/db/migrations/20260628000000_tenant_white_label.ts`

```ts
export async function up(knex: Knex) {
  await knex.schema.alterTable('Tenant', (t) => {
    t.boolean('whiteLabel').notNullable().defaultTo(false);  // add-on PROVISIONED
  });
}
```

- Add `whiteLabel: boolean` to `TenantRow` in `packages/db/src/types.ts`.
- Semantics: `whiteLabel=true` means the add-on is **provisioned**. It is **not** by itself the runtime entitlement. The **effective entitlement** is `whiteLabel && billingActive(tenant)` where `billingActive = activeSubscription || inTrial || enterprise` (§8.1). Gate/revocation/branding all key on the effective entitlement, never the bare boolean (closes the "free white-label after lapsed trial" hole, §8.1).
- Orthogonal to `billingPlan` (`flex|revshare|enterprise|null`).

### 3.2 White-label portal domain table (`PortalCustomDomain`) — **S**

A table (not inline `Tenant` columns) lets a tenant hold a pending + a verified domain during cutover and keeps an audit trail.

`packages/db/migrations/20260628000100_portal_custom_domain.ts`

```ts
await knex.schema.createTable('PortalCustomDomain', (t) => {
  t.string('id').primary();                       // ULID
  t.string('tenantId').notNullable()
     .references('id').inTable('Tenant').onDelete('CASCADE');
  t.string('domain').notNullable().unique();      // GLOBAL unique — prevents claim races
  t.string('verificationToken').notNullable();    // hex; REGENERATED on every (re)registration / re-verify cycle (§7.6)
  t.string('status').notNullable().defaultTo('pending'); // pending|verified|failed
  t.string('edgeKind').notNullable().defaultTo('do_native'); // do_native|droplet — drives dnsInstructions (§4.2)
  t.timestamp('verifiedAt').nullable();
  t.timestamp('lastCheckedAt').nullable();        // last re-verification poll (§7.6)
  t.timestamp('createdAt').notNullable().defaultTo(knex.fn.now());
  t.index(['tenantId']);
  t.index(['domain', 'status']);                  // the allow-gate's hot lookup
});
```

**RLS policy (specified, per reviewer):**

```sql
ALTER TABLE "PortalCustomDomain" ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_custom_domain_tenant ON "PortalCustomDomain"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
```

- The **admin register/verify endpoints (§4.2) run on `appDb` (RLS-scoped)** so a tenant physically cannot insert a `PortalCustomDomain` row under another `tenantId` — the `WITH CHECK` rejects it.
- The **allow-gate (§4.1)** and **host-resolver (§4.3)** run on the privileged `db` pool, which **bypasses RLS** (verified, commit `648c982`) — they perform the legitimate cross-tenant `domain → tenant` lookup. This is exactly the split `resolveTenantFromPath` already uses.
- Keep `Tenant.customDomain` as the **denormalized "primary verified domain"** for the host-resolution hot path; `PortalCustomDomain` is touched on verify/admin/re-verification flows.

### 3.3 Portability (CLAUDE.md §2/§5 — added per review) — **S**

White-label introduces hosted-only concepts; portability is a hard architectural constraint, so we state coverage explicitly:

- **`PortalCustomDomain` is a sidecar table** (clearly optional, not a core attribution table) — correct per CLAUDE.md §2. It is added to the documented export schema and is exported to **CSV + JSON + SQL** like every other table.
- **`Tenant.whiteLabel`** is a hosted-only billing entitlement living alongside the existing hosted-only Stripe columns. It is **intended to export losslessly** and to be an **inert no-op on self-hosted import** (NB: as of schemaVersion 2 the `Tenant` table itself is not yet in the export set — see docs/data-portability.md): in `OPENPARTNER_MODE=selfhost`, the importer accepts the column, ignores its billing semantics (self-host has no metered white-label entitlement — branding is simply always available), and never requires a Stripe price/subscription to honor it. `verificationToken`/`status`/`edgeKind` import as plain data; a self-hosted instance re-derives its own edge.
- Net effect: export stays **lossless and re-importable**; migrating off hosted into self-hosted does not lose the domain history and does not drag in a billing dependency. No core table gains a hosted-only field (CLAUDE.md §2), and nothing here makes export lossy (CLAUDE.md §5).

---

## 4. API changes (`apps/api`)

### 4.1 Entitlement predicate + allow-gate (Caddy `ask`) — **S**

A single predicate is the source of truth for "may this domain serve white-label traffic," used by the droplet `ask` endpoint, the trial-expiry sweep, and revocation:

```ts
// effective entitlement — NOT the bare boolean (closes the lapsed-trial free-ride, §8.1)
export function isWhiteLabelEntitled(t: TenantRow): boolean {
  if (!t.whiteLabel || t.status !== 'active') return false;
  const state = getTenantBillingState(t);          // reuse billing-plan.ts
  return state === 'active' || state === 'trialing' || state === 'enterprise';
}
```

`apps/api/src/routes/portal-domains.ts`, mounted **public/unauthenticated, before `tenantMiddleware`** in `app.ts`:

```ts
// GET /api/portal-domain-allowed?domain=<host>   (server-to-server; white-label droplet only)
router.get('/portal-domain-allowed', async (req, res) => {
  const domain = String(req.query.domain ?? '').toLowerCase().trim();
  if (!domain) return res.status(400).type('text/plain').send('domain required');
  // Privileged pool (db) — cross-tenant read; RLS would block it.
  const row = await db('PortalCustomDomain as d')
    .join('Tenant as t', 't.id', 'd.tenantId')
    .where({ 'd.domain': domain, 'd.status': 'verified' })
    .first(['t.*', 'd.verifiedAt', 'd.lastCheckedAt']);
  if (!row) return res.status(404).type('text/plain').send('not allowed');
  if (isStaleVerification(row.verifiedAt, row.lastCheckedAt))     // §7.6 TTL
    return res.status(404).type('text/plain').send('verification stale');
  if (!isWhiteLabelEntitled(row))                                 // §8.1 billing state
    return res.status(404).type('text/plain').send('not entitled');
  res.status(200).type('text/plain').send('ok');
});
```

- The gate folds in **entitlement (billing state, not just a boolean)** and **verification freshness**. On cancel/trial-lapse/stale → 404 → Caddy stops renewing → cert lapses → domain stops resolving. No separate revocation plumbing for the droplet path.
- **DO-native path has no `ask`.** DO manages the cert, so entitlement revocation there is an explicit action: the trial-expiry sweep (§8) and the Stripe webhook (§8.2) call the **DO API** (`doctl apps update` / `apps` API) to **remove the custom domain** and clear `Tenant.customDomain` when `isWhiteLabelEntitled` goes false. This is the DO-native equivalent of "gate 404."

### 4.2 Register / verify domain (admin) — **M**

New endpoints in `portal-domains.ts`, mounted under the **authenticated admin router (tenant-scoped, `appDb`)**.

**Entitlement-gated registration (closes squatting / partial self-enable, per review):** every endpoint here first requires `isWhiteLabelEntitled(tenant)`. A non-paying or post-trial tenant **cannot** register, verify, or hold a domain.

- `POST /config/domain` `{ domain }`:
  1. Require `isWhiteLabelEntitled(tenant)` → else `402 payment_required`.
  2. Validate FQDN; **reject platform/reserved hosts** before insert — mirror `isPlatformHost` and `RESERVED_SLUGS`: refuse `*.openpartner.dev` (`app|api|router|network`), `*.ondigitalocean.app`, `localhost`, and any host derived from a reserved slug. Fail loudly (`400 reserved_host`) rather than relying only on the unique constraint.
  3. Reject if already claimed globally (`409 domain_taken`).
  4. Insert `PortalCustomDomain{ status:'pending', verificationToken: randomHex(24), edgeKind }` where `edgeKind` is `do_native` (MVP) or `droplet` (Phase 3).
  5. Return **edge-specific `dnsInstructions`** (see below).
- `POST /config/domain/:id/verify`:
  - Require `isWhiteLabelEntitled(tenant)`.
  - `dns.resolveTxt('_openpartner.' + domain)`, compare token. **Does NOT short-circuit on already-verified — it always re-checks DNS** (fixing the template's `{already:true}` bug).
  - On match: `status:'verified'`, `verifiedAt=now`, `lastCheckedAt=now`, set `Tenant.customDomain=domain` if first verified. For `do_native`, also call the DO API to register the domain on the app (idempotent).
  - On mismatch: `status:'failed'`, **regenerate `verificationToken`** (rotation), leave `Tenant.customDomain` untouched.
  - Returns 200 iff verified.
- `GET /config/domain` → list for the admin UI.

**`dnsInstructions` branch on `edgeKind` (fixes the original cross-option inconsistency):**

| edgeKind | CNAME the customer sets | TXT the customer sets | Cert by |
|---|---|---|---|
| `do_native` (MVP) | `portal.xispark.com` → **`<app-id>.ondigitalocean.app`** (the DO app alias) | `_openpartner.portal.xispark.com` = `openpartner-verify=<token>` | **DO** (validates ownership via the CNAME) |
| `droplet` (Phase 3) | `portal.<tenant>.com` → **`portal-router.openpartner.dev`** (the white-label droplet) | `_openpartner.<host>` = `openpartner-verify=<token>` | **Caddy on-demand** (gated by §4.1) |

> The original draft handed the customer `router.openpartner.dev` (the *creator* droplet) regardless of edge — wrong for both paths. Corrected: the CNAME target is now derived from the chosen edge, and the `_openpartner` TXT is **always** required as **OpenPartner's own ongoing ownership proof** (used by the re-verification job §7.6) — independent of DO's cert-validation CNAME. dnsInstructions must tell the customer the **TXT record must remain in place permanently**; removing it triggers demotion (§7.6).

Apex domains need ALIAS/ANAME — defer/restrict to subdomains in v1 (Open Question §10.2).

### 4.3 Host-based tenant resolution — **M** (highest-value + highest-risk change)

Extend `resolveTenant` in `apps/api/src/tenancy.ts`. The critical correction: **`X-Forwarded-Host` is never trusted on its own**, because Express `trust proxy 1` governs only `req.ip/hostname/secure` — not arbitrary header reads — and a request sent **directly** to `app.openpartner.dev/api` with a forged `X-Forwarded-Host: portal.xispark.com` would otherwise be RLS-scoped to that tenant (cross-tenant context leak from the shared origin). Resolution is therefore **deployment-aware** and gated by a shared-secret edge header.

```ts
const EDGE_SECRET = process.env.EDGE_TRUST_SECRET ?? '';
const edgeTrusted = (req: Request) =>
  EDGE_SECRET.length > 0 && timingSafeEqualStr(req.header('x-op-edge-token') ?? '', EDGE_SECRET);

function inboundHost(req: Request): string {
  // Honor X-Forwarded-Host ONLY when the request provably transited OUR edge
  // (the white-label droplet injects X-OP-Edge-Token and rewrites Host→app.openpartner.dev).
  // Otherwise use the GENUINE Host header. NEVER use Express req.hostname here — under
  // `trust proxy 1` it is itself derived from a client-spoofable X-Forwarded-Host.
  const raw = edgeTrusted(req) ? (req.header('x-forwarded-host') ?? '') : (req.header('host') ?? '');
  return raw.split(',')[0]!.split(':')[0]!.toLowerCase().trim();
}

async function resolveTenant(req: Request): Promise<{ id: string; slug: string } | null> {
  const host = inboundHost(req);
  if (host && !isPlatformHost(host)) {
    const { db } = await import('./db.js');
    // NOT gated on whiteLabel — graceful degradation on cancellation (§7.1/§8.1).
    const row = await db('Tenant')
      .where({ customDomain: host, status: 'active' })
      .first(['id', 'slug', 'whiteLabel', 'billingPlan', 'trialEndsAt', /* billing cols */]);
    if (row) {
      req.tenantCustomDomain = host;
      req.tenantWhiteLabelEffective = isWhiteLabelEntitled(row); // branding/Network-hiding (§5.3)
      return { id: row.id, slug: row.slug };
    }
  }
  return resolveTenantFromPath(req); // existing behavior, unchanged
}
```

- `isPlatformHost`: reject `app|api|router|network.openpartner.dev`, `*.ondigitalocean.app`, `localhost`. These take the path-based branch.
- **DO-native path (MVP):** there is no Caddy and no `X-OP-Edge-Token`, so `edgeTrusted` is false and we resolve from the **genuine `Host`**. This is correct **only if DO forwards the public domain as `Host` to the `api` component and strips/normalizes any client-supplied `X-Forwarded-Host`** — a **launch-blocking precondition** (§9 Phase 2): capture the real `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto` the component sees for a DO-native custom domain, confirm `resolveTenant` resolves, and add an e2e assertion. If DO instead delivers the public host only via its own `X-Forwarded-Host`, we add DO's behavior to `edgeTrusted` **only after** confirming DO strips client XFH; until verified, do not trust it.
- **Droplet path (Phase 3):** the droplet sets `X-OP-Edge-Token`, `Host: app.openpartner.dev`, `X-Forwarded-Host: <real domain>`. `edgeTrusted` passes and we use `X-Forwarded-Host`.
- **Spoofing guard (corrected):** the previous "mirror `trusted_proxies` on the droplet" defense does **nothing** for direct-to-DO requests (they never traverse the droplet). The edge-secret is the real control. **Regression test:** a forged `X-Forwarded-Host: portal.xispark.com` against `app.openpartner.dev` with **no** valid `X-OP-Edge-Token` resolves **no** tenant (falls through to genuine Host → path-based).
- **§4.3 and §4.4 are a single atomic deliverable** (§7.1): magic-link *verify* is RLS-scoped and only finds the token once the tenant is resolved from the request. Shipping link-rewrite without host-resolution (or vice-versa) silently breaks custom-domain login.

### 4.4 Per-tenant portal base URL — **M** (the magic-link/invite crux)

New `apps/api/src/portal-url.ts`:

```ts
export function getPortalBaseUrl(tenant?: { customDomain?: string | null; slug?: string }): string {
  const env = (process.env.PORTAL_URL ?? '').replace(/\/$/, '');
  if (tenant?.customDomain) return `https://${tenant.customDomain}`;          // white-label
  if (getTenancyMode() === 'multi' && tenant?.slug) return `${env}/t/${tenant.slug}`; // path-based
  return env;                                                                // single-host / platform
}
```

**Route through the ONE chokepoint (corrected call-site inventory).** On `multi-tenant`, the only link-construction point is `buildMagicLinkUrl(token)` in `apps/api/src/email-templates.ts:8-10` (it reads `PORTAL_URL` directly and builds `${base}/auth/magic?token=`). Change its signature to **`buildMagicLinkUrl(tenant, token)`** → `getPortalBaseUrl(tenant)`, then audit its **8 real callers**, each of which already has `db`/`tenantId` in scope to resolve the `Tenant` row:

| Caller | Line | Email |
|---|---|---|
| `routes/admins.ts` | 49 | admin invite |
| `routes/install.ts` | 190 | bootstrap admin invite |
| `routes/partner-auth.ts` | 59 | admin signin |
| `routes/partner-auth.ts` | 85 | partner signin |
| `routes/partner-signup.ts` | 164 | partner invite |
| `routes/partners.ts` | 78 | partner invite |
| `routes/partners.ts` | 145 | partner re-invite |
| `routes/signup.ts` | 124 | founder admin invite |

- **Remove from the change list:** `auth.ts` (does not issue magic links on this branch), and `campaign-end-notifications.ts` + `routes/session-home.ts` (do **not** exist on `multi-tenant` — they are `feat/mobile-responsive`-only). If those flows are wanted under white-label, they are a Phase-0 **cherry-pick prerequisite**, and only then do they adopt `getPortalBaseUrl(tenant)`. For `session-home`, when cherry-picked, return `/` for a custom-domain tenant (SPA is already at the custom-domain root).
- **Behavior change to call out (not just white-label):** `getPortalBaseUrl` returning `${env}/t/${slug}` for the multi/path case is **required** to make path-based *verify* resolvable. Today `buildMagicLinkUrl` emits a bare `/auth/magic` with no slug, yet `/auth/magic/verify` resolves the tenant **from the path** — so a path-based multi-tenant magic link is under-specified today. Threading the tenant fixes that pre-existing gap as a side effect.
- **Chronology:** at signup `Tenant.customDomain` is **unset** (it is assigned only post-verification, §4.8). So the **first** admin-invite email (`signup.ts:124` / `install.ts:190`) necessarily uses the path-based `/t/<slug>/` URL — `getPortalBaseUrl` handles `null customDomain` gracefully. Document that initial white-label onboarding emails are platform-branded/path-based until the domain verifies; thereafter all links are on the custom domain.
- **Stripe redirect URLs stay client-origin-derived (do NOT rewrite).** Stripe Checkout `successUrl`/`cancelUrl` (`billing.ts:123-124`) and Connect `return`/`refresh` (`connect.ts:61-62`) are **client-supplied** from `window.location.origin` (`Connect.tsx:30-31`). Under the custom domain they are already same-origin and correct. **They must NOT be moved to `getPortalBaseUrl`** — server-building them from `PORTAL_URL` would bounce users to `app.openpartner.dev` and break the cookie-host match. Add a **regression test** asserting the SPA sends `window.location.origin`-based URLs, so a future refactor can't silently regress white-label.
- **Signature takes a `tenant` row, not a `req`,** so any future scheduler-driven send resolves the host from `Tenant.customDomain` without an HTTP request.

### 4.5 CORS — **M** (de-risked, see §7.2)

`apps/api/src/app.ts` builds a static `corsOrigins = [PORTAL_URL, ...CORS_EXTRA_ORIGINS]` and **throws in production if it is empty (`app.ts:64`)** and **deliberately avoids `origin:true`** (regression `regressions.test.ts` case 6). Both invariants are preserved. Replace only the matching logic with an **origin callback over a cached `Set`**:

```ts
const seed = new Set<string>([...corsOrigins]);        // PORTAL_URL + CORS_EXTRA_ORIGINS + dev localhost
let customDomainOrigins = new Set<string>();
async function refreshCustomDomains() {                 // every 60s + on verify/revoke
  const rows = await db('Tenant').whereNotNull('customDomain')
    .where({ status: 'active' }).pluck('customDomain'); // filtered to live tenants
  customDomainOrigins = new Set(rows.map((d) => `https://${d}`));
}
cors({ credentials: true, origin: (origin, cb) =>
  cb(null, !origin || seed.has(origin) || customDomainOrigins.has(origin)) });
```

- Keep the **seed Set** and the **prod boot-throw**; the callback consults `seed ∪ customDomainOrigins` only. No wildcard, no origin reflection.
- **Regression test:** a non-allowlisted `Origin` receives **no** `Access-Control-Allow-Origin` header even with `credentials: true`.
- As §7.2 explains, in production the portal's own calls are **same-origin** and never trigger CORS — this is defense-in-depth + dev. We do **not** put session security on CORS.

### 4.6 Mailer — drop "via OpenPartner" for white-label — **S** (Phase-0 cherry-pick dependency)

On `multi-tenant` today, `mailer.ts` is the simpler `RoutingMailer` (`:47-55`) with **no** `via OpenPartner` block, and `brand-name.ts` does **not** exist. So this is **not** an in-place edit — it **depends on the Phase-0 cherry-pick** of `mailer.ts` + `brand-name.ts` + brand-aware `email-templates.ts` from `main`/`feat/mobile-responsive` into `multi-tenant`. After that cherry-pick:

```ts
const suffix = ctx.whiteLabel ? '' : ' via OpenPartner';
from = `"${safeDisplayName(brandName)}${suffix}" <${extractAddress(from)}>`;
```

- This branch fires **only when `cfg.source === 'env'`** (shared platform sender). Tenants on their own SMTP/Postmark (`cfg.source === 'ui'`) already bypass it.
- `SendContext` already carries `{ db, tenantId }` on `multi-tenant`; add `whiteLabel: boolean` resolved once from the `Tenant` row (effective entitlement).

### 4.7 `install.ts` bootstrap — **S**

Extend `GET /api/install/status` to include `{ tenantId?, slug?, whiteLabel?, customDomain?, displayName?, logoUrl?, brandColor?, networkEnabled? }` so the SPA can initialize brand context on mount.

> **Security note tied to §4.3:** because this endpoint returns tenant-scoped brand metadata and is reached **before** auth, the `X-Forwarded-Host` spoofing fix (§4.3) is what prevents an attacker from reading another tenant's brand context by forging a host against `app.openpartner.dev`. The endpoint returns brand fields for the resolved tenant only; with the edge-secret gate, a forged host resolves no tenant.

### 4.8 Signup — **S**

`signup.ts` already accepts a `plan` param and stamps `trialEndsAt`/`firstTrialActivatedAt`. Set `Tenant.whiteLabel=true` when the chosen plan/add-on includes it. `customDomain` is **not** set at signup — it is assigned via the admin verify flow (§4.2), and registration there requires the effective entitlement. For xispark MVP, `whiteLabel`/`customDomain` are set by the manual ops step (§9). Note: provisioning `whiteLabel=true` during an unpaid trial is fine because the gate enforces **effective** entitlement (in-trial counts; lapsed-without-subscription does not — §8.1).

---

## 5. Portal changes (`apps/portal`)

### 5.1 Hardcoded-string removal — **M**

Verified count: **33 occurrences across 20 files**. Replace each with brand-context fallback. Complete change-list (file:line on `feat/mobile-responsive`):

| File | Line(s) | Current | Change |
|---|---|---|---|
| `App.tsx` | 251, 346 | `settings.data?.programName \|\| 'OpenPartner'` | `\|\| brand.programName` (if `whiteLabel`, programName required non-null) |
| `App.tsx` | 1248 | Logo `alt="OpenPartner"` | `alt={brand.programName}` |
| `index.html` | 6, 11 | `<title>`, `og:title` | injected from brand on first paint (§5.2); WL ⇒ no "OpenPartner" |
| `og-preview.svg` | 50 | wordmark | per-tenant og image or suppressed when WL |
| `pages/Landing.tsx` | 63 | "OpenPartner" wordmark | `brand.programName`; if WL, redirect to `/signup`/`/workspaces` |
| `pages/Landing.tsx` | 119 | "OpenPartner is open source. Learn more" | hide when WL; optional `Tenant.footerText` |
| `pages/Workspaces.tsx` | 85 | "OpenPartner" | `brand.programName` |
| `pages/Dashboard.tsx` | 506, 515, 566 | Network CTAs / "Subscribe to keep using OpenPartner" | hide Network CTAs when WL; rebrand subscribe copy |
| `pages/admin/AdminPrograms.tsx` | 846 | "List on the OpenPartner Network marketplace" | hide when WL |
| `pages/admin/Network.tsx` | 32, 99 | Network listing copy | route-guard hidden when WL |
| `pages/admin/Integrations.tsx` | 64, 95, 380 | "OpenPartner" | `brand.programName` / hide |
| `pages/admin/NetworkCreators.tsx` | 112 | "Browse the OpenPartner Network" | route-guard hidden when WL |
| `pages/admin/Settings.tsx` | 113, 152 | "fall back to OpenPartner" | `brand.programName` |
| `pages/admin/Settings.tsx` | 730 | "…email infrastructure as 'Your brand via OpenPartner' <noreply@openpartner.dev>" | hide/rephrase when WL (matches §4.6) |
| `pages/admin/NetworkBilling.tsx` | 76 | "hosted plan…on app.openpartner.dev" | hide when WL |
| `pages/Connect.tsx` | 62 | "OpenPartner will transfer" | `brand.programName` |
| `pages/Install.tsx` | 98 | "Install OpenPartner" | `brand.programName` |
| `pages/Signup.tsx` | 118 | "Becomes app.openpartner.dev/t/<slug>" | show custom-domain URL when WL |
| `creator/CreatorDiscover.tsx` | 214 | "across the OpenPartner Network" | hidden when WL |
| `creator/CreatorDomains.tsx` | 57 | "Point your own domain at the OpenPartner router" | `brand.programName` |
| `creator/CreatorSignup.tsx` | 77 | "across the OpenPartner Network" | hidden when WL |
| `creator/CreatorPublicProfile.tsx` | 222 | "← OpenPartner link" | `brand.programName` |
| `creator/CreatorShareLinks.tsx` | 559 | "OpenPartner integration" | `brand.programName` |
| `creator/CreatorShell.tsx` | 108, 173 | "OpenPartner" | `brand.programName` |
| `partner/Discover.tsx` | 44 | "across the OpenPartner Network" | hidden when WL |
| `partner/MyProfile.tsx` | 59 | "across the OpenPartner Network" | hidden when WL |
| `auth/Shared.tsx` | 39, 53 | "OpenPartner" | `brand.programName` |

> **Regression guard:** add a portal unit/RTL test that renders the shell with `whiteLabel=true` and asserts **no `/OpenPartner/i`** text in the DOM. Strings reappear after merges — a test is the only durable fix. Styling stays inline CSS-in-JS per repo convention (no Tailwind).

### 5.2 Host-based bootstrap + brand context — **L**

- New `apps/portal/src/brand-context.tsx`: context `{ programName, logoUrl, brandColor, programTermsUrl, supportEmail, whiteLabel, customDomain, networkEnabled }`.
- On mount, `App.tsx` calls `GET /api/install/status` — same-origin under the custom domain, so the API resolves the tenant by host transparently.
- First-paint: accept a one-frame flash hydrated from `/install/status` (MVP), or invest in edge-injected `<script>window.__BRAND__=…</script>`/SSR (Open Question §10.7).

### 5.3 Surface-hiding when white-label is effective — **M**

Gate on `req.tenantWhiteLabelEffective` (effective entitlement, §4.3), surfaced to the SPA via `/install/status`:
- Remove the **Network** nav section and all `network/*` routes (admin `admin/network*`; partner `network/*`, `postbacks`; `Discover`). Drop the route or `return <Navigate to="/" />`.
- Hide "List on OpenPartner Network" onboarding (`Dashboard.tsx:504-509`).
- Keep all internal program/partner-management UI.

### 5.4 Theming — **M**

`brandColor` is stored/returned but not applied. Brand-context injects `--brand-accent`/`--brand-primary` CSS custom properties on `:root`; `apps/portal/src/theme.ts` reads those (current static values as fallback). Logo already renders via `logoUrl` `<img>` in Sidebar/MobileTopBar, falling back to the SVG.

---

## 6. Infra / edge changes

> **Decision (resolves the original's three-way edge contradiction):** the MVP and the first customer ship on **§6.3 DO App-Platform-native custom domains**. The productized self-serve path (Phase 3) is **§6.1 — a dedicated white-label droplet**. The original "second listener IP on one droplet" is **retracted** (§6.1) because it does not work on DO. dnsInstructions (§4.2) branch on `edgeKind` so the customer never receives an inconsistent CNAME target.

### 6.1 Phase-3 self-serve: a **dedicated** white-label droplet — **M** (was "second IP on same droplet" — corrected)

**Why the original mechanism was retracted.** A DO Reserved/Floating IP is **not** bound to the droplet's interface — public traffic to it is delivered via a private anchor IP on `eth0`, so a Caddy listener `https://IP2:443` would never receive packets. DO droplets do not offer two independently-bindable public IPv4 addresses. And the premise itself was false: Caddy routes **unknown SNI to the catch-all**, so two on-demand domain classes **cannot** be split by Host/SNI into per-class site blocks on one instance. The "higher-priority block" and "two listener IPs" ideas are both unworkable.

**Corrected design — a separate box.** Run white-label on its **own droplet** with its **own public IP** (`portal-router.openpartner.dev`), its **own** global `on_demand_tls { ask … /api/portal-domain-allowed }`, and its **own** ACME account + cert storage:

```caddyfile
{
  on_demand_tls { ask https://app.openpartner.dev/api/portal-domain-allowed }
  servers { trusted_proxies static 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 }
}

:443 {
  tls { on_demand }
  reverse_proxy https://app.openpartner.dev {
    header_up Host app.openpartner.dev                 # DO edge accepts only this Host
    header_up X-Forwarded-Host {host}                  # real white-label domain
    header_up X-OP-Edge-Token {env.EDGE_TRUST_SECRET}  # proves request transited our edge (§4.3)
    # NO `rewrite * /api{uri}` — App Platform serves SPA at / and api at /api
  }
}
```

- The **existing creator-share droplet is untouched** — its global `ask` keeps pointing at `network.openpartner.dev/api/share-domain-allowed`. **No repointing of the live gate, no new cross-service hop in creator cert handshakes, no union gate.** (Closes the "couples creator cert issuance to OpenPartner API uptime" and "union gate mints certs without the white-label entitlement" findings — the white-label droplet's own `ask` is the §4.1 entitlement gate.)
- **Trust-proxy hop count (droplet path only):** this path puts the API behind **two** proxies (droplet Caddy → DO LB). `app.set('trust proxy', 1)` would then resolve `req.ip` to the DO LB, degrading velocity limits + request logging for white-label traffic. Bump the hop count for edge-token'd traffic, or derive the client IP from the correct `X-Forwarded-For` position the droplet sets. Cookie `secure` is keyed to `NODE_ENV` (not `req.secure`), so **auth is unaffected**; only IP attribution needs the fix. **N/A on the §6.3 native path.**

### 6.2 Single named-domain Caddy fallback — **S** (superseded by §6.3 for MVP)

If a droplet must be used for one known domain before on-demand is ready, an explicit named block (`portal.xispark.com { reverse_proxy https://app.openpartner.dev { header_up Host app.openpartner.dev; header_up X-OP-Edge-Token {env.EDGE_TRUST_SECRET} } }`) issues one normal LE cert. Retained only as a fallback; **§6.3 supersedes it for the first customer.**

### 6.3 MVP (committed): App-Platform-native custom domain — **S**

Because white-label volume is low (paid add-on, dozens not thousands), register `portal.xispark.com` directly on the DO App Platform `openpartner` app (`doctl apps update` / `.do/app.yaml` domains). DO provisions/renews the cert and validates ownership via the CNAME. **No droplet, no Caddy, no Host-rewrite, no SPOF, no edge token** — the request arrives at the app already on the public host.

**Preconditions (launch-blocking, §9 Phase 2):**
1. **Header capture:** log the real `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto` the `api` component receives for a DO-native custom domain; confirm `resolveTenant` reads the **genuine public host** and that DO strips/normalizes any client-supplied `X-Forwarded-Host`. Add an e2e assertion. If DO does not forward the public host, host resolution silently falls through to path-based and the tenant is mis-resolved — must be caught before xispark onboards.
2. **`app.openpartner.dev` registered:** verify via `doctl apps get` that `app.openpartner.dev` is a configured **PRIMARY/ALIAS** domain on the `openpartner` app and that `PORTAL_URL` matches it. The committed `.do/app.yaml` has the **`domains:` block commented out** (canonical host documented as `*.ondigitalocean.app`) — it must be enabled. This is required even on the DO-native path (path-based links, and the Phase-3 droplet's `header_up Host app.openpartner.dev` 403s if the host is not registered). Make the rewrite target a documented variable tied to the registered host.

**Revocation (DO-native):** on entitlement lapse, the trial-expiry sweep / Stripe webhook calls the DO API to remove the custom domain and clears `Tenant.customDomain`.

### 6.4 Config capture (droplet path only)

If/when the Phase-3 droplet exists, version-control its Caddyfile under `infra/router/` and reconcile drift before edits:

```bash
ssh root@<wl-droplet> 'cat /etc/caddy/Caddyfile' > infra/portal-router/Caddyfile.live
# diff against repo; reconcile; then deploy + reload:
scp infra/portal-router/Caddyfile root@<wl-droplet>:/etc/caddy/Caddyfile
ssh root@<wl-droplet> 'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy'
```

### 6.5 SPOF / HA + ACME coupling note

- **MVP has no white-label SPOF:** §6.3 puts the first paying customer entirely on DO-managed infra (DO LB + DO-managed certs). The creator-share droplet is not in the white-label path at all.
- **Phase-3 droplet HA:** the white-label droplet is single-instance; before it carries revenue-critical traffic, fund a second instance + shared cert storage (S3/Postgres `certmagic`) behind a DO LB, and wire `/_router-health` to alerting + snapshot-after-provision.
- **ACME / rate-limit isolation (added per review):** because Phase 3 uses a **separate** droplet with a **separate** ACME account and cert storage, the two domain classes do **not** share a Let's Encrypt rate-limit pool — a creator-domain provisioning storm cannot rate-limit white-label renewals or vice-versa. (This is a primary reason the corrected design uses a separate box rather than a unified gate on one instance.) Add **cert-issuance volume alerting** per class.

---

## 7. The hard correctness & security problems (the crux — solved, not hand-waved)

### 7.1 Per-tenant `PORTAL_URL` for magic-link / invite redirects

**Problem.** Every magic link / invite / reset is built from global `PORTAL_URL`. A xispark partner emailed a link to `app.openpartner.dev/...` authenticates on the wrong origin, and because sessions are **host-only** (§7.3), the cookie is set on `app.openpartner.dev` and the user is never logged in on `portal.xispark.com`.

**Solution.** `getPortalBaseUrl(tenant)` routed through the single `buildMagicLinkUrl(tenant, token)` chokepoint, applied at all **8** real callers (§4.4). The redeem endpoint sets the host-only cookie on whatever host the link pointed at — now always the tenant's own host.

**Atomicity (added per review).** Magic-link **verify is RLS-scoped**: `partner-auth.ts:101 /auth/magic/verify` calls `tenantOf(req)` then `consumeMagicLink(db, token)` inside the per-request RLS transaction; the link path is a bare `/auth/magic` with no `/t/<slug>/`, so the token is findable **only** if the tenant was already resolved from the request (Host on a custom domain). Therefore **§4.3 (host resolution) + §4.4 (link host) ship together as one atomic deliverable** — neither half works alone.

### 7.2 CORS allowlist for custom domains

**Problem (as filed):** static allowlist (`app.ts`), new domains unrecognized until restart, CORS fires before tenant resolution.

**Verified reality that shrinks it.** In production the SPA is served from `portal.xispark.com` and its `fetch('/api/...')` is **same-origin** — same-origin requests **do not trigger CORS at all** (the code comment confirms: *"In prod the portal proxy serves /api same-origin so this is a no-op"*). Credentialed session calls need **zero** CORS allowance.

**What we still do.** Origin callback over a cached `Set` (§4.5), refreshed every 60s + invalidated on verify/revoke, **preserving the prod boot-throw and the no-`origin:true` invariant**. Covers dev, genuine cross-origin embeds, and the OPTIONS-preflight-before-tenant-resolution race (the callback needs no tenant context). Auth never rests on CORS.

### 7.3 Auth cookie `Domain` scope under a custom domain

**Verified.** `sessionCookieOptions()` = `{ httpOnly, secure, sameSite:'lax', path:'/', maxAge }`, **no `domain`** → host-only. Set in `partner-auth.ts:123,143`; cleared `:165` with `clearCookie(name,{path:'/'})` — **also domain-less**, which correctly matches a host-only set.

**Decision: keep it host-only. Do NOT add a `Domain` attribute, and keep signout domain-less.** A host-only cookie on `portal.xispark.com` is sent only there — it cannot leak to `app.openpartner.dev` or another tenant. Requirements that fall out: `secure` over HTTPS ✓ (DO terminates TLS); `sameSite:'lax'` fine (all auth nav/API same-origin) ✓; link/redeem host matches cookie host ✓ (§7.1). **Documented caveat:** a user logged in on `portal.xispark.com` is *not* logged in on `app.openpartner.dev` — white-label portals are isolated logins by design; no cross-domain SSO in v1. Add a regression test pinning the cookie (set *and* clear) as domain-less so the §7.3 decision can't silently regress.

### 7.4 Network isolation for white-label tenants — **launch-minimal, not deferred**

**Problem.** Even with the portal hiding Network UI, the **Network marketplace** (separate service + DB) could index the tenant; `brand-resources.ts` is readable by "admin + partner + Network federation," and Network discovery handlers have no white-label filter. A single missed manual step makes a white-label tenant publicly discoverable — breaking the exact contract being sold.

**Solution (promoted into launch-minimal scope).**
1. **Suppress federation at the source (now launch-minimal):** when `Tenant.whiteLabel=true`, **never** create/sync a Network `Vendor`/`Offering`; if one exists, mark it hidden. Add an **automated pre-enable assertion/test**: a white-label tenant must have **no** Network `Vendor` row before its domain is enabled. This replaces the original manual "never federate" checklist item.
2. **Filter at the Network read path (Phase 3, belt-and-suspenders):** add a `hidden`/`whiteLabel` flag on the Network `Vendor` row and exclude it from Discover/vendor-detail queries.

For xispark MVP: the automated source-side suppression + assertion runs before the domain is enabled. The read-path filter remains Phase 3.

### 7.5 `X-Forwarded-Host` authenticity / edge trust (new — high)

**Problem.** `resolveTenant` reading `X-Forwarded-Host` raw lets anyone `curl https://app.openpartner.dev/api/...` with `X-Forwarded-Host: portal.xispark.com` and get RLS-scoped to that tenant from the shared origin — reading brand config, `/install/status`, public program/partner-signup surfaces, and enabling host→tenant enumeration. Express `trust proxy 1` does **not** sanitize arbitrary header reads, and `trusted_proxies` on a droplet does nothing for direct-to-DO requests.

**Solution (§4.3).** Never trust `X-Forwarded-Host` on its own. Honor it **only** behind a valid `X-OP-Edge-Token` shared secret injected by the white-label droplet; otherwise resolve from the **genuine `Host`**. Never use Express `req.hostname` for this decision (it is XFH-tainted under `trust proxy`). On the DO-native path, the header-capture precondition (§6.3) confirms DO delivers the public host as `Host` and strips client XFH. **Test:** forged XFH + no valid edge token ⇒ no tenant resolved.

### 7.6 Stale-verification domain takeover (new — high)

**Problem.** In the original design `status='verified'` is **terminal** — the TXT record is never re-checked, the cited template short-circuits re-verify with `{already:true}`, and `domain` is globally unique and persists. If a tenant later abandons the subdomain (or an apex lapses and is re-registered), the new DNS owner pointing a CNAME at the edge passes the ask-gate, gets a fresh cert, and is proxied **into the original tenant's portal** (the still-`verified` `Tenant.customDomain` resolves to the original tenant). That is **cross-tenant account takeover**.

**Solution.**
- **Real token rotation** (the original "rotates on every re-verify" claim was false): regenerate `verificationToken` on initial registration and on every re-verification cycle / demotion; the verify handler **always re-checks DNS** and never short-circuits.
- **Ongoing re-verification job** (scheduled, e.g. daily, plus a lazy check on the gate): re-resolve `_openpartner.<domain>` TXT; if the token is gone/changed, set `status='failed'`, clear `Tenant.customDomain`, and trigger revocation (droplet: gate now 404; DO-native: remove the DO domain). Update `lastCheckedAt`.
- **Staleness TTL:** the gate (§4.1) refuses (`404`) a `verified` row whose `verifiedAt`/`lastCheckedAt` is older than the TTL until it re-verifies.
- **dnsInstructions** state the `_openpartner` TXT must **remain in place permanently** as ongoing ownership proof.

### 7.7 Entitlement & trial-expiry enforcement (new — see §8.1)

The cert/entitlement gate keys on **effective** entitlement (`whiteLabel && billingActive`), and a trial-expiry sweep revokes routing — so a tenant whose trial lapses without subscribing cannot keep white-label for free. Cross-referenced from §8.1.

---

## 8. Billing & pricing

### 8.1 Entitlement model — billing-state, not a boolean

- `Tenant.whiteLabel` (boolean) means the add-on is **provisioned**. The **effective entitlement** that the gate, revocation, and branding all use is `isWhiteLabelEntitled(tenant) = whiteLabel && status='active' && (activeSubscription || inTrial || enterprise)` (§4.1).
- **Why the boolean alone is insufficient (review finding):** `whiteLabel` is set `true` at signup *during* the unpaid 14-day trial. It is only flipped `false` on Stripe `customer.subscription.deleted`. A trial that **lapses without ever subscribing** emits no `subscription.deleted`, so a bare-boolean gate would keep white-label live indefinitely for free. Enforcing **billing state** in the gate closes this.
- **Trial-expiry sweep (added):** a scheduled job recomputes `isWhiteLabelEntitled` for every white-label tenant and, when it goes false, revokes routing — droplet path: the gate already 404s; DO-native path: call the DO API to remove the custom domain and clear `Tenant.customDomain`.
- **Cancellation UX — graceful, not hard-down (review finding):** the **host resolver does NOT require `whiteLabel`** (it keys on `customDomain` + tenant `status='active'`), so login/verify keep working during the cert's remaining validity and the portal **reverts to platform branding on the custom domain** (then to the path URL once the cert/domain is revoked) — rather than going instantly hard-down (no tenant → `invalid_or_expired_token`). Entitlement enforcement lives in the **cert/entitlement gate + revocation**, while **branding and Network-hiding key on the effective entitlement** surfaced as `req.tenantWhiteLabelEffective`. The tenant itself stays live throughout. The admin UI surfaces a clear "white-label add-on inactive — custom domain will stop resolving" warning.

### 8.2 Stripe wiring

- New env `STRIPE_WHITELABEL_ADD_ON_PRICE_ID` (monthly recurring). Add a boot-probe length check in `server.ts` alongside existing price-ID probes.
- `priceIdsForPlan()`: when `plan ∈ {flex, revshare}` and `whiteLabel`, append the add-on price to Checkout line items. Enterprise is sales-led — encode the add-on in the negotiated subscription.
- Webhook (`stripe-webhook.ts`, `customer.subscription.updated|deleted`): detect `STRIPE_WHITELABEL_ADD_ON_PRICE_ID` → set `Tenant.whiteLabel = present`. On a transition that drops effective entitlement, also trigger DO-native revocation. Reuse `persistMerchantSubscription` / `inferPlanFromPriceIds`.
- Trial: the existing 14-day gate applies; the entitlement predicate accepts active-subscription **or** in-trial **or** enterprise — and **the trial-expiry sweep (§8.1) is what handles the no-`subscription.deleted` case**.

### 8.3 Price anchors (founder to set — §10)

- Competitors gate white-label behind enterprise ($1,000+/mo). Room to undercut.
- **Proposed:** add-on at **$99/mo**, free in `enterprise`. Stripe Checkout doesn't cleanly mix one-time + recurring; for MVP **skip the setup fee** (or invoice manually post-verify). xispark is price-sensitive; $99/mo is the likely wedge. Founder confirms before launch.

---

## 9. Phased rollout & effort sizing

**Branch strategy (prerequisite):** all work targets `multi-tenant`. **Cherry-pick the branding migrations (`20260608000000_tenant_logo`, `20260623000000_brand_resources`, `tenant_billing_plan`, `tenant_trial_used`) and the brand-aware `mailer.ts` / `brand-name.ts` / `email-templates.ts` from `main` *into* `multi-tenant`** — never merge `multi-tenant` schema backward. The mailer/brand edits (§4.6) and any `session-home.ts` / `campaign-end-notifications.ts` white-label adoption are **downstream of this cherry-pick**.

| Phase | Scope | Effort | xispark-minimal? |
|---|---|---|---|
| **0 — Brand-from-config + isolation** | Reconcile branches (cherry-pick branding into `multi-tenant`). Add `Tenant.whiteLabel` (§3.1). Brand-context provider (§5.2) + replace all **33** strings (§5.1) + `/OpenPartner/i` regression test. Drop "via OpenPartner" for WL (§4.6, post-cherry-pick) + `Settings.tsx:730`. Surface-hiding (§5.3). `brandColor` theming (§5.4). **Network source-side federation suppression + automated pre-enable assertion (§7.4).** Ships a brand-clean portal on `/t/<slug>/` — no custom domain yet. | **M** | ✅ Required |
| **1 — Host resolution + auth/CORS/URL + edge-trust** | Deployment-aware `resolveTenant` with `X-OP-Edge-Token` gating (§4.3, §7.5) + spoof regression test. `buildMagicLinkUrl(tenant,token)` chokepoint across all **8** callers (§4.4, §7.1) — **atomic with §4.3**. CORS origin-callback preserving boot-throw + no-`origin:true` (§4.5). Host-only cookie unchanged + signout-domain-less test (§7.3). `install/status` bootstrap (§4.7). `PortalCustomDomain` table + RLS (§3.2). Register/verify endpoints **entitlement-gated**, reserved-host rejection, **token rotation + re-verification job + staleness TTL** (§4.2, §7.6). Effective-entitlement gate + trial-expiry sweep (§4.1, §8.1). Portability coverage (§3.3). | **L** | ✅ Required |
| **2 — Edge: provision the domain (DO-native)** | **Preconditions:** header-capture e2e (genuine Host resolves; client XFH stripped) + confirm `app.openpartner.dev` registered on the app (§6.3). Register `portal.xispark.com` on the App Platform app (DO-managed cert, no droplet/SPOF). Wire DO-API revocation into the sweep/webhook. | **S** | ✅ Required (via §6.3) |
| **3 — Self-serve + dedicated droplet** | Admin "White-Label Branding" wizard (register → CNAME+TXT → verify → enable). **Dedicated** white-label droplet (own IP + own global `ask` + own ACME), `edgeKind='droplet'` dnsInstructions, `X-OP-Edge-Token` injection, trust-proxy hop fix (§6.1). Network read-path filter (§7.4 item 2). Droplet HA + cert-issuance alerting (§6.5). Stripe add-on Checkout + webhook toggle (§8.2). `docs/white-label.md` + `.env.example` (`EDGE_TRUST_SECRET`, `STRIPE_WHITELABEL_ADD_ON_PRICE_ID`) + runbook. | **M** | ❌ Deferred |

**Minimum to onboard xispark:** Phase 0 + 1 + 2-via-§6.3, plus manual ops: set `Tenant{ customDomain:'portal.xispark.com', whiteLabel:true }`, register the domain on the App Platform app, **confirm no Network `Vendor` row exists for xispark** (automated assertion, §7.4), and verify both §6.3 preconditions. Self-serve wizard, dedicated droplet, and Stripe automation are Phase 3. First-customer total: **M + L + S**, dominated by Phase 1.

---

## 10. Open questions / decisions for the founder

1. **Edge for MVP — DO-native (§6.3) confirmed.** Native is SPOF-free for the first customer; the dedicated droplet (§6.1) is the Phase-3 self-serve path. Confirm we are not shipping any droplet for xispark.
2. **Apex vs subdomain.** xispark uses `portal.xispark.com` (CNAME-able ✓). Support apex (`xispark.com`)? Apex needs ALIAS/ANAME or DO-native A; restrict to subdomains in v1?
3. **Pricing.** $99/mo add-on vs enterprise-only? Setup fee — skip / $500 manual / bundle? (§8.3)
4. **`whiteLabel` entitlement vs plan tier.** Keep as an orthogonal boolean add-on (recommended), or fold into a `hosted_white_label` plan / `enterprise`? (§8)
5. **Cancellation policy.** Graceful revert (recommended, §8.1) vs forced plan downgrade?
6. **First-paint branding.** One-frame flash hydrated from `/install/status` (MVP) vs edge-injected `<script>__BRAND__`/SSR? (§5.2)
7. **Multi-domain per tenant.** Mirror "first verified = primary," or one domain per tenant in v1? (the table supports multiple)
8. **`EDGE_TRUST_SECRET` rotation policy.** How/when do we rotate the droplet↔API shared secret, and who owns it? (Phase 3, §7.5)
9. **Re-verification cadence + TTL.** Daily poll + N-day staleness TTL (§7.6) — confirm values and the customer-facing "TXT must remain" messaging.
10. **SPF/DKIM for white-label senders.** White-label From without "via OpenPartner" may hit spam filters unless the tenant configures SPF/DKIM on their own SMTP/Postmark. Require BYO-email for white-label, or document the deliverability caveat?

---

## 11. Risks addressed during review

This spec was hardened against three adversarial reviews (Infra/TLS, Auth/CORS/Cookie, Security/Abuse/Billing). Every gap was valid; the dispositions:

**Infra / TLS / DO App Platform**
- **Two-IP-on-one-droplet was unworkable (high)** — DO Reserved IPs are anchor-NAT'd, not interface-bound, and on-demand unknown SNI can't be split by Host. **Retracted** §6.1; MVP pinned to DO-native (§6.3), Phase-3 uses a **dedicated** droplet with its own IP + own global `ask`.
- **Inconsistent CNAME target across edge options (high)** — fixed: dnsInstructions branch on `edgeKind` (§4.2); DO-native emits the `ondigitalocean.app` alias + relies on DO ownership validation, with `_openpartner` TXT retained as OpenPartner's own re-verification proof.
- **Single global `on_demand_tls.ask` / repointing the live creator gate (medium)** — avoided entirely by running white-label on a separate instance with its own `ask`; no union gate (§6.1, §6.5).
- **DO-native inbound header semantics unverified (medium)** — made a launch-blocking header-capture precondition + e2e (§6.3, §4.3, §9).
- **`app.openpartner.dev` must be a registered app domain (medium)** — explicit precondition; `.do/app.yaml` `domains:` block must be enabled (§6.3).
- **Shared ACME account / LE rate-limit coupling (low)** — eliminated by separate ACME account/storage per class; cert-issuance alerting added (§6.5).
- **Stripe redirect URLs (low, clarification — already safe)** — confirmed client-origin-derived; **kept as a documented invariant + regression test** so a future PORTAL_URL refactor can't silently break white-label (§4.4).
- **Express `trust proxy 1` with two hops (low, droplet-only)** — hop-count/IP-attribution fix scoped to the droplet path; auth unaffected (§6.1).

**Auth / CORS / Cookie / Multi-tenant**
- **Magic-link call-site inventory was incomplete and branch-wrong (high)** — corrected to the single `buildMagicLinkUrl(tenant,token)` chokepoint + the **8** real callers; removed `auth.ts`/`session-home.ts`/`campaign-end-notifications.ts` (not on this branch) (§4.4).
- **Spoof guard invalid on the no-Caddy path (medium)** — replaced "mirror `trusted_proxies`" with the `X-OP-Edge-Token` deployment-aware design (§4.3, §7.5).
- **Magic-verify is RLS-scoped → §4.3+§4.4 must ship together; cancellation hard-down (medium)** — declared atomic, and cancellation made graceful by dropping `whiteLabel` from the host-resolver WHERE clause (§7.1, §8.1).
- **CORS invariants (low, rewrite already sound)** — the origin-callback logic was already correct; **integrated the two missing guard-rails** (prod boot-throw, no `origin:true`) + regression test (§4.5).
- **Mailer branch assumption (low)** — §4.6 re-scoped as a Phase-0 cherry-pick dependency (no `via OpenPartner` block / `brand-name.ts` on `multi-tenant`).
- **Missing work** — initial-onboarding emails are path-based until verify (§4.4); path-based verify behavior change documented (§4.4); `PortalCustomDomain` RLS policy specified + register/verify on `appDb` (§3.2); reserved-host rejection (§4.2); signout-domain-less confirmed + test (§7.3).

**Security / Abuse / Billing / Isolation**
- **`X-Forwarded-Host` cross-tenant spoofing from the shared origin (high)** — closed by the edge-secret (§4.3, §7.5).
- **Stale-verification domain takeover (high)** — closed by real token rotation + ongoing re-verification job + staleness TTL; verify no longer terminal (§4.2, §7.6).
- **Free white-label after a lapsed unpaid trial (medium)** — gate now enforces **effective billing state**; trial-expiry sweep revokes routing (§4.1, §8.1).
- **Register/verify not entitlement-gated → squatting (medium)** — registration/verify require effective entitlement; reserved-host rejection; global-unique respected (§4.2).
- **Network isolation deferred (medium)** — source-side federation suppression + automated pre-enable assertion promoted to **launch-minimal** (§7.4, §9).
- **Union ask-gate decoupled cert issuance from entitlement (medium)** — eliminated; the dedicated droplet's own `ask` *is* the entitlement gate (§6.1).
- **Original draft's false "token rotates" claim (low)** — this spec's own draft asserted a property the template lacks; **corrected** to real rotation (§7.6).
- **Portability of hosted-only fields (low)** — `PortalCustomDomain` documented as an exportable sidecar; `whiteLabel`/Stripe fields DESIGNED to export losslessly and be inert no-ops on self-hosted import (the `Tenant` table is not yet in EXPORT_TABLES — see docs/data-portability.md) (§3.3), honoring CLAUDE.md §2/§5.

---

## 12. Phase 0 — implementation status (shipped 2026-06-28)

Branch `feat/white-label-phase0` (4 commits). **Correction to §9:** the multi-tenant foundation AND the branding/billing migrations are already merged into the main line (`feat/mobile-responsive` is 178 commits ahead of the stale `multi-tenant` branch and carries `tenancy.ts`, RLS, `tenant_logo`, `brand_resources`, `tenant_billing_plan`, and the reserved `Tenant.customDomain`). The "cherry-pick branding into multi-tenant" prerequisite was therefore moot — Phase 0 builds directly on the current line; the `multi-tenant` branch is a stale leftover.

**Done & verified** (API typecheck clean, portal typecheck clean, 46 API unit tests green):
- `Tenant.whiteLabel` migration + `TenantRow` type; billing-aware `isWhiteLabelEntitled()` (`apps/api/src/white-label.ts`) with a DB-free regression test (`apps/api/src/__tests__/white-label.test.ts`) incl. the lapsed-trial-no-sub case.
- `whiteLabel` (effective) flows through `GET /config/program`; portal reads it via a shared `useBrand()` hook (`apps/portal/src/lib/useBrand.ts`).
- Portal: brand-identity strings → dynamic `programName`; Network/Discover/marketplace nav + routes hidden when white-label; `BrandMark` renders a neutral monogram instead of the OpenPartner logo for white-label tenants without an uploaded logo.
- Mailer drops the "via OpenPartner" From suffix for white-label tenants.
- Network isolation: data-plane suppression in `dispatch()` + `sendHeartbeat()` + 409 guards on all four federation-enabling routes.

**Residual gaps (deferred to Phase 1):**
- **Login / pre-auth branding** (`apps/portal/src/pages/auth/Shared.tsx`): `/t/:slug/login` still shows "OpenPartner" because `/config/program` requires auth. Closing it needs the **public branding endpoint** that Phase 1's host-based bootstrap (§4.7 / §5.2) introduces.
- **First-paint flash:** `whiteLabel` defaults false for the sub-second the cached query is in flight (§10 q6).
- **Unreachable literals left intact (by design):** route/nav-gated Network pages (`partner/Discover`, `admin/Network*`), the cross-tenant creator portal (`creator/*` — the real Network brand), and platform/pre-tenant surfaces (`Landing`, `Workspaces`, `Install`), plus an admin-only mail note.

**Not runnable locally:** the integration tests (multi-tenant isolation, etc.) need a running, migrated Postgres + `DATABASE_URL`; run them in CI / a DB-backed env. The new `whiteLabel` migration must be applied there.

---

## 13. Multi-brand billing + the "add another brand" flow (platform-wide; acute for white-label)

Surfaced while reviewing white-label pricing. Applies to ALL multi-brand customers, but white-label makes it urgent (resellers explicitly run many brands). **Lock this for Phase 1.**

### 13.1 The data model (get the vocabulary right)
- **There is no "Account" entity / no billing umbrella.** "Account" in the UI = a **platform identity = an email**. `/me/workspaces` (`platform-auth.ts:153-156`) lists every Tenant where `Admin.email = <platform-session email>`.
- **"Brand" = a Tenant** — its own slug, branding, partners, and **billing**. The Tenant is the *only* billable unit. Billing is strictly per-tenant (`billing-plan.ts`).
- So "add another brand to **this account**" is misleading: it creates a brand-new independently-billed tenant that merely shares your login — not one that joins an existing bill.

### 13.2 Two defects found
1. **Billing leak.** Each brand is a separate tenant that starts on a free 14-day trial; nothing forces a plan. The soft trial-gate (`middleware/trial-gate.ts`) deliberately keeps SDK ingest / `POST /attribution/*` / coupon-redeem OPEN after trial (only blocks program *expansion*), and metered billing (`usage-billing.ts reportUsageToStripe`) only fires for tenants with a Stripe customer. Net: additional brands run largely unbilled — fully during trial, core-functionally forever after. RevShare's $0 monthly (bills only 3% of revenue as it earns) makes even *correctly-subscribed* brands look free until revenue flows — the likely source of the customer's "brands aren't charged" confusion.
2. **Switcher orphaning bug.** "Add another brand to this account" is literally `<a href="/signup">` (`App.tsx:842`) to the **public, unauthenticated** signup form with a **blank email field** (`Signup.tsx:30,142`). It does not reuse the logged-in identity. If the new Tenant's first Admin is created under any email ≠ the platform-session email (typo / different address), the brand is **orphaned from the switcher** (`/me/workspaces` filters by email). Compounding: signup activation via `/auth/magic/verify` mints only a per-tenant session and never attaches the new brand to the platform-identity bundle.

### 13.3 Required rework — Phase 1
Replace "Add another brand" with a first-class **authenticated add-brand flow** (kills the switcher bug + the billing gap + the misleading UX in one stroke):
- **a. Reuse the current platform identity's email** for the new Tenant's first Admin — no re-entry, mismatch impossible.
- **b. Attach the new brand to the platform bundle** on create/activate so it appears in the switcher immediately (create/attach `PlatformSession`; ensure `/me/workspaces` returns it).
- **c. Require plan selection in the flow** — RevShare or Flex, plus the white-label add-on for white-label brands — creating the Stripe subscription up front (RevShare = a $0-recurring *metered* subscription, so `stripeSubscriptionId` is set).
- **d. Rename the menu item** to be honest, e.g. "Create a new brand (own plan)".

Plus two guards:
- **Plan-required backstop gate:** an active plan is required before onboarding the first partner **OR** past trial, whichever comes first. Generalize the trial-gate's `POST /partners` entry from "trial expired" → "no active subscription." Keep SDK ingest open (never lose attribution data).
- **White-label requires plan + add-on:** block enabling white-label unless the brand carries its own paid plan (parallel to the Network-conflict guard shipped in Phase 0 §7.4).

**Definition of "active plan"** (the gate's check): a live Stripe subscription — Flex ($49/mo) **or** RevShare (metered, $0 recurring) — OR enterprise (sales-led) OR self-host. "RevShare selected but never checked out" does NOT count; that's the loophole being closed.

### 13.4 Client framing
Each brand = its own fully-isolated, independently-billed program. RevShare = 3% of *that brand's* attributed GMV as it earns (no monthly). Not "unlimited free brands."

### 13.5 Immediate recovery for an already-orphaned brand
Sign in at `/t/<slug>/login` with the email the brand's admin was actually created under (the inbox that received its activation link). If that differs from the account email, it confirms the mismatch and the brand will appear under a *separate* identity in the switcher.

---

## 14. Phase 1 — implementation status (shipped 2026-07-02)

Branch `feat/white-label-phase0` (7 commits on top of Phase 0). **Verified: API + portal typecheck clean; full test suite 176/176 green including the DB-backed integration tier** (local Postgres migrated with the new migration; test env aligned with CI — see below).

**Shipped (spec § → what landed):**
- **§3.2/§3.3** `PortalCustomDomain` migration (`20260702000000`) with RLS + `openpartner_app` grant; row type + `TABLES` entry; added to `EXPORTABLE_TABLES` as a documented sidecar.
- **§4.3/§7.5** Host-based `resolveTenant` in `tenancy.ts`: custom-domain host lookup ahead of path-based resolution; `X-Forwarded-Host` honored only behind a timing-safe `X-OP-Edge-Token` match (`EDGE_TRUST_SECRET`); `isPlatformHost` guard; `req.tenantWhiteLabelEffective`; spoof regression tests. Host resolver NOT gated on `whiteLabel` (graceful cancellation, §8.1).
- **§4.4/§7.1** `portal-url.ts` `getPortalBaseUrl(tenant)` + `buildMagicLinkUrl(token, tenant)` chokepoint across all **9** callers on this branch (spec said 8 for `multi-tenant`; this line also has `signin.ts`). Middleware stashes `Tenant.customDomain` on both host- and path-resolved requests so links always target the custom domain. Stripe redirect URLs untouched (client-origin-derived).
- **§4.5** CORS origin callback: seed allowlist ∪ cached verified custom domains (60s TTL, invalidated on verify/revoke, DB failure = deny); boot-throw + no-reflection invariants pinned by test.
- **§4.1/§4.2/§7.6/§8.1** `portal-domains.ts` lifecycle: public `GET /portal-domain-allowed` ask-gate (verified + fresh + entitled), admin `/config/domain` register/verify/list/delete (effective-entitlement-gated, reserved-host + apex rejection, global-unique, token rotation, verify always re-checks DNS), 7-day staleness TTL, daily re-verification sweep + white-label entitlement sweep (04:45/04:55 UTC; selfhost skips). DO-native edge removal is a logged hook point — **Phase 2 wires the DO API**.
- **§4.7/§5.2** Public `GET /branding` (tenant by host or path; platform scope → nulls) + portal `usePublicBrand()`; pre-auth login/magic pages now render tenant brand (closes the Phase-0 residual gap; neutral placeholder while loading, monogram for WL-without-logo).
- **SPA custom-domain routing** (not explicit in spec, required for §4.3+§4.4 atomicity): `/branding` returns `tenantSlug`; on a host-resolved origin the portal mounts `/login`, `/auth/magic`, and the Shell at root instead of the platform landing table.
- **§13.3** Authenticated add-brand: `POST /me/brands` (platform session; first Admin = session email, created activated; plan **required**, flex|revshare only), portal `/brands/new` page with per-brand billing copy → workspace enter → `admin/billing` checkout; switcher item renamed "Create a new brand (own plan)". Public `/signup` no longer accepts self-declared `enterprise` (it would bypass the plan-required gate).
- **§7.3** Regression test pinning `sessionCookieOptions()` domain-less. `.env.example`: `EDGE_TRUST_SECRET`, `DO_APP_DOMAIN_ALIAS`, `WHITELABEL_DROPLET_HOST`.

**Test-environment note:** the DB-backed suites previously "passed in CI, unrunnable locally". A vitest setup file now pins `OPENPARTNER_MODE=selfhost` (CI parity — a local `.env` saying `flat` tripped the §13 plan gate) and resets the seeded default tenant's billing columns per file. `docker compose up -d postgres && pnpm migrate` then `pnpm --filter @openpartner/api test` runs the whole suite locally.

**Deferred to Phase 2 (xispark launch):** DO header-capture precondition + e2e (§6.3.1), `app.openpartner.dev` registered as app domain (§6.3.2), registering `portal.xispark.com` on the app, wiring DO-API domain removal into the sweeps/webhook, manual ops step (§9).

**Deferred to Phase 3:** admin domain-wizard UI (the API is ready; no portal Settings surface yet), dedicated droplet, Stripe white-label add-on price + webhook toggle (§8.2), Network read-path filter (§7.4.2), `docs/white-label.md` runbook.

---

## 15. Phase 2 + Phase 3 self-serve slice — implementation status (shipped 2026-07-03)

**Phase 2 (DO edge automation):** `do-app-domains.ts` — DO Apps API read-modify-write (no per-domain endpoint exists; domains are part of the app spec). Verify registers the domain on the app (`edge` field in the response); the sweeps, the webhook transition, and admin domain-delete remove it. `DO_API_TOKEN` + `DO_APP_ID` gate the automation (unset = manual console mode with logged warnings). Customer CNAME target derived from the app's `default_ingress` (`DO_APP_DOMAIN_ALIAS` overrides). `.do/app.yaml` now carries a hard warning never to declare `domains:` (a spec push would clobber dynamically-managed customer domains). `docs/white-label-onboarding-runbook.md` is the ops guide.

**Phase 3 — self-serve slice (§8.2 + wizard):**
- `STRIPE_WHITELABEL_ADD_ON_PRICE_ID` (+ boot probe). `priceIdsForPlan(plan, {whiteLabel})` bundles the add-on into plan Checkout; `/billing/checkout` accepts `whiteLabel: true`.
- `GET/POST/DELETE /billing/white-label`: status; enable = add-on Stripe subscription item with proration (enterprise = flag only, sales-led; no subscription = 409 `subscription_required`); disable = item removed + custom-domain routing/DO edge revoked.
- Webhook: `customer.subscription.updated` mirrors add-on presence onto `Tenant.whiteLabel` (no-op when the price env is unset — protects manually-provisioned deployments); `customer.subscription.deleted` disables + revokes. Shared `applyWhiteLabelFromSubscription` / `revokeTenantCustomDomainRouting` keep webhook, sweeps, and admin-disable on one code path.
- Portal: **admin → White label** wizard (`pages/admin/WhiteLabel.tsx`) — add-on enable/disable, domain register, CNAME+TXT records with copy buttons, verify (surfaces the DO `edge` result), delete, and TXT-rotation guidance on failed verification.
- Runbook updated: self-serve is the primary onboarding path; curl equivalents kept for concierge/debugging.

**Still deferred (not needed for xispark):** dedicated white-label Caddy droplet (§6.1 — the `EDGE_TRUST_SECRET` code path exists in `resolveTenant`; no droplet provisioned), Network read-path filter (§7.4.2 — Network-repo change), marketing-site pricing copy, first-paint `__BRAND__` injection (§10.6).

**Refinement to §4.2 rotation semantics (2026-07-07):** the token no longer rotates on a failed MANUAL verify attempt — that punished DNS-propagation lag (every retry invalidated the record the customer just published) while adding no security: rotation's purpose is forcing fresh proof when ownership may have changed, and a failed button click is the same admin asserting the same claim. Rotation now happens only where it has that value: on demotion by the daily re-verification job (§7.6). A verified domain failing a manual re-check is additionally left un-demoted (reported, domain keeps serving) — demotion/revocation authority stays with the daily job so a transient DNS blip during a hand-run check can't take a live portal down.