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
  metadata: { stripeInvoiceId: invoice.id },
});
```

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

For multi-touch campaigns (`linear`, `position`, etc.) `touches` will contain one entry per attributed click with a fractional `weight`.

### Stripe webhooks

On a single-tenant self-host whose `STRIPE_SECRET_KEY` and webhook signing secret belong to *your* Stripe account, OpenPartner's built-in `/webhooks/stripe` handler ingests `checkout.session.completed`, `customer.created`, `customer.subscription.created` and `invoice.paid` for you. Point a webhook in your Stripe account at `https://<your-openpartner-api>/webhooks/stripe`, and you don't need to call `trackEvent` for Stripe revenue. Hosted OpenPartner only accepts events signed with its own Stripe secrets, so on hosted, call `trackEvent` from your backend instead.

OpenPartner has to know which Stripe customer is which referred user. Link them in one of two ways:

- **Checkout `client_reference_id`.** When you create the Checkout Session, pass the referral the browser captured: `client_reference_id: ref ?? undefined`, where `ref` is `op.getReferral()` sent up from the browser. OpenPartner stitches the session's customer to the partner click, and its events are keyed to the Stripe customer id (`cus_…`). Stripe doesn't deliver events in order. If `invoice.paid` or `customer.subscription.created` arrives before `checkout.session.completed`, OpenPartner looks up the customer's completed Checkout Sessions in Stripe and stitches then.
- **Customer metadata `openpartner_user_id`.** Set it on the Stripe Customer to the user id you pass to `identify()`. Set it before the customer pays, for example by creating the Customer with the metadata and passing `customer` when you create the Checkout Session. An invoice that arrives before the metadata is set is skipped, and Stripe won't redeliver it.

Call `trackEvent` from your backend when:

- You don't use Stripe (or Stripe isn't the source of the conversion).
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
- **trackEvent** — any subsequent conversion event is written as an `Event` row. The attribution engine walks `Event.userId → Identity → Click → Campaign`, checks the attribution window, applies the configured model (`last_click` / `first_click` / `linear` / `position`), and writes `Attribution` + `Commission` rows.

## License

MIT.
