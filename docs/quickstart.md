# Quickstart

End-to-end walkthrough: spin up the stack, run first-run install, invite a partner, simulate a click, stitch an identity, post an event, approve the commission, run a payout, export the data.

## 1. Spin up

```bash
git clone https://github.com/getcoherence/openpartner
cd openpartner
cp .env.example .env
# edit .env: set ADMIN_API_KEY (bootstrap) and SECRETS_ENCRYPTION_KEY
# (both random 32-byte hex). Generate each with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
pnpm install
docker compose up -d postgres
pnpm migrate

pnpm dev:api       # :4601
pnpm dev:router    # :4701
pnpm dev:portal    # :5673
```

## 2. First-run install (UI)

Open **http://localhost:5673/install** — a three-step wizard:

1. **You** — admin name + email
2. **Program** — program name + optional support email (surfaced to partners in their footer)
3. **Email delivery** — SMTP or Postmark credentials (stored encrypted in the DB) or "None" to print magic links to the `pnpm dev:api` console

On submit, OpenPartner emails you a one-time activation link. Click it and you're signed in as the first admin with a session cookie. From here, everything else is admin UI — no more curl bootstrap.

> The `ADMIN_API_KEY` env remains valid as a headless / CI bearer. Everything below works with either auth mode.

## 3. Bootstrap via API (headless)

If you'd rather skip the wizard for scripted setups, the admin key still works as a bearer token.

```bash
export ADMIN=$(grep '^ADMIN_API_KEY=' .env | cut -d= -f2)

# Create a partner.
PARTNER=$(curl -s -X POST http://localhost:4601/partners \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"email":"ada@example.com","name":"Ada"}' | jq -r .id)
# ^ Also emails Ada an invite with a magic link. She clicks it, sets
#   up her own partner dashboard session — admin never sees her creds.

# Create a program (20% recurring percent rule). destinationUrl is
# where partner links land. The router appends ?cref=<click id> to it;
# put {click_id} in the URL to send the id in your own parameter instead
# (see "Conversions by click id" below).
PROGRAM=$(curl -s -X POST http://localhost:4601/programs \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"name":"Default","destinationUrl":"https://example.com/signup","commissionRule":{"type":"percent","value":20,"recurring":true}}' | jq -r .id)

# Partners create their own Links — but admin can seed one for
# testing. In the real UX the partner does this from their dashboard.
# The link inherits the program's destinationUrl.
curl -s -X POST http://localhost:4601/partners/$PARTNER/links \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d "{\"linkKey\":\"ada\",\"programId\":\"$PROGRAM\"}"
```

## 4. Simulate the funnel

```bash
# Click — router sets _cref cookie, writes Click row, 302s to destinationUrl.
CLICK=$(curl -sI http://localhost:4701/r/ada | grep -i '^set-cookie' | sed -E 's/.*_cref=([^;]+).*/\1/' | tr -d '\r')

# Stitch a user (this is what the SDK's identify() call does).
curl -s -X POST http://localhost:4601/attribution/identify \
  -H "content-type: application/json" \
  -d "{\"cref\":\"$CLICK\",\"userId\":\"user_123\"}"

# Server-to-server revenue event. externalEventId makes retries safe.
curl -s -X POST http://localhost:4601/attribution/events \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"userId":"user_123","type":"invoice_paid","value":200,"currency":"USD","externalEventId":"in_1001"}'
```

### Conversions by click id

`identify()` needs a user who visits your site with the SDK running. Plenty of conversions happen elsewhere: a lender funds the loan, a sales rep closes the deal, an affiliate network confirms the sale. Those systems can carry the click id instead.

**Get the click id there.** The click router appends `?cref=<click id>` to the destination. To send it in a parameter the destination already reads, put the `{click_id}` macro in the program's `destinationUrl` (or a partner's deep-link override). The router substitutes it and appends no `cref`:

```bash
# A Stripe Payment Link reads the referral only from client_reference_id.
curl -s -X PATCH http://localhost:4601/programs/$PROGRAM \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"destinationUrl":"https://buy.stripe.com/abc123?client_reference_id={click_id}"}'
```

The macro may go in the path, query or fragment, not the host. A misspelling such as `{clickid}` or `{cref}` is rejected. Click ids are ULIDs (26 letters and digits), so they fit Stripe's `client_reference_id`. On a single-tenant self-host whose Stripe webhook points here, a Payment Link purchase is then recorded automatically: a `signup`, plus the paid amount as `invoice_paid`. A refund of the whole purchase reverses its commission. Subscribe the webhook to `checkout.session.async_payment_succeeded` too, so purchases paid by SEPA, ACH or Bacs are counted when they clear.

**Report it in one call.** Whatever holds the click id posts the conversion with a key that has `events:write`. No identify step:

```bash
curl -s -X POST http://localhost:4601/attribution/conversions \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d "{\"clickId\":\"$CLICK\",\"type\":\"loan_funded\",\"value\":5000,\"currency\":\"USD\",\"externalEventId\":\"loan-881:funded\"}"
```

- OpenPartner stitches the click and records the event in one transaction. Without a `userId` the click gets its own user (`click:<clickId>`), so every conversion reported for that click is credited to it. Pass `userId` if you also identify the user elsewhere.
- `externalEventId` is required and shares the idempotency rules below. A retry replays, and reusing a key for a different click or conversion returns `409`.
- An unknown click, or one from another program, returns `404 click_not_found`. A click flagged as fraud (velocity, revoked partner) returns `422 click_flagged`. Neither records anything.

**Or as a postback URL.** Affiliate networks and many lenders can only fire a URL. Mint a postback token under **Admin → Integrations**, or via the API:

```bash
TOKEN=$(curl -s -X POST http://localhost:4601/conversion-postback/token \
  -H "Authorization: Bearer $ADMIN" | jq -r .plaintext)

curl -s "http://localhost:4601/postback?click_id=$CLICK&type=sale&amount=49.00&currency=USD&txn_id=T-1001&token=$TOKEN"
# ok
```

- The token (`opcp_…`) records conversions and nothing else, and isn't accepted as an API key. The API's request log redacts it.
- `txn_id` is the idempotency key, so a network re-firing the postback records once. `cref`, `transaction_id` and `value` work as aliases for `click_id`, `txn_id` and `amount`.
- The response is `ok`, or a 1×1 GIF with `&pixel=1`. Errors are plain-text codes with a 4xx status (`invalid_token`, `ip_not_allowed`, `click_not_found`, …).
- Pin it to the network's IPs with `PATCH /conversion-postback {"ipAllowlist":["203.0.113.0/24"]}`. The check uses the client address the API sees through one trusted proxy hop, so point networks at the API host directly.
- `POST /conversion-postback/token` again rotates it, and the old URL stops working at once. `DELETE /conversion-postback/token` turns postbacks off.

## 5. Review + payout

Always send an `externalEventId` from your backend. Use your own system's stable id for that one event, such as the invoice id or order id. Servers, queues and Zapier all retry when a request times out. Without a key, each retry records a second event and pays a second commission.

With a key, a retry returns `200` with `"replayed": true` and the original `eventId` and attribution, and nothing new is written. This holds for duplicates that arrive at the same moment too. Run the `curl` above twice to see it.

- **One key per event, not per order.** An order's `subscription_created` and its `invoice_paid` need different keys, for example `sub_123:created` and `in_456`.
- **Reusing a key for a different event** (another `userId`, `type`, `value` or `currency`) returns `409 external_event_id_conflict`. Nothing is recorded.
- **Keys are scoped to your program** and can be up to 120 characters. They share one namespace with `/attribution/conversions`, `/postback` and `/coupons/redeem`, so don't reuse a key across them for different events.

```bash
# The commission is 'accrued'; approve it.
COMMISSION=$(curl -s -H "Authorization: Bearer $ADMIN" \
  "http://localhost:4601/partners/$PARTNER/commissions" | jq -r '.commissions[0].id')

curl -s -X POST http://localhost:4601/commissions/$COMMISSION/approve \
  -H "Authorization: Bearer $ADMIN"

# Connect Stripe (opens a hosted onboarding URL — partner completes there).
curl -s -X POST http://localhost:4601/partners/$PARTNER/connect/start \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"returnUrl":"http://localhost:5673","refreshUrl":"http://localhost:5673"}'

# Run the payout batch (requires partner to have completed Connect).
curl -s -X POST http://localhost:4601/payouts/run \
  -H "Authorization: Bearer $ADMIN"
```

> **`docker-compose.prod.yml` runs scheduled jobs by default.** It defaults `OPENPARTNER_ENABLE_SCHEDULER` to `1`; set it to `0` in `.env` to turn them off and trigger everything by hand, as above. Anywhere else, including `pnpm dev`, they run only when it's `1`. With them on, the API runs:
>
> - Scheduled payouts on the tenant's **Payout cadence** (weekly unless changed), including **real Stripe Connect transfers** to partners on the Connect rail. In `selfhost` mode they come out of your own Stripe balance.
> - Auto-approval of accrued commissions once a holdback above 0 days has elapsed. The next payout run then pays them.
> - In `flat` and `revshare`, a daily usage report to Stripe. A tenant's first report covers all attributed GMV to date.
> - Reminder and cleanup sweeps.
>
> To keep paying partners by hand while the other jobs run, set **Payout cadence** to **Manual**. Run the scheduler on **exactly one** API process. See [deploy.md](./deploy.md#scheduled-jobs), including what upgrading an existing compose deploy turns on.

## 6. Export / import

```bash
# Full dump — round-trippable into a self-hosted instance.
curl -s -H "Authorization: Bearer $ADMIN" \
  http://localhost:4601/export.json > export.json

# One table at a time, CSV or JSON.
curl -s -H "Authorization: Bearer $ADMIN" \
  http://localhost:4601/export/Click.csv > clicks.csv

# On a fresh selfhost instance:
curl -s -X POST http://localhost:4601/import \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  --data @export.json
```

## 7. Deployment modes

Set `OPENPARTNER_MODE` in `.env`:

| Mode | Billing | Partner payouts |
| --- | --- | --- |
| `selfhost` | none | manual (operator pays out-of-band), or Stripe Connect Standard from the operator's own Stripe account |
| `flat` | Flex subscription via Stripe Checkout (`POST /billing/checkout`): a monthly base price (`STRIPE_FLAT_PRICE_ID`), plus 1.5% of attributed GMV on the attributed-GMV usage meter when `STRIPE_FLAT_USAGE_PRICE_ID` is set. Without it, Checkout bills only the base. `apps/api/scripts/setup-stripe.mjs` creates both ($49/mo + 1.5%). | Stripe Connect Standard |
| `revshare` | 3% of attributed GMV, billed to the merchant through a Stripe usage meter (`STRIPE_REVSHARE_USAGE_PRICE_ID`; usage is reported daily by the scheduler when it's enabled, or on demand via `POST /billing/report-usage`). Partners receive their full commission — `Payout.metadata.platformFee` is a ledger note, not a deduction. | Stripe Connect Standard |

See `/billing/status` for the current state, and `/billing/portal` in `flat` mode for the merchant's Stripe customer portal.

## 8. Browser SDK

```ts
import { OpenPartner } from '@openpartner/sdk';

const op = OpenPartner.init({ apiUrl: 'https://openpartner.example.com' });

// On login or signup:
op.identify(currentUser.id);
```

The SDK captures `?cref=…` from the landing URL and the `_cref` cookie, stashes in localStorage so the attribution survives ITP / multi-session gaps, then POSTs to `/attribution/identify` when you call `identify()`.

## 9. Server SDK

For conversion events your backend controls (custom events, non-Stripe billing):

```ts
import { OpenPartnerServer } from '@openpartner/sdk/server';

const op = new OpenPartnerServer({
  apiUrl: process.env.OPENPARTNER_API_URL!,
  apiKey: process.env.OPENPARTNER_API_KEY!,
});

await op.trackEvent({
  userId: user.id,
  type: 'invoice_paid',
  value: 249,
  currency: 'USD',
});
```

See [`packages/sdk/README.md`](../packages/sdk/README.md) for full integration docs, including framework notes and error handling.

## 10. API reference

The tenant API (partners, programs, links, attribution, commissions, payouts, reporting, webhooks, keys, export), with request and response schemas, auth and scopes, is in the OpenAPI 3.1 spec: `http://localhost:4601/openapi.json`, rendered at `http://localhost:4601/docs` (on OpenPartner Cloud, `https://app.openpartner.dev/api/docs`). To run a referral program inside your own app with no OpenPartner login, see [headless-referral.md](./headless-referral.md).
