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

Vendors stamp `Partner.metadata.network.creatorId` so admin UIs can show
"this creator is on the Network" without an extra round-trip.

## Partner consent (vendor side)

A vendor sends a partner's details to the Network **only if that partner
opted in**. Joining a brand's program is not joining the Network. Before
Oct 2026 the brand-level `autoEnroll` flag pushed every partner. It now
only means "offer the Network to my partners". Partners decide for
themselves on the join page, in a one-time portal prompt, or in a portal
setting. The decision is recorded in the vendor's `PartnerNetworkConsent`
table. The vendor enforces this before every `/partners/upsert` call,
revokes included, and its outbox re-checks it before each retry.

Partners provisioned by the Network's own approve federation
(`POST /partners` with `metadata.source = 'openpartner_network'`, on the
scoped key from registration) are already Network members and count as
consented. When a partner withdraws, or declines the prompt, the vendor
calls `POST /partners/unlink` (below) and pushes nothing else for them.

## Auth

Two credential pairs:

1. **Vendor → Network** (this is what `network-client.ts` uses).
   - Network issues a `vendorToken` on registration.
   - Vendors send it as `Authorization: Bearer <vendorToken>` on every call.
   - Stored encrypted in the vendor's `Config` row keyed `network_membership`.
2. **Network → Vendor** (for matchmaking write-backs).
   - Vendor mints a scoped key with `NETWORK_FEDERATION_SCOPES`
     (`partners:write`, `partners:read`, `links:write`,
     `commissions:read`, `clicks:write`, `bonuses:write`) and hands it to
     the Network at registration. Keys minted before Network bounties lack
     `bonuses:write`; the brand adds it to the same key from the admin
     Network page ("Re-authorize to enable Network bounties", `POST
     /config/network/authorize-bonuses`). The Network keeps the key it has,
     so nothing needs to be rotated. `GET /config/network` says
     `bonusesAuthorized`.
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

Called for a partner who opted in (see Partner consent above): when they
join or opt in, when the brand revokes them, and from the admin re-sync.
A brand's other partners are never sent. Email is the join key.

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

**Revoke** uses this same endpoint with `status: "revoked"` and the full
body (`email`, `name` and `joinedVendorAt` included), because the Network
validates every upsert against the schema above. Vendors before Oct 2026
sent only `{ vendorPartnerId, status, revokedAt }`. The Network rejected
that with a 400 on every attempt until the outbox gave up, so no revoke
from those versions ever landed.

### `POST /partners/unlink`

Implemented in openpartner-network#11 (Oct 2026).

Removes one vendor's affiliation with a partner, because the partner
withdrew Network consent or declined it. The body carries **no personal
data**, so a vendor may send it for a partner the Network never received.

```
Headers
  Authorization: Bearer <vendorToken>
Body
  {
    "vendorPartnerId": "01J...",                       // Partner.id on the vendor side
    "reason": "consent_withdrawn" | "consent_declined"
  }
Response 200
  {
    "removed":        true | false,   // false = no affiliation for (vendorId, vendorPartnerId); still 200
    "creatorDeleted": true | false
  }
```

Required Network behaviour:

1. Delete the `VendorAffiliation` for `(vendor.id, vendorPartnerId)`.
   Don't mark it `revoked`: the partner asked for the brand's link to the
   Network to be removed, and a revoked row still records it. After this
   call, acting as that partner (`x-act-as-vendor-partner`) must fail with
   `invalid_acting_context`.
2. Then, if the creator has **no** remaining affiliations, Partnerships or
   PartnershipRequests, has never signed in to the Network themselves (no
   `lastSignInAt`, no consumed sign-in link), and is still `active`, delete
   the `Creator`. Delete with it everything vendors filled in for them:
   `CreatorPlatform` rows and `creatorProfile` fill-ins. Such a creator
   only existed because vendors pushed them, so removing the last push
   removes them. A creator who signed in, or who works with another brand,
   keeps their account. So does a creator an operator blocked or
   suspended, so the decision stays on record.
3. Don't touch Partnerships the creator made on the Network. Those are the
   creator's own marketplace relationships, which they manage on the
   Network.
4. Be idempotent: an unknown `vendorPartnerId` answers `200` with
   `removed: false`, never `404`.
5. Accept the call from a suspended vendor too. It only removes data, and
   suspension mustn't trap a partner who wants out.

**404 is reserved for "endpoint not implemented".** Against a Network
that predates this endpoint, vendors keep unlink calls queued in
`NetworkOutbox` and retry them every 12h. They never mark them dead, so every withdrawal
made in the meantime is delivered once the endpoint exists. Any other
failure follows the normal outbox limit (8 attempts, about 24h).

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
  { "partnerCount": 42, "lastEventAt": "2026-04-25T...Z", "logoUrl": "https://…",
    "bookingFeeBps": 1000 }
Response 204
```

`bookingFeeBps` is the storefront booking fee the brand's plan gives it
(see Storefront bookings below), honoured from hosted vendors only.

### Storefront bookings and conversations (`/vendors/me/bookings`, `/vendors/me/conversations`)

Creators on the Network list priced packages on their public profile.
Since phase 3 (openpartner-network docs/creator-storefront.md §8) brands
and creators talk in a **conversation**, one per (creator, brand), and
every booking lives in it. The creator accepts a brand's request at a price
(or sends an offer), and the brand **pays upfront** through Stripe Checkout:
a direct charge on the creator's own Stripe account, with OpenPartner's
booking fee on top as the application fee. Nobody is paid through
`POST /bonuses` for a booking any more.

```
Headers
  Authorization: Bearer <vendorToken>

GET  /vendors/me/conversations                    → 200 { conversations[], unreadTotal }
POST /vendors/me/conversations                    { creatorId, body, authorName?, authorEmail? }
                                                  → 201 { conversationId, message }
GET  /vendors/me/conversations/:id?before=<msgId> → 200 { conversation, messages[], hasMore, bookings[] }
POST /vendors/me/conversations/:id/messages       { body, authorName?, authorEmail? } → 201 { message }

POST /vendors/me/bookings
  { "creatorId": "crt_…", "packageId": "cpk_…" | null, "brief": "20–2000 chars",
    "amount": 500 | null, "currency": "USD" | null, "offeringId": "off_…" | null,
    "authorName"?, "authorEmail"?, "bookingFeeBps"? }
  → 201 { "booking": Booking, "conversationId": "cnv_…" }

GET  /vendors/me/bookings?status=<status>         → 200 { "bookings": Booking[] }
POST /vendors/me/bookings/claim                   { token, authorName?, authorEmail?, bookingFeeBps? }
                                                  → 201 { booking, conversationId }
POST /vendors/me/bookings/:id/checkout            { feeRateBps?, returnPath? } → 200 { url }
POST /vendors/me/bookings/:id/sync                record a finished Checkout now
POST /vendors/me/bookings/:id/cancel              pending | awaiting_payment → cancelled (an offer → declined)
POST /vendors/me/bookings/:id/track               { offeringId } — make it a tracked deal
POST /vendors/me/bookings/:id/approve             delivered → completed
POST /vendors/me/bookings/:id/recheck             re-run the delivery checks
POST /vendors/me/bookings/:id/retry-payout        410 gone
```

- **`amount`** is whole currency units: the creator's price. It's
  optional on a request (a fixed-price package defaults to its price, and
  otherwise the creator names it when accepting).
- **The booking fee** is the brand's commission rate for its plan
  (`booking-fee.ts`: 10% Revshare or no plan, 5% Flex, contract overrides
  honoured), sent as `bookingFeeBps` / `feeRateBps` (basis points, at most
  3,000) on every booking call and in the heartbeat. The Network trusts it
  from hosted vendors only; self-hosted vendors pay the Network's own rate,
  set in the ops console (Fees → Storefront bookings).
- **`authorName` / `authorEmail`** are the signed-in admin. The creator
  sees the name; the email is where the brand's notifications for that
  conversation go, and is never shown to the creator. An API key sends
  neither.
- **Booking statuses:** `pending → awaiting_payment → paid → delivered →
  completed`, plus `declined`, `cancelled` and `refunded`. `accepted`,
  `approved` and `payout_failed` exist only on rows from before.
- **A `Booking` contains:** the creator's public fields (never their
  email), `conversationId`, `proposedBy`, the package snapshot, the
  offering, `amount` / `currency`, `amountMinor` / `feeMinor` /
  `totalMinor` (Stripe's integer form) and `total`, `deliverableUrls`,
  `partnerId` (once tracked), `refundedMinor`, `disputedAt`, the delivery
  checks and the timestamps.
- **Refusals:**
  - `403 vendor_pending_review` (a new booking or conversation needs an
    approved brand; a brand in review may claim, write, pay and approve in
    the conversation its claimed request opened);
  - `403 conversation_blocked` (the creator blocked the brand);
  - `404 creator_not_found`, `404 offering_not_found`;
  - `409 bookings_closed` (the storefront isn't open: bookings off, or the
    creator's Stripe account can't take payments);
  - `409 too_many_open_bookings` (3 in flight per brand and creator);
  - `409 payments_not_ready`, `409 not_awaiting_payment`, `409 already_paid`;
  - `422 amount_too_large`; `429 rate_limited`.
- **A claim** (`token`) continues a public storefront request as this brand
  (routes/booking-claims.ts below). `404 invalid_or_used`, `410 expired`
  and `410 creator_unavailable` say why it can't.

**Tracking** (an `offeringId` on the request, or `track` later)
federates the partnership the same way an approved application does:
`POST /partners` + `POST /partners/:id/links` with the offering's
`programIds` and commission snapshot.

**This repo's side.** The brand portal reaches these routes through admin
proxies in `routes/settings.ts`, which add `authorName` / `authorEmail`
and the fee rate:
- `GET|POST /admin/network/conversations`, `GET /admin/network/conversations/:id`,
  `POST /admin/network/conversations/:id/messages`;
- `GET|POST /admin/network/bookings`, `POST /admin/network/bookings/claim`;
- `POST /admin/network/bookings/:id/{checkout,sync,cancel,track,approve,recheck}`.

Starting a conversation, booking, and tracking sit behind the go-live
gate (`middleware/approval-gate.ts`). Tracking (it adds a partner), and a
booking that names an offering, need an active plan
(`middleware/trial-gate.ts`, `settings.ts`); bookings themselves don't,
because they carry their own fee.

**Public requests become brands.** A request sent from a creator's public
storefront is emailed a link to `PORTAL_URL/booking/confirm?token=`. The
portal reads it through `POST /booking-claims/preview` (this repo), which
calls the Network's `POST /bookings/preview` with the Network admin key. A
new address names its brand and `POST /booking-claims/signup` creates it
(activated, signed in, pending review, no plan), enrols it on the Network
and claims the request. An address that has a brand signs in and lands on
`/admin/network/claim?token=`, which calls the claim proxy.

**Delivery checks** add `deliveryChecks` / `deliveryCheckedAt` on each
Booking and read `GET /partners/:id/timeseries` and
`GET /partners/:id/breakdowns` for clicks since delivery on tracked
bookings.

## Endpoints (Vendor-side, called by Network)

These already exist in this repo, gated by `grantScope(...)`:

| Network use case | Vendor endpoint | Required scope |
|---|---|---|
| Onboard a creator the Network matched | `POST /partners` | `partners:write` |
| Mint a referral link for that creator | `POST /partners/:id/links` | `links:write` |
| Show a creator their accrued earnings | `GET /partners/:id/commissions` | `commissions:read` |
| Chart a creator's activity and earnings | `GET /partners/:id/timeseries` | `partners:read` |
| Pay a creator a Network bounty | `POST /bonuses` | `bonuses:write` |
| Pay a creator an approved storefront booking | `POST /bonuses` | `bonuses:write` |
| Read the bonuses it paid | `GET /bonuses`, `GET /bonuses/:id` | `commissions:read` |
| Clicks since a booking was delivered, by referring site | `GET /partners/:id/timeseries`, `GET /partners/:id/breakdowns?dimension=referer` | `partners:read` |
| Verify the scoped key still works | `GET /auth/introspect` | (any) |

### Bonuses (Network bounties)

A Network bounty (a submission or social-metrics bounty the Network
reviewed) pays the creator through `POST /bonuses` on the brand's instance
([bounties.md](bounties.md) §8), with the creator's partner id, the
offering's `programId`, the amount and currency, a `note` the creator
sees, and `externalRef` = the Network's submission id. Called with the
federation key, the bonus is recorded as `source: "network"` and approved
at once (the Network already reviewed it). A retry with the same
`externalRef` returns the original bonus (`200`, `replayed: true`); the
same ref with a different partner, program, amount or currency is `409
external_ref_conflict`. A brand that hasn't re-authorized its key answers
`403 forbidden_scope` with `required: "bonuses:write"`. The brand's
`bonus.*` webhooks fire, never `commission.*`.

**Storefront bookings no longer pay through bonuses** (openpartner-network
docs/creator-storefront.md §8). The brand pays the creator upfront through
Stripe Checkout on the creator's own account; bookings paid as bonuses
before phase 3 keep their `externalRef: "booking:<bookingId>"`.

**Commission lists and the timeseries include bonuses (Oct 2026).** A
bonus is paid through one commission, so `GET /partners/:id/commissions`
returns it alongside sale commissions, with `source: "bonus"`, a `bonus`
object (`id`, `source`, `note`, `bountyId`, `bountyName`), `bonusId` set and
`attributionId` null: there is no event or click behind it. Sale
commissions say `source: "attribution"` and `bonus: null`. The timeseries
`earnings` include bonus commissions (filtered by the bonus's program when
`programId` is given); `leads`, `sales` and `revenue` stay event-based, so
a bonus never counts as a sale.

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
tenant path (`https://app.openpartner.dev/api/t/<slug>`, the slug after
`/api`; see `instanceUrl` in `apps/api/src/routes/signup.ts`).

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
2. The POST endpoints above.
3. Network → vendor client (already-known shape: scoped key + REST).
4. A vendor-facing dashboard for admins to mint enrollment tokens, see
   live vendors, and prune abandoned ones.
5. A creator-facing surface (search / browse vendors, see own
   affiliations, manage profile) — but that's product, not protocol.

The vendor side of this contract (this repo) will land first so the
Network has a real client to test against.
