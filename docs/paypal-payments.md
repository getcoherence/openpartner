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

The brand's server creates and captures the order (PayPal's standard
integration, and what the [sample page](../examples/paypal-checkout/README.md)
does). Don't create or capture orders in the page
(`actions.order.create` / `actions.order.capture`): in our sandbox check
PayPal refused a page-side capture of a payment made with a PayPal account
(`permission_denied`).

The page, with PayPal's JS SDK and the OpenPartner script on it, sends
`openpartner.getReferral()` with the order request:

```js
const post = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    .then((r) => r.json());

paypal.Buttons({
  createOrder: () => post('/api/orders', { referral: openpartner.getReferral() }).then((order) => order.id),
  onApprove: (data) => post(`/api/orders/${data.orderID}/capture`),
}).render('#paypal-button');
```

The server puts it in `custom_id`, or reads the `op_ref` cookie the script
sets (`referralCookieHeader` in `@openpartner/sdk/server` writes one Safari
keeps):

```js
const paypal = (path, body) =>
  fetch(`https://api-m.paypal.com${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

app.post('/api/orders', async (req, res) => {
  const referral = req.body.referral ?? req.cookies.op_ref;
  const order = await paypal('/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: 'USD', value: '49.00' },
      custom_id: referral || undefined,
    }],
  });
  res.json({ id: order.id });
});

app.post('/api/orders/:id/capture', async (req, res) => {
  res.json(await paypal(`/v2/checkout/orders/${encodeURIComponent(req.params.id)}/capture`, {}));
});
```

Subscriptions are created in the page, PayPal's usual subscription
integration:

```js
paypal.Buttons({
  createSubscription: (data, actions) =>
    actions.subscription.create({
      plan_id: 'P-YOUR-PLAN',
      custom_id: openpartner.getReferral() ?? undefined,
    }),
}).render('#paypal-subscribe');
```

Or on the server: the same `custom_id` goes in the
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
  payment events and the card says to turn Customer disputes on. The
  hourly catch-up adds them once PayPal accepts them.
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
| `CUSTOMER.DISPUTE.RESOLVED` | Decided for the buyer with the brand debited: each refund PayPal lists on the dispute, recorded as that refund (see below). Otherwise nothing. |

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
- a refund of a payment OpenPartner hasn't recorded waits for it: the
  payment's own webhook may only be late, so the catch-up tries the refund
  again while PayPal still lists it (three days). After that it is left
  alone (`not_tracked`). Disputes and their resolutions wait the same way.

When PayPal takes the payment back itself (`PAYMENT.CAPTURE.REVERSED` /
`PAYMENT.SALE.REVERSED`, for example a card chargeback), that is recorded
through the same path as a `chargeback`, so the commission is reduced,
reversed or clawed back by the share taken.

A dispute is recorded and reverses nothing: disputes can be won. Its
resolution (`CUSTOMER.DISPUTE.RESOLVED`) decides what happens to the
commission:

- **Decided for the buyer, and the brand was debited the settlement**
  (the dispute's `fund_movements`, or the older `money_movements`: the
  seller's `DEBIT` for `DISPUTE_SETTLEMENT`): each refund PayPal lists on
  the dispute (`refund_details.transactions`) is recorded against the
  disputed payment, as a `refund` when the brand refunded (accepted the
  claim) and a `chargeback` when PayPal decided. It is keyed on the refund's
  own id, the one its `PAYMENT.CAPTURE.REFUNDED` / `REVERSED` webhook and
  Transaction Search use, so the same money counts once, whichever arrives
  first.
- **Decided for the brand, or PayPal covered it** (seller protection: no
  settlement debit): nothing is reversed. The brand kept the money.
- **Fees** (`DISPUTE_SETTLEMENT_FEE` and the like) are the brand's cost and
  never touch the commission.
- **A loss PayPal doesn't tie to one payment's refund** (no refund listed,
  or several disputed payments) isn't guessed at: it is counted on Tracking
  health as **PayPal dispute lost, commission not adjusted**, with the
  dispute id, for an admin to check.

A resolution PayPal changes later (an appeal) is read again. A reversal
PayPal undoes (the brand won on appeal) is not restored automatically: an
admin re-credits the partner.

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
   asked again a day later. It isn't searched in the first three hours of
   tracking: PayPal refuses a window that starts after its newest data
   ("Data for the given start date is not available"), and a later run
   searches from when tracking began.

Both sources turn into the same facts the webhook settles. Each fact
(`capture:<id>`, `sale:<id>`, `refund:<id>`, `subscription:<id>`,
`subscription_activated:<id>`, `dispute:<id>`,
`dispute_resolved:<id>:<update_time>`) is settled once, under an advisory
lock, and logged in `PaymentEventLog` with what became of it (`recorded`,
`linked`, `no_reference`, `unknown_click`, `foreign_reference`,
`test_click`, `not_tracked`, `unmatched`, `ignored`), so a webhook, its
redeliveries and the catch-up never settle it twice. A refund, dispute or
resolution of a payment not recorded yet isn't logged, so a later run
settles it. Oldest first, so a subscription is stored before its renewals
and a payment before its refunds. Bounded per app per
run (1,000 facts, 40 pages); what a run leaves is still in the window next
hour. Events it records carry `metadata.recoveredBy: "paypal_catchup"`.

Each run also checks the app's webhook against PayPal's copy
(`GET /v1/notifications/webhooks/{id}`) and puts it back to the events
OpenPartner reads, in place:
- an app set up before an event was added gets it, with nothing for the
  brand to do;
- events changed in PayPal's dashboard are put back;
- a webhook removed there is registered again;
- dispute events PayPal refused are asked for once per run, and added when
  PayPal takes them.

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
own-reference counts, and lost disputes the commission couldn't follow,
appear under **Dropped by OpenPartner**
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
  webhook (and the dispute events on a merchant's own app);
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
  counted twice; a full one can't, there's nothing left);
- a dispute PayPal decides lists its refund in `refund_details` under the
  id the refund's own events carry.

Checked on a sandbox app (Nov 2026): payments by card and by PayPal
account, refunds (a `T1107` row's `transaction_id` is the refund id the
webhook sends, and its `paypal_reference_id` the capture), disputes opened,
and a claim the brand accepted (its `PAYMENT.CAPTURE.REFUNDED`, then the
resolution listing that refund's id). The events list takes at most 100
events a page and times to the second. The sandbox never offered its
settle call (`adjudicate`), so a dispute PayPal decides, and the reversal
events, haven't been seen live.

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
9. **A dispute.** Pay again through the partner's link. In your own
   terminal, start the sandbox settle script with the app's credentials:
   ```bash
   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node examples/paypal-checkout/sandbox-dispute.mjs
   ```
   Then, as the sandbox buyer, open a dispute on that payment
   (sandbox.paypal.com/disputes, item not received): a `dispute_created` is
   recorded and the commission stays. The script picks the dispute up and
   settles it for the buyer: PayPal's sandbox-only adjudicate if PayPal
   offers it, otherwise by accepting the claim. Accepting refunds the buyer:
   a `refund` is recorded and the commission is reversed. In our checks
   (Nov 2026) PayPal never offered adjudicate, whether the dispute was
   escalated, answered or left alone, so a reversal couldn't be produced in
   the sandbox. Its parsing is covered by tests only.
10. **Transaction Search.** After the next hourly catch-up (at :50) the card
   shows no Transaction Search warning. Payments appear there up to three
   hours late, as do any the webhook missed.

## Not yet

- **Reversals undone**: a reversal PayPal undoes later (`T1202`, a
  chargeback reversed for the merchant) isn't re-credited automatically.
- **Lost disputes PayPal doesn't tie to one payment's refund** are counted
  on Tracking health for an admin, not adjusted automatically.
- **Repeat buyers without a click**: a later purchase by the same PayPal
  payer whose browser lost the referral isn't credited. The payer id is on
  the order, not the capture, so it would cost a read per payment.
- **No-code PayPal payment links and buttons** have no reference to carry.
- **The platform route** (PayPal Partner Referrals) for brands that can't
  connect their own app needs PayPal's partner approval first.
- **Stripe's event log** (`StripeEventLog`) hasn't moved onto the
  provider-neutral `PaymentEventLog` yet (roadmap phase 0).
