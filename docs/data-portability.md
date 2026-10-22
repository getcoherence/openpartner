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
  "schemaVersion": 10,
  "tables": { "Partner": [ … ], "Program": [ … ], … }
}
```

Rows are raw DB rows — the same shape `select *` returns, no reshaping,
no derived fields. Anything derived (attribution, commissions) is present
as its own table *and* re-derivable from the raw layers. Two exceptions,
both deliberate: credential columns are dropped (see
[Credentials](#credentials)), and `Config` carries only the brand's own
settings (see [Settings](#settings-config)).

To re-derive `Attribution`, replay each customer's events in `ts` order. A
renewal takes the attribution of the customer's first attributed event of
its type ([renewal-attribution.md](renewal-attribution.md)), so replayed
out of order it would be decided as a first conversion instead.

### Tables, in import order

Order is load-bearing: the importer walks it as written, so every table
appears after everything it references.

| # | Table | Primary key | Why it's in the bundle |
|---|-------|-------------|------------------------|
| 1 | `Partner` | `id` | the roster |
| 2 | `Program` | `id` | programs + their commission rules |
| 3 | `PartnerProgram` | `id` | **which partners may promote which programs** |
| 4 | `PartnerCommission` | `id` | **snapshotted per-partner terms** (partner-wide or per-program) |
| 5 | `PartnerNetworkConsent` | `partnerId` | **each partner's own OpenPartner Network opt-in** |
| 6 | `PartnerPayoutProfile` | `partnerId` | **where each partner wants manual payouts sent** (opened; see [Payout details](#payout-details)) |
| 7 | `Coupon` | `id` | **code → (partner, program) attribution** |
| 8 | `Link` | `id` | tracking links |
| 9 | `Click` | `id` | raw click log |
| 10 | `Identity` | `id` | click → user stitch |
| 11 | `Event` | `id` | raw conversion events |
| 12 | `Attribution` | `id` | derived attribution (re-derivable) |
| 13 | `Bounty` | `id` | **performance bounties**: goals on a program that pay a bonus |
| 14 | `Bonus` | `id` | **rewards not tied to a sale** (manual, performance bounty, Network bounty) |
| 15 | `Commission` | `id` | derived commission ledger |
| 16 | `Payout` | `id` | payout ledger |
| 17 | `PortalCustomDomain` | `id` | white-label domain history (inert on self-host) |
| 18 | `CommissionAdjustment` | `id` | clawbacks / corrections |
| 19 | `BrandAsset` | `id` | **the marketing-asset library** (image URLs, text snippets) |
| 20 | `WebhookEndpoint` | `id` | **your outbound webhook endpoints** (not the signing secret) |
| 21 | `PartnerPostback` | `id` | **each partner's own tracker callbacks** (the URL opened) |
| 22 | `ConversionPostbackToken` | `id` | **the GET /postback allowlist and rotation history** (not the token) |
| 23 | `Config` | (`tenantId`, `key`) | **program settings, the join-page policy, the portal-access default and the onboarding Network skip** |

Rows 3, 4 and 7 were added in schemaVersion 2 (Aug 2026). Without them a
restored instance had the roster but no grants, no coupon attribution, and
no record of what any partnership was actually agreed at.

Row 5 was added in schemaVersion 4 (Oct 2026). It records whether each
partner opted in to the OpenPartner Network, declined or withdrew, how
(join page, portal prompt, portal setting, joined from a Network offering,
or grandfathered from the old brand-level auto-enroll), and when. It is the
partner's decision, not the brand's, so it travels with the roster. A v1,
v2 or v3 bundle restores with no consent rows, so every restored partner
starts undecided and nobody is sent to the Network until they opt in on
the new instance.

Rows 19 to 23 were added in schemaVersion 5 (Oct 2026). Before that a
restored instance had the attribution and money ledger but none of the
brand's configuration: no program name or support email, no join-page
policy, no asset library, no webhooks, and no partner postbacks.

Row 14 was added in schemaVersion 6 (Oct 2026). A `Bonus` is a reward paid
to a partner that isn't tied to an attributed sale
([bounties.md](bounties.md)): who got it, how much, under which program,
where it came from (`manual`, `performance_bounty`, `network`), the
caller's idempotency key and the note shown to the partner. Each bonus is
paid through exactly one `Commission` row whose `bonusId` names it and
whose `attributionId` is null (a CHECK requires exactly one of the two),
so it sits before `Commission`. A bonus is a decision, not a raw event, so
it is never re-derived from the event log; it travels as recorded. A v1–v5
bundle has no bonuses, and its `Commission` rows restore with `bonusId`
null.

Row 13 was added in schemaVersion 7 (Oct 2026). A `Bounty` is a goal on a
program ("10 new sales by Dec 31 earns $500"): its metric, threshold,
window, reward, partner allowlist, status, and the stamps that keep its
partner emails from going out twice. A bonus a bounty paid names it in
`Bonus.bountyId`, so it sits before `Bonus`. A partner's progress is never
stored: it is re-derived from the exported Attribution, Event and
Commission rows. A v6 bundle has no bounties, and none of its bonuses name
one.

`Click` rows carry `subId` (schemaVersion 8, Oct 2026): the publisher's own
sub-ID, from `?sub_id=` on the partner link. Tracking tools that pull a
publisher's conversions from many programs into one dashboard put their
click id there, and it comes back on the `commission.*` webhooks and in the
`{sub_id}` partner postback macro. It is raw click data that nothing can
re-derive, so the column bumps the version, unlike the nullable columns
below: an instance too old to store it refuses the bundle up front instead
of failing on an unknown column. A v1–v7 bundle's clicks restore with
`subId` null.

Row 6 was added in schemaVersion 9 (Oct 2026). A `PartnerPayoutProfile` is
where a partner wants manual-rail payouts sent: a PayPal email, a bank
account, a UPI ID or free-text instructions
([manual-payout-files.md](manual-payout-files.md)). It is stored sealed, so
it travels opened; see [Payout details](#payout-details). A v1–v8 bundle
restores with no payout details, and partners enter them again.

`Coupon` rows carry `brandChosen` (schemaVersion 10, Oct 2026): the
brand's admin typed the code, rather than it being generated or picked by
the partner. The Stripe webhook matches a discount to a partner code by
its string, and only for a code the admin chose does a promotion code or
coupon the brand already had under that string credit the partner. Any
other code matches only Stripe promos made for it. It is raw data about
who picked the code, which nothing can re-derive, so the column bumps the
version. A v1–v9 bundle's coupons restore with `brandChosen` false, the
value the migration `20261021020000_coupon_brand_chosen` gave every
existing code.

`Partner` rows carry `portalAccess` (schemaVersion 5, Oct 2026): whether
the partner may sign in to the partner portal. A headless program turns it
off so its customers can't, and a restored instance keeps them out too. A
v1–v4 bundle has no such column, and its partners restore with the column
default, `true`, which is what every partner had when it was exported. The
tenant-wide default for new partners (`GET /config/partner-access`) is the
`partner_access` `Config` key, which travels with the bundle from v5 on.

`PartnerCommission` rows carry a nullable `programId`. Null means the
partner's partner-wide terms; a value means their terms for that one
program (schemaVersion 3, Oct 2026). The table's natural key is one
partner-wide row per partner and one row per (partner, program). Partial
unique indexes enforce it, not the primary key. So both restore paths skip
a `PartnerCommission` row that collides on **any** unique key, using a bare
`ON CONFLICT DO NOTHING`, not just one that collides on `id`. Every other
table conflicts on its primary key; `PartnerNetworkConsent` and
`PartnerPayoutProfile` are keyed on **`partnerId`**, one row per partner. The importer looks the key up per
table rather than assuming `id`. `Config` (primary key `tenantId, key`) and
`ConversionPostbackToken` (at most one live token per tenant, a partial
unique index) skip on any unique collision too, so a setting or live token
the destination already has is kept and the bundle's copy is skipped.

### Credentials

A bundle never contains a credential: anyone holding the file must not be
able to sign a webhook or record a conversion with it. The exporter drops
these columns from every format (JSON, CSV and SQL), and the importer
ignores them if a hand-made bundle has them:

| Table | Not exported | On restore |
|---|---|---|
| `WebhookEndpoint` | `secret`, `secretPrefix` | A fresh signing secret is generated (stored sealed, like every webhook secret), and the endpoint comes back **paused** (`active = false`), because its receiver doesn't know the new secret yet. |
| `ConversionPostbackToken` | `tokenHash` | Replaced by a hash nothing matches. The live token keeps its IP allowlist and history, but no postback URL works, the source's included, until you **rotate** it on the Integrations page. Rotating keeps the allowlist. |

**Why webhook secrets don't travel opened, when payout details do.** Since
Oct 2026 the signing secret is sealed at rest with AES-256-GCM under the
deployment's `SECRETS_ENCRYPTION_KEY`, the same envelope as
[payout details](#payout-details), and a sealed value means nothing
anywhere else. Payout details and partner postback URLs travel opened
anyway, because they are your partners' data: leaving them out would make
every partner enter their bank details, or set up their tracker, again. A
signing secret is different on both counts:

- It is a credential. Whoever holds the file could sign deliveries your
  receivers would accept as genuine (`commission.paid`, `payout.created`,
  …), and an export file is kept far less carefully than the database.
- Replacing it costs one setting per receiver, which you change yourself.
  No partner has to do anything.

So the bundle still leaves it out, and a restored endpoint gets a new one.
A move from hosted to self-hosted (or back) means giving each receiver
its new secret once.

To finish a restore:

- **Webhooks.** `POST /import` returns each restored endpoint's new secret
  once, in `report.credentials.WebhookEndpoint` as `{ id, url, secret }`.
  A SQL restore writes a random secret nobody is shown, and the API seals
  it within ten minutes of starting, so **rotate** each restored endpoint
  to get one: **Rotate secret** on the admin Webhooks page, or
  `POST /webhooks/{id}/secret`, which returns the new secret once. Give
  each receiver its new secret, then turn the endpoint back on (admin
  Webhooks page, or `PATCH /webhooks/{id}` with `{"active": true}`).
  Endpoints that already existed on the destination are skipped and keep
  their own secret.
- **Conversion postbacks.** Rotate the token, then update the URL at every
  network or lender that fires it. The host changes on a hosted to
  self-host move anyway.

Partner postback URLs travel opened; see
[Partner postback URLs](#partner-postback-urls).

### Payout details

`PartnerPayoutProfile.details` is sealed at rest with AES-256-GCM under the
deployment's `SECRETS_ENCRYPTION_KEY` ([manual-payout-files.md](manual-payout-files.md)).
A sealed value means nothing under any other key, so unlike the SMTP
password in `mail_settings` and webhook signing secrets
([Credentials](#credentials)) it travels **opened**: every format (JSON, CSV
and SQL) writes `details` as the JSON object the partner entered (email,
account holder, IBAN or account and routing numbers, address, UPI ID,
instructions). It isn't a credential: nobody can move money with it. But it
is your partners' bank details, so **treat an export file accordingly**.
Leaving it out would strand the data on this deployment and make every
partner re-enter it after a migration, which is the lock-in this bundle
exists to prevent.

On restore:

- **JSON** (`POST /import`) seals each row again under the destination's
  key as it inserts it.
- **SQL** can't encrypt (the key is the app's), so the dump writes the
  opened JSON and says so in a comment. The API seals each row the first
  time it reads it, and a sweep seals every remaining one when the API
  starts and hourly (the `seal-payout-details` job), so nothing stays in
  the clear at rest for long.
- A hand-made bundle whose `details` is still a sealed envelope from another
  deployment restores as it came. It reads as unreadable, and that partner
  enters their details again.

### Partner postback URLs

`PartnerPostback.url` is a partner's own tracker callback, and partners put
their tracker's shared secret in it (`?secret=…`), because postbacks aren't
signed. Since Oct 2026 it is sealed at rest with AES-256-GCM under the
deployment's `SECRETS_ENCRYPTION_KEY`, like [payout details](#payout-details),
and opened only to fire the postback. The API shows it masked
(`urlPreview`: the scheme and host and each `name={macro}` pair, with the
path and every other query pair as `•••`) to everyone but the partner who
owns it, who sees it in full when editing.

It holds no OpenPartner credential: nobody can sign a webhook or record a
conversion with it. It is the partner's data, so like payout details it
travels **opened**: every format (JSON, CSV and SQL) writes `url` as the
partner entered it, macros and all. A partner's tracker secret is in there,
so **treat an export file as you would the partner list itself**.
`urlPreview` is left out of every format: it is derived from the URL, and
the import derives it again, so the row has the shape it had before
sealing and the bundle version is unchanged.

On restore:

- **JSON** (`POST /import`) seals each URL again under the destination's
  key and writes its preview. A bundle from before sealing (no
  `urlPreview`) imports the same way.
- **SQL** can't encrypt (the key is the app's), so the dump writes the URL
  opened and says so in a comment. Until the API seals it, it fires and
  lists (masked) as it is. A sweep seals every plaintext URL ten minutes
  after the API starts and hourly after that (the `seal-postback-urls`
  job), so nothing stays in the clear at rest for long.
- A hand-made bundle whose `url` is still a sealed envelope from another
  deployment restores as it came. Its postback fails every fire, with an
  error saying so, until the partner enters the URL again.

**Why ten minutes.** During a rolling deploy the previous build keeps
serving until the new one is healthy, and a build from before sealing fires
whatever `url` holds. So for its first ten minutes a process neither seals
the sweep's rows nor seals the URLs partners save: those are stored as
entered, and the sweep that runs at the ten-minute mark seals them. Webhook
signing secrets wait out the same window.

The PayPal and Wise files a brand made from its payout runs
([manual-payout-files.md](manual-payout-files.md)) need nothing extra: a
file is a stamp on each of its payouts (`Payout.metadata.manualExport`),
which travels with the `Payout` rows. On a restored instance a file's
unconfirmed payouts still show under "Files made", to confirm or discard.

### Settings (`Config`)

Only these keys are exported, and only these are imported:

| Key | What it holds |
|---|---|
| `program_settings` | program name, support email, router URL, whether partners see the Network |
| `partner_signup` | the join page: auto-approve or review, or closed |
| `partner_access` | whether partners created without an invite may sign in to the partner portal (a headless program turns it off) |
| `onboarding` | whether the brand said "Not now" to listing on the OpenPartner Network (the dashboard's Getting started card) |

`onboarding` was added in Oct 2026 without a version bump. It is a new
key in a table the bundle already carries, not a new table or column. An
instance from before it skips the key on import (Config import takes only
the keys it knows), and the restored brand sees the Network step on its
Getting started card again.

Every other key stays out, on purpose:

- `mail_settings` holds the SMTP password or Postmark server token,
  encrypted under the source deployment's `SECRETS_ENCRYPTION_KEY`, so it
  could not be decrypted anywhere else. Set up mail again on the
  destination.
- `network_membership` holds the Network vendor token (also encrypted) and
  points at the federation `ApiKey`, which is never exported. Reconnect to
  the Network on the destination.
- `billing_cancel_scheduled_notice`, `billing_dunning_notice`, the
  `stripe.merchant.*` keys and `network.lastPayoutsReportedAt` are hosted
  billing bookkeeping: Stripe ids and report cursors that mean nothing on
  another instance.

### Brand asset files

`BrandAsset` rows are exported, but the image files are not: an image row
carries the public URL of its file, not its bytes. Three reasons:

- the bundle is row data in three text formats, and image bytes don't fit
  CSV or a SQL dump;
- the files are already public. Each URL is absolute, on the hosted
  instance's object storage or a self-host's `/uploads`, and OpenPartner
  never rewrites a stored URL, so a restored row keeps showing the same
  image;
- uploads are capped at 2 MB and are images only, so fetching them takes
  one command.

The catch: a URL only works while its storage does. If you are leaving an
instance for good, download the files before you close it:

```bash
jq -r '.tables.BrandAsset[] | select(.url) | .url' openpartner-export.json | xargs -n 1 curl -fsSO
```

Then upload them on the destination, or serve them from your own storage
and update each row's `url`. Text snippets (`kind = 'snippet'`) are in the
row's `body` and need nothing extra.

Commission slabs (value bands and performance tiers,
[commission-slabs.md](commission-slabs.md)) need nothing extra: they are
JSON inside `Program.commissionRule` and `PartnerCommission.commissionRules`,
and the band/tier each commission was paid at is JSON in
`Commission.metadata` (Oct 2026). That column was added without a version
bump — a bundle from before it imports with `metadata = {}`. The reverse
(a newer bundle into an instance that hasn't run the migration) fails on
the unknown column; migrate first.

`Program.revenueEventTypes` (Oct 2026) is the same kind of addition: the
event types a brand declares are sales in a program, beyond `invoice_paid`
and `subscription_created` ([platform-fee.md](platform-fee.md)). A brand
fact about its own events, so it is core and travels with the program. A
bundle from before it imports with `{}`. Since then each accrued
commission also records `metadata.rateType` (`percent` | `fixed`); older
rows don't have it, and nothing on import needs it.

Refunds and chargebacks (Oct 2026) need nothing extra either, and no
version bump. The refund itself is an `Event` (`type` `refund` or
`chargeback`, negative `value`; an API refund names its conversion in
`metadata.conversionEventId`). A partial refund's replacement commission
is an ordinary `Commission` row whose `metadata.refund` names the
commission it replaced and the refund behind it. A clawback on a paid
commission is a `CommissionAdjustment` with `reason = 'refund_clawback'`.
All three tables are already in the bundle, so a restored instance has
the same refund history and the same derived amounts.

Netting a clawback off a later payout (Oct 2026,
[refund-clawback-netting.md](refund-clawback-netting.md)) adds one
nullable column, `CommissionAdjustment.appliedPayoutId`: the `Payout` that
deducted it, or null while it is still outstanding. No version bump, for
the same reason as `Commission.metadata`. An older bundle imports with
null, and a newer bundle needs the migration first. Restored, a netted
clawback stays netted. An outstanding one is deducted from that partner's
next manual or direct-Connect payout on the new instance, as it would have
been on the old one.

### Versioning

`SCHEMA_VERSION` is the current bundle version; `SUPPORTED_IMPORT_VERSIONS`
is what `POST /import` accepts. **That list only ever grows.** A v1 bundle
sitting on someone's disk keeps importing — it is simply a v9 bundle
without the tables and columns added later. A v4 bundle restores with no
settings, assets, webhooks or postbacks; configure those on the destination.

**Importing a v1–v4 bundle's programs.** Their `Program` rows have no
`renewalsStayWithPartner`, so the column default applies: `true`, the same
value the migration `20261017010000_program_renewals_stay_with_partner`
gave every existing program. Set it to `false` afterwards on any program
that should attribute every event against the window alone.

| Version | Change |
|---|---|
| 1 | original table set |
| 2 (Aug 2026) | added `PartnerProgram`, `PartnerCommission`, `Coupon`; per-table primary keys |
| 3 (Oct 2026) | `PartnerCommission` gains `id` (the new primary key; was `partnerId`) and `programId` |
| 4 (Oct 2026) | added `PartnerNetworkConsent` |
| 5 (Oct 2026) | added `BrandAsset`, `WebhookEndpoint`, `PartnerPostback`, `ConversionPostbackToken` (credentials excluded) and `Config` (portable keys only); `Program` rows carry `renewalsStayWithPartner` and `Partner` gains `portalAccess` (older bundles restore both as `true`) |
| 6 (Oct 2026) | added `Bonus`; `Commission` rows carry `bonusId`, and `attributionId` is null on a bonus's commission |
| 7 (Oct 2026) | added `Bounty` (performance bounties; `Bonus.bountyId` references it) |
| 8 (Oct 2026) | `Click` rows carry `subId`, the publisher's `?sub_id=` (older bundles restore it as null) |
| 9 (Oct 2026) | added `PartnerPayoutProfile`, its `details` opened (older bundles restore no payout details) |
| 10 (Oct 2026) | `Coupon` rows carry `brandChosen`, whether the brand's admin typed the code (older bundles restore it as false) |

**Importing a v1 or v2 bundle.** `POST /import` upgrades older rows before
inserting them (`upgradeBundle` in `apps/api/src/export.ts`). A v2
`PartnerCommission` row applied to every program the partner was in, which
is exactly what a v3 partner-wide row means. So it imports with
`programId = null` and `id = 'pcm_' || partnerId`. That is the id the
migration `20261016000000_partner_commission_program_scope` gave existing
rows, so a bundle exported before the upgrade lines up row for row with the
upgraded instance, and re-importing it changes nothing.

**Restoring a v2 SQL dump.** A dump written before schemaVersion 3 ends its
`PartnerCommission` statement with `ON CONFLICT ("partnerId") DO NOTHING`.
`partnerId` is no longer unique on its own, so Postgres rejects the
statement ("there is no unique or exclusion constraint matching the ON
CONFLICT specification") and the whole restore rolls back. Change that one
line to `ON CONFLICT DO NOTHING` and the dump restores. The rows become
partner-wide terms, and `id` is filled by its column default. Alternatively,
restore the same export's JSON bundle through `POST /import`, which needs
no edit.

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
`ON CONFLICT (pk) DO NOTHING` (a bare `ON CONFLICT DO NOTHING` for
`PartnerCommission`, `ConversionPostbackToken` and `Config`, as described
above), so re-running is safe and a partial import can be resumed.

The response reports rows inserted and skipped per table, plus
`credentials`: the new signing secret of each webhook endpoint it restored.
It is shown once. See [Credentials](#credentials).

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

Credentials are generated by the restoring server (`gen_random_uuid()`,
so **Postgres 13 or newer**). The file contains none, and nobody is shown
the generated webhook secrets: rotate each restored endpoint to get one
(see [Credentials](#credentials)).

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

**Two known residuals, both from `JSON.parse`.** The driver hands us parsed
JavaScript, so anything JSON can express but JS cannot represent exactly is
already lost before either serializer runs:

- **JSON `null` versus SQL NULL.** Indistinguishable after `select *` — both
  arrive as JS `null` — so a column holding the JSON value `null` exports as
  SQL `NULL`. On a nullable column that round-trips fine in practice; on a
  `NOT NULL` json column the restore fails loudly rather than corrupting
  anything.
- **Number precision.** `'9007199254740993'::jsonb` parses to the JS number
  `9007199254740992` and restores rounded; `1e400` becomes `Infinity`, which
  `JSON.stringify` writes as `null`. This is silent, unlike the case above.

Closing either properly means not going through `JSON.parse` at all —
selecting the column as text, or installing a lossless parser — which is not
worth the complexity until someone actually stores such a value. Both are
covered by tests that assert the CURRENT lossy behaviour, so if a future
change makes the parse lossless those tests fail and this section gets
updated rather than quietly going stale.

An earlier version of this doc claimed null-vs-NULL was the *only* residual.
It was not.

**Scoping does not rely on RLS alone.** `exportTable` takes an explicit
`tenantId` and filters on it. RLS is still the outer guarantee, but `appDb`
falls back to the privileged `DATABASE_URL` when `DATABASE_URL_APP` is unset
— supported for single-tenant self-host; a multi-tenant API refuses to boot
that way — and an unfiltered `select *` on that pool would return every
tenant's rows. Every exportable table carries
`tenantId`, so the filter is complete rather than best-effort.

## What is deliberately NOT in the bundle

Being explicit matters more than being complete here: a promise the code
doesn't keep is worse than a documented gap.

**Never exported** (credentials, platform-operational state, or delivery
logs — not customer data):
`Session`, `MagicLinkToken`, `ApiKey`, `ConversionPostbackToken`, `TenantStripeConnection`, `Admin`, `PlatformSession`,
`PlatformSessionBundle`, `PlatformAdmin`, `PlatformAdminSession`,
`PlatformAuditLog`, `SignupBlocklist`, `WebhookDelivery`, `NetworkOutbox`,
`StripeWebhookInbox`, `LocationDeclaration`, `SanctionsScreening`.

`LocationDeclaration` is the hosted platform's record of where each brand
and partner said it is based ([country-access.md](country-access.md)), and
`SanctionsScreening` its record of each brand and partner name it checked
against the US sanctions lists ([sanctions-screening.md](sanctions-screening.md)).
They are compliance records the operator keeps for itself, not the brand's
attribution data, and a self-hosted install doesn't use them.

`Admin` is the consequential one: it is authentication data, so it stays
out — which is exactly why `HostedFundingAuthorization` (whose `adminId`
is an FK to it) can't simply be added to the bundle. Credential *columns*
of exported tables, and the `Config` keys that aren't settings, are listed
under [Credentials](#credentials) and [Settings](#settings-config).

`TenantStripeConnection` (hosted only, Oct 2026) is in the same category:
the OAuth tokens a hosted brand granted OpenPartner by installing the Stripe
App on its own Stripe account ([stripe-app.md](stripe-app.md)), plus that
account's id and connection timestamps. It's credentials for one deployment,
so it's never exported, and a self-host has no use for it: there the brand's
own `STRIPE_SECRET_KEY` is the connection. What the connection *recorded* is
in the bundle as ordinary raw `Event` rows (tagged `metadata.via =
'stripe_app'`, with the Stripe account id), and those re-derive on any
instance like every other Event.

**Not exported yet — known gaps, not decisions:**

- `Tenant` — brand name, logo, colours, default currency, payout settings.
  (Every Event, Commission and Payout row carries its own currency, so the
  raw layers don't depend on the default currency.) The destination
  tenant row has to exist before an import can run, so restoring one needs
  a merge strategy rather than an insert.
- The hosted funding sidecars (`HostedFundingBatch`, `HostedFundingAllocation`,
  `HostedFundingTransfer`, `HostedFundingAuthorization`, `HostedBillingState`)
  and `PayoutReversal`. `docs/payout-funding.md` §4 says these are
  exportable sidecars, and today they are not — `PayoutReversal` is the
  material one, since payout status is *derived* from it, so a restored
  database can hold a `reversed` payout with no reversal ledger behind it.
  Exporting them needs an FK decision first:
  `HostedFundingAuthorization.adminId` references `Admin`, which is
  deliberately never exported.
- `UsageLedger` — what the hosted platform fee billed or credited for each
  conversion (apps/api/src/usage-ledger.ts). It's OpenPartner's invoice
  basis for the brand, not the brand's attribution data, and it means
  nothing on a self-hosted instance, which isn't metered. Anything that
  needs it can re-derive the billable value from the exported Event,
  Attribution and Commission rows. Its `terms` column freezes the fee
  terms each conversion was first billed under. Bonuses are billed on rows
  of their own (`bonusId` set instead of `eventId`), re-derivable the same
  way from the exported Bonus and Commission rows.
- `HostedFeeTerms` and `UsageFeeShadow` — which platform-fee rule a tenant
  is on (plan start, pricing-notice date, effective date, contract rates
  and minimum) and the old-vs-new shadow comparison
  ([platform-fee.md](platform-fee.md)). Hosted billing sidecars in the
  same category as `UsageLedger`: the hosted contract, not attribution
  data, and meaningless on an unmetered self-hosted instance.
- `HostedBillingProfile` — how a tenant pays its OpenPartner subscription
  (card or invoice, invoice terms, overdue grace, Indian GSTIN;
  [invoice-billing.md](invoice-billing.md)). A hosted billing sidecar like
  `HostedFeeTerms`: the brand's billing relationship with OpenPartner, not
  attribution data.
- `OperatorRecoveryRequest` — the operator-recovery decision ledger
  (apps/api/src/operator-recovery.ts). Operational sidecar in the same
  category: an auditable record of hosted/self-host *operations*, not of
  the attribution or commission data itself. Its `requestedBy` carries
  admin identity, so it inherits the same `Admin`-adjacent export
  question as `HostedFundingAuthorization`.

Until those land, an export is a complete record of **attribution, the
commission ledger, and the payouts derived from it**. It is NOT a
complete record of payout *corrections*: with `PayoutReversal` absent, a
restored payout can carry a `reversed` status whose supporting ledger
didn't come with it. Nor is it a record of hosted billing operations.

## Adding a table to the bundle

1. Add `{ table, primaryKey }` to `EXPORT_TABLES` in
   `apps/api/src/export.ts`, positioned after everything it references.
   A column that holds a credential goes in the spec's `credentials`, with
   the fresh value the JSON and SQL restores put in its place. Never
   export one.
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
