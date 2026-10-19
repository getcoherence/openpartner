# The OpenPartner Stripe App — hosted brands connect their own Stripe

OpenPartner Cloud brands install the **OpenPartner Stripe App** on their own
Stripe account (an OAuth install). From then on, the brand's own Stripe events
drive attribution, the way a single-tenant self-host's do through its own
`STRIPE_SECRET_KEY` and `/webhooks/stripe`:

| Before (hosted) | With the app connected |
| --- | --- |
| Payment Link buyers needed the brand's server to forward each checkout to `POST /attribution/conversions` | `checkout.session.completed` with `client_reference_id = <click id>` is attributed directly |
| Stripe-billed SaaS brands reported every invoice from their server | `invoice.paid` is recorded directly, for any customer linked to a click |
| A refund needed an admin to reverse the commission | `charge.refunded` reverses the commissions on a full refund and prorates them on a partial one, exactly as on self-host (see *Refunds and disputes*) |
| Disputes were invisible | `charge.dispute.created` is recorded. It reverses nothing until the brand reports a lost dispute as a chargeback |
| Customer-reward promo codes were created by hand in the brand's Stripe | They're created in the brand's account automatically, and redemptions at Stripe Checkout attribute with no `POST /coupons/redeem` call |
| The platform fee was computed from self-reported amounts | Stripe-sourced amounts win over self-reported ones for the same transaction (see *Stripe wins*) |

Self-host is unchanged: it never connects anything, and `/webhooks/stripe`
keeps handling the brand's own account.

Code: `apps/api/src/stripe-app.ts` (tokens, rules), `routes/stripe-app.ts`
(install + admin API), `routes/stripe-app-webhook.ts` (events),
`routes/stripe-webhook.ts` (`processBrandStripeEvent`, the mapping both
routes share). Manifest: `stripe-app/`. Table: `TenantStripeConnection`
(migration `20261017000000`).

---

## How it works

### Install (OAuth)

1. **Admin → Integrations → Connect Stripe** calls
   `POST /stripe-app/connection/start`. The API signs a `state` that binds the
   tenant, the signed-in admin, the link type (live / test / sandbox) and the
   portal page to return to. It expires after 30 minutes. The admin is sent to
   `https://marketplace.stripe.com/oauth/v2/authorize?client_id=…&redirect_uri=…&state=…`.
2. The admin picks an account and accepts the permissions. Stripe redirects to
   the **one** redirect URI the manifest allows, on the platform origin:
   `https://app.openpartner.dev/api/stripe-app/oauth/callback`.
3. The callback checks the state's signature, wraps `{code, state}` in an
   encrypted grant, and sends the admin back to the page they started on with
   `?stripe_app_grant=…`. It exchanges nothing itself. The request carries no
   tenant, and a white-label admin's session cookie lives on the brand's custom
   domain, not the platform origin.
4. The Integrations page POSTs the grant to `/stripe-app/connection/complete`
   under the admin's session. The API exchanges the code at
   `POST https://api.stripe.com/v1/oauth/token`, using the developer key for the
   link's mode, **only if** the state names this tenant and this admin.

Step 4 makes the state worth having. Suppose an attacker hands a victim an
install link carrying the attacker's own state. The victim has no admin session
on the attacker's tenant, so the code is never exchanged, and it expires after 5
minutes. The grant is encrypted so the one-time code never sits readable in a
portal URL, where page analytics and browser history would keep it.

The connection is stored in `TenantStripeConnection`:

- the Stripe account id;
- `livemode`;
- which developer key issued the tokens;
- the refresh and access tokens, AES-GCM encrypted (`crypto.ts`);
- the permission-set version the brand accepted.

Reconnect and conflicts:

- Reconnecting the same account refreshes that row.
- Connecting a different account, or switching live and test, closes the old
  row as `replaced`.
- **An account that's live on another tenant is refused** with
  `409 stripe_account_connected_elsewhere`. Two partial unique indexes enforce
  this: one live connection per tenant, and one per Stripe account.

### Tokens

- Access tokens last an hour. Refresh tokens last a year and **rotate on every
  refresh**: the old one dies the moment a new one is issued.
- Refreshes are single-flight per connection. An in-process promise covers
  concurrent callers in one process. A `SELECT … FOR UPDATE` on the connection
  row covers concurrent processes: whoever holds the lock either finds a token
  someone else just stored, or refreshes and stores the new refresh token
  before releasing the lock.
- The access token is cached, encrypted, on the row (and in memory), so
  processes don't each refresh and rotate.
- `invalid_grant` from Stripe means the grant was revoked, expired or already
  used. The connection is marked **reconnect needed** (`refreshFailedAt`). The
  portal shows a banner, ops gets an email (`PLATFORM_OPS_EMAIL`) and a
  `[stripe-app] ALERT` log line, and that connection's events are acknowledged
  and skipped until the brand reconnects.
- Any other refusal (wrong developer key, `invalid_client`) is our
  misconfiguration. Reconnecting wouldn't fix it, so it's thrown and logged as
  an ALERT, and nothing is marked.
- Residual risk: if Stripe rotates the token and our database commit then
  fails, the new refresh token is lost. The brand sees "reconnect needed" on
  the next refresh.

### Events — `POST /webhooks/stripe-app`

The app's developer account has Connect webhook endpoints ("Listen to events on
Connected accounts") pointing here. For each event, the route:

1. Verifies the signature against `STRIPE_APP_WEBHOOK_SECRET`, its own secrets.
   Neither Stripe route accepts the other's deliveries.
2. Takes the tenant **only** from `event.account`, through
   `TenantStripeConnection`, never from object metadata, which the brand
   controls. Events with no account, for an account no live connection
   names, or for a tenant inside its deletion grace window, are acknowledged
   and skipped.
3. Skips the event unless `livemode` matches the connection. A live Connect
   endpoint also receives test-mode events from an account that installed the
   app in both modes.
4. Runs only the brand-attribution event types (`STRIPE_APP_ATTRIBUTION_EVENT_TYPES`)
   through `processBrandStripeEvent`, the same coupon redemption + `mapStripeEvent`
   + record-and-attribute pipeline single-tenant self-host runs. The funding
   pipeline and the billing / payout handlers (`handleConnectEvent`) never see
   these events: they concern OpenPartner's own account, not a brand's.
5. Makes every Stripe read with the brand's access token, never
   `STRIPE_SECRET_KEY`.

**Dedupe.** Every recorded Event is idempotent on `(tenantId, externalEventId)`,
as on self-host:

- An invoice's revenue is keyed on the **invoice id**, not the event id, so a
  conversion the brand also forwarded under that invoice id is the same Event.
- A one-time Checkout's revenue is keyed on the Checkout Session id.
- Refunds, disputes and failed payments are keyed on the Stripe event id.

A redelivery records nothing new.

Two deliberate differences from self-host:

- The app can't write customers. The checkout's `openpartner_user_id` metadata
  backfill is skipped, and resolution falls back to the stitched Identity row,
  which the self-host path already does whenever that write fails.
- Every Event carries `metadata.via = 'stripe_app'` and
  `metadata.stripeAccountId`.

**Refunds and disputes.** `charge.refunded` applies the refund with the same
code as `POST /attribution/refunds` (`apps/api/src/refunds.ts`). Each of the
payment's commissions ends up worth its original amount times the share of the
collected amount the customer kept. The share comes from the charge's
cumulative `amount_refunded`, so two partial refunds add up.

- **Accrued or approved:** reversed. On a partial refund, a replacement for the
  kept share is accrued on the same attribution, with the same status and
  accrual date, so its holdback doesn't restart.
- **Paid:** stays paid. A negative `refund_clawback` CommissionAdjustment
  records what the partner holds for refunded revenue. Nothing deducts it from
  later payouts.
- **In a payout in flight:** held (`heldInTransferCommissions` on the refund
  Event). The next refund of the same charge finishes it.
- **A payment split across invoices** (API version `2025-03-31.basil` and later):
  if the refunded payment paid part of an invoice, or several invoices, the
  refund is recorded (`splitPaymentReversalSkipped`, `stripeSplitInvoiceIds`)
  and reverses nothing. The charge doesn't say how much of which invoice it
  gave back. The brand reports it with `POST /attribution/refunds` and the
  amount.

`charge.dispute.created` is recorded as a `dispute_created` Event and reverses
nothing, because a dispute can be won. OpenPartner doesn't read the dispute's
outcome. The brand reports a lost one with `POST /attribution/refunds` and
`"kind": "chargeback"`, against the invoice id or Checkout Session id the
revenue was keyed on.

**Retries.** A transient failure (the database, a Stripe read, a token refresh
that couldn't reach Stripe) answers `500`, so Stripe redelivers. A connection
that's gone or waiting for a reconnect answers `2xx` with a skip reason, so one
brand's revoked grant doesn't keep the shared endpoint failing for days.

**Uninstall.** `account.application.deauthorized` (or `apps.install.deleted`)
closes the connection in that event's mode: uninstalling from the test-mode
sandbox leaves a live connection running. The tokens are wiped. Events already
recorded stay (CLAUDE.md principle 5).

**Disconnect from the portal.** Disconnecting wipes the tokens and stops all
processing. Stripe has no API for an app to uninstall itself, so the admin is
told to uninstall it under Settings → Installed apps to remove it from Stripe
too.

### Stripe wins — forwarded conversions vs. Stripe-sourced revenue

While a tenant's connection is healthy, a forwarded conversion whose
`externalEventId` is a Stripe invoice or Checkout Session id (`in_…`,
`cs_live_…`, `cs_test_…`) is refused with **`409 recorded_from_stripe`**. This
applies on `POST /attribution/events`, `POST /attribution/conversions`,
`GET /postback` and `POST /coupons/redeem`.

The order of arrival doesn't matter:

- The Stripe-sourced Event (Stripe's amount, Stripe's customer) is the single
  record of that payment.
- A forwarded copy can't pay the partner twice, or understate the amount the
  platform fee is billed on.
- A `/coupons/redeem` keyed on a Checkout Session can't claim the key first and
  turn the checkout's revenue into a dropped "replay".

Two limits:

- A connection waiting for a reconnect records nothing, so forwarding works
  again until it's fixed.
- A conversion forwarded under the brand's **own** order id can't be matched to
  a Stripe payment.

So once a brand connects, they should stop forwarding Stripe-billed revenue, and
link the Stripe customer to their user instead: `client_reference_id = <click id>`
at Checkout, or `metadata.openpartner_user_id` on the Customer. The Integrations
page and the 409's `detail` say so.

### Getting the partner click into Stripe

Stripe never sees the brand's website, so the app can't know who referred a
buyer unless the partner click reaches Stripe. Once it does, that customer's
invoices, renewals and refunds attribute on their own. Once connected,
Integrations asks how the brand takes payment and shows only that path:

| How customers pay | What the brand does |
| --- | --- |
| A partner link goes straight to a Payment Link | Nothing: put `?client_reference_id={click_id}` on the program's destination URL |
| Payment Links, a Pricing Table or a Buy Button on the brand's site | Paste one script tag (`<portal>/op.js`). The browser SDK adds the click to `buy.stripe.com` links and to Pricing Table / Buy Button embeds, including ones added later |
| The brand's app creates the Checkout Session | The same tag, plus `client_reference_id: req.cookies.op_ref`. The script keeps the click in a first-party `op_ref` cookie |
| Partner promo codes at Stripe Checkout | Nothing, when the program offers a customer discount (codes are created in the brand's Stripe) |

The portal's build produces `/op.js` from `packages/sdk/src/auto.ts`
(`pnpm --filter @openpartner/sdk build:global`). That makes it available on
the platform origin and on every white-label domain, with no npm release
needed.

### Customer rewards

`customer-rewards.ts rewardStripe(tenantId)` returns the brand's own client on
hosted when the connection is healthy and grants `coupon_write` and
`promotion_code_write`. It **never** returns `STRIPE_SECRET_KEY`, which is
OpenPartner's billing account. Reward promos were once wrongly minted there
(PR #97). Programs then report `customerRewardDelivery: 'stripe'`, and each
partner code gets its Coupon + PromotionCode in the brand's account. Deactivating
a code deactivates its promo there. That's best-effort, and a promo minted under
a previously connected account is out of reach.

---

## Permissions (version 1)

Least privilege: read-only except coupons and promotion codes. Nothing moves
money (CLAUDE.md principle 4), and nothing edits customers.

| Permission | Shown at install | Code that needs it |
| --- | --- | --- |
| `event_read` | Receive the checkout, invoice, refund and dispute events that credit your partners. | Any event delivery at all |
| `checkout_session_read` | Read completed Checkout Sessions and Payment Link purchases to match them to the partner link the buyer clicked. | `checkout.session.*` events; `checkout.sessions.list` (`stitchFromCompletedCheckouts`); `checkout.sessions.retrieve` with `total_details.breakdown` (`collectDiscounts`) |
| `customer_read` | Read a customer's metadata to match their payments to the user your app identified. | `customer.created`; `customers.retrieve` (`resolveUserIdFromCustomer`, `couponUserId`, the checkout's merchant-userId check) |
| `subscription_read` | Record new subscriptions for referred customers. | `customer.subscription.created` |
| `invoice_read` | Record paid invoices for referred customers so partners earn commission on them, including the promo code used. | `invoice.paid`, `invoice.payment_failed`; `invoices.retrieve` with expanded discounts (`collectDiscounts`); `invoicePayments.list`, the invoice a refunded charge paid on API versions from 2025-03-31.basil (`invoicePaidBy`) |
| `charge_read` | Read refunds and disputed charges so commissions on refunded revenue are reversed or flagged. | `charge.refunded`; `charges.retrieve` (a dispute's customer) |
| `dispute_read` | Flag commissions on disputed payments for your review. | `charge.dispute.created` |
| `promotion_code_read` | Match promotion codes used at checkout to your partners' codes. | `promotionCodes.retrieve` (`resolveDiscountCode`); `promotionCodes.list` (`codeExistsInStripe`); expanding a discount's promotion code |
| `promotion_code_write` | Create each partner's customer-discount promotion code in your account, and deactivate it when the code is retired. | `provisionCustomerReward`, `deactivateCustomerReward` |
| `coupon_read` | Check that a new partner code doesn't collide with one of your own coupons. | `coupons.retrieve` (`codeExistsInStripe`) |
| `coupon_write` | Create the coupon behind each partner's customer discount. | `provisionCustomerReward` |

`STRIPE_APP_PERMISSIONS` in `stripe-app.ts` is the source of truth, and a test
holds the manifest to it. Changing the list:

1. Edit both files.
2. Bump `STRIPE_APP_PERMISSIONS_VERSION`. Connections on an older version show
   "reconnect to grant" in the portal.
3. Upload a new app version (Stripe asks existing installs to accept the new
   permissions).

---

## Setting it up (Keith — Stripe Dashboard steps)

### 1. A separate developer account (required)

Create a **new** Stripe account, e.g. "OpenPartner Apps", under the same
organization. Do **not** use OpenPartner's billing / Connect platform account.

- **Events stay apart.** That account's Connect webhook endpoint only ever
  receives events from brands that installed the app. The platform account
  already has Connect accounts of its own (partner payouts, `routes/connect.ts`),
  whose events belong on Destination B. On a shared account, a brand-install
  `account.application.deauthorized` and a partner's Standard-account
  disconnect would be the same event type on the same endpoint, and couldn't be
  told apart reliably.
- **Key blast radius.** The OAuth token exchange needs the developer account's
  full secret key (Stripe rejects restricted keys there). On a separate account
  that key can reach nothing: no customers, no balance, no payouts.
- **Webhooks stay untouched.** Destinations A and B (docs/deploy-production.md
  §6), and the Network's own endpoint, are left alone.

Activate the account (business details). Stripe requires it to publish a public
app.

### 2. Upload the app

Done Oct 18 2026: versions 0.1.0 and then 0.1.1 (the real icon) are uploaded to
the **OpenPartner Apps** account (`acct_1URepJLKsWusNm7Z`). For a later version,
bump `version` in `stripe-app.json`, repeat the last command, and switch the
External test (step 5) to the new version: it stays on the version it was
started with.

```bash
stripe login --interactive --project-name openpartner-apps   # paste the live secret key
stripe plugin install apps
cd stripe-app
npm install
stripe apps upload --live --project-name openpartner-apps
```

Things that tripped the first upload:

- **CLI version.** CLI 1.40 can't install plugins: its plugin index is gone.
  Use 1.54 or later.
- **`--live` is required.** Without it, uploads go to test mode. A live upload
  records this account as the app's developer account, which a public app
  needs.
- **Log in with a key, not the browser flow.** Since 1.54, the browser login
  saves an OAuth session that the apps plugin can't read yet ("your live mode
  API key needs to be re-configured"). `stripe login --interactive` with a live
  key of the account works. A restricted key (`rk_live_…`) is enough for the
  CLI, but `STRIPE_APP_SECRET_KEY` must be the standard secret key (step 4).
- **The Stripe Apps Agreement.** The account must accept it in the Dashboard
  first. The CLI prints the link.
- **Redirect URIs must be HTTPS**, in test mode too. A `localhost` URI is
  rejected.
- **The CLI rewrites the manifest** into its canonical layout (`$schema`, key
  order). Commit that.

The first upload created the app from `stripe-app.json`: id
`dev.openpartner.attribution`, name, permissions and redirect URIs. The id can't
change now. The icon, `openpartner_icon.png`, is a 300×300 PNG: the "op" mark
from `apps/portal/public/logo-mark-white.svg` on the brand green `#53735D`. A
logo change needs a new version upload; the Dashboard can't edit it.

The only redirect URI in the manifest is
`https://app.openpartner.dev/api/stripe-app/oauth/callback` (production). To
connect from local dev or staging, add that host's HTTPS callback, e.g. through
a tunnel, set `STRIPE_APP_REDIRECT_URI` to match, and upload a new version.

### 3. Webhook endpoints (one per environment)

In the developer account, create an event destination for each environment. Use
**Connected accounts** (the "Listen to events on Connected accounts" option):

| Environment | Where | URL | Status |
| --- | --- | --- | --- |
| Live | Live mode → Developers → Webhooks | `https://app.openpartner.dev/api/webhooks/stripe-app` | **Created Oct 18 2026**: `we_1US3LILKsWusNm7ZId7KuPr8` |
| Test-mode sandbox | Test mode → Developers → Webhooks | same URL | to do |
| General sandboxes (optional) | The app's managed sandbox | same URL | optional |

**API version: any, but keep the app's endpoints on `2025-02-24.acacia` for
now.** The live endpoint was created on acacia. Give the others the same version
so every environment sends the same payloads.

Version `2025-03-31.basil` removed `Invoice.charge`, `Invoice.payment_intent`
and `Charge.invoice`, the fields that tie a refund to the payment it refunds. On
basil and later, `charge.refunded` reads the invoice from the PaymentIntent's
InvoicePayments instead (`invoicePaidBy` in `routes/stripe-webhook.ts`), with the
brand's token. Stripe lists no separate InvoicePayment permission, so
`invoice_read` should cover it. That read hasn't run against a real install yet.
If Stripe refuses it, the refund is recorded and reverses nothing, and the API
logs `Stripe read failed permanently` for `invoicePayments.list`. So before
moving an endpoint past acacia, test it on a test-mode endpoint at the new
version: refund a referred customer's **subscription invoice** in full and check
that the commission flips to `reversed`. Step 5's Payment Link refund doesn't
test this. A one-time purchase is matched by its PaymentIntent and never reads
InvoicePayments. Pick the `app.install.*` or `apps.install.*` event names that
version has.

Events to select (names as of acacia):

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`
- `customer.created`, `customer.subscription.created`
- `invoice.paid`, `invoice.payment_failed`
- `charge.refunded`, `charge.dispute.created`
- `account.application.deauthorized`
- `app.install.created`, `app.install.updated`, `app.install.deleted`. API
  versions from 2026-09-30 call these `apps.install.*`. The route accepts both.

From the CLI, logged in to the developer account as in step 2 (this is how the
live one was created):

```bash
stripe webhook_endpoints create --live --project-name openpartner-apps \
  --url https://app.openpartner.dev/api/webhooks/stripe-app \
  --api-version 2025-02-24.acacia -d connect=true \
  --enabled-events checkout.session.completed --enabled-events checkout.session.async_payment_succeeded \
  --enabled-events customer.created --enabled-events customer.subscription.created \
  --enabled-events invoice.paid --enabled-events invoice.payment_failed \
  --enabled-events charge.refunded --enabled-events charge.dispute.created \
  --enabled-events account.application.deauthorized \
  --enabled-events app.install.created --enabled-events app.install.updated --enabled-events app.install.deleted
```

Drop `--live` for the test-mode endpoint (that needs the test secret key in the
CLI profile). The response includes the endpoint's signing secret, and only that
once; it can be revealed again in the Dashboard (Developers → Webhooks → the
endpoint → Signing secret). Put each endpoint's secret into
`STRIPE_APP_WEBHOOK_SECRET`, comma-separated. Until that var is set, the route
answers `503` and Stripe retries, which does no harm before any brand has
installed.

### 4. Keys and client ids

| Env var (api component) | Value |
| --- | --- |
| `STRIPE_APP_SECRET_KEY` | Developer account **live** secret key (`sk_live_…`, from **Standard keys**). Not a restricted `rk_live_…` key: Stripe's token endpoint refuses those with `invalid_client`, "Unable to authenticate the request", and every install then fails at the last step. |
| `STRIPE_APP_CLIENT_ID` | `client_id` from the app's **live** install link (Settings → public OAuth links, or External test → live link before publishing) |
| `STRIPE_APP_SECRET_KEY_TEST` | Developer account **test** secret key (`sk_test_…`) |
| `STRIPE_APP_CLIENT_ID_TEST` | `client_id` from the **test-mode** install link |
| `STRIPE_APP_SECRET_KEY_SANDBOX` / `STRIPE_APP_CLIENT_ID_SANDBOX` | Optional: the app's managed-sandbox key and link |
| `STRIPE_APP_WEBHOOK_SECRET` | The endpoint signing secrets from step 3, comma-separated |
| `STRIPE_APP_REDIRECT_URI` | Optional. Defaults to `${PORTAL_URL}/api/stripe-app/oauth/callback`, and must exactly match a manifest URI |
| `STRIPE_APP_AUTHORIZE_URL` | **Until the app is published.** Paste the External test tab's live-mode link whole (`https://marketplace.stripe.com/oauth/v2/chnlink_…/authorize?…`). Only its origin and path are used; `client_id` still comes from the vars above. It applies to every mode unless `_TEST` / `_SANDBOX` overrides it, since the live and test links have shared one channel so far. Unset = the public link, which works only after publishing. |

Each mode is offered in the portal only when both its key and client id are set:

- **Connect Stripe**: live.
- **Connect a test-mode account**: test.

With nothing set, the card is hidden. Set these on the DO app's `api` component.
`SECRETS_ENCRYPTION_KEY` (already set) encrypts the stored tokens.

### 5. External test

1. App details → **External test** → Get started, picking the uploaded version.
2. Under **Test OAuth**, copy the **Live mode link** and the **Test mode link**.
   They look like
   `https://marketplace.stripe.com/oauth/v2/chnlink_…/authorize?client_id=ca_…`.
   The channel (`chnlink_…`) is in the path, and each mode has its own
   `client_id`. Set:
   - `STRIPE_APP_CLIENT_ID`: the live link's `client_id`;
   - `STRIPE_APP_CLIENT_ID_TEST`: the test link's `client_id`, plus
     `STRIPE_APP_SECRET_KEY_TEST`, if you want the test-mode button;
   - `STRIPE_APP_AUTHORIZE_URL`: the live link, pasted whole.

   Without the channel, an install shows "The provided OAuth link is invalid":
   public links don't work until the app is published.

   As of Oct 18 2026 (version 0.1.0): live `client_id`
   `ca_VSz5Gbxypnv9PUB5PlSbh4PVs0oKrdvI`, test `client_id`
   `ca_VSz5qyW7JXnLY6PUvfnEfvGXS8aIPmaT`, channel
   `chnlink_61VbRZD7GqfQXOlfu41LKsWusNm7ZOpU`.
3. In OpenPartner Cloud, as an approved test brand: Admin → Integrations →
   Connect Stripe (or Connect a test-mode account).
4. Make a test purchase on a Payment Link with
   `?client_reference_id=<a click id>`: the click id from a partner link
   destination with `{click_id}`. Check that the conversion and commission
   appear, and that Integrations shows "last event".
5. Refund it in full in the Stripe Dashboard: the commission flips to
   `reversed`. (A partial refund reverses it and accrues a smaller replacement.)
6. Uninstall the app in Stripe: Integrations shows Stripe as disconnected.

### 6. App Review

Submit from the app's page in the developer account. Stripe asks for a
**Marketplace install URL**: a page that starts the OAuth install with clear
instructions. Our installs have to start inside OpenPartner, because the signed
state needs a signed-in admin. So the page explains that and links to sign-in:

> Sign in to OpenPartner (or create a brand), open **Admin → Integrations**,
> and click **Connect Stripe**.

For example, a public page at `https://openpartner.dev/integrations/stripe`
(openpartner-marketing repo), with a button to
`https://app.openpartner.dev/login`. Give the reviewers credentials for a
pre-approved demo brand. New brands queue for platform approval (`/platform`),
so approve it first. Once published:

1. Switch `STRIPE_APP_CLIENT_ID` (and `_TEST`) to the **public** links' client
   ids, from the Settings tab, if they differ.
2. Remove `STRIPE_APP_AUTHORIZE_URL` (and any `_TEST` / `_SANDBOX`), so installs
   use the public link.
3. Redeploy.

---

## Operations

- **Reconnect needed.** The ops email names the brand and account. The brand
  reconnects from Integrations, and the same row is refreshed. Events delivered
  while the connection was broken were skipped (see follow-ups).
- **Rotating a webhook secret.** Add the new secret to
  `STRIPE_APP_WEBHOOK_SECRET` (comma-separated) before rolling it in Stripe, and
  remove the old one after.
- **Rotating a developer key.** Swap `STRIPE_APP_SECRET_KEY[_TEST]`. Refresh
  tokens are issued to the app, not to one key value, so they should keep
  working. Confirm with a test-mode connection's next refresh after rolling.
- **What's stored.** The account id, livemode, encrypted tokens, permission
  version, timestamps, and the admin who connected. `TenantStripeConnection` is
  **never exported** (credentials, `docs/data-portability.md`). The Events the
  app recorded are ordinary raw Event rows, and they export like any other.

## Coordination with other work

- **Refunds API + refund-aware billing** (#138, #136, merged): the app path
  runs `mapStripeEvent`, so prorated partial refunds apply to app events too
  (see *Refunds and disputes*).
- **Commission-floor platform fee** (#139, merged; applies from the cutover,
  [platform-fee.md](platform-fee.md)): app-sourced revenue is ordinary
  `invoice_paid` Events tagged `metadata.via = 'stripe_app'`. *Stripe wins*
  guarantees one Event per Stripe transaction, so the rule sees no duplicate to
  dedupe.
- **Multi-currency** (#133, #135): the mapping already records the payment's
  currency. Same mapping, same fixes.
- **Renewals past the window** (#141, merged): `invoice.paid` renewals go
  through `attributeEvent`, so they stay with the partner who won the customer,
  as on self-host ([renewal-attribution.md](renewal-attribution.md)).

## Follow-ups (not built)

- **Stripe Dashboard UI extension**: show the referring partner on a customer's
  page in the brand's Stripe Dashboard.
- **Backfill after a reconnect**: replay the events skipped while a connection
  needed reconnecting, through the Events API (`event_read` allows 30 days).
- **Per-account Coupon provenance**: deactivating a promo minted under a
  previously connected account. Needs a hosted sidecar, because Coupon is a core
  table.
- **The same `/coupons/redeem` key collision on self-host**: a redemption keyed
  on a Checkout Session id can take the key before `/webhooks/stripe` records
  that checkout's revenue.
