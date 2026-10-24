# Roadmap: Stripe-quality conversion data from other payment providers

Status: draft for Keith, Oct 24 2026. Nothing here is built yet.

Stripe is the one provider where OpenPartner sees a purchase end to end
without the brand writing code. This document says what that rests on, which
other providers can give us the same, in what order to build them, and where
the honest limits are. It comes out of the tracking-gap review that produced
Admin → Tracking health (docs/tracking-health.md) and the Stripe catch-up
(docs/stripe-app.md, *Missed events*).

Provider facts below come from each provider's own documentation, read on
Oct 24 2026. Anything marked **verify** wasn't confirmed there and must be
checked in a sandbox before the connector is built.

## What "Stripe-quality" means

What Stripe gives us today, and what a connector for another provider has to
match:

| # | Capability | How Stripe does it | Why it matters |
|---|---|---|---|
| 1 | **The click rides the payment** | `client_reference_id` on Checkout, Payment Links and Pricing Tables, set by the script tag with no brand code | the purchase names its partner click, so no cookie has to survive |
| 2 | **Signed events** | webhooks signed per endpoint | nobody can forge a conversion |
| 3 | **Renewals stay attached** | `invoice.paid` carries a stable customer id | the partner who won the customer keeps the renewals (docs/renewal-attribution.md) |
| 4 | **Refunds and disputes** | `charge.refunded` (partial amounts) reverses commissions automatically; `charge.dispute.created` is recorded, and a lost chargeback is reported to `POST /attribution/refunds` | partners aren't paid on money the brand gave back (docs/refund-clawback-netting.md) |
| 5 | **Catch-up** | the Events API lists 30 days | missed webhooks are recovered, not lost (the catch-up job) |
| 6 | **Access without pasted secrets** | the Stripe App: OAuth, read-only, revocable by the brand | brands connect in a click and stay in control |
| 7 | **Coupon codes** | promotion codes on the checkout and invoice | partner codes credit without a click |

A connector needs **1, 2 and 5** to be worth building (without 5, a missed
webhook is a silent loss, which is the problem Tracking health exists to
surface). 3 can be a join on a subscription or customer id when the
reference doesn't carry over. 4, 6 and 7 are what make it as good as Stripe
rather than good enough.

## What brands can do today

- **Stripe**: full coverage (hosted Stripe App, or a self-host's own key).
- **Everything else**: the brand's backend reports conversions itself with
  `POST /attribution/conversions` (the click id from the `{click_id}` macro or
  `?cref=`), `POST /attribution/events` after `identify()`, or the `GET
  /postback` URL for senders that can only fire a URL. Refunds go to `POST
  /attribution/refunds`. It works for any provider, but it's the brand's
  code, and a bug in it is exactly the silent leak the commenter on Keith's
  post described. Tracking health now counts the unknown click ids those
  calls send (`conversion_unknown_click`), but it can't see a call that was
  never made.

A native connector replaces that code with a connection the brand clicks
through, the same way the Stripe App did for Stripe.

## The connector shape (shared by every provider)

Build the plumbing once, then each provider is a mapping.

1. **A connection sidecar per provider**, like `TenantStripeConnection` and
   `PaypalConnection`: credentials sealed under `SECRETS_ENCRYPTION_KEY`, never
   exported, revocable from Admin → Integrations. Hosted-only metadata never
   goes in core tables (CLAUDE.md principle 2).
2. **One ingest pipeline.** Each provider's webhook route verifies the
   signature, resolves the tenant from the connection (never from metadata the
   brand controls), and maps the event to the same `MappedEvent` shape
   `processBrandStripeEvent` uses: `signup`, `invoice_paid` with value and
   currency, `refund` with the amount, `dispute_created`. Everything after the
   mapping (Event rows, idempotent `externalEventId`, attribution, refunds,
   commission webhooks) is shared and already tested.
3. **Generalise the event log.** `StripeEventLog` becomes a provider event log
   (`provider`, `providerEventId`, `via`), and the catch-up job runs a
   per-provider "list since" function. Providers without an events API catch up
   from their payments or orders list instead (keyed on the payment id, which
   the Event's `externalEventId` already dedupes).
4. **Tagging on the brand's page.** The script tag already tags Stripe links
   and embeds. Each provider gets the equivalent where its checkout allows it:
   a URL parameter on a hosted checkout link, an attribute on an embed, or a
   documented one-line snippet for the provider's JS SDK
   (`openpartner.getReferral()`).
5. **Events tagged by source**: `metadata.via = '<provider>'`, the provider's
   own ids in metadata. Exports carry them as ordinary Event rows, so a brand
   that leaves us takes its full history (principle 5), and a re-import
   re-derives attribution from them (principle 1).
6. **Tracking health per source**: last event received, events recovered by
   catch-up, and checkouts that arrived without a click reference, for each
   connected provider. That's the "prove the tracking works" promise extended
   past Stripe.

Phase 0 below builds 1–6 with no new provider, by refactoring Stripe onto it.

## Provider by provider

### PayPal — first (phase 1)

The second checkout for many brands, and the one we already half-integrate:
**Pay with PayPal already stores the brand's own PayPal REST app and registers
a webhook on it** (`paypal-connection.ts`).

- **The click rides the payment.** Orders v2 `purchase_units[].custom_id`
  (up to 255 characters) comes back on the capture (`PAYMENT.CAPTURE.COMPLETED`)
  and in Transaction Search. The brand's checkout code sets it, client-side in
  the JS SDK's `createOrder` or server-side. Don't use `invoice_id`: it must be
  unique per merchant, so a repeat purchase would collide. PayPal's no-code
  payment links have no documented reference parameter (**verify**).
- **Renewals.** Subscriptions have their own `custom_id` (up to 127). Renewal
  payments arrive as the older `PAYMENT.SALE.COMPLETED`, whose documented schema
  doesn't carry it. Store `custom_id` from `BILLING.SUBSCRIPTION.CREATED`, then
  join each sale on `billing_agreement_id` (the subscription id), falling back
  to the subscription's transactions list when a webhook omits it.
- **Refunds and disputes**: `PAYMENT.CAPTURE.REFUNDED` (partial amounts) and
  `PAYMENT.SALE.REFUNDED` map to refunds, which reverse commissions;
  `CUSTOMER.DISPUTE.CREATED` (its disputed transactions carry the `custom`
  value) is recorded like a Stripe dispute, without reversing anything until
  a chargeback is reported.
- **The gotcha: webhooks are per REST app.** Payments made through one app
  never fire webhooks on another. So:
  - If the brand's checkout runs on the app it connected for payouts, we add the
    payment event types to the webhook we already register. No PayPal partner
    approval needed. **This is the cheap path, and the first thing to verify.**
  - If its checkout runs on a different app, the brand connects that one too
    (same paste-the-credentials flow).
  - The platform route (PayPal Partner Referrals, acting for any merchant)
    needs PayPal's partner approval. That's a business process, not code; start
    it only if brands can't connect their own app.
- **Catch-up**: Transaction Search (`GET /v1/reporting/transactions`, 31-day
  windows, three years back, but up to three hours behind) and the webhook
  events list with resend. Whether a merchant's own app can call Transaction
  Search without partner approval: **verify** (PayPal shows it as a per-app
  feature toggle).
- **Coupons**: PayPal has none. Orders show only a discount amount, so a partner
  code must come from the brand's own system.
- **Amounts** are decimal strings with a currency code. Ties into the INR/USD
  work in docs/paypal-payouts.md.

Scope: medium. The connection, sealing and webhook registration exist. New:
the event mapping, the subscription join, the catch-up, and a script-tag
snippet for the JS SDK.

### Wise — not a conversion source; keep it as a payout rail

Wise was the other provider named, so to be direct about it: **Wise can't give
us conversion data like Stripe's, and no connector would change that.**

- There is no checkout. A customer pays a Wise Business account by bank
  transfer or a payment link made in the Wise app, and the only reference on the
  incoming payment is free text the payer typed. Nothing our script could set
  rides along.
- The API for incoming transfers "is not publicly available" (Wise's own
  wording); balance statements over the API work only for accounts based in six
  countries; OAuth exists only for Wise Platform partners under an agreement.

Where Wise does belong is the **payout** side, which we already serve with
Wise batch files (docs/manual-payout-files.md). A next step there is sending
those payouts through the Wise API, the way Pay with PayPal sends PayPal
payouts. That's a separate item from conversion tracking.

A brand whose customers pay by bank transfer to Wise can still credit partners
today: its own system reports the payment with `POST /attribution/conversions`
and the click id it captured on the order.

### Paddle Billing — high fit

- `custom_data` can be set client-side in Paddle.js, and Paddle copies it from
  the first transaction to the subscription and to every renewal.
- HMAC-signed webhooks, a replay API, and a 90-day events API for catch-up.
- No OAuth: the brand pastes a scoped API key with read permissions plus
  `notification_setting.write`, which lets us create our own webhook
  destination through the API. Without that one write permission the brand
  adds the webhook by hand.
- Script tag: set `customData` on `Paddle.Checkout.open` (a snippet), or tag
  Paddle checkout links if the brand uses hosted checkout links (**verify** the
  URL parameter).

Scope: small to medium. The cleanest mapping of any provider.

### Shopify — high fit, the biggest e-commerce base

- An app install (OAuth) and HMAC-signed webhooks (`orders/paid`,
  `refunds/create`, disputes).
- The click rides as a cart attribute the script sets client-side (Ajax cart
  API), returned on the order. Orders also carry a customer journey summary
  (landing page, referrer, UTM, `ref`), discount codes, and subscription
  contracts copy attributes onto renewal orders.
- Costs: Shopify's app review, protected customer data access, and
  `read_all_orders` to read orders older than 60 days.
- A Web Pixel (Shopify's sandboxed customer events API) could carry the click
  through checkout without theme edits.

Scope: large: a public Shopify app, its review, a theme or pixel extension.
The payoff is every Shopify brand's checkout working with no code.

### Razorpay — high fit, India

- `notes` (15 keys × 256 characters) set in Checkout options, HMAC webhooks,
  payments listed by time, OAuth with a `read_only` scope and a partner webhooks
  API.
- Renewal payments arrive with empty `notes`: join on the subscription, whose
  notes carry the click.
- The partner path needs Razorpay Technology Partner status (a business step).
- Fits the India work (pay-by-invoice in docs/invoice-billing.md, Volza).

Scope: medium.

### Chargebee and Mollie — high fit, after the above

- **Chargebee**: custom fields can be pre-filled on the hosted page URL, renewal
  webhooks carry the whole subscription, OAuth Apps exist. Webhooks are
  basic-auth only (no signature), so verify each by fetching the event back.
- **Mollie**: subscription metadata is forwarded to every payment, Connect OAuth
  has a `webhooks.write` scope, next-generation webhooks are signed. Legacy
  webhooks send only an id: fetch to verify. The payments list has no date
  filter (page by cursor).

### Long tail — when brands ask

| Provider | Fit | Notes |
|---|---|---|
| Lemon Squeezy | medium | checkout URL `checkout[custom][...]`, signed webhooks; API key only, no date filter, three retries |
| Gumroad | medium | any URL parameter comes back in `url_params`, offer codes reported; webhooks unsigned (fetch to verify), USD only |
| Square | medium | OAuth, signed webhooks, 28-day events API; `reference_id` is server-side and 40 characters, and doesn't follow renewals |
| WooCommerce | medium | self-hosted; needs a small plugin to store the click on the order; signed webhooks, coupon lines |
| Paystack | medium | metadata and signed webhooks, but the brand pastes a full-access secret key; renewal metadata **verify** |
| Recurly, Braintree | low | server-side only references; Braintree has no webhook for a one-off sale |
| Adyen | low | no API to list payments (reports only); enterprise only, on request |

## Phases

**Phase 0 — the shared shape (no new provider).** Refactor the Stripe paths
onto a provider-neutral connection and event log (`StripeEventLog` → provider
event log), keep the catch-up generic, and add per-source rows to Tracking
health. Also from the tracking review:
- **Stripe totals on Tracking health** (built in #267): the window's paid
  invoices and one-time Checkout payments, read through the Stripe App, next
  to what OpenPartner recorded and credited, with every payment that carries
  a partner signal but wasn't recorded listed. The catch-up closes gaps from
  missed webhooks; this shows the size of what's left. The same report per
  provider is part of each connector.
- **Catch-up on a self-host** (docs/stripe-app.md follow-ups).
- **Consent-banner adapters**: the SDK's `setConsent()` wired to OneTrust,
  Cookiebot and Google Consent Mode out of the box, so brands don't write the
  callback.

**Phase 1 — PayPal through the brand's own app.** Verify first: a payment
made through the connected app fires our webhook with `custom_id`, and
Transaction Search works on the brand's own credentials. Then the mapping,
the subscription join, catch-up, and the JS SDK snippet.

**Phase 2 — Paddle**, then **Shopify** (start the app review early; it gates
the launch, not the code).

**Phase 3 — Razorpay**, then **Chargebee** and **Mollie**.

**Phase 4 — long tail on demand.** Ship the Phase 0 contract as a documented
guide so a long-tail provider is a mapping plus a test.

**Not planned**: Wise as a conversion source (payouts instead), Adyen unless an
enterprise customer brings it.

## Decisions for Keith

1. **PayPal path**: brand-connected apps (no partner approval, a pasted secret)
   first, or start PayPal partner approval now in parallel?
2. **Shopify**: worth a public app and Shopify's review this year, given the
   e-commerce share of the pipeline?
3. **Order after PayPal**: Paddle (SaaS) or Shopify (e-commerce)? Depends on
   which prospects are waiting.
4. **Wise payouts by API**: build it alongside Pay with PayPal, or keep batch
   files until a brand asks?
5. **Pasted keys**: Paddle, Lemon Squeezy and Paystack have no OAuth. Accept
   pasted, scoped, sealed keys for them (we already do for PayPal), or only
   ship OAuth providers?

## Sources

[payment-provider-research.md](payment-provider-research.md) has the full
notes: the same eight questions answered for each provider, with links to its
documentation, and what couldn't be verified.
