# Audit log

What a brand's admins and API keys did, and when: who changed a commission
rate, approved a payout, revoked a partner, rotated a webhook secret or
downloaded the data export. Admin → Audit log, or `GET /audit-log`.

## What's recorded

One `AuditLog` row per action (migration `20261108120000_audit_log`):

| Column | |
|---|---|
| `actorKind` | `admin` (a signed-in admin), `api_key` (an API key, scoped keys included) or `operator_key` (the deployment's `ADMIN_API_KEY`) |
| `actorId` | `Admin.id` or `ApiKey.id`; null for the operator key. No FK: the log outlives the admins and keys it names |
| `actorLabel` | the admin's email or the key's label when it happened |
| `action` | the route as registered (`PATCH /programs/:id`), or `signin` |
| `targetId` | the record acted on: the route's first parameter, or the `id` a create returned |
| `params` | the route parameters |
| `fields` | the names of the request body's top-level fields. **Never their values** |
| `detail` | `changes` (old and new values) where a route records them; `via` for a sign-in |
| `status` | the HTTP status sent |
| `ip` | the caller's address (`req.ip`, so `TRUST_PROXY` applies) |

Bodies carry passwords, webhook and PayPal secrets and partners' payout
details, so none is stored. Four routes record old and new values, for rows
with no secrets or personal data in them: `PATCH /programs/:id`,
`PATCH /bounties/:id`, `PATCH /admins/:id` (the role) and
`PUT /partners/:id/programs/:programId/commission`. A handler opts in with
`auditChanges(req, table, where, before)`: the entry re-reads the row just
before commit and keeps each field the body named whose value changed.

## Which requests

`requireAuth` calls `auditRequest` (apps/api/src/audit-log.ts) for every
request it admits:

- **Writes** by an admin session, an API key or the operator key, when they
  succeed (status below 400). A refused write leaves no entry.
- **Reads that hand over bulk data or credentials** (`AUDITED_READS`): the
  JSON, SQL and per-table exports, a payout file, a partner's payout
  details, a partner's postback URL, and the audit log's own CSV.
- **Sign-ins**: an admin redeeming a sign-in link or a password sign-in
  (`via: "link"`), entering a workspace from their OpenPartner account
  (`workspace`), or the first sign-in of a booking claim (`claim`). With
  [two-step sign-in](two-step-sign-in.md) on, it's recorded once the code
  is in, with `secondFactor: "totp"` or `"recovery_code"`.

Not recorded:

- Partners' own requests. This is the brand team's log.
- `NOT_AUDITED`: conversion and click ingestion (kept as Event and Click
  rows), usage metering, Network message threads and booking refreshes,
  Stripe Checkout and billing-portal sessions, previews and test sends, and
  partner sign-in links (kept in `PartnerSigninLinkLog`, one per partner
  portal visit). Each has its reason beside it.
- The OpenPartner operator console (`/platform-admin/*`), which has its own
  log (`PlatformAuditLog`).

`__tests__/audit-log.test.ts` walks every route in the app. Each write
behind `requireAuth` needs a label in `AUDIT_ACTION_LABELS` or a reason in
`NOT_AUDITED`, so a new route fails the test until it is classified.

## Written with the change

The entry is written inside the request's own transaction, just before it
commits (`beforeCommit` in tenancy.ts), with the response body in hand (for
a create's id). If writing it fails, the whole request rolls back and
answers 500: a change never lands without its entry. A route that writes
through a transaction of its own (the payout planner, say) still gets its
entry from the request transaction, so there the two commit separately.

The app role may only `SELECT` and `INSERT` on `AuditLog` (app-role-grants.ts):
no request can edit or delete an entry. The tenant purge removes a deleted
brand's entries on the privileged pool.

## Reading it

Full admins and admin API keys. View-only seats are refused (`read_only`):
the log names teammates with their IP addresses
([view-only-seats.md](view-only-seats.md)).

- `GET /audit-log?actorId=&action=&targetId=&from=&to=&limit=&cursor=`:
  newest first, keyset-paginated. Each entry adds `label` ("Updated a
  program") and `targetName`, the program's, partner's, admin's, bounty's
  or key's name now, while the record exists.
- `GET /audit-log/actors`: each admin and key with an entry, under its
  latest label, for the `actorId` filter (the operator key has no id).
- `GET /audit-log.csv`: the same filters, at most 50,000 rows. The
  download is itself an entry.

The portal page lists entries with a filter by person and a CSV download.

## Retention and export

Entries are kept for the life of the brand. The log isn't in the export
bundle ([data-portability.md](data-portability.md#what-is-deliberately-not-in-the-bundle)):
like `PartnerSigninLinkLog` it records access to one deployment, its
`actorId`s name Admin and ApiKey rows, which never travel, and a restore
that could write it could write history. Download the CSV to keep a copy.
