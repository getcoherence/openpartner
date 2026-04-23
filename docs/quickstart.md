# Quickstart

End-to-end walkthrough: spin up the stack, create a partner + campaign + link, simulate a click, stitch an identity, post an event, approve the commission, run a payout, export the data.

## 1. Spin up

```bash
git clone https://github.com/openpartner/openpartner
cd openpartner
cp .env.example .env
# edit .env: set ADMIN_API_KEY to a strong random value
pnpm install
docker compose up -d postgres
pnpm migrate

pnpm dev:api       # :4100
pnpm dev:router    # :4000
pnpm dev:portal    # :5173
```

## 2. Bootstrap

All admin calls use your `ADMIN_API_KEY` as a bearer token.

```bash
export ADMIN=$(grep '^ADMIN_API_KEY=' .env | cut -d= -f2)

# Create a partner.
PARTNER=$(curl -s -X POST http://localhost:4100/partners \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"email":"ada@example.com","name":"Ada"}' | jq -r .id)

# Create a campaign (20% recurring percent rule).
CAMPAIGN=$(curl -s -X POST http://localhost:4100/campaigns \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"name":"Default","commissionRule":{"type":"percent","value":20,"recurring":true}}' | jq -r .id)

# Create a link.
curl -s -X POST http://localhost:4100/partners/$PARTNER/links \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d "{\"linkKey\":\"ada\",\"campaignId\":\"$CAMPAIGN\",\"destinationUrl\":\"https://example.com/signup\"}"

# Issue a partner-scoped key so Ada can read her own dashboard.
curl -s -X POST http://localhost:4100/partners/$PARTNER/api-keys \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"label":"ada personal"}'
```

## 3. Simulate the funnel

```bash
# Click — router sets _cref cookie, writes Click row, 302s to destinationUrl.
CLICK=$(curl -sI http://localhost:4000/r/ada | grep -i '^set-cookie' | sed -E 's/.*_cref=([^;]+).*/\1/' | tr -d '\r')

# Stitch a user (this is what the SDK's identify() call does).
curl -s -X POST http://localhost:4100/attribution/identify \
  -H "content-type: application/json" \
  -d "{\"cref\":\"$CLICK\",\"userId\":\"user_123\"}"

# Server-to-server revenue event.
curl -s -X POST http://localhost:4100/attribution/events \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"userId":"user_123","type":"invoice_paid","value":200,"currency":"USD"}'
```

## 4. Review + payout

```bash
# The commission is 'accrued'; approve it.
COMMISSION=$(curl -s -H "Authorization: Bearer $ADMIN" \
  "http://localhost:4100/partners/$PARTNER/commissions" | jq -r '.commissions[0].id')

curl -s -X POST http://localhost:4100/commissions/$COMMISSION/approve \
  -H "Authorization: Bearer $ADMIN"

# Connect Stripe (opens a hosted onboarding URL — partner completes there).
curl -s -X POST http://localhost:4100/partners/$PARTNER/connect/start \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  -d '{"returnUrl":"http://localhost:5173","refreshUrl":"http://localhost:5173"}'

# Run the payout batch (requires partner to have completed Connect).
curl -s -X POST http://localhost:4100/payouts/run \
  -H "Authorization: Bearer $ADMIN"
```

## 5. Export / import

```bash
# Full dump — round-trippable into a self-hosted instance.
curl -s -H "Authorization: Bearer $ADMIN" \
  http://localhost:4100/export.json > export.json

# One table at a time, CSV or JSON.
curl -s -H "Authorization: Bearer $ADMIN" \
  http://localhost:4100/export/Click.csv > clicks.csv

# On a fresh selfhost instance:
curl -s -X POST http://localhost:4100/import \
  -H "Authorization: Bearer $ADMIN" \
  -H "content-type: application/json" \
  --data @export.json
```

## 6. Deployment modes

Set `OPENPARTNER_MODE` in `.env`:

| Mode | Billing | Partner payouts |
| --- | --- | --- |
| `selfhost` | none | operator handles out-of-band |
| `flat` | merchant subscription (Stripe Checkout via `POST /billing/checkout`; set `STRIPE_FLAT_PRICE_ID`) | Stripe Connect Standard |
| `revshare` | 3% of each payout retained as platform fee (tracked in `Payout.metadata.platformFee`) | Stripe Connect Standard |

See `/billing/status` for the current state, and `/billing/portal` in `flat` mode for the merchant's Stripe customer portal.

## 7. Browser SDK

```ts
import { OpenPartner } from '@openpartner/sdk';

const op = OpenPartner.init({ apiUrl: 'https://openpartner.example.com' });

// On login or signup:
op.identify(currentUser.id);
```

The SDK captures `?cref=…` from the landing URL and the `_cref` cookie, stashes in localStorage so the attribution survives ITP / multi-session gaps, then POSTs to `/attribution/identify` when you call `identify()`.
