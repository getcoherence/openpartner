# PayPal payments: conversions from the brand's own PayPal app

A brand whose customers pay with PayPal can have those payments credit its
partners the way Stripe payments do: each payment, each subscription
renewal and each refund that goes through the brand's PayPal REST app is
recorded, with nothing forwarded from the brand's server. This is phase 1
of [payment-provider-roadmap.md](payment-provider-roadmap.md) (the
brand-connected path; no PayPal partner approval).

It reuses the connection Pay with PayPal already makes
([paypal-payouts.md](paypal-payouts.md)): the brand's own client id and
secret, sealed, and a webhook OpenPartner registers on that app. OpenPartner
never touches the money. It reads what the brand's app reports.

Code: `apps/api/src/paypal-payments.ts` (the mapping),
`paypal-payments-catchup.ts` (the hourly catch-up), `paypal-connection.ts`
(connecting, tracking on and off), `paypal-api.ts`,
`routes/paypal-webhook.ts`, `routes/paypal.ts`; portal
`pages/admin/PaypalPaymentsCard.tsx` (Admin → Integrations → PayPal) and
`pages/admin/TrackingHealth.tsx`.

## The click rides the payment

The brand's checkout puts the visitor's partner click, which the
OpenPartner script captured (`openpartner.getReferral()`), in the order's
`purchase_units[].custom_id`. PayPal returns it on the capture
(`PAYMENT.CAPTURE.COMPLETED`) and in Transaction Search. Nothing else about
the buyer is needed or read.

- **Never `invoice_id`.** PayPal holds it unique per merchant, so a click
  there couldn't buy twice.
- **A brand already using `custom_id`** for its own reference adds the click
  after it, separated by a space or `|`: `order-1042|01JC…`. Every
  click-shaped value (a 26-character click id) in `custom_id` is tried, in
  order, and the first that names one of the brand's clicks wins.
- **Subscriptions** have their own `custom_id` (up to 127 characters), set
  the same way when the subscription is created.
- **No-code PayPal payment links** have no documented way to carry a
  reference, so they can't be tracked.

### The checkout code

Client-side, with PayPal's JS SDK and the OpenPartner script on the page:

```js
paypal.Buttons({
  createOrder: (data, actions) =>
    actions.order.create({
      purchase_units: [{
        amount: { currency_code: 'USD', value: '49.00' },
        custom_id: openpartner.getReferral() ?? undefined,
      }],
    }),
  onApprove: (data, actions) => actions.order.capture(),
}).render('#paypal-button');

// Subscriptions
paypal.Buttons({
  createSubscription: (data, actions) =>
    actions.subscription.create({
      plan_id: 'P-YOUR-PLAN',
      custom_id: openpartner.getReferral() ?? undefined,
    }),
}).render('#paypal-subscribe');
```

Server-side (PayPal's standard integration, and what the sample page does;
in our sandbox check PayPal refused a client-side capture with
`permission_denied`): the page
sends `openpartner.getReferral()` with its request, or the server reads the
`op_ref` cookie the script sets (`referralCookieHeader` in
`@openpartner/sdk/server` writes one Safari keeps).

```js
const referral = req.body.referral ?? req.cookies.op_ref;
await fetch('https://api-m.paypal.com/v2/checkout/orders', {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: 'USD', value: '49.00' },
      custom_id: referral || undefined,
    }],
  }),
});
```

For a subscription, the same `custom_id` goes in the
`POST /v1/billing/subscriptions` body.

## Connecting (Admin → Integrations → PayPal)

PayPal sends a webhook only to the REST app a payment went through, so the
app that records payments must be the one the checkout uses.

- **The checkout runs on Pay with PayPal's app.** Press **Record its
  payments** on that app (`POST /config/paypal/{environment}/payments`
  `{"tracking": true}`). OpenPartner adds the payment events to the webhook
  it already has on the app, in place, with the credentials it already
  holds: a brand connected before this needs to paste nothing again, and the
  app never gets a second webhook (PayPal allows 10 per app). One removed in
  PayPal's dashboard since is registered again. **Stop recording** takes the
  payment events off again.
- **Disputes are optional.** If PayPal refuses the dispute event for an app
  (one without the Customer disputes feature), the webhook takes the other
  payment events and the card says to turn Customer disputes on, then
  record its payments again.
- **The checkout runs on another app.** **Connect your checkout's PayPal
  app** and paste that app's client id and secret
  (`POST /config/paypal-payments`). It is verified, sealed and never shown,
  logged or exported, exactly like Pay with PayPal's, and gets a webhook of
  its own for the payment events only. It never sends payouts: the database
  refuses to make it the active sending app. Pay with PayPal's own app is
  refused here (`409 same_app_as_payouts`), so one app never has two
  webhooks for the same payments. **Disconnect** removes its webhook and
  wipes its secret (`DELETE /config/paypal-payments/{environment}`).
- **Nothing before tracking began is recorded.** The catch-up never reaches
  back past the moment tracking was turned on, as a new Stripe connection
  leaves its account's history alone.
- **A new secret for the same app** keeps tracking and its start. Replacing
  Pay with PayPal's app with a different app turns tracking off for it: that
  app's checkout may not be this one.

The webhook needs `PORTAL_URL` to be a public https address, as for Pay with
PayPal. Without one, nothing is registered and payments are read from
Transaction Search every hour instead (below).

## What each PayPal event becomes

Every payment is recorded under the click's own user (`click:<clickId>`, as
`POST /attribution/conversions` without a `userId`), stitched to the click.
All of one click's payments land on that one user, which is what lets
renewals stay with the partner.

| PayPal event | Recorded |
|---|---|
| `PAYMENT.CAPTURE.COMPLETED` | `invoice_paid`, the captured amount, keyed on the capture id, attributed. |
| `BILLING.SUBSCRIPTION.CREATED` | Nothing yet: the subscription's `custom_id` and the click it names are stored (`PaypalSubscription`). |
| `BILLING.SUBSCRIPTION.ACTIVATED` | `subscription_created`, keyed on the subscription id, attributed (the buyer approved it). |
| `PAYMENT.SALE.COMPLETED` | `invoice_paid` for a subscription payment, the first and every renewal, keyed on the sale id, joined to its subscription. |
| `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.SALE.REFUNDED` | A `refund` against the payment's Event, through `POST /attribution/refunds`' own path. |
| `PAYMENT.CAPTURE.REVERSED`, `PAYMENT.SALE.REVERSED` | A `chargeback` against the payment's Event, the same path: PayPal took the payment back. |
| `CUSTOMER.DISPUTE.CREATED` | `dispute_created` under the disputed payment's user. Reverses nothing. |

Events carry `metadata.via: "paypal"`, the PayPal event type and PayPal's
own ids (`paypalCaptureId`, `paypalOrderId`, `paypalSaleId`,
`paypalSubscriptionId`, `paypalRefundId`, `paypalReversalId`,
`paypalDisputeId`), `paypalEnvironment` (`live` or `sandbox`) and the raw
`custom_id` (`paypalCustomId`). A pending capture or refund records nothing
until PayPal sends its completion. A payment of zero is skipped.

A payment whose `custom_id` names no click of the brand's records nothing.
One shaped like a click id is counted on Tracking health as
**PayPal payment carried an unknown click**, anything else as **PayPal
payment carried your own reference**; one with no `custom_id` is counted
among the PayPal payments without a click. A brand's own conversion call
keyed on the PayPal transaction id is the same Event, whichever came first.

### Renewals

Renewal payments arrive as the older `PAYMENT.SALE.COMPLETED`, which doesn't
carry the subscription's `custom_id`. Each sale is joined on
`billing_agreement_id` (the subscription id):

1. the stored subscription (from `BILLING.SUBSCRIPTION.CREATED`), or
2. PayPal's read of it (`GET /v1/billing/subscriptions/{id}`), stored for
   the next renewal, when its CREATED event came late or before tracking
   was on;
3. for a sale webhook without `billing_agreement_id` (reported for some),
   the transactions of the app's 20 most recent subscriptions that named a
   click (`GET /v1/billing/subscriptions/{id}/transactions`). A sale none of
   them has is left unsettled for the catch-up: Transaction Search names
   every subscription payment's subscription.

The subscription's first `custom_id` is kept: a renewal's partner can't
change under it. Because every payment of the subscription is the click
user's `invoice_paid`, attribution's renewal rule applies as it does to a
Stripe customer ([renewal-attribution.md](renewal-attribution.md)): with
`Program.renewalsStayWithPartner` on, renewals stay with the partner who won
the customer past the attribution window (only recurring rules pay past
it); with it off, each payment is judged against the window alone.

### Refunds and disputes

A refund is recorded with `recordRefund`, the code behind
`POST /attribution/refunds`, against the payment's `invoice_paid` Event:

- each refund is its own amount, so partial refunds add up, and the
  conversion's commissions end up worth the share the customer kept:
  accrued or approved ones reversed (with a replacement for a partial
  refund), paid ones clawed back on the partner's next payout
  ([refund-clawback-netting.md](refund-clawback-netting.md));
- the refund Event names its conversion (`metadata.conversionEventId`), so
  the platform fee and bounties net it like an API refund
  ([platform-fee.md](platform-fee.md));
- a redelivery repeats exactly what was recorded and finishes anything a
  payout in flight held;
- a refund larger than what's left (other refunds reported through the API)
  refunds what's left, marked `cappedToRemaining`;
- a refund of a payment OpenPartner never recorded is left alone.

A dispute is recorded and reverses nothing: disputes can be won. When PayPal
takes the payment back (`PAYMENT.CAPTURE.REVERSED` / `PAYMENT.SALE.REVERSED`:
a dispute lost, a card chargeback), that is recorded through the same path
as a `chargeback`, so the commission is reduced, reversed or clawed back by
the share taken. A reversal PayPal later undoes (the brand won on appeal) is
not restored automatically: an admin re-credits the partner.

## Sandbox

A sandbox app's payments are recorded exactly like a live app's: Events,
attribution, commissions, refunds, reversals and disputes. That is what lets
a test workspace run the whole flow on PayPal's test money. Their Events say
`metadata.paypalEnvironment: "sandbox"`, and the platform fee never bills
them (usage-ledger.ts). Don't track a sandbox app in a workspace with real
partners: their clicks would earn commissions on test money.

A payment (or subscription) from either app whose `custom_id` carries an
admin's [test click](tracking-health.md#send-a-test-click) links the test
("A PayPal payment carried it") and records nothing else: test clicks are
never Clicks.

## Missed webhooks: the catch-up

PayPal retries a failed delivery for three days. The `paypal-payments-catchup`
job (hourly, every mode, `OPENPARTNER_ENABLE_SCHEDULER=1`) reads two
sources for each app that records payments, with the brand's own
credentials:

1. **The webhook events PayPal generated for the app**
   (`GET /v1/notifications/webhooks-events`), when OpenPartner has a webhook
   on it: the last 72 hours, minus the last 30 minutes a delivery may still
   be on its way for.
2. **Transaction Search** (`GET /v1/reporting/transactions`): the last four
   days, in windows of at most 31 days. It runs up to three hours behind but
   needs no webhook, so it is the only source for a deployment PayPal can't
   post to, and it names every subscription payment's subscription
   (`paypal_reference_id_type: SUB`). Payments received (`T00xx`, positive)
   become captures or sales, `T1107` rows refunds, `T1106` (a reversal) and
   `T1201` (a card chargeback) rows chargebacks; payouts sent, holds and
   fees are skipped. PayPal turns Transaction Search on per app: an app it
   refuses (403) shows **Turn on Transaction Search** on its card and is
   asked again a day later.

Both sources turn into the same facts the webhook settles. Each fact
(`capture:<id>`, `sale:<id>`, `refund:<id>`, `subscription:<id>`,
`subscription_activated:<id>`, `dispute:<id>`) is settled once, under an
advisory lock, and logged in `PaymentEventLog` with what became of it
(`recorded`, `linked`, `no_reference`, `unknown_click`,
`foreign_reference`, `test_click`, `not_tracked`, `ignored`), so
a webhook, its redeliveries and the catch-up never settle it twice. Oldest
first, so a subscription is stored before its renewals. Bounded per app per
run (1,000 facts, 40 pages); what a run leaves is still in the window next
hour. Events it records carry `metadata.recoveredBy: "paypal_catchup"`.

## Amounts and currencies

PayPal sends decimal strings with a currency code. They're stored as the
Event's value and currency as they are: zero-decimal currencies (JPY, HUF,
TWD) arrive as whole units and stay whole. Currencies are upper-cased like
every other path, and the hosted GMV meter converts non-USD revenue with the
ECB rate as it does for Stripe ([platform-fee.md](platform-fee.md)).

## Tracking health

Admin → Tracking health shows, once an app records payments, **PayPal
payments with a partner click**: of the window's PayPal payments, how many
carried a click, how many came with no `custom_id`, how many with one
naming no click, and how many the catch-up recorded after the webhook
missed them; and **Last received → PayPal payment**. The unknown-click and
own-reference counts appear under **Dropped by OpenPartner**
([tracking-health.md](tracking-health.md)).

## Portability

- What the payments recorded is ordinary raw `Event`, `Identity`,
  `Attribution` and `Commission` rows, exported like every other
  (principle 1): a bundle restored elsewhere re-derives the same
  attribution, renewals included.
- `PaypalConnection` stays credentials for one deployment: never exported.
- `PaymentEventLog` is a delivery log (pruned after 95 days) and
  `PaypalSubscription` a cache of PayPal's own data. Neither is exported
  ([data-portability.md](data-portability.md)). On another instance, a
  renewal of a subscription it hasn't seen is read back from PayPal, and the
  click user it lands on is the same.
- The tenant purge deletes both (`TENANT_PURGE_ORDER`).

## API

All admin-only; see `/docs` for the schemas.

| Operation | What it does |
|---|---|
| `GET /config/paypal-payments` | every connected app, and whether it records payments |
| `POST /config/paypal/{environment}/payments` (`{ tracking }`) | record Pay with PayPal's app's payments, or stop |
| `POST /config/paypal-payments` (`{ environment, clientId, clientSecret }`) | connect the checkout's own app |
| `DELETE /config/paypal-payments/{environment}` | disconnect it |
| `POST /webhooks/paypal/{connectionId}` | PayPal's webhook (public, verified by PayPal), shared with Pay with PayPal |

## Checking it against PayPal

The automated tests run against a fake PayPal
(`apps/api/src/__tests__/fake-paypal.ts`) built from PayPal's documented
payloads. What still needs PayPal itself:

- a payment through the connected app fires the webhook with `custom_id`,
  and PayPal accepts the PATCH that adds the payment events to an existing
  webhook (and `CUSTOMER.DISPUTE.CREATED` on a merchant's own app);
- Transaction Search works on the brand's own credentials, takes the date
  format (`2026-11-02T10:00:00Z`), and its ids match the webhook's (a
  capture's `transaction_id` is the capture id, a subscription payment's the
  sale id);
- `custom_id` passes through `actions.subscription.create`, renewals carry
  `billing_agreement_id`, and a subscription's transactions list its sale
  ids;
- the events list's retention and next-page link;
- a v2 refund's `up` link names the capture, and a `T1107` row's
  `paypal_reference_id` is the refunded payment;
- a reversal's resource is a refund naming the capture (v2) or the sale
  (`sale_id`, or a `/v1/payments/sale/` link), and its `T1106` row carries
  the same id as the webhook's (otherwise a partial reversal could be
  counted twice; a full one can't, there's nothing left).

**Where to run it.** PayPal posts webhooks only to public https addresses.
Run the check **after deploying, in a test workspace on the hosted app**:
the change is additive (new columns and tables; Pay with PayPal unchanged)
and nothing happens for any brand until an admin presses **Record its
payments**. A local stack behind a public tunnel works too, but `PORTAL_URL`
then has to be the tunnel's address, which every sign-in link uses as well.
Only the webhook needs to be public: the checkout page can run on
`localhost`.

**Steps** (a test workspace of your own, approved):

1. In PayPal's developer dashboard, on the sandbox app, tick **Customer
   disputes** and **Transaction search**. Under Sandbox Accounts, note the
   Personal (buyer) account.
2. In the workspace, create a program whose rule pays a percentage of
   `invoice_paid`, a partner and their link. Set the program's destination
   to `http://localhost:3001/`.
3. **Settings → Pay with PayPal → Connect sandbox app**: paste the app's
   client id and secret there yourself (nowhere else). Then **Integrations
   → PayPal → Record its payments** on it. Expect "Recording payments" and no
   note about disputes. In PayPal's dashboard, the app's Webhooks list shows
   one webhook, OpenPartner's, now with the payment events too.
4. Run the sample checkout page
   ([examples/paypal-checkout](../examples/paypal-checkout/README.md)) in
   your own terminal with the app's client id and secret: it creates and
   captures orders on the server. Add `PAYPAL_PLAN_ID` (a sandbox plan of the
   same app) to test subscriptions.
5. **The test click.** Tracking health → **Send a test click** on the
   program. The tab lands on the page, which shows the click. Pay with the
   sandbox buyer. Within a minute the test's last step reads "A PayPal
   payment carried it", and nothing is recorded.
6. **Conversion and commission.** Click the partner's link in a private
   window and pay with the sandbox buyer (the page's `AMOUNT`). Within a
   minute Admin → Commissions shows an `invoice_paid` under the partner with
   its commission, and Tracking health counts a PayPal payment with a click.
7. **Refunds.** In the sandbox merchant account (sandbox.paypal.com, the
   app's Business account): Activity → the payment → Refund part of it. The
   commission drops to the share kept. Refund the rest: it is reversed.
8. **Subscriptions.** Through `/?mode=subscription`, subscribe with the
   sandbox buyer: `subscription_created` at approval and an `invoice_paid`
   for the first payment, under the same partner.
9. **A dispute, then a reversal.** Pay again through the partner's link.
   As the sandbox buyer, open a dispute on that payment (Resolution Center,
   item not received): a `dispute_created` is recorded and the commission
   stays. Then settle it for the buyer with PayPal's sandbox-only calls,
   from your own terminal, with the app's credentials:
   ```bash
   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node examples/paypal-checkout/sandbox-dispute.mjs PP-D-…
   ```
   It escalates the dispute to a claim and settles it in the buyer's favour.
   PayPal reverses the payment: a `chargeback` is recorded and the
   commission is reversed.
10. **Transaction Search.** After the next hourly catch-up (at :50) the card
   shows no Transaction Search warning. Payments appear there up to three
   hours late, as do any the webhook missed.

## Not yet

- **Reversals undone**: a reversal PayPal undoes later (`T1202`, a
  chargeback reversed for the merchant) isn't re-credited automatically.
- **Repeat buyers without a click**: a later purchase by the same PayPal
  payer whose browser lost the referral isn't credited. The payer id is on
  the order, not the capture, so it would cost a read per payment.
- **No-code PayPal payment links and buttons** have no reference to carry.
- **The platform route** (PayPal Partner Referrals) for brands that can't
  connect their own app needs PayPal's partner approval first.
- **Stripe's event log** (`StripeEventLog`) hasn't moved onto the
  provider-neutral `PaymentEventLog` yet (roadmap phase 0).
