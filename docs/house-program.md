# OpenPartner's own partner program

OpenPartner runs a partner program of its own on the hosted platform: a
tenant whose partners refer brands to OpenPartner and earn commission on what
those brands pay. This page covers how a referral is credited from click to
invoice. The code is `apps/api/src/house-program.ts`.

## Setup

1. **Pick the program's brand.** In the ops console, open **Own program**
   (`/platform/own-program`) and enter the brand's slug. It's stored in
   `PlatformSetting` (`houseProgram`). With no brand set, nothing below runs.
2. **Connect the Stripe App to the billing account.** In that brand's
   dashboard, connect the Stripe App to the Stripe account OpenPartner bills
   brands from. The Own program tab shows the connected account.
3. **Put op.js on the marketing site.** The tag carries
   `data-cookie-domain=".openpartner.dev"`, so the `op_ref` cookie it writes
   reaches app.openpartner.dev, and `data-api-url` names the program's tenant
   (`/api/t/<slug>`). It also carries `data-stripe="off"`: billing Checkout must
   never carry a `client_reference_id` (see below).

## How a referral is credited

A referred brand is one user in the program's tenant. Its userId is the
brand's own tenant id.

| Step | What happens |
| --- | --- |
| Click | The partner's link goes through the router as usual. op.js on openpartner.dev stores the click in `op_ref`, once the visitor accepts the cookie banner. |
| Signup | `POST /signup` and `POST /me/brands` (Google sign-up) look for one of the program's clicks: the signup page's own `?cref=`, sent in the body, comes first, then the `op_ref` cookie. With a match they record an Identity and a `signup` Event (`externalEventId` `brand_signup:<tenantId>`), attributed as usual. The router's `_cref` cookie isn't read, because every brand's clicks share it. |
| Billing customer | When `/billing/checkout` or `/billing/invoice-subscription` creates the brand's Stripe Customer, a referred brand also gets `metadata.openpartner_user_id` = its tenant id. |
| Subscription and invoices | The billing account's events reach `/webhooks/stripe-app` through the program brand's connection. They map like any connected brand's events: `customer.created` is deduplicated against the signup, and `customer.subscription.created` and `invoice.paid` resolve to the brand's user and credit the partner under the program's commission rules. |

## Guard on /webhooks/stripe

`/webhooks/stripe` also receives these billing Customers, as OpenPartner's own
account, and resolves them to the brand's own tenant. There, a Customer with
`openpartner_role: merchant_self_subscription` has its `openpartner_user_id`
ignored (`customerUserId` in `routes/stripe-webhook.ts`). Without that, the
brand's own customer and subscription events would be recorded as
conversions in its own program.

Billing Checkout never sets `client_reference_id`. `handleConnectEvent`
treats one as "not our subscription" and would skip persisting the brand's
subscription.

## What isn't credited

- A signup with no click from the program: no Identity, no Event and no
  metadata.
- A Google sign-up that started from a link straight to the signup page. The
  `?cref=` doesn't survive the Google round trip, and only `op_ref` is read
  there.
- A brand whose billing Customer was created before its referral was
  recorded. The metadata is only written when the Customer is created.
