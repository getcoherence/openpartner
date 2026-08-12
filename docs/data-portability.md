# Data portability — export formats and how to restore them

"Your data stays yours" is an architectural constraint, not a feature
(CLAUDE.md principle #2). Concretely that means: **everything in the
bundle exports to CSV, JSON and SQL, and a hosted export restores into a
self-hosted instance.** This document is the format contract — including
an explicit list of what is NOT in the bundle yet, because a contract
that overstates itself is worse than one with a documented hole.

## What's in a bundle

`GET /export.json` returns:

```json
{
  "exportedAt": "2026-08-09T12:00:00.000Z",
  "schemaVersion": 2,
  "tables": { "Partner": [ … ], "Program": [ … ], … }
}
```

Rows are raw DB rows — the same shape `select *` returns, no reshaping,
no derived fields. Anything derived (attribution, commissions) is present
as its own table *and* re-derivable from the raw layers.

### Tables, in import order

Order is load-bearing: the importer walks it as written, so every table
appears after everything it references.

| # | Table | Primary key | Why it's in the bundle |
|---|-------|-------------|------------------------|
| 1 | `Partner` | `id` | the roster |
| 2 | `Program` | `id` | programs + their commission rules |
| 3 | `PartnerProgram` | `id` | **which partners may promote which programs** |
| 4 | `PartnerCommission` | `partnerId` | **snapshotted per-partner terms** |
| 5 | `Coupon` | `id` | **code → (partner, program) attribution** |
| 6 | `Link` | `id` | tracking links |
| 7 | `Click` | `id` | raw click log |
| 8 | `Identity` | `id` | click → user stitch |
| 9 | `Event` | `id` | raw conversion events |
| 10 | `Attribution` | `id` | derived attribution (re-derivable) |
| 11 | `Commission` | `id` | derived commission ledger |
| 12 | `Payout` | `id` | payout ledger |
| 13 | `PortalCustomDomain` | `id` | white-label domain history (inert on self-host) |
| 14 | `CommissionAdjustment` | `id` | clawbacks / corrections |

Rows 3–5 were added in schemaVersion 2 (Aug 2026). Without them a restored
instance had the roster but no grants, no coupon attribution, and no record
of what any partnership was actually agreed at.

Note `PartnerCommission` is keyed on **`partnerId`**, not `id` — one
snapshot per partner. The importer looks the key up per table rather than
assuming `id`.

### Versioning

`SCHEMA_VERSION` is the current bundle version; `SUPPORTED_IMPORT_VERSIONS`
is what `POST /import` accepts. **That list only ever grows.** A v1 bundle
sitting on someone's disk keeps importing — it is simply a v2 bundle
without the three tables added later.

## Restoring

### JSON — `POST /import`

Self-host only (`OPENPARTNER_MODE=selfhost`); importing a foreign export
into a shared hosted database would collide primary keys.

```bash
curl -X POST "$API/import" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @openpartner-export.json
```

Every row's `tenantId` is rewritten to the importing tenant — that's what
lets an `acme` export land in a self-host `default` tenant. Inserts are
`ON CONFLICT (pk) DO NOTHING`, so re-running is safe and a partial import
can be resumed.

### SQL — `GET /export.sql`

The dump is portable by default: rows are written under a psql variable,
so one file restores into any instance.

```bash
# The destination tenant's PRIMARY KEY — not its slug.
psql "$DATABASE_URL" -v tenant_id=01J0000000DEFAULTTENANT0000 -f openpartner-export.sql
```

Omit `-v` entirely and the file falls back to that same id, which is the
seeded self-host tenant (`DEFAULT_TENANT_ID`). Pass the **id**, never the
slug: every row carries `tenantId`, which is a foreign key to `Tenant.id`,
so `-v tenant_id=default` fails on the first row and rolls the whole
restore back.

The file opens a transaction, pins `standard_conforming_strings` (the
string-literal mode its escaping assumes), sets `app.tenant_id` so it
works on the RLS-scoped app role as well as the privileged role, and
inserts every table in the order above with `ON CONFLICT DO NOTHING`.

**Requires psql 10 or newer.** The `-v`-or-default behaviour uses `\if`,
which older clients don't understand — they'd skip the conditional and
apply the default unconditionally, overwriting the tenant you passed. If
you're stuck on an older psql, use `?tenantId=<id>` to get a dump with the
destination already baked in and no meta-commands at all.

`?tenantId=<id>` bakes a literal tenant id instead of the psql variable —
plain SQL for clients that don't run psql meta-commands. The value must be
id-shaped (`[A-Za-z0-9_-]{1,64}`) and is **rejected with a 400**, not
escaped, if it isn't. It lands in a header comment of a file that psql
executes, and psql's meta-commands are line-oriented, so a newline would
end the comment and start a line the restoring machine obeys.

Per-table dumps: `GET /export/<Table>.sql` (also `.json`, `.csv`).

### CSV — `GET /export/<Table>.csv`

For spreadsheets and one-off analysis. Cells starting with `=`, `+`, `-`
or `@` are prefixed with `'` so a spreadsheet can't evaluate exported data
as a formula. CSV is a *view*, not a restore format — use JSON or SQL to
round-trip.

## Type fidelity

One subtlety worth knowing if you write tooling against this: a JSON array
coming out of a row is ambiguous. `Program.commissionRule` is a `jsonb`
array; `Program.categories` is a Postgres `text[]`. Both arrive as JS
arrays. The exporter reads the live column types and renders each
correctly — `'[{"type":"percent"}]'` versus `'{"saas","devtools"}'` — and
the importer serializes json/jsonb columns itself instead of letting the
driver guess. Before that, any program with compound commission rules
failed to re-import.

**Scalars count as JSON too.** Both serializers originally re-serialized a
json/jsonb value only when it was a JS *object*. But `pg` parses json/jsonb
through `JSON.parse`, so a column holding `'"hello"'` hands back the plain
JS string `hello`, and one holding `'42'` hands back a number. Those were
emitted as the SQL literals `'hello'` and `42`, which the column rejects —
so a perfectly valid stored value made the restore fail. Any non-null JSON
value is now re-serialized regardless of its JS type.

**Known residual: JSON `null` versus SQL NULL.** After `select *` these are
indistinguishable — both arrive as JS `null` — so a column holding the JSON
value `null` exports as SQL `NULL`. On a nullable column that round-trips
fine in practice; on a `NOT NULL` json column the restore fails loudly
rather than corrupting anything. Closing this properly needs the exporter to
read column nullability, which is not worth the complexity until someone
actually stores a bare JSON `null`.

**Scoping does not rely on RLS alone.** `exportTable` takes an explicit
`tenantId` and filters on it. RLS is still the outer guarantee, but `appDb`
falls back to the privileged `DATABASE_URL` when `DATABASE_URL_APP` is unset
— a supported self-host configuration — and an unfiltered `select *` on that
pool would return every tenant's rows. Every exportable table carries
`tenantId`, so the filter is complete rather than best-effort.

## What is deliberately NOT in the bundle

Being explicit matters more than being complete here: a promise the code
doesn't keep is worse than a documented gap.

**Never exported** (credentials, platform-operational state, or delivery
logs — not customer data):
`Session`, `MagicLinkToken`, `ApiKey`, `Admin`, `PlatformSession`,
`PlatformSessionBundle`, `PlatformAdmin`, `PlatformAdminSession`,
`PlatformAuditLog`, `SignupBlocklist`, `WebhookDelivery`, `NetworkOutbox`,
`StripeWebhookInbox`.

`Admin` is the consequential one: it is authentication data, so it stays
out — which is exactly why `HostedFundingAuthorization` (whose `adminId`
is an FK to it) can't simply be added to the bundle.

**Not exported yet — known gaps, not decisions:**

- `Tenant` — brand name, logo, colours, payout settings. The destination
  tenant row has to exist before an import can run, so restoring one needs
  a merge strategy rather than an insert.
- `Config` — program name, support email and other UI-managed settings.
- `PartnerPostback`, `BrandAsset` — customer-configured integration and
  content.
- `WebhookEndpoint` — the customer's own outbound webhook configuration
  (the *delivery log* is deliberately excluded, but the endpoints are
  customer data and belong in the bundle).
- The hosted funding sidecars (`HostedFundingBatch`, `HostedFundingAllocation`,
  `HostedFundingTransfer`, `HostedFundingAuthorization`, `HostedBillingState`)
  and `PayoutReversal`. `docs/payout-funding.md` §4 says these are
  exportable sidecars, and today they are not — `PayoutReversal` is the
  material one, since payout status is *derived* from it, so a restored
  database can hold a `reversed` payout with no reversal ledger behind it.
  Exporting them needs an FK decision first:
  `HostedFundingAuthorization.adminId` references `Admin`, which is
  deliberately never exported.

Until those land, an export is a complete record of **attribution, the
commission ledger, and the payouts derived from it**. It is NOT a
complete record of payout *corrections*: with `PayoutReversal` absent, a
restored payout can carry a `reversed` status whose supporting ledger
didn't come with it. Nor is it a record of hosted billing operations.

## Adding a table to the bundle

1. Add `{ table, primaryKey }` to `EXPORT_TABLES` in
   `apps/api/src/export.ts`, positioned after everything it references.
2. Bump `SCHEMA_VERSION` and add the new version to
   `SUPPORTED_IMPORT_VERSIONS` (never remove an old one).
3. Add it to the `TABLES` list in `apps/portal/src/pages/AdminExport.tsx`.
4. Extend the round-trip test (`export-roundtrip.test.ts`) — it seeds one
   row per table and asserts every table restores, so a missing seed fails
   the suite rather than silently skipping coverage.
5. Update the table above.

Hosted-only metadata does **not** go in core tables (principle #2). It
goes in a clearly optional sidecar table, and that table is either
exported losslessly (like `PortalCustomDomain`) or left out on purpose.
