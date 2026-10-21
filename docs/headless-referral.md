# Build an in-app referral page

This guide shows you how to run a customer referral program ("Refer & earn") inside your own app. Your customers see their link, stats and earnings on a page you build. They never sign in to OpenPartner. Your backend talks to the OpenPartner API, and the browser only talks to your backend.

The same API also lets you run OpenPartner from your own admin dashboard or storefronts. See [Drive OpenPartner from your own admin](#drive-openpartner-from-your-own-admin).

- **API reference:** `GET /openapi.json` and the rendered `/docs` on every deployment, e.g. `https://app.openpartner.dev/api/docs`. A copy lives in [`docs/openapi.json`](./openapi.json).
- **Runnable sample:** [`examples/in-app-referral`](../examples/in-app-referral) is a dependency-free Node server plus one HTML page that does everything below.
- **Selling through Stripe Payment Links?** See [Stripe Payment Links on OpenPartner Cloud](#stripe-payment-links-on-openpartner-cloud). Lenders and other senders that report by click id: [Lenders, suppliers and affiliate networks](#lenders-suppliers-and-affiliate-networks).

```
 customer's browser                your backend                         OpenPartner
 ──────────────────                ────────────                         ───────────
 Refer & earn page  ── /api/me ──▶ POST /partners (first visit)  ──────▶ partner (active, no email)
                                   POST /partners/{id}/links     ──────▶ share link
                    ◀── link, ──── GET  /partners/{id}/dashboard ──────▶ stats
                        stats      GET  /partners/{id}/commissions
                                   GET  /partners/{id}/payouts

 friend clicks link ─────────────────────────────────────────────────▶ router: click + 302 ?cref=…
 your signup page: SDK captures cref ── POST /attribution/identify ────▶ click ↔ user
                                   POST /attribution/events (signup)  ─▶
 friend pays        ──────────────▶ POST /attribution/events (invoice_paid) ▶ commission
 friend is refunded ──────────────▶ POST /attribution/refunds         ──────▶ commission reversed / reduced
```

## 0. Before you start

### Base URL

Every path in this guide is relative to your tenant's API base:

| Deployment | API base | Share links |
| --- | --- | --- |
| OpenPartner Cloud | `https://app.openpartner.dev/api/t/<tenant-slug>` | `https://app.openpartner.dev/r/<tenant-slug>/<linkKey>` |
| Cloud on a white-label domain | `https://<your-domain>/api` | `https://<your-domain>/r/<linkKey>` |
| Self-hosted | your API origin, e.g. `http://localhost:4601` | `<router origin>/r/<linkKey>` |

The tenant slug goes **after** `/api`. A URL like `https://app.openpartner.dev/t/<slug>/api/...` reaches the static portal, not the API, and answers with HTML. Your slug is the `/t/<slug>/` part of your admin portal's address.

```bash
export OP=https://app.openpartner.dev/api/t/acme     # your API base
export ADMIN=op_...                                  # admin key: setup only
```

### Keys

Use two keys, both server-side only:

- **An admin key** for the one-time setup below (steps 1 and 2). Mint it in the portal, or with `POST /api-keys`. Don't deploy it with your app.
- **A scoped key** for everything your app does at runtime. It can call only what its scopes unlock:

```bash
curl -s -X POST $OP/api-keys/scoped -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"label":"in-app referral","scopes":["partners:create","partners:read","links:write","links:read","commissions:read","payouts:read","events:write"]}'
# → { "id": "...", "plaintext": "op_...", "scopes": [...] }   plaintext is shown once
```

| Scope | Used for |
| --- | --- |
| `partners:create` | `POST /partners` with `sendInvite: false`, and nothing else. It can't send an invite, set commission terms, change, revoke or import partners. |
| `partners:read` | `GET /partners`, `GET /partners/{id}`, `/dashboard`, `/timeseries`, `/events`, `/customers`, `/breakdowns` |
| `links:write` / `links:read` | `POST` / `GET /partners/{id}/links` |
| `commissions:read` | `GET /partners/{id}/commissions` |
| `payouts:read` | `GET /partners/{id}/payouts` |
| `events:write` | `POST /attribution/events`, `POST /attribution/conversions`, `POST /attribution/refunds`, `POST /coupons/redeem` |

**Give the runtime key `partners:create`, not `partners:write`.** `partners:write` is the broad partner scope, meant for admin tools and Zapier-style integrations. Besides creating partners it unlocks:

| With `partners:write` a key can also | Endpoint | Emails the partner? |
| --- | --- | --- |
| Create a partner **with an invite** (the default when `sendInvite` is omitted) | `POST /partners` | Yes, a sign-in link |
| Set a partner's commission terms at creation | `POST /partners` (`commissionSnapshot`, `programCommissions`) | No |
| Send or resend an invite | `POST /partners/{id}/invite` | Yes, a sign-in link |
| Suspend a partner | `POST /partners/{id}/revoke` | Yes, unless `"notify": false` (partners without portal access: only with `"notify": true`) |
| Turn a partner's portal access on or off | `PATCH /partners/{id}` | No |
| Bulk-create partners | `POST /import/partners-csv` | No |
| Mint and retire coupon codes, on programs with `partnersMayCustomizeCode` | `POST` / `DELETE /partners/{id}/coupons` | No |

A `partners:create` key that asks for any of these gets `403 forbidden_scope` with `"required": "partners:write"`. Omitting `sendInvite` counts as asking for an invite, so a forgotten field fails loudly instead of emailing your customers. If your backend needs any of these (say, revoking a customer who closes their account), give that job its own `partners:write` key rather than widening the one your referral page uses.

The full table, generated from the routes, is in the API reference under **Authentication**. A scoped key acts on every partner in your tenant, so **your backend must decide which partner a request is for from its own session, never from a parameter the browser sends.**

## 1. Decide what partners see of OpenPartner

Do both of these before you create the first partner, with the admin key. Each setting is per tenant.

### The partner portal

Every tenant has a hosted partner portal with a sign-in page. A customer who can sign in there sees their dashboard, commissions and links, and a prompt to connect Stripe. In an in-app program your page is their only view, so keep them out:

```bash
curl -s $OP/config/partner-access -H "Authorization: Bearer $ADMIN"
# { "uninvitedPortalAccess": true }

curl -s -X POST $OP/config/partner-access -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"uninvitedPortalAccess": false}'
# { "uninvitedPortalAccess": false }
```

Or use **Admin → Settings → Partner portal access**. From then on, a partner created with `sendInvite: false` and no `portalAccess`, or imported from CSV, has no portal access (step 3 says what that means). Invited partners, and creators the OpenPartner Network provisions, still get the portal. Partners that already exist keep what they have: change them one at a time with `PATCH /partners/{id}`, or on the Partners page. Also send `"portalAccess": false` on each create (step 3), so the setting is a safety net rather than the only guard.

### The OpenPartner Network

**What happens:** a partner's name and email reach the OpenPartner Network only if the partner opts in themselves. `POST /partners` never shares anyone, with or without an invite, and a brand can't opt in for a partner. Your own `metadata` on a partner is never sent. While your tenant offers the Network (`autoEnroll` on: the stored name for "offer the Network to my partners"), partners are asked: a checkbox on the join page, a one-time prompt on their first portal sign-in, and a setting in the portal. Hosted brands start with `autoEnroll: true`.

A customer-referral program usually shouldn't ask customers at all. Check the setting and turn offering off with the admin key:

```bash
curl -s $OP/config/network -H "Authorization: Bearer $ADMIN"
# { "enabled": true, "autoEnroll": true, ... }

curl -s -X POST $OP/config/network -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"autoEnroll": false}'
# { "enabled": true, "autoEnroll": false, ... }
```

Or use **Admin → Network** in the portal and switch off **Offer the Network to your partners**.

- With offering off, partners aren't asked and nothing is sent for anyone, whatever they chose earlier. Partners already on the Network stay there: turning it off doesn't unlink them.
- **Reconnecting to the Network** (the Connect or one-click enroll buttons on Admin → Network) sets `autoEnroll` back to `true`. Check `GET /config/network` after any reconnect.
- **Re-sync** (`POST /config/network/backfill`) sends only partners who opted in, and answers `409 network_not_offered` while offering is off.
- Scoped keys can't read or change this setting. Use the admin key.

## 2. Create a private program

A program holds the terms: commission rule, attribution window, destination URL. Create one for your referral program with the admin key:

```bash
curl -s -X POST $OP/programs -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{
  "name": "Refer & earn",
  "destinationUrl": "https://yourapp.example.com/signup",
  "commissionRule": [
    { "trigger": "every", "eventType": "invoice_paid", "type": "percent", "value": 20, "recurring": true, "recurringMonths": 12 }
  ],
  "attributionWindowDays": 90,
  "holdbackDays": 30,
  "shareOnNetwork": false
}'
# → { "id": "01J...", ... }    keep this as PROGRAM_ID
```

- **`shareOnNetwork: false`** keeps the program off the public marketplace. When the tenant is on the Network it defaults to `true`, and then a `marketplaceDescription` is required.
- **`destinationUrl`** is where share links land. The router appends `?cref=<click id>`.
- **`attributionWindowDays`** decides which click wins a customer's first payment. Renewals then stay with that partner for as long as the customer pays (`renewalsStayWithPartner`, default `true`). Past the window only `recurring` rules pay, so this one pays 20% for 12 months from the first invoice. See [renewal-attribution.md](renewal-attribution.md).
- **`holdbackDays`** above 0 means a commission is **approved automatically** once it's that many days old, and paid by the next payout run. Set it to your refund window so refunds land before approval (step 8). With `0` or no holdback, nothing is approved until you call `POST /commissions/{id}/approve`. Use that if you want to review every commission.
- **Rules** are an array of sub-rules, each with `trigger` (`every` / `first` / `subsequent`), an optional `eventType`, and a `percent` or `fixed` amount. Scope each rule to an event type: a `fixed` rule with no `eventType` pays on every event, signups included.

- **Slabs.** A sub-rule can pay more on bigger orders (`bands`: thresholds on the event's value) or as the partner grows (`tiers`: thresholds on their own revenue or conversions over a window). See `CommissionBands` and `CommissionTiers` in the API reference.
- **One partner's own terms.** `PUT /partners/{id}/commission-snapshot` (admin key) overrides the rule on all of that partner's programs; `PUT /partners/{id}/programs/{programId}/commission` overrides it on one program, and wins there.

## 3. Create a partner for each customer

When a customer first opens your referral page, create their partner record from your backend with the scoped key:

```bash
curl -s -X POST $OP/partners -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "email": "ada@example.com",
  "name": "Ada Lovelace",
  "sendInvite": false,
  "portalAccess": false,
  "programIds": ["'$PROGRAM_ID'"],
  "metadata": { "appUserId": "user_123" }
}'
# 201 → { "id": "01J...", "activatedAt": "2026-10-16T...", "invited": false, "portalAccess": false, ... }
```

- **`sendInvite: false`** makes the partner active immediately, and OpenPartner sends no email. A `partners:create` key must send it: leave it out and the call answers `403 forbidden_scope`.
- **`portalAccess: false`** keeps the customer out of the hosted partner portal (see **Portal access** below). Omitted, it follows the tenant setting from step 1.
- **Always pass `programIds`.** If you omit it, the partner is granted every program in the tenant. A coupon code is auto-minted for each granted program.
- **Store the returned `id` on your user record.** On later page views, use it directly.
- **`email` is unique per tenant.** A second create answers `409 email_taken`. Look the partner up with `GET /partners?email=ada@example.com` and **check its `metadata.appUserId` is this user before linking it**. If it isn't, the address belongs to someone else (another user, or a partner in another program), so don't link it. Only use email addresses your app has verified. The same lookup covers two first visits racing each other.
- `metadata` is free-form JSON, returned on reads. Put your own ids there: your user id, your CRM record id.
- On OpenPartner Cloud, creating partners needs an active plan (`402 plan_required`) and an approved brand (`403 brand_pending_review`).

**Existing customers in bulk.** To give every current customer a referral account up front, use `POST /import/partners-csv` with the admin key instead of one call per customer: `text/csv` with `email,name,metadata` columns, `?dryRun=true` first. It sends no email, fires no webhooks, never pushes to the Network, gives every partner the tenant's portal-access setting from step 1 (so turn that off first), and skips emails that already exist, so re-running it is safe. Unlike `POST /partners` it grants **every** program in the tenant and mints no coupons, so run it while the referral program is your only program. Send large rosters in batches of a few thousand rows. You can also skip the import and create partners lazily on first visit, as above.

**Portal access.** A partner without portal access (`portalAccess: false`) can't use the hosted partner portal at all:
- The portal's sign-in form (`POST /auth/signin`) sends them nothing. It answers `{"ok": true}`, exactly as it does for an address it doesn't know, so it can't be used to find out who your customers are.
- Sign-in links don't work for them, and any portal session they had ends.
- OpenPartner can't invite them: `POST /partners/{id}/invite` answers `409 portal_access_disabled`.
- Partner API keys (`POST /partners/{id}/api-keys`) keep working: they're API credentials, not portal access. That includes any key the partner minted in the portal while they had access, so revoke those with `DELETE /api-keys/{id}` when you turn access off.

Turn it on or off for one partner with `PATCH /partners/{id}` and `{"portalAccess": false}` (admin key or `partners:write`), or with the Portal column on Admin → Partners. Turning it off signs them out at once. Turning it on sends nothing; they can then request a link on the sign-in page.

A partner **with** portal access and `sendInvite: false` is active, so anyone who knows their email can make the sign-in form email them a link, and they can then use the portal. Before `portalAccess` existed that was the only behaviour, and it's still the default for a tenant that hasn't changed the setting in step 1.

**Email.** OpenPartner emails a partner without portal access only when you ask it to:
- `POST /partners/{id}/revoke` notifies them only with `"notify": true`. (A partner with portal access is notified unless you pass `"notify": false`.)
- The "program ending soon" email, sent seven days before a program's `endsAt`, links into the portal, so it skips them. Partners with portal access get it: leave `endsAt` unset on an evergreen referral program.

**Webhooks.** Creating a partner fires `partner.created` and then, because a `sendInvite: false` partner is active at once, `partner.activated` with `"invited": false`. Both carry `"source": "api"`. An invited partner fires `partner.activated` with `"invited": true` when they accept. Partners who apply on your join page fire the same events with `"source": "join_page"`. If you approve applicants automatically, they are active at once too, so they also arrive with `"invited": false`. If a Zapier flow or CRM workflow greets new partners on `partner.activated`, skip events with `"source": "api"` and `"invited": false` so your in-app customers don't get a partner-program welcome. A headless program that doesn't want applicants can turn off **Accept public applications** on Admin → Settings.

**Privacy.** OpenPartner stores the name and email you send, and nothing else about the customer. If you'd rather not share real addresses, any unique address works for a headless partner, for example `user_123@referrals.yourapp.invalid`. Such an address can never receive OpenPartner email, whatever the partner's settings. Then the `metadata.appUserId` check above is how you match records; the email no longer does it.

## 4. Create their share link

```bash
curl -s -X POST $OP/partners/$PARTNER_ID/links -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"linkKey":"ada-7f3a","programId":"'$PROGRAM_ID'"}'
# 201 → { "id": "...", "linkKey": "ada-7f3a", "programId": "...", ... }
```

- `linkKey` is the short code in the URL: 3–64 characters from `A–Z a–z 0–9 _ -`, unique in your tenant. On `409 linkKey_taken`, retry with a different suffix.
- The share URL is built from your router base, it isn't returned: `https://app.openpartner.dev/r/<tenant-slug>/ada-7f3a` on Cloud.
- `GET /partners/{id}/links` lists existing links, so you can reuse one instead of creating another.

## 5. Show stats, earnings and payouts

All of these work with the scoped key:

| Call | Gives you |
| --- | --- |
| `GET /partners/{id}/dashboard?since=<iso>` | `clicks`, `attributedEvents`, `attributedRevenue` and `commissionByStatus` (`accrued` / `approved` / `paid` / `reversed` totals) in `currency`, your default currency. `attributedRevenueByCurrency` and `commissionByCurrency` hold every currency. Defaults to the last 30 days. |
| `GET /partners/{id}/timeseries?since=&until=&programId=` | Dense daily (or weekly) buckets: `clicks`, `leads` (`signup` + `trial_started`), `sales` (events with a value), `revenue`, `earnings`. |
| `GET /partners/{id}/events?limit=&offset=` | Each attributed event, with the click it came through. |
| `GET /partners/{id}/commissions?limit=&cursor=&status=` | The commission ledger, newest first, cursor-paginated. Each row has `amount`, `status` and `matureAt` (when the holdback ends). |
| `GET /partners/{id}/payouts` | Up to the 200 most recent payouts. |

What to show:

- **Pending earnings:** commissions with status `accrued` or `approved`.
- **Processing:** commissions with status `paid` whose payout is still `pending`. On the manual rail (below), commissions become `paid` as soon as the payout is planned, before any money moves.
- **Paid out:** payouts with status `paid`. Only these are money that actually went out.

Amounts in different currencies are never added together. `commissionByStatus` is in `currency` (your default currency, Settings → Brand info) and `commissionByCurrency` has the rest. Both only cover commissions accrued since `since` (default 30 days), so neither is a lifetime total. For lifetime figures, page through `/commissions`. With nothing to show, format the zero in `currency`, not in dollars.

- Commission and payout amounts are decimal strings such as `"9.80"`. Report endpoints (dashboard, timeseries, the events list) return numbers.
- `GET /partners/{id}/funnel` (click → identity → signup → paid) does **not** accept scoped keys yet. Call it with an admin key from your server, or build the same counts from `/timeseries`. *TODO: a scoped read for `/funnel` and `/coupons` isn't built yet.*
- **Cache these responses.** All API calls from one IP share a limit of **600 requests per 5 minutes**, and your backend calls from one IP, so this is the budget for your whole integration, event ingest included. At four calls per page view, that's about 150 uncached views per 5 minutes. Cache each user's stats for several minutes. Don't give users a button that bypasses the cache. On a `429 rate_limited` response, serve the cached copy. The response carries `RateLimit` headers.

### How headless partners get paid

A headless partner has no Stripe Connect account, so its payouts use the **manual rail**. The scheduled payout run (weekly by default), or `POST /payouts/run`, groups approved commissions into a `manual` Payout. The Payout is `pending`, its commissions are marked `paid`, and `payout.created` and `commission.paid` fire. **No money has moved yet.** You pay the customer yourself, as account credit, a bank transfer or a gift card, then call `POST /payouts/{id}/confirm`, and the Payout becomes `paid`. Set the tenant's payout cadence to **Manual** (Admin → Settings) if you'd rather run payouts only yourself.

## 6. Capture the click in the browser

When someone follows a share link, the router records the click and redirects to your `destinationUrl` with `?cref=<click id>` appended. On your landing and signup pages, load the browser SDK. It stores the `cref` in `localStorage`, so the referral survives across page loads and later visits:

```ts
import { OpenPartner } from '@openpartner/sdk';

const op = OpenPartner.init({ apiUrl: 'https://app.openpartner.dev/api/t/acme' }); // your API base

// Right after signup (see the note below about calling it on login):
await op.identify(user.id);
```

`identify()` calls `POST /attribution/identify`, which needs no API key and accepts any origin, so the SDK can call it from your site. It links the click to your user id, and attributes any events you already recorded for that user. Repeat calls for the same pair do nothing. Use the same `userId` everywhere: your stable internal id, not an email address.

Calling it after login as well as signup stitches a customer who clicked on one device and signed up on another. A later stitch only attributes events that haven't attributed yet: an event that already credited a partner keeps that credit, so calling `identify()` on every login can't pay twice.

Where capture can lose a referral:
- **`localStorage` is per origin.** If the link lands on `www.example.com` and signup happens on `app.example.com`, the signup page can't see the stored `cref`. Point `destinationUrl` at the origin where signup happens, or pass the `cref` along yourself.
- **The router's `_cref` cookie isn't yours.** On OpenPartner Cloud it's set on the router's domain, so your site can't read it. The `?cref=` parameter on the landing URL is what counts.
- **Safari may clear storage** that scripts wrote, after about seven days without a visit. For long gaps between click and signup, also save the `cref` on your side when you first see it, in a first-party cookie your server sets or on an anonymous visitor record.

If you'd rather keep all OpenPartner calls on your server, read `op.getReferral()` in the browser, send it with your signup form, and call identify from your backend instead. Two cautions. From your server, every stitch counts against your backend IP's identify limit (120 per minute). And a failed stitch must never fail the signup: log it and move on.

```bash
curl -s -X POST $OP/attribution/identify -H 'content-type: application/json' \
  -d '{"cref":"01J9Z...","userId":"user_456"}'
```

## 7. Report conversions from your server

> **Bill with Stripe? Connect it instead.** On OpenPartner Cloud, **Admin → Integrations → Connect Stripe** installs the OpenPartner Stripe App on your own Stripe account ([stripe-app.md](stripe-app.md)). Your Checkout and Payment Link purchases, invoices, refunds and disputes are then recorded from Stripe directly: no forwarding conversions, no reporting invoices. What's left is getting the partner click into Stripe once. Integrations asks how you take payment and shows just that step:
> - **A partner link straight to a Payment Link:** no code. Put `?client_reference_id={click_id}` on the program's destination URL.
> - **Payment Links, a Pricing Table or a Buy Button on your site:** one script tag, `<script src="<your portal>/op.js" data-api-url="…">`. It adds the click to them on its own.
> - **Your app creates the Checkout Session:** the same tag, plus `client_reference_id: req.cookies.op_ref` where you create the session.
> - **Partner promo codes at Stripe Checkout:** no code, when the program offers a customer discount.
> - **Stripe Billing customers you create yourself:** set `metadata.openpartner_user_id` on the Customer to the same `userId` you pass to `identify()`.
>
> Partner codes with a customer discount get their Stripe promotion code created for you, and a code entered at Stripe Checkout attributes without `POST /coupons/redeem`. Once connected, a conversion forwarded under a Stripe invoice or Checkout Session id (`in_…`, `cs_…`) returns `409 recorded_from_stripe`: Stripe's record of the payment wins. Keep using the calls below for anything that isn't a Stripe payment: signups, CRM stages, payments taken elsewhere.

Report each conversion with `POST /attribution/events` and the scoped key:

```bash
# At signup:
curl -s -X POST $OP/attribution/events -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"userId":"user_456","type":"signup","externalEventId":"signup:user_456"}'

# Each payment:
curl -s -X POST $OP/attribution/events -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"userId":"user_456","type":"invoice_paid","value":49.00,"currency":"USD","externalEventId":"in_1001"}'
# → { "ok": true, "eventId": "...", "attribution": { "status": "attributed", "touches": [...] } }
```

Or use the server SDK, `@openpartner/sdk/server`: `await op.trackEvent({ userId, type: 'invoice_paid', value: 49, currency: 'USD', externalEventId: invoice.id })`.

**Report payments as `invoice_paid`.** It's the only "paid" stage in the funnel, and on OpenPartner Cloud it counts toward billable GMV, as does `subscription_created`. Report each payment once: sending both `subscription_created` and `invoice_paid` with a value for the same charge counts it twice. Likewise, on a self-host whose Stripe account already sends webhooks to `/webhooks/stripe`, those payments are recorded automatically, keyed by the Stripe event id. Reporting them here too, under your invoice id, pays twice. (On Cloud with Stripe connected, that same report is refused with `409 recorded_from_stripe` instead.) That self-host webhook keys a one-time Checkout's payment on its Checkout Session id, so session ids are reserved for it: a `cs_…` key sent here, to `/attribution/conversions` or to `/coupons/redeem` returns `409 recorded_from_stripe`. Key a signup or coupon redemption for that checkout on your own order id, and redeem a code when the customer applies it, before they pay.

| Type | Meaning in OpenPartner |
| --- | --- |
| `signup` | The funnel's *signups* stage. A *lead* in the timeseries. |
| `trial_started` | Counts toward the funnel's *signups*. A *lead* in the timeseries. |
| `invoice_paid` | The funnel's *paid* stage (and counts toward *signups*). Billable GMV on Cloud. Use for every payment. |
| `subscription_created` | Counts toward the funnel's *signups*. Billable GMV on Cloud. |
| anything else (`demo_booked`, `lead_qualified`, ...) | Recorded, and commissionable if a rule names it. Not in the funnel or lead counts, and not GMV. |

For example, if you track clicks, signups, leads, demos and paid customers: clicks come from the router, signups are `signup`, payments are `invoice_paid`, and leads and demos are custom types. To pay a flat bounty for a booked demo, add a sub-rule such as `{ "trigger": "first", "eventType": "demo_booked", "type": "fixed", "value": 10 }`.

- **Always send `externalEventId`.** Use your own stable id for that one event: invoice id, order id, or deal id plus stage. A retry with the same key returns `200` with `"replayed": true` and records nothing, even for duplicates that arrive at the same moment. Reusing a key for a different event returns `409 external_event_id_conflict`. Keys are per tenant and up to 120 characters.
- `value` is a JSON number in major units: `49.00`, not `4900` and not `"49.00"`. Omit it for an event with no value; `null` gets `400 invalid_body`.
- `currency` is an ISO 4217 code in any case (`inr` is stored as `INR`). Without one, the event is recorded in your **default currency** (Admin → Settings → Brand info), which is USD until you change it. Set it before your first payment, and send `currency` anyway whenever you take more than one currency.
- A `ts` you send must be UTC and end in `Z` (`2026-10-16T10:00:00Z`). An offset like `+00:00`, the default from Python's `isoformat()`, gets `400 invalid_body`. Omit `ts` to use the time OpenPartner receives the event.
- Send events from a job queue, not inline in your request handler. On `429`, or on a network error, retry later with the same `externalEventId`.
- An event for a user with no stitched click returns `"status": "no_identity"` and is kept. If the user is stitched later, earlier events are attributed then (`backfilledAttributions` on the identify response).
- **Refunds** go to `POST /attribution/refunds` (step 8). This endpoint doesn't take negative values, and a `refund` or `chargeback` event sent here is recorded but reverses nothing (`"status": "corrective"`). With Stripe connected, a refund in Stripe is applied for you. A holdback as long as your refund window means most refunds land before anything is approved.

## 8. Report refunds and chargebacks

When you refund a payment, in full or in part, or lose a chargeback, report it with `POST /attribution/refunds` and the same scoped key (`events:write`). Point at the conversion by the `externalEventId` you reported it with:

```bash
# Part of a payment (amount in major units):
curl -s -X POST $OP/attribution/refunds -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"conversionExternalEventId":"in_1001","amount":19.00,"reason":"downgraded","externalEventId":"re_2001"}'
# → { "ok": true, "fullRefund": false, "refundedAmount": "19.00", "actionRequired": false,
#     "commissions": [ { "commissionId": "...", "originalAmount": "9.80", "keptAmount": "6.00",
#                        "status": "reduced", "currentCommissionId": "...", ... } ] }

# All of it, or whatever is left (no amount). A lost chargeback is "kind": "chargeback":
curl -s -X POST $OP/attribution/refunds -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"conversionExternalEventId":"in_1001","kind":"chargeback","externalEventId":"dp_3001"}'
```

Or send `conversionEventId`, the `eventId` OpenPartner returned for the conversion. Exactly one of the two. The refund is recorded as its own event, with a negative value. It's never attributed, and it never counts as GMV.

What happens to the conversion's commissions. Each one ends up worth its original amount times the share of the payment the customer kept:

| Commission was | What happens | `status` in the response |
| --- | --- | --- |
| `accrued` or `approved` | Reversed (`commission.reversed`, `reason: "refund"` or `"chargeback"`, plus the partner's postback). On a partial refund, a replacement commission for the kept amount follows (`commission.accrued` with `replacesCommissionId`). It keeps the original's status and accrual date, so its holdback doesn't restart. | `reversed`, or `reduced` with `currentCommissionId` |
| `paid` | Stays paid: the partner has the money. A negative adjustment records what they hold for refunded revenue. OpenPartner deducts it from the partner's next manual or self-hosted Stripe Connect payout (a partner who owes more than they are due isn't paid until enough accrues). Funded Stripe Connect payouts on hosted OpenPartner don't deduct it: recover those yourself. | `clawback_recorded`, with `clawbackAmount` |
| In a payout right now | Nothing changes. Retry the same request, with the same `externalEventId`, once the payout settles. | `held_in_transfer` |

`actionRequired: true` means at least one commission is `clawback_recorded` or `held_in_transfer`.

- **Partial refunds add up.** Refunds of 30 and then 20 on a 100 payment leave each commission at 50% of its original amount. A refund larger than what's left gets `422 refund_exceeds_remaining`, with `remaining`. Once nothing is left, `422 nothing_to_refund`.
- The share applies to every commission on the conversion, a `fixed` bounty included: refunding 30% of an order takes 30% of its bounty.
- A conversion with no `value` (a signup) can only be refunded in full. Sending an `amount` gets `422 partial_refund_needs_value`.
- **Idempotency.** `externalEventId` is required: your refund or credit-note id. A retry with the same key returns `200` with `"replayed": true` and records nothing new. Reusing it for a different conversion, kind or amount gets `409 external_event_id_conflict`. Keys share the namespace of step 7.
- **Report a chargeback once it's final**, not when the dispute opens: it reverses commissions just as a refund does.
- Refunds of payments recorded from Stripe (the self-host Stripe webhook, or the Stripe App on OpenPartner Cloud) are handled from Stripe's `charge.refunded` already. Don't report those here too. A dispute from Stripe is recorded but reverses nothing, and OpenPartner doesn't read its outcome, so report a lost one here as a chargeback.
- If the refund arrives before the customer's click is stitched, it's kept. When identify later attributes the payment, its new commissions are cut by the refund straight away.
- A holdback as long as your refund window (step 2) still helps: refunds inside it reverse unpaid commissions, rather than leaving a clawback to collect.

## 9. Get webhooks in your backend

Subscribe an endpoint (admin key, or a scoped key with `webhooks:write`, which can only subscribe and unsubscribe; listing, testing and redelivering need the admin key):

```bash
curl -s -X POST $OP/webhooks -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"url":"https://yourapp.example.com/hooks/openpartner","events":["commission.accrued","commission.approved","commission.paid","commission.reversed","payout.created"]}'
# → { "endpoint": {...}, "secret": "whsec_..." }   the secret is shown once
```

OpenPartner stores the secret encrypted and never shows it again. If you lose it, or it leaks, rotate it (admin key): `POST $OP/webhooks/{id}/secret` returns a new one, once. The old secret stops working immediately, so deliveries fail until your receiver has the new one; redeliver those from the endpoint's delivery log.

Events: `attribution.created`, `commission.accrued`, `commission.approved`, `commission.paid`, `commission.reversed`, `partner.created`, `partner.activated`, `partnership.approved`, `payout.created`, or `*` for all. Payload schemas are under **Webhook events** in the API reference. Every `POST /partners` with `sendInvite: false` fires both `partner.created` and `partner.activated` (`"invited": false`, `"source": "api"`); see step 3.

Each delivery is `POST {id, event, created, data}`, signed with HMAC-SHA256 over `<X-OpenPartner-Timestamp>.<raw body>`, keyed with the whole `whsec_…` secret:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the request body as received, before any JSON parsing.
function verifyOpenPartner(rawBody, headers, secret) {
  const ts = headers['x-openpartner-timestamp'];
  const sig = headers['x-openpartner-signature'] ?? '';
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex'));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

- **Dedupe on the envelope `id`** (also sent as `X-OpenPartner-Delivery`). A resend carries the same `id`.
- **No automatic retries.** A non-2xx answer, a redirect, or no answer within 10 seconds marks a delivery failed. Find failures with `GET /webhooks/{id}/deliveries` and resend with `POST /webhooks/{id}/deliveries/{deliveryId}/retry`.
- Treat webhooks as a nudge to refresh. The API is the record: on `commission.*`, re-read the partner's dashboard rather than adding the webhook's amount to a running total.
- `POST /webhooks/{id}/test?event=commission.accrued` sends a signed sample with the real payload shape.
- A partial refund (step 8) arrives as `commission.reversed` with `replacementCommissionId`, then `commission.accrued` for that replacement with `replacesCommissionId`. Re-reading the dashboard handles it: the reversed original drops out and the replacement counts.

## 10. CRM recipe: Zoho CRM or HubSpot

### Deal stage → conversion event

When a deal reaches a stage you pay on, send it to `POST /attribution/events`. The CRM record must carry the same `userId` your app passed to `identify()`, so sync your app's user id into a custom field on the contact or deal. Use a scoped key with only `events:write`.

The request:

```http
POST https://app.openpartner.dev/api/t/acme/attribution/events
Authorization: Bearer op_<events:write key>
Content-Type: application/json

{ "userId": "<App User ID field>", "type": "invoice_paid", "value": <Amount>, "currency": "<Currency field, e.g. INR>",
  "externalEventId": "crm:<deal id>:closed_won" }
```

- `value` must be a JSON **number**. A quoted merge field (`"value": "25000"`) and an empty one (`null`) are both refused with `400`. Leave `value` out of the body rather than send it empty.
- Always send `currency`. Without it the payment is recorded in your default currency, which is USD unless you changed it, so a ₹25,000 deal sent without a currency becomes USD 25,000.

- **Zoho CRM:** create a Workflow Rule on Deals (for example, Stage is Closed Won) with a Webhook action: method POST, the URL above, the `Authorization` and `Content-Type` headers, and a JSON body built from merge fields. If your edition can't send a raw JSON body, use a Deluge function action instead, with the deal id as its argument and the key in an org variable or connection rather than the code:

  ```
  deal = zoho.crm.getRecordById("Deals", dealId);
  payload = Map();
  payload.put("userId", deal.get("App_User_ID"));
  payload.put("type", "invoice_paid");
  amount = deal.get("Amount");
  if(amount != null)
  {
    // A number, never a string or null.
    payload.put("value", amount.toDecimal());
  }
  // The deal's currency when multi-currency is on, else your home currency.
  payload.put("currency", ifnull(deal.get("Currency"), "INR"));
  payload.put("externalEventId", "zoho:" + deal.get("id") + ":closed_won");
  response = invokeurl
  [
    url: "https://app.openpartner.dev/api/t/acme/attribution/events"
    type: POST
    parameters: payload.toString()
    headers: {"Authorization": "Bearer " + openpartnerKey, "Content-Type": "application/json"}
  ];
  ```

- **HubSpot:** a workflow's custom code action (plan-dependent) can make the call, with the key stored as a secret:

  ```js
  exports.main = async (event, callback) => {
    const { app_user_id, amount, deal_currency_code, hs_object_id } = event.inputFields;
    const res = await fetch('https://app.openpartner.dev/api/t/acme/attribution/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENPARTNER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: app_user_id,
        type: 'invoice_paid',
        // A number; leave it out when the deal has no amount.
        ...(amount ? { value: Number(amount) } : {}),
        currency: deal_currency_code,
        externalEventId: `hubspot:${hs_object_id}:closedwon`,
      }),
    });
    callback({ outputFields: { openpartnerStatus: res.status } });
  };
  ```

  Without custom code, point HubSpot's "Send a webhook" action at a small relay of your own that reshapes the body.

CRM workflows retry, and a deal can be moved back and forth. Because the `externalEventId` is the deal id plus the stage, each paid stage is counted once.

### Deal refunded → refund

When the CRM records a refund, a credit note or a lost deal after payment, send it to `POST /attribution/refunds` with the same `events:write` key. Reference the conversion by the `externalEventId` you sent from the deal-stage workflow above, so build it the same way:

```http
POST https://app.openpartner.dev/api/t/acme/attribution/refunds
Authorization: Bearer op_<events:write key>
Content-Type: application/json

{ "conversionExternalEventId": "crm:<deal id>:closed_won", "amount": <Refunded amount>,
  "reason": "<Refund reason>", "externalEventId": "crm:<deal id>:refund:<refund or credit note id>" }
```

Leave `amount` out to refund the whole deal. Send `"kind": "chargeback"` for a lost chargeback.

- **Zoho CRM:** a second Workflow Rule, for example on Deals when Stage changes to Refunded, or on Credit Notes if you use Zoho Books, with a Deluge function like the one above:

  ```
  deal = zoho.crm.getRecordById("Deals", dealId);
  payload = Map();
  payload.put("conversionExternalEventId", "zoho:" + deal.get("id") + ":closed_won");
  payload.put("amount", deal.get("Refunded_Amount"));
  payload.put("reason", deal.get("Refund_Reason"));
  payload.put("externalEventId", "zoho:" + deal.get("id") + ":refund:" + deal.get("Refund_ID"));
  response = invokeurl
  [
    url: "https://app.openpartner.dev/api/t/acme/attribution/refunds"
    type: POST
    parameters: payload.toString()
    headers: {"Authorization": "Bearer " + openpartnerKey, "Content-Type": "application/json"}
  ];
  ```

- **HubSpot:** a workflow on the deal's refund property (or a deal stage such as Refunded) with a custom code action:

  ```js
  exports.main = async (event, callback) => {
    const { hs_object_id, refund_amount, refund_id } = event.inputFields;
    const res = await fetch('https://app.openpartner.dev/api/t/acme/attribution/refunds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENPARTNER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversionExternalEventId: `hubspot:${hs_object_id}:closedwon`,
        ...(refund_amount ? { amount: Number(refund_amount) } : {}),
        externalEventId: `hubspot:${hs_object_id}:refund:${refund_id}`,
      }),
    });
    const body = await res.json();
    callback({ outputFields: { openpartnerStatus: res.status, openpartnerActionRequired: String(body.actionRequired ?? '') } });
  };
  ```

Key the refund on its own id (refund or credit note), not only on the deal. Two refunds of one deal are then two refunds, while the workflow's own retries of one refund are replays. If `actionRequired` comes back `true`, flag the deal for someone: the partner was already paid (`clawback_recorded`; deducted from their next payout unless it's a funded hosted Stripe Connect payout), or a payout was in flight (`held_in_transfer`; re-run the workflow later).

### Webhooks → CRM fields

CRMs can't check an HMAC signature themselves, so put a small relay in between. It verifies the signature (section 9), maps `data.partnerId` to the CRM record, and writes absolute values read back from the API:

```js
// On any commission.* or payout.created webhook (signature verified),
// and right after your own POST /payouts/{id}/confirm:
const { partnerId } = envelope.data;
const partner = await op('GET', `/partners/${partnerId}`);          // metadata.crmContactId, set at creation
const [dash, { payouts }] = await Promise.all([
  op('GET', `/partners/${partnerId}/dashboard?since=2020-01-01T00:00:00Z`),
  op('GET', `/partners/${partnerId}/payouts`),
]);
const cur = dash.currency;                                           // your default currency
const owed = dash.commissionByCurrency[cur] ?? {};
const payoutTotal = (status) =>
  payouts.filter((p) => p.status === status && p.currency === cur).reduce((n, p) => n + Number(p.amount), 0);
await crm.updateContact(partner.metadata.crmContactId, {
  referral_earnings_pending: (owed.accrued ?? 0) + (owed.approved ?? 0),
  referral_earnings_processing: payoutTotal('pending'),             // planned, not sent yet
  referral_earnings_paid: payoutTotal('paid'),                      // money that went out
  referral_currency: cur,
  referral_clicks: dash.clicks,
});
```

"Paid" comes from **payouts** with status `paid`, not from commissions with status `paid`. On the manual rail, a commission turns `paid` when its payout is planned, before you've sent anything (see [How headless partners get paid](#how-headless-partners-get-paid)). The payout turns `paid` only when you confirm it, and no webhook fires for that, so refresh the record from the code that confirms. `/payouts` returns the 200 most recent, which is plenty for one customer's referral earnings. If a partner can earn in more than one currency, write one field per currency, or one line per currency, from `commissionByCurrency` and each payout's `currency`.

Writing totals rather than adding each webhook's amount means a duplicate, missed or out-of-order delivery can't skew the field. The next event corrects it. Store the CRM record id in the partner's `metadata` when you create it (step 3); metadata stays in your tenant, even for a partner who joins the Network. For HubSpot, the update is `PATCH /crm/v3/objects/contacts/{id}`; for Zoho, `PUT /crm/v6/Contacts/{id}` or an upsert. See their API docs for auth.

## Stripe Payment Links on OpenPartner Cloud

A Stripe Payment Link takes the buyer straight to Stripe, so no page of yours runs the SDK, and on OpenPartner Cloud Stripe's webhooks go to your Stripe account, not to OpenPartner. The click id reaches Stripe in the link, comes back to you in Stripe's webhook, and you report it with one call. (A single-tenant self-host whose Stripe webhook points at `/webhooks/stripe` does this itself.)

A runnable version of steps 2 and 3 is [`examples/stripe-payment-link-forwarder`](../examples/stripe-payment-link-forwarder): about 50 lines of Node, no dependencies.

> If **Admin → Integrations** offers **Connect Stripe**, use that instead of steps 2 and 3. OpenPartner then reads the checkout from your Stripe account itself. While the connection is healthy, a forwarded session id answers `409 recorded_from_stripe`, so a forwarder left running records nothing twice. Step 1 is still needed.

**1. Send the click id to Stripe.** Set the program's destination to the Payment Link with the `{click_id}` macro in `client_reference_id`, written exactly like this:

```
https://buy.stripe.com/<link>?client_reference_id={click_id}
```

The router replaces `{click_id}` with the click id (26 letters and digits) and appends no `cref`. Stripe reads the referral only from `client_reference_id`, and silently drops a value with anything but letters, digits, `-` and `_`. So OpenPartner refuses any other brace text when you save: `{{click_id}}` (Zapier and Make syntax), `{ click_id }`, `{CLICK_ID}`, `{subid}`. A `buy.stripe.com` destination without the macro saves, with a warning (`warnings` in the API response, a note under the field in the portal), because no purchase through it can be credited.

**2. Forward the paid checkout.** In Stripe, add a webhook endpoint on your server, subscribed to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. For each event:

1. Verify Stripe's signature on the raw request body (`Stripe-Signature`, your endpoint's `whsec_` secret) before you trust anything in it.
2. Skip the session unless it has a `client_reference_id` (it came through a partner link) and `payment_status` is `"paid"`. A bank debit is `unpaid` at `checkout.session.completed`; `checkout.session.async_payment_succeeded` reports it when it clears.
3. Report it:

```bash
curl -s -X POST $OP/attribution/conversions -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"clickId":"<session.client_reference_id>","type":"invoice_paid","value":49.00,"currency":"USD","externalEventId":"<session.id>"}'
# → { "ok": true, "outcome": "attributed", "attribution": { "status": "attributed", "commission": "accrued", ... } }
```

- `value` is `amount_total` in major units: divide by 100, except zero-decimal currencies such as JPY and KRW, where the amount is already whole units (and three-decimal ones such as KWD, divided by 1000). UGX and ISK are on Stripe's special-cases list: whole units, but sent with two decimals, so divide them by 100 too (5 UGX is `500`). `currency` is Stripe's, upper-cased.
- `externalEventId` is the session id (`cs_…`). Both checkout events and every Stripe retry then record the purchase once.
- The key needs only `events:write`.

**3. Answer Stripe.** Stripe retries anything but a `2xx` for up to three days.
- `200`: recorded. A `200` with `"replayed": true` is a retry of one you already sent. Answer `2xx`.
- `404 click_not_found`, `409 external_event_id_conflict`, `422 click_flagged`: no retry changes these. Log them and answer `2xx`.
- `429`, `5xx` or a network error: answer `5xx`, so Stripe tries again later. Do the same on `401`/`403` if you'd rather Stripe kept retrying while you fix the key.

**4. Check what it came to.** A `200` means recorded, not paid. `outcome` says whether a partner was credited: `attributed`; `no_matching_rule` (the program has no rule for `invoice_paid`); `not_attributed` with `reason: "outside_window"` (the click is older than the program's attribution window). Log anything but `attributed`. Types that matched no rule also show on **Admin → Integrations**.

**Subscriptions.** A subscription checkout's `amount_total` is its first invoice, and Stripe also sends `invoice.paid` for that invoice (`billing_reason: "subscription_create"`). Don't forward that one too: it's the same payment, and it would count twice. To credit renewals:
- At checkout, store `session.customer` against the click id (`client_reference_id`) on your side.
- On later `invoice.paid` events for that customer (`billing_reason` is `subscription_cycle`, or `subscription_update` for a mid-cycle change), report `{clickId, type: "invoice_paid", value: amount_paid / 100, currency, externalEventId: invoice.id}`.
- A checkout with a free trial is `payment_status: "no_payment_required"`, so step 2 skips it. Store the customer anyway: the first charge after the trial is a `subscription_cycle` invoice.
- Renewals stay with the partner who won the customer for as long as they pay, past the program's attribution window (`renewalsStayWithPartner`, on by default). Report every renewal under the same click id: that's how OpenPartner knows it's the same customer. Once the click is older than the window, only `recurring` commission rules pay, so under a one-off rule a renewal answers `attributed` / `no_commission`. With `renewalsStayWithPartner` off, a renewal outside the window is `not_attributed` / `outside_window`. See [renewal-attribution.md](renewal-attribution.md).

**Refunds.** If your deployment's API reference lists `POST /attribution/refunds`, report each Stripe refund there with the same key: `conversionExternalEventId` is the session id you sent as `externalEventId` (find the session from the refund's `payment_intent` with Stripe's `GET /v1/checkout/sessions?payment_intent=pi_…`), `amount` the refunded amount in major units (leave it out for a full refund), and `externalEventId` the Stripe refund id (`re_…`). Otherwise, reverse the commission with `POST /commissions/{id}/reverse` (admin key), or from the **Review queue** in the portal. A holdback as long as your refund window means most refunds land before anything is approved.

## Lenders, suppliers and affiliate networks

A sender that holds the click id (a lender's system, a supplier's order pipeline, an affiliate network) reports with `POST /attribution/conversions` and an `events:write` key, or fires `GET /postback` with the postback token from **Admin → Integrations**. Both are in the API reference. What trips senders up:

- **`externalEventId` (`txn_id` on the postback) is unique across your whole tenant**, shared with `/attribution/events`, `/coupons/redeem` and the Stripe webhook. A reused id is `409 external_event_id_conflict`, and that conversion is lost, not recorded.
- **Use one id per stage**, not per deal: `loan-881:approved`, then `loan-881:funded`. Reporting the second stage under the first stage's id is a `409`.
- **Prefix ids per sender.** Two suppliers can both have an order `881`: `acme:loan-881:funded`, `zenlend:loan-881:funded`.
- **Conversions are scoped to the tenant, not a program.** The click id already names its program, so there's no `programId` to send, and a click from any program in your tenant is accepted. An unknown click is `404 click_not_found`.
- **The postback token and `events:write` keys are tenant-wide.** A sender holding one can report a conversion for any click in any of your programs. Give each sender its own key where it can send a header, and pin the postback token to your senders' addresses with its IP allowlist (`PATCH /conversion-postback {"ipAllowlist":["203.0.113.0/24"]}`). Rotate the token when a sender leaves: the old URL stops working at once.
- **Stage names must match the rule exactly.** A conversion whose `type` no commission rule takes is recorded and credited, and pays nothing: `outcome: "no_matching_rule"`, or `ok no_matching_rule` on the postback. These types are listed on **Admin → Integrations**.
- **Read the answer.** Every recorded conversion is a `200`, so a sender doesn't retry it: `ok attributed`, `ok attributed no_commission`, `ok no_matching_rule`, `ok not_attributed outside_window`. Errors are `4xx` codes.
- **Partner terms replace program rules.** Custom terms for a partner (`PUT /partners/{id}/programs/{programId}/commission`) replace the program's whole rule set for that partner. A program paying $25 on `approved` and $400 on `loan_funded`, overridden with only a `loan_funded` rule, pays that partner nothing on `approved`. Send every stage you want paid.

## Security checklist

- [ ] OpenPartner API keys live only on your server: never in the browser, a mobile app, or front-end env vars. Partner keys (`POST /partners/{id}/api-keys`) are credentials too.
- [ ] The runtime key is scoped, with `partners:create` rather than `partners:write` (step 0), and the admin key isn't deployed.
- [ ] Customers can't sign in to the hosted portal: `GET /config/partner-access` says `"uninvitedPortalAccess": false` (step 1), and each create sends `"portalAccess": false` (step 3).
- [ ] Your backend takes the partner id from its own session, never from a request parameter. A scoped key can read every partner.
- [ ] A partner found by email is linked to a user only when its `metadata.appUserId` matches (step 3), and only verified emails are used.
- [ ] If customers shouldn't be asked to join the Network, offering is off (step 1), and you re-check it after any Network reconnect.
- [ ] Webhook signatures are verified on the raw body, with the 5-minute timestamp window, and deliveries are deduped on `id`.
- [ ] `userId` is an opaque internal id, not an email address.
- [ ] "Paid out" in your UI comes from payouts with status `paid`, not from commissions marked `paid` (step 5).
- [ ] Users can't force cache refreshes that spend your rate limit, and event reporting retries on `429`.
- [ ] To rotate a key, mint a new one, deploy it, then `DELETE /api-keys/{id}` the old one.

## Drive OpenPartner from your own admin

For an operator dashboard or storefront, the same API covers the admin side (admin key, or the scopes shown):

| Task | Endpoints |
| --- | --- |
| Programs: one per product or supplier | `GET/POST /programs`, `PATCH /programs/{id}` |
| Who may promote what | `GET/POST /partners/{id}/programs`, `DELETE /partners/{id}/programs/{programId}` |
| Find partners | `GET /partners?q=` (name/email search), `?email=` (exact), cursor-paginated (`partners:read`) |
| Bulk-load partners | `POST /import/partners-csv` (`partners:write`) |
| Who may sign in to the hosted partner portal | `PATCH /partners/{id}` `{"portalAccess": …}` (`partners:write`); the default for partners added without an invite: `GET/POST /config/partner-access` |
| Review commissions | `GET /commissions?status=accrued` (`commissions:read`), `POST /commissions/{id}/approve`, `.../reverse` |
| Refunds and chargebacks | `POST /attribution/refunds` (`events:write`) |
| Pay partners | `POST /payouts/run`, `POST /payouts/{id}/confirm` (manual rail) |
| Coupon-code attribution | `GET/POST /partners/{id}/coupons`, `POST /coupons/redeem` (`events:write`) |
| Conversions reported by a click id (a lender, CRM or affiliate network) | `POST /attribution/conversions` (`events:write`), or the `GET /postback` URL on Admin → Integrations |
| Your data, any time | `GET /export.json`, `GET /export/{table}.{json\|csv\|sql}`, `GET /export.sql` |

## Not built yet

These are tracked as follow-ups. None of them is available today:

- **Embedding the hosted partner portal without a separate login** (a signed embed/SSO token from your backend). Today, either build your own page (this guide) or have partners sign in to the portal with a magic link.
- **Scoped reads** for `/partners/{id}/funnel`, `/coupons` and `/commission-snapshot`.
- **Per-key rate limits.** Today the limit is per client IP (step 5).
- **A create-only scope for CSV import.** `POST /import/partners-csv` needs `partners:write` or the admin key; `partners:create` covers `POST /partners` only.
- **Read helpers in the server SDK** (dashboard, commissions, payouts). Today the SDK covers `trackEvent` and `identify`; use plain HTTP for reads, as the sample does.
- **Netting refund clawbacks off funded Stripe Connect payouts on hosted OpenPartner.** Manual and self-hosted Stripe Connect payouts deduct them (step 8); funded hosted ones don't yet.
- **A refund helper in the server SDK.** Use plain HTTP for `POST /attribution/refunds`.
