# @openpartner/sdk

Client + server SDK for [OpenPartner](https://github.com/getcoherence/openpartner).

- **Browser** — captures the `cref` attribution token from landing URLs and the first-party cookie, survives Safari / ITP cookie expiry via localStorage, and stitches to a logged-in user on auth.
- **Server** — posts conversion events, stitches server-side where needed, with typed errors.

Zero runtime dependencies. ~4 KB gzipped browser bundle.

```bash
npm install @openpartner/sdk
```

## Browser

Embed once on every page of your marketing site and product. The SDK runs on init, pulling the cref out of `?cref=…` (first visit from a partner link) or the `_cref` cookie (subsequent pages) and stashing it in localStorage.

```ts
import { OpenPartner } from '@openpartner/sdk';

const op = OpenPartner.init({
  apiUrl: 'https://openpartner.example.com',
});

// On signup or login — any time you learn the user's id:
await op.identify(currentUser.id);
```

That's the whole browser integration. The `identify()` call POSTs `{ cref, userId }` to `/attribution/identify` on your OpenPartner API. Errors are logged to the console by default — pass `onError` to hook in observability, or `await` the call and handle errors yourself.

### Config

```ts
OpenPartner.init({
  apiUrl: 'https://openpartner.example.com',
  // Optional:
  cookieName: '_cref',          // first-party cookie set by the click router
  queryParam: 'cref',           // query param on landing URLs
  storageKey: 'openpartner:cref', // localStorage key
  onError: (err) => Sentry.captureException(err),
});
```

### Framework notes

- **React / Vue / SolidJS**: call `OpenPartner.init()` once at the top of your app. Call `op.identify()` from your auth callback.
- **Next.js App Router**: put `OpenPartner.init()` in a `'use client'` provider component mounted in your root layout.
- **SPA with route-based auth**: `captureCref()` runs on init, so you only need one init per page load. Subsequent SPA navigations don't need to re-init.

## Server

Use the server SDK in your backend — Node 18+, Bun, Deno, Cloudflare Workers (native fetch).

```ts
import { OpenPartnerServer } from '@openpartner/sdk/server';

const op = new OpenPartnerServer({
  apiUrl: process.env.OPENPARTNER_API_URL!,
  apiKey: process.env.OPENPARTNER_API_KEY!,
});

// On signup (no revenue yet — still useful for funnel analysis):
await op.trackEvent({ userId: user.id, type: 'signup' });

// On first paid invoice:
await op.trackEvent({
  userId: user.id,
  type: 'invoice_paid',
  value: 249,
  currency: 'USD',
  externalEventId: invoice.id, // makes retries safe; see below
  metadata: { stripeInvoiceId: invoice.id },
});
```

Pass `externalEventId` on every call. Use your system's stable id for that one event, such as the invoice id or order id. Your job queue or HTTP client will retry when a request times out. Without a key, each retry records a second event and pays a second commission. With a key, a retry resolves with the original `eventId` and attribution plus `replayed: true`, and nothing new is written. That includes duplicates sent at the same moment. Use one key per event, not per order: an order's `subscription_created` and its `invoice_paid` need different keys. Reusing a key for a different `userId`, `type`, `value` or `currency` throws an `OpenPartnerError` with code `external_event_id_conflict` (409).

The response includes the attribution result:

```ts
{
  ok: true,
  eventId: '01K…',
  attribution: {
    status: 'attributed',        // or 'no_identity' / 'no_click' / 'outside_window'
    model: 'last_click',
    touches: [
      { clickId, partnerId, weight: 1, attributionId, commissionId }
    ],
  }
}
```

A replay adds `replayed: true`. Its `attribution` is rebuilt from the rows the first call wrote. If that call didn't attribute, the status is `'not_attributed'`, because the specific reason isn't stored.

For multi-touch campaigns (`linear`, `position`, etc.) `touches` will contain one entry per attributed click with a fractional `weight`.

### Conversions by click id

Sometimes the system that learns about the conversion only has the click id, not a user you `identify()`'d. A lender funds a loan, or a CRM closes a deal from a lead form that captured the click id. The click id reaches it from the partner link: as `?cref=…` on the destination URL, or in any parameter you choose, by putting `{click_id}` in the program's destination URL (`https://apply.example.com/?ref={click_id}`). Report the conversion in one call:

```ts
await op.trackConversion({
  clickId,                          // from ?cref= or your {click_id} parameter
  type: 'loan_funded',
  value: 5000,
  currency: 'USD',
  externalEventId: `${loan.id}:funded`, // required
});
```

OpenPartner stitches the click and records the event together. Without a `userId` the conversion goes to the click's own user (`click:<clickId>`), so every conversion you report for that click is credited to it, and a "first" commission rule fires once. Pass `userId` when you also identify that user elsewhere. Attribution then follows the program's model across all of that user's clicks. `externalEventId` is required and behaves as on `trackEvent`. An unknown click throws `click_not_found` (404). A click flagged as fraud throws `click_flagged` (422). The response adds `userId` to `trackEvent`'s shape.

Senders that can only fire a URL (affiliate networks, many lenders) use the postback URL from the admin Integrations page instead: `GET /postback?click_id=…&type=…&amount=…&currency=…&txn_id=…&token=…`. Its token records conversions and nothing else.

### Stripe

How Stripe revenue reaches OpenPartner depends on where OpenPartner runs.

**Hosted OpenPartner.** Call `trackEvent` from your own backend, for example in your `invoice.paid` webhook handler as shown above. OpenPartner's `/webhooks/stripe` endpoint accepts only events signed with OpenPartner's own Stripe signing secrets. A webhook you point at it from your Stripe account fails verification. A scoped API key with `events:write` is enough to call `trackEvent`; you don't need an admin key.

**Self-hosted, single tenant.** If the instance's `STRIPE_SECRET_KEY` and webhook signing secret (`STRIPE_WEBHOOK_SECRET_PLATFORM`, or the legacy `STRIPE_WEBHOOK_SECRET`) belong to *your* Stripe account, you can skip `trackEvent` for Stripe revenue. OpenPartner takes revenue from `invoice.paid` (subscriptions and other invoices) and from paid one-time Checkout Sessions (`mode: 'payment'`, including Payment Links). Point a webhook in your Stripe account at `https://<your-openpartner-api>/webhooks/stripe`. Subscribe it to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.created`, `customer.subscription.created`, `invoice.paid`, `charge.refunded` and `charge.dispute.created`.

OpenPartner has to know which Stripe customer is which referred user. Link them in one of two ways:

- **Checkout `client_reference_id`.** Pass the captured referral through when you create the Checkout Session:

  ```ts
  // Browser: the captured referral, or null if the visitor didn't come from a partner link.
  const ref = op.getReferral();

  // Your backend, with `ref` sent up from the browser:
  const session = await stripe.checkout.sessions.create({
    client_reference_id: ref ?? undefined,
    // ...line_items, mode, success_url, etc.
  });
  ```

  A Stripe Payment Link can't run your code, so let the partner link fill it in: set the program's destination URL to the Payment Link with `?client_reference_id={click_id}`, and the click router puts the click id there.

  On `checkout.session.completed`, OpenPartner stitches the session's customer to that click and records a `signup` event. A paid one-time session also records its `amount_total` as an `invoice_paid` event, keyed on the session id. A guest checkout with no Stripe Customer, the Payment Link default, is keyed to the click's own user (`click:<clickId>`). A delayed payment method (SEPA, ACH, Bacs) records the revenue at `checkout.session.async_payment_succeeded`, when the money actually clears. Subscription sessions record no revenue at checkout, because their `invoice.paid` carries it. Neither does a session with `invoice_creation` enabled, for the same reason. The customer's events are keyed to the Stripe customer id (`cus_…`). Stripe doesn't deliver events in order. If the first `invoice.paid` or `customer.subscription.created` arrives before `checkout.session.completed`, OpenPartner looks up the customer's completed Checkout Sessions in Stripe and stitches then.
- **Customer metadata `openpartner_user_id`.** Set it on the Stripe Customer to the user id you pass to `identify()`. Set it before the customer pays, for example by creating the Customer with the metadata and passing `customer` when you create the Checkout Session. An invoice that arrives before the metadata is set is skipped, and Stripe won't redeliver it.

You can use both. If the Customer already carries your `openpartner_user_id` when the checkout completes, OpenPartner stitches the click to that id instead of the `cus_…` id and leaves your metadata as you set it. The user gets one signup, although `customer.created` and `checkout.session.completed` both report it.

Once a customer is linked, OpenPartner ingests and attributes their `customer.subscription.created` and `invoice.paid` automatically, and their later one-time Checkout purchases even without a `client_reference_id`. A refund of an invoice's or one-time purchase's charge (`charge.refunded`) leaves each of that payment's commissions worth its original amount times the share of the collected amount the customer kept, so a full refund keeps nothing. Partial refunds add up. Accrued and approved commissions are reversed, and on a partial refund a replacement for the kept share is accrued with the same status and accrual date. Paid commissions stay paid: a `refund_clawback` adjustment records what the partner holds, and OpenPartner doesn't deduct it from later payouts, so recover it by hand. A commission in a payout that's in progress is held until the next refund of that charge. A dispute is recorded and reverses nothing. If you lose it, report the chargeback with `POST /attribution/refunds` (`"kind": "chargeback"`). Don't also `trackEvent` the same invoices from your backend, or the revenue is counted twice.

If `STRIPE_SECRET_KEY` is a restricted key, give it read access to Customers and Checkout Sessions. When the key isn't allowed to read one of them, OpenPartner skips that lookup instead of failing the webhook, and the event can go unattributed.

Call `trackEvent` from your backend when:

- You're on hosted OpenPartner.
- You don't use Stripe, or the customer is linked neither by a Checkout `client_reference_id` nor by `openpartner_user_id` metadata.
- The revenue doesn't come through Stripe Checkout or an invoice, such as a PaymentIntent your backend charges directly. `payment_intent.*` and `charge.succeeded` aren't ingested as revenue.
- You want to track custom event types (`trial_started`, `feature_activated`, etc.).
- You want to override the event timestamp (`ts: '2026-04-20T12:00:00Z'`).

### Error handling

All failures throw an `OpenPartnerError` with:

```ts
try {
  await op.trackEvent({ userId, type: 'signup' });
} catch (err) {
  if (err instanceof OpenPartnerError) {
    console.error(err.status, err.code, err.detail);
  }
}
```

- `status` — HTTP status (400, 401, 403, 404, 500…)
- `code` — the API's machine-readable error string (e.g. `invalid_body`)
- `detail` — the full response body (often Zod's `flatten()` output)

### Custom transport

For tests or specialized environments, pass your own `fetch`:

```ts
new OpenPartnerServer({
  apiUrl,
  apiKey,
  fetch: customFetch,
});
```

## Attribution model

```
click (on vendor router)       ← Click row on vendor's OpenPartner
  ↓
identify(cref, userId)         ← Identity row stitches click to user
  ↓
trackEvent(userId, type, value)← Event row
  ↓
attribution engine             ← Applies campaign model, emits Attribution + Commission rows
```

- **click** — visitor lands on `https://vendor.example.com/r/<slug>`. The OpenPartner router sets `_cref` cookie and writes a `Click` row.
- **identify** — once the visitor authenticates on the vendor's site, the browser SDK (or server SDK) calls `/attribution/identify` which writes an `Identity` row stitching `cref → userId`.
- **trackEvent** — any subsequent conversion event is written as an `Event` row. The attribution engine walks `Event.userId → Identity → Click → Campaign`, checks the attribution window (a repeat of a conversion the user already made, such as a renewal, keeps that conversion's partner past it), applies the configured model (`last_click` / `first_click` / `linear` / `position`), and writes `Attribution` + `Commission` rows.

## License

MIT.
