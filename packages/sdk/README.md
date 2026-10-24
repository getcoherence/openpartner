# @openpartner/sdk

Client + server SDK for [OpenPartner](https://github.com/getcoherence/openpartner).

- **Browser** — captures the `cref` attribution token from landing URLs and first-party cookies, keeps it across pages and subdomains, waits for consent when you ask it to, and stitches to a logged-in user on auth.
- **Server** — posts conversion events, stitches server-side where needed, with typed errors.

Zero runtime dependencies. ~4 KB gzipped browser bundle.

```bash
npm install @openpartner/sdk
```

## Browser

Embed once on every page of your marketing site and product. The SDK runs on init, pulling the cref out of `?cref=…` (first visit from a partner link), or on later pages out of localStorage or a first-party cookie (`_cref` from the click router, `op_ref` from a sibling subdomain or your server), and stashing it in localStorage.

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
  stripe: { linkHosts: ['pay.yourbrand.com'] }, // or false — see below
  referralCookie: { name: 'op_ref', domain: '.yourbrand.com' }, // off by default
  consent: 'pending',           // default 'granted' — see Consent below
  reportLanding: true,          // default on — see Landing report below
});
```

### Subdomains

A visitor who lands on `www.yourbrand.com` and signs up on `app.yourbrand.com` has two localStorages, one per subdomain. Share the referral through a cookie on the parent domain: `referralCookie: { domain: '.yourbrand.com' }` (script tag: `data-cookie-domain=".yourbrand.com"`) on every subdomain. The SDK on `app.` reads `op_ref` back when its own storage is empty, so `identify()` and Stripe links work there too. A journey across two different domains (`yourbrand.com` → `yourbrand-shop.com`) has no shared cookie: carry `?cref=` on the link between them.

### Safari and long gaps

Safari deletes storage a page's scripts wrote (localStorage, and cookies set through `document.cookie`) after 7 days without a visit. A visitor who clicks, comes back after a fortnight and buys without signing up first would arrive with nothing. Two things close that gap:

- **Call `identify()` as early as you can.** Once a click is stitched to a user, the link lives on OpenPartner's side and no browser storage matters. An email capture or account creation before checkout is enough.
- **Set the referral cookie from your own server**, on the landing page's response. A cookie your server sets keeps its full lifetime in Safari, and the browser SDK reads it back:

  ```ts
  import { referralCookieHeader, referralCookieMiddleware } from '@openpartner/sdk/server';

  // Express / Connect:
  app.use(referralCookieMiddleware({ domain: '.yourbrand.com' }));

  // Anything else (Next.js middleware, a Worker): set the header yourself.
  const header = referralCookieHeader(request.url, { domain: '.yourbrand.com' });
  if (header) response.headers.append('Set-Cookie', header);
  ```

  Set it from the server that serves the page. Safari caps a cookie at 7 days when it comes from a server on a different IP address than the site, such as an API hosted on another provider. The SDK never rewrites an `op_ref` cookie that already holds the referral, because rewriting it from script would bring the 7-day cap back.

### Consent

Behind a consent banner, start the SDK with `consent: 'pending'` and tell it the answer:

```ts
const op = OpenPartner.init({ apiUrl, consent: 'pending' });

yourConsentBanner.onChange((choices) => {
  op.setConsent(choices.marketing ? 'granted' : 'denied');
});
```

While consent is pending, the SDK keeps the click from the URL in memory and does nothing else: it doesn't read or write storage or cookies, tag Stripe links, or call OpenPartner. `setConsent('granted')` then works as if the page had just loaded, even after the visitor has navigated within a single-page app. `setConsent('denied')` stops everything, takes the references the SDK added back off Stripe links and embeds (one you set yourself stays), and deletes what was stored. Starting with `consent: 'denied'` deletes what an earlier visit stored. `getReferral()` and `identify()` return `null` until consent is granted. Script tag: `data-consent="pending"`, then `openpartner.setConsent('granted')`.

Clicks from visitors who never consent can't be credited, and Admin → Tracking health counts them among the clicks that never landed.

### Landing report

When a partner click first arrives from the URL, the SDK tells OpenPartner (`POST /attribution/landing`, the click id and nothing else; the page's hostname comes from the browser's `Origin` header). **Admin → Tracking health** compares landings with clicks to show the ones lost between the partner link and your page: a redirect that dropped `?cref=`, a page without the script, a consent banner. A `click_not_found` from it reaches `onError` and usually means `apiUrl` names another program; any other failure is dropped, because the report is a diagnostic and never part of attribution. Turn it off with `reportLanding: false` (script tag: `data-landing="off"`).

### Stripe links and embeds

When the visitor came from a partner link, the SDK hands that click to Stripe for you:

- Every Payment Link on the page (`buy.stripe.com`, plus any `linkHosts` you list for a custom Payment Link domain) gets `client_reference_id`.
- Every `<stripe-pricing-table>` and `<stripe-buy-button>` embed gets `client-reference-id`.

That includes elements added after the page loads. A link or embed that already carries a reference keeps it. With your Stripe account connected to OpenPartner (or your self-host's webhook pointed at it), those checkouts then credit the partner with no code at all. `stripe: false` turns it off. For an app-created Checkout Session, pass `op.getReferral()`, or the `op_ref` cookie with `referralCookie` set, as `client_reference_id`.

Pricing Table and Buy Button embeds read `client-reference-id` when Stripe renders them, so load the SDK before Stripe's embed script.

### Script tag (no bundler)

An OpenPartner portal serves a self-starting build of this SDK at `/op.js`. Paste it into your site's `<head>`:

```html
<script src="https://app.openpartner.dev/op.js" data-api-url="https://app.openpartner.dev/api/t/your-slug"></script>
```

**Admin → Integrations** shows the exact tag for your program. It does everything above, keeps the referral in an `op_ref` cookie on your domain, and exposes `window.openpartner` (`openpartner.identify(userId)`, `openpartner.getReferral()`, `openpartner.setConsent('granted')`). Optional attributes:
- `data-stripe-hosts="pay.yourbrand.com"`: a custom Payment Link domain.
- `data-cookie-domain=".yourbrand.com"`: share `op_ref` across subdomains.
- `data-consent="pending"`: wait for `openpartner.setConsent()` (see [Consent](#consent)).
- `data-stripe="off"`, `data-cookie="off"`, `data-landing="off"`: turn any of them off.

The npm package carries the same file at `dist-global/openpartner.js`.

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

**Hosted OpenPartner.** Connect your Stripe account under **Admin → Integrations → Connect Stripe**. That installs the OpenPartner Stripe App on it (beta; read-only except coupons and promotion codes), and your Checkout and Payment Link purchases, invoices, renewals, refunds and disputes are then recorded from Stripe, with no `trackEvent` for them. Customers are linked to the partner click the same way as on self-host, below: the [script tag](#script-tag-no-bundler) does it for Payment Links and embeds on your site, and a Checkout Session your backend creates passes `client_reference_id`. With Stripe connected, a `trackEvent` keyed on a Stripe invoice or Checkout Session id (`in_…`, `cs_…`) throws `recorded_from_stripe` (409): Stripe's record of the payment wins. See [openpartner.dev/docs/stripe-app](https://openpartner.dev/docs/stripe-app). Don't point a webhook from your Stripe account at OpenPartner's `/webhooks/stripe`: on hosted it accepts only events signed with OpenPartner's own Stripe signing secrets.

**Self-hosted, single tenant.** If the instance's `STRIPE_SECRET_KEY` and webhook signing secret (`STRIPE_WEBHOOK_SECRET_PLATFORM`, or the legacy `STRIPE_WEBHOOK_SECRET`) belong to *your* Stripe account, you can skip `trackEvent` for Stripe revenue. OpenPartner takes revenue from `invoice.paid` (subscriptions and other invoices) and from paid one-time Checkout Sessions (`mode: 'payment'`, including Payment Links). Point a webhook in your Stripe account at `https://<your-openpartner-api>/webhooks/stripe`. Subscribe it to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.created`, `customer.subscription.created`, `invoice.paid`, `charge.refunded` and `charge.dispute.created`.

The endpoint can use any Stripe API version, including the one Stripe preselects when you create it. Version `2025-03-31.basil` removed the invoice ↔ payment pointers from webhook payloads (`Invoice.charge`, `Invoice.payment_intent`, `Charge.invoice`). On basil and later, OpenPartner reads a refunded charge's invoice back from Stripe's InvoicePayments: one Stripe API call per refund of an invoice's charge.

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

  With the [script tag](#script-tag-no-bundler) (or `referralCookie` set), your backend can read the referral straight off the request instead: `client_reference_id: req.cookies.op_ref`, or `readReferralCookie(req.headers.cookie)` from `@openpartner/sdk/server` without a cookie parser. The same call lets your backend stitch at signup, which works even where browser scripts are blocked: `await op.identify({ cref, userId: user.id })`.

  A Stripe Payment Link can't run your code, so let the partner link fill it in: set the program's destination URL to the Payment Link with `?client_reference_id={click_id}`, and the click router puts the click id there.

  On `checkout.session.completed`, OpenPartner stitches the session's customer to that click and records a `signup` event. A paid one-time session also records its `amount_total` as an `invoice_paid` event, keyed on the session id. A guest checkout with no Stripe Customer, the Payment Link default, is keyed to the click's own user (`click:<clickId>`). A delayed payment method (SEPA, ACH, Bacs) records the revenue at `checkout.session.async_payment_succeeded`, when the money actually clears. Subscription sessions record no revenue at checkout, because their `invoice.paid` carries it. Neither does a session with `invoice_creation` enabled, for the same reason. The customer's events are keyed to the Stripe customer id (`cus_…`). Stripe doesn't deliver events in order. If the first `invoice.paid` or `customer.subscription.created` arrives before `checkout.session.completed`, OpenPartner looks up the customer's completed Checkout Sessions in Stripe and stitches then.
- **Customer metadata `openpartner_user_id`.** Set it on the Stripe Customer to the user id you pass to `identify()`. Set it before the customer pays, for example by creating the Customer with the metadata and passing `customer` when you create the Checkout Session. An invoice that arrives before the metadata is set is skipped, and Stripe won't redeliver it.

You can use both. If the Customer already carries your `openpartner_user_id` when the checkout completes, OpenPartner stitches the click to that id instead of the `cus_…` id and leaves your metadata as you set it. The user gets one signup, although `customer.created` and `checkout.session.completed` both report it.

Once a customer is linked, OpenPartner ingests and attributes their `customer.subscription.created` and `invoice.paid` automatically, and their later one-time Checkout purchases even without a `client_reference_id`. A refund of an invoice's or one-time purchase's charge (`charge.refunded`) leaves each of that payment's commissions worth its original amount times the share of the collected amount the customer kept, so a full refund keeps nothing. Partial refunds add up. Accrued and approved commissions are reversed, and on a partial refund a replacement for the kept share is accrued with the same status and accrual date. Paid commissions stay paid: a `refund_clawback` adjustment records what the partner holds, and OpenPartner takes it off that partner's next manual or self-hosted Stripe Connect payout. Stripe Connect payouts on hosted OpenPartner don't deduct it, so recover those by hand. A commission in a payout that's in progress is held until the next refund of that charge. Since `2025-03-31.basil`, an invoice can be paid in several payments, and one payment can pay several invoices. A refund of such a payment is recorded but reverses nothing, because the charge doesn't say how much of which invoice it gave back. Report it with `POST /attribution/refunds` and the amount. A dispute is recorded and reverses nothing. If you lose it, report the chargeback with `POST /attribution/refunds` (`"kind": "chargeback"`). Don't also `trackEvent` the same invoices from your backend, or the revenue is counted twice.

If `STRIPE_SECRET_KEY` is a restricted key, give it read access to Customers, Checkout Sessions and Invoices. Invoices covers a promo code applied to an invoice, and on API versions from `2025-03-31.basil` the InvoicePayment that names a refunded charge's invoice. When the key isn't allowed to read one of them, OpenPartner skips that lookup instead of failing the webhook, and the event can go unattributed.

Call `trackEvent` from your backend when:

- You're on hosted OpenPartner and haven't connected Stripe.
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
