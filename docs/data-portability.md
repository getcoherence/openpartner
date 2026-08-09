# Data portability — export formats and how to restore them

"Your data stays yours" is an architectural constraint, not a feature
(CLAUDE.md principle #2). Concretely that means: **every table exports to
CSV, JSON and SQL, and a hosted export restores into a self-hosted
instance.** This document is the format contract.

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
psql "$DATABASE_URL" -v tenant_id=default -f openpartner-export.sql
```

Omit `-v` and it defaults to `default` (the self-host tenant). The file
opens a transaction, sets `app.tenant_id` so it works on the RLS-scoped
app role as well as the privileged role, and inserts every table in the
order above with `ON CONFLICT DO NOTHING`.

`?tenantId=<id>` bakes a literal tenant id instead of the psql variable —
plain SQL for clients that don't run psql meta-commands.

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
