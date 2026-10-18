# Stripe Payment Link forwarder (sample)

On OpenPartner Cloud, Stripe's webhooks go to your own account, not to OpenPartner. This ~50-line server is the piece in between. It receives Stripe's checkout webhooks, checks Stripe's signature, and reports each paid Checkout Session that came from a partner link to `POST /attribution/conversions`.

If **Admin → Integrations** offers **Connect Stripe**, use that instead: OpenPartner then reads checkouts from your Stripe account itself, and a forwarded session answers `409 recorded_from_stripe` (which this server treats as done).

The full walkthrough, including subscriptions and refunds, is [Stripe Payment Links on OpenPartner Cloud](../../docs/headless-referral.md#stripe-payment-links-on-openpartner-cloud). This folder is not part of the pnpm workspace, so nothing here is built in CI. Only its currency rule (`stripe-amount.mjs`) is tested, from the API's test suite.

## Before you start

1. **The program's destination** is your Payment Link with the click id macro, written exactly like this:

   ```
   https://buy.stripe.com/<link>?client_reference_id={click_id}
   ```

2. **A scoped key** with `events:write` only: **Admin → Integrations**, or `POST /api-keys/scoped {"scopes":["events:write"]}`.
3. **A Stripe webhook endpoint** pointing at this server, subscribed to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Stripe shows its signing secret (`whsec_…`) once you create it.

## Run it

```bash
cd examples/stripe-payment-link-forwarder

STRIPE_WEBHOOK_SECRET=whsec_... \
OPENPARTNER_API_URL=https://app.openpartner.dev/api/t/<your-slug> \
OPENPARTNER_API_KEY=op_... \
node server.mjs       # listens on :3001 (PORT to change)
```

Locally, `stripe listen --forward-to localhost:3001` forwards test-mode events and prints the `whsec_` secret to use.

## What it does

- **Verifies the signature** on the raw body before parsing it. Unsigned or stale requests (more than 5 minutes old) get `400`.
- **Skips** sessions with no `client_reference_id` (not from a partner link) and sessions not yet `paid`. A bank debit is `unpaid` at `checkout.session.completed`; `checkout.session.async_payment_succeeded` reports it once it clears.
- **Reports** `{ clickId: client_reference_id, type: "invoice_paid", value, currency, externalEventId: session.id }`. `value` is `amount_total` in major units: divided by 100, by 1 for zero-decimal currencies such as JPY and KRW, by 1000 for BHD, JOD, KWD, OMR and TND. UGX and ISK are divided by 100 too: they're whole units, but Stripe still sends them with two decimals (5 UGX is `500`). The lists are in `stripe-amount.mjs`, and a test in the API fails if they stop matching the API's own (`apps/api/src/stripe-amounts.ts`). The session id is the idempotency key, so Stripe's retries and both checkout events record the purchase once.
- **Answers Stripe** `2xx` once OpenPartner has answered for good, including `404 click_not_found`, `409 external_event_id_conflict` and `422 click_flagged`, which no retry fixes. It answers `503` on a network error, `429`, `5xx`, `401` or `403`, so Stripe retries (for up to three days) while you fix the outage or the key.
- **Logs** OpenPartner's `outcome` for every session: `attributed`, `no_matching_rule` (the program has no rule for `invoice_paid`) or `not_attributed outside_window`.

It doesn't handle subscription renewals or refunds; the guide shows how to add both.
