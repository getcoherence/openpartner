# Multi-tenant refactor — handoff

This document is the resumption point for the multi-tenant refactor in
progress on the `multi-tenant` branch. The foundation, the route
refactor, helper updates, the public signup flow, and a first pass at
test seed updates are committed. The remaining work is verifying the
test suite end-to-end against a live Postgres, adding multi-tenant
isolation tests, and ops/env config for hosted deploys.

If you're picking this up fresh: read this whole doc, scan the commits
on `multi-tenant`, then start with section G (new isolation tests) and
H (env + ops). Verify tests pass against a real DB first.

## TL;DR

- One codebase, two tenancy modes:
  - `OPENPARTNER_TENANCY=single` — self-host. tenantId always `'default'`.
  - `OPENPARTNER_TENANCY=multi` — hosted. tenantId resolved from URL path.
- Database has `tenantId` on every data table.
- RLS enforced via `app.tenant_id` GUC + `app.platform_admin` override,
  with FORCE so even the table owner is subject to policies.
- Two DB roles: privileged (migrations, signup, platform tooling) and
  `openpartner_app` (subject to RLS at runtime).
- Per-request transaction wraps every tenant-scoped request, sets the
  GUCs, exposes `req.db` to handlers.
- Route refactor pending: every handler uses `req.db` + `tenantOf(req)`.

## Branch state (as of pause)

```
multi-tenant
  HEAD     feat(api): public /signup + test seed tenantId fixes
  095fc89  feat(api): route + helper refactor for tenant-scoped req.db
  92f570a  docs(multi-tenant): handoff guide for the in-progress refactor
  e560b3f  feat(tenancy): add tenantOf(req) helper for route handler ergonomics
  44f5311  feat(api): tenancy middleware + connection split (admin vs app pools)
  b2c69ac  feat(db): multi-tenant foundation + RLS
  ... (matches main from here)
```

`main` is unaffected — production deploys keep working off `main` until
`multi-tenant` merges.

## Architecture decisions

### Tenant resolution: path-based, not subdomain

`/t/<slug>/...` not `<slug>.openpartner.dev`. Reasons:

- Wildcard subdomain SSL on DO App Platform requires Pro tier and has
  domain-count limits. Path-based scales unboundedly.
- Cookie isolation concerns aren't real for portal/api at our stage.
  Session cookies can be path-scoped or per-tenant-named.
- Click router cookie isolation is genuinely tenant-sensitive, but
  solved by either (a) per-tenant cookie names (`_op_cref_<slug>`) or
  (b) optional custom-domain CNAME for tenants that want first-party
  cookies on their own domain.
- Premium subdomain feel can be added later as an upgrade — most v1
  tenants won't notice or care.

URL layout in production:

```
openpartner.dev / www.openpartner.dev    → marketing site
app.openpartner.dev/t/<slug>/...         → multi-tenant portal + admin
app.openpartner.dev/api/...              → api (tenantId from path/auth/event metadata)
r.openpartner.dev/<linkKey>              → click router
network.openpartner.dev                  → Network coordinator (separate service)
partners.<merchant>.com                  → optional custom domain per tenant
```

### Database isolation: RLS + role separation

Two layers of defense:

1. **App-level filtering** — every query goes through `req.db` with
   `app.tenant_id` set; handlers either filter explicitly or rely on
   the GUC. Primary defense.
2. **Row-Level Security** — every tenanted table has FORCE RLS with a
   policy matching `tenantId` to the GUC, plus a `platform_admin = 'on'`
   override for cross-tenant tooling. Secondary defense — catches
   missed `where()` clauses, SQL injection, compromised API keys.

For RLS to actually engage, the runtime DB role must not be a superuser
or have BYPASSRLS. Hence `openpartner_app` (provisioned by
`20260507020000_app_role.ts` from `OPENPARTNER_APP_DB_PASSWORD`).
Migrations continue running as the privileged role with
`SET row_security = off`.

### Two connection pools, one source of truth

`apps/api/src/db.ts`:
- `db` — privileged pool, `DATABASE_URL`. For migrations, signup,
  platform-admin tooling, jobs that legitimately need cross-tenant access.
- `appDb` — app pool, `DATABASE_URL_APP` (falls back to `DATABASE_URL`
  for self-host without role separation). Connection of choice for
  request handlers via `req.db`.

If `DATABASE_URL_APP` is unset, RLS is bypassed (the app runs as the
migration role) but app-level filtering still applies. Self-hosters
opt into RLS by setting both env vars.

### Per-request transaction

`tenantMiddleware` (apps/api/src/tenancy.ts) wraps every tenant-scoped
request in a knex transaction:

1. Resolve tenantId (single → `default`, multi → `/t/<slug>/...`).
2. `appDb.transaction(...)`.
3. `SET LOCAL app.tenant_id = '<id>'` (and `app.platform_admin = 'on'`
   if applicable).
4. Stash trx as `req.db`.
5. Handler runs, writes response.
6. Transaction commits on `res.finish` / `close`, rolls back on error.

Routes get the trx via `req.db` or — more ergonomically — the helper:

```typescript
import { tenantOf } from '../tenancy.js';

router.get('/foo', async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const rows = await db('Partner').limit(10);
  // inserts must include tenantId:
  await db('Partner').insert({ id: ulid(), tenantId, ... });
  res.json(rows);
});
```

`tenantOf(req)` throws if the route wasn't behind `tenantMiddleware` —
makes routing bugs loud.

### Reserved slugs

`apps/api/src/tenancy.ts` exports `RESERVED_SLUGS`:
default, www, api, app, admin, signup, login, auth, docs, help, support,
status, network, static, public, platform.

These can never be claimed by a tenant. Add to this set if we introduce
new top-level URL spaces.

## What's committed (foundation)

### `packages/db/migrations/20260507000000_multi_tenant.ts`
- New `Tenant` table.
- Seeded `'default'` tenant (id = `01J0000000DEFAULTTENANT0000`).
- `tenantId` column on every data table, backfilled to `'default'`.
- Per-tenant unique constraints: Partner.email, Admin.email,
  Link.linkKey, Config.(tenantId, key).

### `packages/db/migrations/20260507010000_rls_policies.ts`
- `PlatformAdmin` table (cross-tenant Coherence support staff).
- FORCE RLS on every tenanted table.
- Policies match on `app.tenant_id` GUC OR `app.platform_admin = 'on'`.
- Self-policy on `Tenant` and `PlatformAdmin` tables.

### `packages/db/migrations/20260507020000_app_role.ts`
- Provisions `openpartner_app` role from `OPENPARTNER_APP_DB_PASSWORD`.
- Idempotent (rotates password if role exists).
- Skipped with notice if env unset (self-host without RLS isolation).
- Grants DML (no DDL) on every tenanted table.

### `packages/db/scripts/migrate.ts`
- Sets `row_security = off` at session start so DDL bypasses policies.

### `packages/db/src/types.ts`
- Every `Row` interface gained `tenantId: string`.
- New `TenantRow`, `PlatformAdminRow` exports.
- `DEFAULT_TENANT_ID` constant.

### `apps/api/src/db.ts`
- `db` (admin pool, DATABASE_URL) and `appDb` (app pool, DATABASE_URL_APP).

### `apps/api/src/tenancy.ts`
- `getTenancyMode()` reads `OPENPARTNER_TENANCY`.
- `RESERVED_SLUGS` set.
- `tenantMiddleware` Express middleware (transaction wrapping, GUC setup).
- `tenantOf(req)` helper.
- Express `Request` interface augmentation: `tenantId`, `tenantSlug`,
  `db`, `platformAdmin`.

## What's done since the original handoff

- **Route refactor (section A)** — every route file under
  `apps/api/src/routes/` uses `tenantOf(req)` and `req.db`. Inserts stamp
  `tenantId`. Public, non-tenant routes (`install`, `metrics`, `signup`,
  `stripe-webhook`) are mounted before `tenantMiddleware` and use the
  privileged `db` directly.
- **Helper refactor (section B)** — `auth-sessions`, `auth.resolvePrincipal`,
  `attribution`, `payouts`, `usage-billing`, `webhook-dispatcher`,
  `mailer`, `mail-settings`, `config` all take `(db, tenantId, ...)`
  parameters. `dispatchEvent` takes `tenantId` as the first arg and uses
  the privileged `db` (since it's fire-and-forget after the request
  transaction commits).
- **Mount middleware (section C)** — `tenantMiddleware` mounted in
  `app.ts` between public mounts and tenant-scoped routes.
- **Public signup (section D)** — `apps/api/src/routes/signup.ts` is
  done. POST /signup creates Tenant + first Admin + magic link.
- **Stripe webhook tenant routing (section E)** — events resolve their
  tenant from object metadata (every Stripe object we create is now
  stamped with `openpartner_tenant_id`); fallback resolution via
  partnerId / payoutId / clickId for events without metadata. The
  handler runs in `appDb.transaction(...)` with `app.tenant_id` pinned
  so RLS catches cross-tenant mistakes.
- **Test seed inserts (section F, partial)** — every
  `db(TABLES.X).insert({ ... })` in `integration.test.ts`,
  `regressions.test.ts`, `stripe-webhook.test.ts`, `webhooks.test.ts`
  now stamps `tenantId: DEFAULT_TENANT_ID`. `OPENPARTNER_TENANCY=single`
  added to the test env. **Not yet validated against a live DB** — do
  this first when resuming.
- **Scheduler tenant iteration** — `scheduler.ts` iterates
  `forEachActiveTenant(...)` for usage-report and payouts; each tenant
  runs in its own appDb transaction with `app.tenant_id` pinned.

`pnpm typecheck` passes across the workspace.

## What's left

### A. Route refactor (~4–6 hours, mostly mechanical) ✅ DONE

Every route file under `apps/api/src/routes/` that uses the
module-level `db` needs:

1. Drop the `import { db } from '../db.js';`.
2. Add `import { tenantOf } from '../tenancy.js';`.
3. Each handler: `const { db, tenantId } = tenantOf(req);`.
4. Inserts: include `tenantId`.
5. Inner `db.transaction(...)` wrappers can be removed — the request is
   already in a transaction. Just use `req.db` directly.

Files (alphabetical, per `apps/api/src/routes/`):

- [ ] admin-overview.ts
- [ ] admins.ts (uses issueMagicLink — see helper-refactor below)
- [ ] api-keys.ts
- [ ] auth.ts (uses resolveSession — see helper-refactor below)
- [ ] billing.ts (Stripe-aware; tenantId stamped on Customer metadata)
- [ ] campaigns.ts
- [ ] commissions.ts
- [ ] connect.ts (Stripe Connect onboarding; stamp tenantId on account metadata)
- [ ] dashboard.ts
- [ ] events.ts
- [ ] export.ts (export only the current tenant's data)
- [ ] fraud-review.ts
- [ ] funnel.ts
- [ ] identify.ts (the SDK identify endpoint — tenant inferred from cookie or path)
- [ ] install.ts (single-mode only; multi-mode rejects)
- [ ] links.ts
- [ ] metrics.ts
- [ ] partner-auth.ts (uses issueMagicLink, createSession, resolveSession)
- [x] partners.ts (started but reverted — restart fresh)
- [ ] payouts.ts
- [ ] settings.ts (per-tenant Config — already (tenantId, key) primary key)
- [ ] stripe-webhook.ts (special case — see "Stripe webhook tenant routing" below)
- [ ] webhooks.ts

### B. Shared helper refactor ✅ DONE

These modules use the module-level `db` and need to accept it as a
parameter so they can be called with `req.db`:

- `apps/api/src/auth-sessions.ts` — every function takes `(db, params)`.
  `issueMagicLink` and `createSession` also take `tenantId` for inserts.
  Sketch in the unsuccessful first attempt is on local but reverted —
  redo cleanly. The 5 callers will need updating in lockstep.
- `apps/api/src/auth.ts` — `resolvePrincipal` reads ApiKey + sessions.
  Use `req.db`. Tenant scope handled by RLS on the lookup.
- `apps/api/src/attribution.ts` — `attributeEvent` etc. accept `db: Knex`
  parameter; callers pass `req.db` (webhook handler) or pass the privileged
  `db` (for back-fill jobs, with explicit `app.tenant_id` set).
- `apps/api/src/payouts.ts` — `runPayouts(db, ...)`. Cron-driven; runs
  per-tenant, so it needs to set `app.tenant_id` itself or accept a
  pre-scoped trx.
- `apps/api/src/mailer.ts`, `email-templates.ts` — likely no DB access;
  verify and skip if so.

### C. Mount `tenantMiddleware` in `app.ts` ✅ DONE

After the route refactor lands. The line `app.use(tenantMiddleware);`
goes BEFORE the tenant-scoped routes and AFTER the public-route mounts
(stripe webhook, /health, eventually /signup and /platform/*).

The current `app.ts` doesn't mount the middleware at all on this branch
— intentional, so the existing behavior keeps working until the routes
are ready for it.

### D. Public signup flow ✅ DONE

New router (`apps/api/src/routes/signup.ts`):

- `POST /signup` — public, no auth required.
- Body: `{ slug, displayName, adminEmail, adminName }`.
- Validates: slug matches `[a-z0-9-]{3,30}`, not in `RESERVED_SLUGS`,
  not already taken (Tenant slug unique).
- Creates Tenant + first Admin (status='active', activatedAt=null).
- Issues a magic link to the admin email (purpose `admin_invite`,
  scoped to the new tenantId).
- Returns 201 with the tenant slug (for the portal to redirect).
- Uses the privileged `db` (no tenant context yet).

Mount BEFORE `tenantMiddleware` in `app.ts`.

### E. Stripe webhook tenant routing ✅ DONE

`apps/api/src/routes/stripe-webhook.ts` doesn't go through
`tenantMiddleware` — Stripe events have no URL tenant. Resolve tenant
inside the handler from event metadata:

1. Webhook deliveries identified by reading `event.data.object.metadata`
   for `openpartner_tenant_id` (Connect events: `account.metadata`,
   subscription/customer events: `customer.metadata`, checkout session:
   `metadata`).
2. Stamp `openpartner_tenant_id` on every Stripe object we create:
   - `stripe.customers.create({ metadata: { openpartner_tenant_id, ... } })`
     in `billing.ts`.
   - `stripe.accounts.create({ metadata: { openpartner_tenant_id, ... } })`
     in `connect.ts`.
   - `stripe.checkout.sessions.create({ metadata: { openpartner_tenant_id, ... } })`.
3. Inside the webhook handler, after resolving the tenantId, run the
   actual processing inside `appDb.transaction(...)` with
   `SET LOCAL app.tenant_id` so attribution/event/identity inserts land
   in the right tenant.

For events with no resolvable tenant (genuinely platform-level events),
process them with the privileged `db` and tag accordingly.

### F. Update existing tests ⚠️ DONE BUT NOT VALIDATED

The mechanical update is committed: every `db(TABLES.X).insert({...})`
in `integration.test.ts`, `regressions.test.ts`, `stripe-webhook.test.ts`,
and `webhooks.test.ts` now stamps `tenantId: DEFAULT_TENANT_ID`, and
every test file sets `OPENPARTNER_TENANCY = 'single'` in its env block.

**Next step on resume**: run the suite against a live Postgres
(`DATABASE_URL=postgres://... pnpm test --filter @openpartner/api`) and
confirm previously-failing tests now pass. If any still fail, the
likely cause is either:

  - A direct insert that was missed (search `\.insert(` to audit)
  - Helper-route assumptions that assumed cross-tenant queries
  - The Tenant table getting truncated by a `db('Tenant').del()` in
    test cleanup (shouldn't happen — Tenant isn't in TABLES_TO_CLEAN —
    but worth confirming if "default tenant not found" surfaces)

### G. New tests for multi-tenant isolation (~2 hours)

In a new `apps/api/src/__tests__/multi-tenant.test.ts`:

- Spin up 2 tenants (`acme`, `globex`) via direct DB seed (privileged db).
- Verify, connecting as `openpartner_app` with `app.tenant_id` set to
  acme: cannot read globex Partner rows.
- Verify, with `app.tenant_id` unset: cannot read any Partner rows
  (default deny).
- Verify, with `app.platform_admin = 'on'`: can read both tenants.
- Verify FORCE RLS: even table owner (privileged role) is subject to
  policies when the GUC is set.
- Verify the WITH CHECK clause: insert with mismatched tenantId fails.
- Verify signup: POST /signup with reserved slug → 409. With taken
  slug → 409. With valid slug → 201 + Tenant + Admin + magic link.
- Verify session cookies don't cross tenants: a session for tenant A
  used on a `/t/globex/...` URL → 401.

### H. Env config + ops (~1 hour)

- `.env.example` add: `OPENPARTNER_TENANCY=single|multi`,
  `OPENPARTNER_APP_DB_PASSWORD=...`, `DATABASE_URL_APP=...`.
- `docker-compose.yml`: add an `initdb.d/` script that creates the
  `openpartner_app` role using `OPENPARTNER_APP_DB_PASSWORD` from env.
  Self-hosters get RLS by default in dev as a result.
- `.do/app.yaml`: add the three new env vars, marked SECRET as needed.
- `docs/deploy-production.md`: add a section on multi-tenant rollout.

## How to resume

If picking up in a fresh session, the prompt should be roughly:

> Continue the multi-tenant refactor on the `multi-tenant` branch.
> Read `docs/multi-tenant-refactor.md` first. Start with section A —
> route refactor — and work alphabetically. Commit after each route
> file or small group of related ones. Run typecheck after each commit.

Or, more action-oriented:

> Refactor `apps/api/src/routes/admins.ts` to use `req.db` and
> `tenantOf(req)`. Update `auth-sessions.ts` to take `db: Knex` as a
> parameter (this affects 5 callers — update them too). Verify tsc
> passes. Then move to `apps/api/src/auth.ts`.

Memory entries on the `auto-memory` system already point at this doc.

## Things to watch for

- **Knex transaction nesting.** The request is already in a transaction
  via `tenantMiddleware`. `req.db.transaction(...)` works (savepoint)
  but for most read+write groupings it's redundant — just use `req.db`
  directly. Watch for over-zealous nesting in the refactor.
- **Async callbacks holding the trx after response sends.** Anything
  that calls `void db(...).update(...)` (fire and forget) needs to
  either run synchronously inside the request or use the privileged
  `db` so it doesn't depend on the request transaction.
- **Migration role for in-process scheduler.** The cron jobs in
  `scheduler.ts` (usage report, payouts) run outside any request
  context. They should use the privileged `db` and explicitly
  `SET LOCAL app.tenant_id` per tenant they're processing — or, more
  cleanly, the scheduler iterates tenants and runs a transaction per
  tenant.
- **Existing `setConfig` callers.** Config is now `(tenantId, key)` —
  the previous fix for jsonb serialization is fine but the API needs a
  tenantId param now. `getConfig` likewise.
- **`/import` and `/export` endpoints.** In multi-tenant they should
  scope to the current tenant. In single-tenant they preserve their
  current behavior. The mode gate is in code, not URL.
