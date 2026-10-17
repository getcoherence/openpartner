# OpenPartner Network protocol

The contract between an OpenPartner *vendor instance* (hosted tenant or
self-hosted install) and the Network coordinator at
`network.openpartner.dev`. The Network never shares a database with
vendors — every interaction is REST over scoped credentials. That keeps
data portability intact (a vendor leaving the Network loses Network
matchmaking but keeps every Partner / Commission / Payout row) and
keeps the Network out of the vendor's audit boundary.

This doc lives in the openpartner (vendor) repo because the vendor side
is what calls Network endpoints. The Network repo is responsible for
implementing them.

## Identities

| Term | Lives in | Stable across | Notes |
|---|---|---|---|
| `vendorId` | Network DB | A vendor instance's lifetime | Network-issued on `/vendors/register`. |
| `vendorPartnerId` | Vendor DB | A creator's relationship with this vendor | The `Partner.id` (ULID) on the vendor side. |
| `networkCreatorId` | Network DB | A creator's lifetime across vendors | Email-keyed canonical identity. Same email → same id, even across tenants/vendors. |

Vendors stamp `Partner.metadata.networkCreatorId` so admin UIs can show
"this creator is on the Network" without an extra round-trip.

## Auth

Two credential pairs:

1. **Vendor → Network** (this is what `network-client.ts` uses).
   - Network issues a `vendorToken` on registration.
   - Vendors send it as `Authorization: Bearer <vendorToken>` on every call.
   - Stored encrypted in the vendor's `Config` row keyed `network_membership`.
2. **Network → Vendor** (for matchmaking write-backs).
   - Vendor mints a scoped key with `NETWORK_FEDERATION_SCOPES`
     (`partners:write`, `partners:read`, `links:write`,
     `commissions:read`) and hands it to the Network at registration.
   - Network sends it as `Authorization: Bearer <scopedKey>` when calling
     vendor endpoints (POST /partners, etc).

Both creds are rotatable: the vendor mints a new scoped key and pushes
it via `POST /vendors/me/rotate-callback-key`; the Network can rotate
the vendor's bearer via `POST /vendors/me/rotate-token` returning a new
token the vendor stores.

## Endpoints (Network-side, called by vendor)

### `POST /vendors/register`

Vendor onboarding. Idempotent on `instanceUrl` — calling twice with the
same URL returns the existing vendor record (with a fresh token if
requested).

```
Headers
  Authorization: Bearer <network-issued enrollment token>   # one-time, distributed by Network UI / dashboard
Body
  {
    "instanceUrl":  "https://app.openpartner.dev/t/acme/api",   // or self-host URL + /api
    "scopedKey":    "op_<24 hex>",                               // vendor's federation key for Network → vendor calls
    "displayName":  "Acme Inc.",
    "tier":         "hosted" | "self_hosted",
    "contact":      { "email": "...", "name": "..." }
  }
Response 200
  {
    "vendorId":    "vnd_01J...",
    "vendorToken": "vntok_<48 hex>",      // store this, send on every subsequent vendor → Network call
    "issuedAt":    "2026-04-26T...Z"
  }
```

Validation: `instanceUrl` must be HTTPS and reachable (Network does a
GET `/health` from its own infra and rejects on non-200 within 5s).

### `POST /partners/upsert`

Called every time a vendor creates or revokes a partner (whether via
admin invite, public `POST /partner-signup`, or federated onboarding).
Email is the join key.

```
Headers
  Authorization: Bearer <vendorToken>
Body
  {
    "vendorPartnerId": "01J...",                  // Partner.id on the vendor side
    "email":           "creator@example.com",
    "name":            "Ada Creator",
    "profile":         { ... },                   // optional, surfaced to other vendors searching
    "joinedVendorAt":  "2026-04-26T...Z",
    "status":          "pending" | "active" | "revoked",
    "metadata":        { "source": "self_signup" | "admin_invite" | "backfill" },
    "creatorProfile": {                           // optional; public signup only
      "websiteUrl":   "https://ada.example",
      "socialUrls":   ["https://youtube.com/@ada"],  // max 5
      "audienceSize": "under_1k" | "1k_10k" | "10k_50k" | "50k_250k" | "250k_1m" | "over_1m"
    }
  }
Response 200
  {
    "networkCreatorId": "crt_01J...",
    "alreadyExisted":   true | false,             // true if Network already knew this email
    "affiliations": [
      { "vendorId": "vnd_...", "vendorPartnerId": "01J...", "status": "active",   "displayName": "Acme Inc." },
      { "vendorId": "vnd_...", "vendorPartnerId": "01J...", "status": "pending",  "displayName": "Beta Co." }
    ]
  }
```

The `affiliations` array tells the vendor *what other programs the
creator is in*. Vendor stores `networkCreatorId` and (optionally)
surfaces affiliations in its admin UI ("This creator also works with
Beta Co.").

`creatorProfile` carries the answers from the brand's join-page
application. The Network only fills BLANKS in the creator's profile from
it (platform rows from the URLs, `audienceSize`), never overwriting what
the creator set. A Network that predates the field strips it, so vendors
always send it on public signup.

Idempotency: `(vendorId, vendorPartnerId)` is unique on the Network
side. Re-posting the same `vendorPartnerId` updates status and bumps
`updatedAt`.

### `POST /vendors/backfill-partners`

Called once when a vendor flips Network membership ON after already
having a partner roster. Pushes existing `Partner` rows in batches.
This is the **late-join reconciliation** path:

- For partners whose email is unknown to the Network → new
  `networkCreatorId`, single affiliation.
- For partners whose email is already on the Network (because they
  signed up at another Network-affiliated vendor first) → returns the
  existing `networkCreatorId` and adds this vendor to their
  `affiliations`. The vendor stamps `Partner.metadata.networkCreatorId`
  + `networkPreExisting=true` so the admin can see which partners
  already had Network presence.

```
Headers
  Authorization: Bearer <vendorToken>
Body
  {
    "partners": [
      { "vendorPartnerId": "...", "email": "...", "name": "...", "joinedVendorAt": "...", "status": "active" },
      ...
    ]
  }
Response 200
  {
    "results": [
      { "vendorPartnerId": "...", "networkCreatorId": "crt_...", "alreadyExisted": false },
      ...
    ]
  }
```

Batch size: vendor sends ≤ 500 partners per call and paginates
internally for larger rosters. Network is expected to handle this in a
single transaction so a partial failure rolls back cleanly.

### `POST /vendors/me/heartbeat`

Optional liveness probe — vendor pings every 24 h with current partner
count + last activity timestamp. Gives the Network a way to detect
abandoned instances (and prune them from creator-facing search).

```
Headers
  Authorization: Bearer <vendorToken>
Body
  { "partnerCount": 42, "lastEventAt": "2026-04-25T...Z" }
Response 204
```

## Endpoints (Vendor-side, called by Network)

These already exist in this repo, gated by `grantScope(...)`:

| Network use case | Vendor endpoint | Required scope |
|---|---|---|
| Onboard a creator the Network matched | `POST /partners` | `partners:write` |
| Mint a referral link for that creator | `POST /partners/:id/links` | `links:write` |
| Show a creator their accrued earnings | `GET /partners/:id/commissions` | `commissions:read` |
| Verify the scoped key still works | `GET /auth/introspect` | (any) |

`POST /partners` scopes the new Partner's grants with `programIds`
(`[offering.vendorProgramId]` on approve). **Omitting it grants every
program the brand has**, and unknown body keys are stripped, not
rejected. That's why the field name is load-bearing. `campaignIds` is
accepted as a deprecated alias (`programIds` wins when both are sent).
The Network sends both. `programIds` is what scopes brand instances
built between the Campaign → Program rename and this alias, since they
strip `campaignIds`.

Sending `campaignIds` does **not** make approve work against a
pre-rename brand instance. That brand reads `campaignIds`, so the
Partner is scoped correctly. But its `POST /partners/:id/links` requires
`campaignId`, and the Network sends `programId`, so approve fails at the
link step after the Partner row exists. That leaves an orphan, and every
re-approve 409s on `email_taken`. The legacy key only keeps that orphan
scoped to one program instead of every program. A pre-rename brand has
to upgrade to be approvable. `campaignIds` can be dropped once no
pre-rename brand is federated.

### Commission terms on `POST /partners`

The Network sends the approved offering's terms as `commissionSnapshot`
(`commissionRules`, plus the legacy `commissionType` / `commissionValue` /
`recurring`, and `holdbackDays`). The brand stores them as a
`PartnerCommission` row and pays future commissions from it instead of
the live program rule.

**Scope (brand-side, Oct 2026).** When the request names exactly one
program (`programIds`, or `campaignIds` if `programIds` is absent), the
snapshot is stored for **that program only**. The Network's approve flow
always sends `[offering.vendorProgramId]`, so its terms now price
commissions on the offering's program and nothing else. If the brand later
grants the creator another program, that program accrues at its own rule,
or at the brand's partner-wide override for the creator if one exists.
Before this change the row was partner-wide, so the offering's terms priced
every program the creator was ever granted. Requests naming several
programs, or none (none means every program), still store a partner-wide
snapshot.

**The Network's side of the contract is unchanged.** It sends the same
payload and reads the same response. Only the brand's interpretation got
narrower, and it now matches what the Network already records: the terms
live on the `Partnership` row, which is per offering. Brand instances from
before this change keep storing the snapshot partner-wide.

`POST /partners` also accepts `programCommissions:
[{ programId, commissionType, commissionValue, recurring?, holdbackDays?,
commissionRules? }]` for per-program terms at creation. Each `programId`
must be among the programs the request grants, and at most one set of
terms may target a program (the scoped snapshot counts as one). The
Network doesn't send `programCommissions` today. It's there for brands'
own integrations.

Brand admins can edit both scopes afterwards:
`GET|PUT|DELETE /partners/:id/commission-snapshot` (partner-wide) and
`GET|PUT|DELETE /partners/:id/programs/:programId/commission`
(one program).

Still open: approving a creator who is **already** a partner at the brand
(say, a second offering from the same brand) fails, because
`POST /partners` 409s on `email_taken`. Fixing that needs a federation call
that adds a grant plus program-scoped terms to an existing partner, and
that call doesn't exist yet on either side.

The Network uses the scoped key registered in `/vendors/register` for
all of these. On hosted multi-tenant the URL is
`{instanceUrl}/partners` where `instanceUrl` already includes the
tenant path (`https://app.openpartner.dev/t/<slug>/api`).

## Failure semantics

Vendor → Network calls (the ones this repo makes) are **fire-and-forget
from the request hot path**. A signup that succeeds in the vendor's DB
must not fail because the Network is down. The vendor side:

1. Tries the call with a 5s timeout.
2. On failure, logs `[network] push failed: <reason>` and persists a
   row in `NetworkOutbox` (a small per-vendor queue) for retry.
3. A periodic job (in the same `scheduler.ts` cron) drains
   `NetworkOutbox` with exponential backoff up to 24h, then drops with
   an admin-visible alert.

Network → vendor calls (the federation surface) are synchronous from
the Network's perspective; the Network is responsible for its own retry
on 5xx.

## What this means for the openpartner-network repo

Implementing this contract means building:

1. Storage: `Vendor`, `Creator` (email-unique), `VendorAffiliation`
   (vendorId × creatorId), `EnrollmentToken` (one-time, for vendor
   registration).
2. The four POST endpoints above.
3. Network → vendor client (already-known shape: scoped key + REST).
4. A vendor-facing dashboard for admins to mint enrollment tokens, see
   live vendors, and prune abandoned ones.
5. A creator-facing surface (search / browse vendors, see own
   affiliations, manage profile) — but that's product, not protocol.

The vendor side of this contract (this repo) will land first so the
Network has a real client to test against.
