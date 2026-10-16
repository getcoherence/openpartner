# Build an in-app referral page

This guide shows you how to run a customer referral program ("Refer & earn") inside your own app. Your customers see their link, stats and earnings on a page you build. They never sign in to OpenPartner. Your backend talks to the OpenPartner API, and the browser only talks to your backend.

The same API also lets you run OpenPartner from your own admin dashboard or storefronts. See [Drive OpenPartner from your own admin](#drive-openpartner-from-your-own-admin).

- **API reference:** `GET /openapi.json` and the rendered `/docs` on every deployment, e.g. `https://app.openpartner.dev/api/docs`. A copy lives in [`docs/openapi.json`](./openapi.json).
- **Runnable sample:** [`examples/in-app-referral`](../examples/in-app-referral) is a dependency-free Node server plus one HTML page that does everything below.

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
  -d '{"label":"in-app referral","scopes":["partners:write","partners:read","links:write","links:read","commissions:read","payouts:read","events:write"]}'
# → { "id": "...", "plaintext": "op_...", "scopes": [...] }   plaintext is shown once
```

| Scope | Used for |
| --- | --- |
| `partners:write` | `POST /partners`, `POST /import/partners-csv` |
| `partners:read` | `GET /partners`, `GET /partners/{id}`, `/dashboard`, `/timeseries`, `/events`, `/customers`, `/breakdowns` |
| `links:write` / `links:read` | `POST` / `GET /partners/{id}/links` |
| `commissions:read` | `GET /partners/{id}/commissions` |
| `payouts:read` | `GET /partners/{id}/payouts` |
| `events:write` | `POST /attribution/events`, `POST /coupons/redeem` |

The full table, generated from the routes, is in the API reference under **Authentication**. A scoped key acts on every partner in your tenant, so **your backend must decide which partner a request is for from its own session, never from a parameter the browser sends.**

## 1. Turn off Network auto-enroll first

Do this before you create the first partner.

**What happens today:** when your tenant is on the OpenPartner Network with `autoEnroll` on, every `POST /partners` pushes the new partner's **name, email and `metadata`** to the OpenPartner Network. That happens even with `sendInvite: false`, so a customer-referral program would copy your customers' details into a separate service. Partner self-signup does the same. Hosted brands are enrolled with `autoEnroll: true` by default when they sign up. CSV import does not push.

Check and turn it off with the admin key:

```bash
curl -s $OP/config/network -H "Authorization: Bearer $ADMIN"
# { "enabled": true, "autoEnroll": true, ... }

curl -s -X POST $OP/config/network -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"autoEnroll": false}'
# { "enabled": true, "autoEnroll": false, ... }
```

Or use **Admin → Network** in the portal and switch off auto-enroll. The setting is per tenant.

- Partners already pushed stay on the Network. Turning the setting off only stops new pushes.
- **Reconnecting to the Network** (the Connect or one-click enroll buttons on Admin → Network) sets `autoEnroll` back to `true`. Check `GET /config/network` after any reconnect.
- Don't run **Admin → Network → Backfill** (`POST /config/network/backfill`). It pushes every existing partner.
- Scoped keys can't read or change this setting. Use the admin key.

> **TODO ([#124](https://github.com/getcoherence/openpartner/pull/124), open as of 2026-10-16):** Network membership is moving to partner opt-in. Each partner will choose whether to join, and `autoEnroll` will only mean "offer the Network to my partners". Once that ships, update this section. Until then, the behaviour above is what runs.

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
- **`holdbackDays`** delays approval of a commission. Set it to your refund window.
- **Rules** are an array of sub-rules, each with `trigger` (`every` / `first` / `subsequent`), an optional `eventType`, and a `percent` or `fixed` amount. Scope each rule to an event type: a `fixed` rule with no `eventType` pays on every event, signups included.

> **TODO (in progress, not merged):** revenue-based commission slabs and tiers. Today a program's rule is flat. You can override one partner's terms with `PUT /partners/{id}/commission-snapshot` (admin key); that override applies to all of the partner's programs. Scoping it to one program is [#123](https://github.com/getcoherence/openpartner/pull/123), also open.

## 3. Create a partner for each customer

When a customer first opens your referral page, create their partner record from your backend with the scoped key:

```bash
curl -s -X POST $OP/partners -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "email": "ada@example.com",
  "name": "Ada Lovelace",
  "sendInvite": false,
  "programIds": ["'$PROGRAM_ID'"],
  "metadata": { "appUserId": "user_123" }
}'
# 201 → { "id": "01J...", "activatedAt": "2026-10-16T...", "invited": false, ... }
```

- **`sendInvite: false`** makes the partner active immediately, and OpenPartner sends no email.
- **Always pass `programIds`.** If you omit it, the partner is granted every program in the tenant. A coupon code is auto-minted for each granted program.
- **Store the returned `id` on your user record.** On later page views, use it directly.
- **`email` is unique per tenant.** A second create answers `409 email_taken`. Handle it by looking the partner up with `GET /partners?email=ada@example.com`, which also covers two first visits racing each other.
- `metadata` is free-form JSON, returned on reads. Put your own ids there: your user id, your CRM record id.
- On OpenPartner Cloud, creating partners needs an active plan (`402 plan_required`) and an approved brand (`403 brand_pending_review`).

**Existing customers in bulk.** To give every current customer a referral account up front, use `POST /import/partners-csv` instead of one call per customer: `text/csv` with `email,name,metadata` columns, `?dryRun=true` first. It sends no email, never pushes to the Network, and skips emails that already exist, so re-running it is safe. Unlike `POST /partners` it grants **every** program in the tenant and mints no coupons, so run it while the referral program is your only program. Send large rosters in batches of a few thousand rows. You can also skip the import and create partners lazily on first visit, as above.

**Email.** OpenPartner emails a headless partner only when you trigger it:
- `POST /partners/{id}/invite`, which sends a sign-in link.
- `POST /partners/{id}/revoke`, which notifies by default. Pass `"notify": false`.
- A program with an `endsAt`: seven days before the end, partners with a link on it get an "ending soon" email. Leave `endsAt` unset for an evergreen referral program.

**Privacy.** OpenPartner stores the name and email you send, and nothing else about the customer. If you'd rather not share real addresses, any unique address works for a headless partner, for example `user_123@referrals.yourapp.invalid`. The trade-off is that such a partner can never sign in to the hosted partner portal.

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
| `GET /partners/{id}/dashboard?since=<iso>` | `clicks`, `attributedEvents`, `attributedRevenue`, and `commissionByStatus` (`accrued` / `approved` / `paid` / `reversed` totals). Defaults to the last 30 days. |
| `GET /partners/{id}/timeseries?since=&until=&programId=` | Dense daily (or weekly) buckets: `clicks`, `leads` (`signup` + `trial_started`), `sales` (events with a value), `revenue`, `earnings`. |
| `GET /partners/{id}/events?limit=&offset=` | Each attributed event, with the click it came through. |
| `GET /partners/{id}/commissions?limit=&cursor=&status=` | The commission ledger, newest first, cursor-paginated. Each row has `amount`, `status` and `matureAt` (when the holdback ends). |
| `GET /partners/{id}/payouts` | Up to the 200 most recent payouts. |

A typical page shows *pending* as `accrued + approved` and *paid* as `paid` from `commissionByStatus`, and lists the latest commissions and payouts.

- Money on a row (`amount`, `value`) is a decimal string such as `"9.80"`. Report totals are numbers.
- `GET /partners/{id}/funnel` (click → identity → signup → paid) does **not** accept scoped keys yet. Call it with an admin key from your server, or build the same counts from `/timeseries`. *TODO: a scoped read for `/funnel` and `/coupons` isn't built yet.*
- **Cache these responses.** All API calls from one IP share a limit of **600 requests per 5 minutes**. Your backend calls from one IP, so this is the budget for your whole integration. A referral page that makes four calls per view and caches each user's stats for a minute or two stays far below it. A `429 rate_limited` response carries `RateLimit` headers.

## 6. Capture the click in the browser

When someone follows a share link, the router records the click and redirects to your `destinationUrl` with `?cref=<click id>` appended. On your landing and signup pages, load the browser SDK. It stores the `cref` in `localStorage`, so the referral survives Safari's cookie limits and visits days apart:

```ts
import { OpenPartner } from '@openpartner/sdk';

const op = OpenPartner.init({ apiUrl: 'https://app.openpartner.dev/api/t/acme' }); // your API base

// Right after signup (see the note below about calling it on login):
await op.identify(user.id);
```

`identify()` calls `POST /attribution/identify`, which needs no API key and accepts any origin, so the SDK can call it from your site. It links the click to your user id, and attributes any events you already recorded for that user. Repeat calls for the same pair do nothing. Use the same `userId` everywhere: your stable internal id, not an email address.

Calling it after login as well as signup stitches a customer who clicked on one device and signed up on another.

> **TODO (fix not merged as of 2026-10-16):** today, stitching a *second* click to a user whose events are already attributed can credit those events again, a duplicate commission. Until that fix ships, call `identify()` at signup only, and keep a holdback so the review queue catches anything doubled. Update this section when the fix merges.

If you'd rather keep all OpenPartner calls on your server, read `op.getReferral()` in the browser, send it with your signup form, and call identify from your backend instead:

```bash
curl -s -X POST $OP/attribution/identify -H 'content-type: application/json' \
  -d '{"cref":"01J9Z...","userId":"user_456"}'
```

## 7. Report conversions from your server

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

**Report payments as `invoice_paid`.** It's the only "paid" stage in the funnel, and on OpenPartner Cloud it counts toward billable GMV, as does `subscription_created`. Report each payment once: sending both `subscription_created` and `invoice_paid` with a value for the same charge counts it twice.

| Type | Meaning in OpenPartner |
| --- | --- |
| `signup` | The funnel's *signups* stage. A *lead* in the timeseries. |
| `trial_started` | A *lead* in the timeseries. |
| `invoice_paid` | The funnel's *paid* stage. Billable GMV on Cloud. Use for every payment. |
| `subscription_created` | Billable GMV on Cloud. |
| anything else (`demo_booked`, `lead_qualified`, ...) | Recorded, and commissionable if a rule names it. Not in the funnel or lead counts, and not GMV. |

For example, if you track clicks, signups, leads, demos and paid customers: clicks come from the router, signups are `signup`, payments are `invoice_paid`, and leads and demos are custom types. To pay a flat bounty for a booked demo, add a sub-rule such as `{ "trigger": "first", "eventType": "demo_booked", "type": "fixed", "value": 10 }`.

- **Always send `externalEventId`.** Use your own stable id for that one event: invoice id, order id, or deal id plus stage. A retry with the same key returns `200` with `"replayed": true` and records nothing, even for duplicates that arrive at the same moment. Reusing a key for a different event returns `409 external_event_id_conflict`. Keys are per tenant and up to 120 characters.
- `value` is in major units (`49.00`, not `4900`). `currency` defaults to USD.
- An event for a user with no stitched click returns `"status": "no_identity"` and is kept. If the user is stitched later, earlier events are attributed then (`backfilledAttributions` on the identify response).
- **Refunds.** This endpoint doesn't take negative values. Reverse the commission with `POST /commissions/{id}/reverse` (admin key). A holdback as long as your refund window means most refunds land before anything is approved.

## 8. Get webhooks in your backend

Subscribe an endpoint (admin key, or a scoped key with `webhooks:write`):

```bash
curl -s -X POST $OP/webhooks -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"url":"https://yourapp.example.com/hooks/openpartner","events":["commission.accrued","commission.approved","commission.paid","commission.reversed","payout.created"]}'
# → { "endpoint": {...}, "secret": "whsec_..." }   the secret is shown once
```

Events: `attribution.created`, `commission.accrued`, `commission.approved`, `commission.paid`, `commission.reversed`, `partner.created`, `partner.activated`, `partnership.approved`, `payout.created`, or `*` for all. Payload schemas are under **Webhook events** in the API reference.

Each delivery is `POST {id, event, created, data}`, signed with HMAC-SHA256 over `<X-OpenPartner-Timestamp>.<raw body>`, keyed with the whole `whsec_…` secret:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the request body as received, before any JSON parsing.
function verifyOpenPartner(rawBody, headers, secret) {
  const ts = headers['x-openpartner-timestamp'];
  const sig = headers['x-openpartner-signature'] ?? '';
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

- **Dedupe on the envelope `id`** (also sent as `X-OpenPartner-Delivery`). A resend carries the same `id`.
- **No automatic retries.** A non-2xx answer, a redirect, or no answer within 10 seconds marks a delivery failed. Find failures with `GET /webhooks/{id}/deliveries` and resend with `POST /webhooks/{id}/deliveries/{deliveryId}/retry`.
- Treat webhooks as a nudge to refresh. The API is the record: on `commission.*`, re-read the partner's dashboard rather than adding the webhook's amount to a running total.
- `POST /webhooks/{id}/test?event=commission.accrued` sends a signed sample with the real payload shape.

## 9. CRM recipe: Zoho CRM or HubSpot

### Deal stage → conversion event

When a deal reaches a stage you pay on, send it to `POST /attribution/events`. The CRM record must carry the same `userId` your app passed to `identify()`, so sync your app's user id into a custom field on the contact or deal. Use a scoped key with only `events:write`.

The request:

```http
POST https://app.openpartner.dev/api/t/acme/attribution/events
Authorization: Bearer op_<events:write key>
Content-Type: application/json

{ "userId": "<App User ID field>", "type": "invoice_paid", "value": <Amount>, "currency": "USD",
  "externalEventId": "crm:<deal id>:closed_won" }
```

- **Zoho CRM:** create a Workflow Rule on Deals (for example, Stage is Closed Won) with a Webhook action: method POST, the URL above, the `Authorization` and `Content-Type` headers, and a JSON body built from merge fields. If your edition can't send a raw JSON body, use a Deluge function action instead, with the deal id as its argument and the key in an org variable or connection rather than the code:

  ```
  deal = zoho.crm.getRecordById("Deals", dealId);
  payload = Map();
  payload.put("userId", deal.get("App_User_ID"));
  payload.put("type", "invoice_paid");
  payload.put("value", deal.get("Amount"));
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
    const { app_user_id, amount, hs_object_id } = event.inputFields;
    const res = await fetch('https://app.openpartner.dev/api/t/acme/attribution/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENPARTNER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: app_user_id, type: 'invoice_paid', value: Number(amount), externalEventId: `hubspot:${hs_object_id}:closedwon` }),
    });
    callback({ outputFields: { openpartnerStatus: res.status } });
  };
  ```

  Without custom code, point HubSpot's "Send a webhook" action at a small relay of your own that reshapes the body.

CRM workflows retry, and a deal can be moved back and forth. Because the `externalEventId` is the deal id plus the stage, each paid stage is counted once.

### Webhooks → CRM fields

CRMs can't check an HMAC signature themselves, so put a small relay in between. It verifies the signature (section 8), maps `data.partnerId` to the CRM record, and writes absolute values read back from the API:

```js
// On any commission.* or payout.created webhook (signature verified):
const { partnerId } = envelope.data;
const partner = await op('GET', `/partners/${partnerId}`);          // metadata.crmContactId, set at creation
const dash = await op('GET', `/partners/${partnerId}/dashboard?since=2020-01-01T00:00:00Z`);
await crm.updateContact(partner.metadata.crmContactId, {
  referral_earnings_pending: (dash.commissionByStatus.accrued ?? 0) + (dash.commissionByStatus.approved ?? 0),
  referral_earnings_paid: dash.commissionByStatus.paid ?? 0,
  referral_clicks: dash.clicks,
});
```

Writing totals rather than adding each webhook's amount means a duplicate, missed or out-of-order delivery can't skew the field. The next event corrects it. Store the CRM record id in the partner's `metadata` when you create it (step 3); with Network auto-enroll off, that metadata stays in your tenant. For HubSpot, the update is `PATCH /crm/v3/objects/contacts/{id}`; for Zoho, `PUT /crm/v6/Contacts/{id}` or an upsert. See their API docs for auth.

## Security checklist

- [ ] OpenPartner API keys live only on your server: never in the browser, a mobile app, or front-end env vars. Partner keys (`POST /partners/{id}/api-keys`) are credentials too.
- [ ] The runtime key is scoped, and the admin key isn't deployed.
- [ ] Your backend takes the partner id from its own session, never from a request parameter. A scoped key can read every partner.
- [ ] Network auto-enroll is off (step 1), and you re-check it after any Network reconnect.
- [ ] Webhook signatures are verified on the raw body, with the 5-minute timestamp window, and deliveries are deduped on `id`.
- [ ] `userId` is an opaque internal id, not an email address.
- [ ] To rotate a key, mint a new one, deploy it, then `DELETE /api-keys/{id}` the old one.

## Drive OpenPartner from your own admin

For an operator dashboard or storefront, the same API covers the admin side (admin key, or the scopes shown):

| Task | Endpoints |
| --- | --- |
| Programs: one per product or supplier | `GET/POST /programs`, `PATCH /programs/{id}` |
| Who may promote what | `GET/POST /partners/{id}/programs`, `DELETE /partners/{id}/programs/{programId}` |
| Find partners | `GET /partners?q=` (name/email search), `?email=` (exact), cursor-paginated (`partners:read`) |
| Bulk-load partners | `POST /import/partners-csv` (`partners:write`) |
| Review commissions | `GET /commissions?status=accrued` (`commissions:read`), `POST /commissions/{id}/approve`, `.../reverse` |
| Pay partners | `POST /payouts/run`, `POST /payouts/{id}/confirm` (manual rail) |
| Coupon-code attribution | `GET/POST /partners/{id}/coupons`, `POST /coupons/redeem` (`events:write`) |
| Your data, any time | `GET /export.json`, `GET /export/{table}.{json\|csv\|sql}`, `GET /export.sql` |

## Not built yet

These are tracked as follow-ups. None of them is available today:

- **Embedding the hosted partner portal without a separate login** (a signed embed/SSO token from your backend). Today, either build your own page (this guide) or have partners sign in to the portal with a magic link.
- **Partner opt-in for the OpenPartner Network** ([#124](https://github.com/getcoherence/openpartner/pull/124), open; see step 1).
- **Revenue-based commission slabs and tiers** (in progress; see step 2).
- **Scoped reads** for `/partners/{id}/funnel`, `/coupons` and `/commission-snapshot`.
- **Per-key rate limits.** Today the limit is per client IP (step 5).
- **Read helpers in the server SDK** (dashboard, commissions, payouts). Today the SDK covers `trackEvent` and `identify`; use plain HTTP for reads, as the sample does.
