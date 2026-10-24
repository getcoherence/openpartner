<!-- Research appendix to payment-provider-roadmap.md. Compiled Oct 24 2026 from each provider's own documentation (pages, OpenAPI specs, doc exports). Points that couldn't be confirmed there are marked UNVERIFIED: check them in a sandbox before building on them. -->

# Payment provider research: getting Stripe-quality attribution data elsewhere

Researched 24 Oct 2026 from official docs: rendered pages, the providers' own OpenAPI/YAML specs, their `llms.txt`/`.md` doc exports, and, for Gumroad, its open-source app repo. Anything I could not confirm in a provider's own material is marked **UNVERIFIED**. Our click id is a 26-char ULID (`[0-9A-Z]`), so it fits every reference field below. The tightest limits are Square's 40-char `reference_id` and Adyen's 20-char metadata key / 80-char value.

## Summary ranking

**Closest to Stripe (high fit):**
- **Paddle Billing.** You can set `custom_data` client-side in Paddle.js. Paddle copies it from the first transaction to the subscription and then to every renewal transaction. Webhooks are signed with HMAC and there is a replay API. A 90-day events API and notification settings you can create through the API cover catch-up. The one gap: there is no OAuth, so the merchant has to paste a scoped API key.
- **Shopify.** App-install OAuth, HMAC-signed webhooks, cart attributes you can set client-side, `customerJourneySummary` (landing page, referrer, UTM, `ref` code), discount codes on the order, and subscription-contract attributes that are copied onto renewal orders. The costs are app-review gates: protected customer data, `read_all_orders`, and the 60-day order window.
- **Chargebee.** OAuth Apps exist, `cf_*` fields can be pre-filled through the hosted-page URL, and renewal webhooks carry the full subscription. The weak spot is security: webhooks have no HMAC, only basic auth, and you are limited to 5 endpoints.
- **Razorpay.** Notes (15 × 256 chars), HMAC webhooks, OAuth `read_only`, partners can register webhooks through an API, and a payments list with time filters. The partner path requires becoming a Technology Partner, and renewal payments arrive with empty notes, so attribution has to join through the subscription's notes.
- **Mollie.** Subscription metadata is forwarded to every generated payment, Connect OAuth includes a `webhooks.write` scope, and the next-gen webhooks are signed. The legacy webhooks send only an id with no signature, and the payments list has no date filter.

**Medium fit:**
- **PayPal.** `custom_id` (255 chars on orders) comes back on capture webhooks and in Transaction Search, and subscriptions have their own `custom_id`. But webhooks are scoped to the REST app that created the transaction. Partner (third-party) access needs PayPal partner approval. Transaction Search lags by up to 3 hours. Orders carry no coupon codes.
- **Lemon Squeezy.** Custom data can be passed as a checkout URL parameter and returns in `meta.custom_data`, and webhooks are signed. But there is no OAuth, no date filter on orders, no events API, only 3 retries, and the product's future is tied to Stripe Managed Payments.
- **Gumroad.** Any URL parameter on the product link comes back in `url_params`, `offer_code` is reported, and OAuth plus resource subscriptions let a platform register webhooks. But webhooks are unsigned, retries are short, and amounts are always USD cents.
- **Square.** OAuth with app-level webhooks, HMAC signatures, and a 28-day Events API. But `reference_id` is server-side only and capped at 40 chars, and renewals do not propagate it.
- **WooCommerce.** The `/wc-auth` key-grant flow, HMAC webhooks, coupon codes on orders, and renewal orders that copy subscription meta. But it is self-hosted, the click id needs a plugin or snippet to store it, and webhooks are disabled after 5 failures.
- **Paystack.** Metadata, HMAC-SHA512 webhooks, time-filtered lists. But there is no partner OAuth (the merchant would paste a secret key) and renewal metadata is UNVERIFIED.

**Lower fit:**
- **Recurly.** Custom fields exist but are not available on the Starter plan, can only be set server-side, and webhooks cannot be configured through the API.
- **Braintree.** Subscriptions take no `customFields`, there is no webhook for a successful one-off card sale, and OAuth is closed beta.
- **Adyen.** No API to list payments (reports only), OAuth is for partners only, and Adyen runs no subscriptions itself.

**Poor fit: Wise.** It has no checkout. Incoming payments carry only a payer-typed free-text reference. The Incoming Transfer API "is not publicly available", and personal tokens cannot read balance statements outside six countries.

### At-a-glance

| Provider | Reference field (client-side?) | Survives renewals? | Signed webhooks | Platform auth | Read / replay API | Coupon code on order | Fit |
|---|---|---|---|---|---|---|---|
| Paddle | `custom_data` (yes: Paddle.js) | Yes (copied by Paddle) | HMAC-SHA256 | Scoped API key (no OAuth) | Events 90d + replay | `discount_id` | High |
| Shopify | cart attributes → `customAttributes` (yes: Ajax cart) | Yes (contract `customAttributes`) | HMAC-SHA256 | OAuth app install | Orders query (60d default) | `discountCodes` | High |
| Chargebee | `cf_*` / `meta_data` (yes: hosted URL `subscription[cf_x]`) | Yes (on subscription) | Basic auth only | OAuth Apps / read-only key | Events list | Coupon events; code on sub UNVERIFIED | High |
| Razorpay | `notes` (yes: Checkout options) | Subscription notes only | HMAC-SHA256 | OAuth (Tech Partner) | Payments `from`/`to` | Offers (`offer_id`) | High |
| Mollie | `metadata` (server only) | Yes (forwarded) | Next-gen: HMAC; legacy: none | OAuth (Connect) | List (cursor, no dates); webhook events API | No | High |
| PayPal | `custom_id` (yes: JS SDK) | Subscription `custom_id`; sale join via `billing_agreement_id` | Cert/verify API | Partner Referrals (approval) | Txn Search 3y / events list + resend | No (amount only) | Medium |
| Lemon Squeezy | `checkout[custom][k]` (yes: URL) | UNVERIFIED on invoices | HMAC-SHA256 | API key | Orders list (no dates) | Redemptions resource | Medium |
| Gumroad | any URL param → `url_params` (yes: URL) | `custom_fields` yes; `url_params` UNVERIFIED | None | OAuth `view_sales` | Sales `after`/`before` | `offer_code` | Medium |
| Square | `reference_id` ≤40 (server only) | No | HMAC-SHA256 | OAuth | Events 28d; payments 1y default | No code | Medium |
| WooCommerce | order meta (needs plugin) | Yes (meta copied) | HMAC-SHA256 | `/wc-auth` key grant | Orders `after`/`modified_after` | `coupon_lines` | Medium |
| Paystack | `metadata` (yes: Popup JS) | UNVERIFIED | HMAC-SHA512 | Secret key | Transactions `from`/`to` | UNVERIFIED | Medium |
| Recurly | custom fields (server only) | On subscription | HMAC-SHA256 (JSON) | API key | List endpoints | UNVERIFIED | Low-Med |
| Braintree | `customFields`/`orderId` (server only) | No | SDK-parsed signature | OAuth closed beta | Transaction search | No | Low-Med |
| Adyen | `merchantReference` + `metadata` (server only) | Merchant re-sends | HMAC | OAuth partners only | Reports only | No | Low |
| Wise | payer-typed reference | n/a | RSA-SHA256 | Partner OAuth only | Statements (limited) | n/a | Poor |

---

## 1. PayPal (Orders v2, Subscriptions, Partner Referrals, Transaction Search, Webhooks)

**1. Reference passthrough.**
- **Orders v2 `purchase_units[].custom_id`.** String, 1–255 chars, pattern `^[\S\s]*$`. The spec says it is "Used to reconcile client transactions with PayPal transactions. Appears in transaction and settlement reports but is not visible to the payer." The capture object in Orders/Payments responses carries `custom_id` and `invoice_id` (readOnly), so `PAYMENT.CAPTURE.COMPLETED` returns it. The Payments v2 refund request has its own `custom_id` (max 127).
- **Do not use `invoice_id` for the click id.** It is up to 127 ASCII and must be unique per merchant account by default, so a click id would collide on a repeat purchase.
- **`reference_id`** (≤256) is per purchase unit and is meant for PATCH addressing.
- **Client-side.** The JS SDK `createOrder` can build the order client-side with `purchase_units[].custom_id`. PayPal recommends server-side creation.
- **Subscriptions v1 `custom_id`.** 1–127 chars, pattern `^[\x20-\x7E]+`. It is returned on the subscription and can be PATCHed. The JS SDK `actions.subscription.create({plan_id, …})` takes the create-subscription body; passing `custom_id` this way is common practice but UNVERIFIED in the JS SDK reference.
- **Legacy HTML buttons (Payments Standard)** have a `custom` pass-through returned in IPN (255 chars per the IPN variable reference).
- **No-code PayPal payment links:** no documented URL parameter for a reference (UNVERIFIED / likely none).
- Docs: Orders spec https://developer.paypal.com/api/orders/v2/schema.yaml, ref https://developer.paypal.com/docs/api/orders/v2/; Payments v2 https://developer.paypal.com/docs/api/payments/v2/; Subscriptions https://developer.paypal.com/docs/api/subscriptions/v1/ (spec `.../api/subscriptions/v1/schema.yaml`); IPN vars https://developer.paypal.com/api/nvp-soap/ipn/IPNandPDTVariables/

**2. Webhooks.**
- **Event names:**
  - Orders and payments: `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.COMPLETED` (marketplaces/platforms only), `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED` (full or partial; the resource is a refund), `PAYMENT.CAPTURE.REVERSED`.
  - Subscriptions: `BILLING.SUBSCRIPTION.CREATED`, `.ACTIVATED`, `.UPDATED`, `.CANCELLED`, `.SUSPENDED`, `.EXPIRED`, `.PAYMENT.FAILED`.
  - Subscription payments (renewals) use the deprecated v1 sale events: `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`.
  - Disputes: `CUSTOMER.DISPUTE.CREATED`, `.UPDATED`, `.RESOLVED`.
- **Verification.** Either call `POST /v1/notifications/verify-webhook-signature`, which takes `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time`, `webhook_id`, and the event, or verify yourself with CRC32 of the body plus PayPal's cert.
- **Retries.** Up to 25 attempts over 3 days, then marked Failed. Failed deliveries can be resent from the dashboard or through the API.
- Docs: https://developer.paypal.com/api/rest/webhooks/event-names/ ; https://developer.paypal.com/docs/subscriptions/webhooks/ ; https://developer.paypal.com/api/rest/webhooks/

**3. Third-party access.**
- **Partner Referrals v2** onboards a merchant with `operations: API_INTEGRATION` and `third_party_details.features`. Relevant features: `PAYMENT`, `REFUND`, `ADVANCED_TRANSACTIONS_SEARCH`, `ACCESS_MERCHANT_INFORMATION`, `READ_SELLER_DISPUTE`, `BILLING_AGREEMENT`. The return URL gives `merchantIdInPayPal`, `permissionsGranted`, and `consentStatus`. Platform webhooks `MERCHANT.ONBOARDING.COMPLETED` and `MERCHANT.PARTNER-CONSENT.REVOKED` track the connection.
- **Approval.** You "must be an approved partner to use this integration", and Transaction Search on behalf of third parties requires the PayPal partner network.
- **Acting for the merchant** uses the `PayPal-Auth-Assertion` JWT (`iss` = our client id, `payer_id` = merchant).
- **Webhook scoping (big gotcha).** Webhooks are per REST app: "payments processed on one REST app … will not generate events for webhooks subscribed to a different REST app." A merchant's own checkout integration therefore will not push events to our app. Options: the merchant adds our URL as a webhook on their own app (manual), or we poll Transaction Search. A "webhook lookup" can route events not tied to a REST app (NVP/SOAP or paypal.com UI).
- Docs: https://developer.paypal.com/docs/api/partner-referrals/v2/ ; https://developer.paypal.com/docs/multiparty/seller-onboarding/before-payment/ ; https://developer.paypal.com/api/rest/requests/ ; https://developer.paypal.com/api/rest/webhooks/

**4. Read API.**
- **Transaction Search** `GET /v1/reporting/transactions`:
  - `start_date`/`end_date` with a maximum range of 31 days.
  - "lists transaction for the previous three years".
  - "takes a maximum of three hours for executed transactions to appear".
  - `page_size` ≤ 500; result sets over 10,000 return `RESULTSET_TOO_LARGE`.
  - Returns `transaction_info.custom_field` (≤127, pattern `^[a-zA-Z0-9_'\-., ":;!?|]*$`; a ULID fits), `invoice_id`, `paypal_reference_id` + type (`ODR`/`TXN`/`SUB`/`PAP`, so subscription payments link to `I-…`), `transaction_event_code`, and `payer_info.account_id`.
- **Events list.** `GET /v1/notifications/webhooks-events` takes `start_time`, `end_time`, `event_type`, `transaction_id`, `page_size`. `POST /v1/notifications/webhooks-events/{id}/resend` resends one. Retention is not stated in the spec (UNVERIFIED), and the list is scoped to our app.
- **Per subscription.** `GET /v1/billing/subscriptions/{id}/transactions?start_time&end_time`.
- Docs: https://developer.paypal.com/docs/api/transaction-search/v1/ (spec `.../api/transaction-search/v1/schema.yaml`); https://developer.paypal.com/docs/api/webhooks/v1/

**5. Coupons.** PayPal has no coupon-code object. Orders carry only `amount.breakdown.discount` (an amount). Any code must come from the merchant's own system or travel in `custom_id`/`description`.

**6. Customer identity.**
- `payer.payer_id` is the PayPal account id, stable for logged-in PayPal payers. Guest card payers may not have a stable id (UNVERIFIED).
- Subscriptions: the subscription id `I-…` is stable across renewals. The v1 sale object has `billing_agreement_id`, the field that links a `PAYMENT.SALE.COMPLETED` to its subscription.

**7. Amounts.** Decimal strings plus `currency_code` (for example `"105.00"`). Multi-currency is supported.

**8. Gotchas.**
- **Renewals lose the reference.** The subscription `custom_id` is not in the documented v1 sale schema. Community reports say it appears as `custom` on `PAYMENT.SALE.COMPLETED`, but that is UNVERIFIED. Design: store `custom_id` from `BILLING.SUBSCRIPTION.CREATED`/`ACTIVATED`, then join sales on `billing_agreement_id`. A GitHub issue also reports `billing_agreement_id` missing on some sale webhooks (https://github.com/paypal/PayPal-PHP-SDK/issues/1201), so fall back to subscription transactions.
- The sale events come from the deprecated v1 Payments API.
- Do not put the click id in `invoice_id` (uniqueness).
- The 3-hour search lag and 31-day windows make catch-up slower than Stripe.
- Partner approval is a business process, not just an API flow.
- Dispute resources carry `disputed_transactions[].custom` (≤2000) and `seller_transaction_id`, which makes clawback matching possible (https://developer.paypal.com/docs/api/customer-disputes/v1/).

---

## 2. Wise (Wise Business)

**Honest verdict: Wise is a poor fit for checkout conversion tracking.** It is a transfer, payout and receive-to-account product. There is no checkout object, nothing like a session, and no reference that a merchant's code attaches.

**1. Reference passthrough.**
- Incoming bank transfers carry only what the payer types. The Incoming Transfer resource has `unstructuredReference`, "Unstructured remittance information provided by the debtor". Swift `pacs.008` messages carry `RmtInf/Ustrd`.
- Wise Business "payment links" (single-use, valid 30 days, or reusable, with card/Apple Pay in some regions) are created in the Wise app or web UI. I found no public API for them and no documented way to attach our reference (UNVERIFIED).
- Docs: https://docs.wise.com/guides/product/receive-money/incoming-transfer-notifications ; https://docs.wise.com/api-reference/incoming-transfer ; https://www.wise.com/help/articles/4qr3kkvIQlHNiD8BegEB4u/getting-paid-to-your-wise-business-by-payment-link

**2. Webhooks.**
- **Events:**
  - `incoming-transfer#credited` is the recommended event. It carries only `incoming_transfer_id` + `occurred_at`; you then fetch the record.
  - `swift-in#credit` and `swift#message-received` (raw `pacs` message) are Swift-only.
  - `balances#update` (profile-level) carries `amount`, `currency`, `transaction_type: credit`, `channel_name`, `transfer_reference`, `step_id`, `post_transaction_balance_amount`. It has no payer context. The older `balances#credit` is superseded.
  - `transfers#state-change` covers outbound transfers.
  - No refund or dispute events apply to receiving bank transfers.
- **Signing.** `X-Signature-SHA256`: RSA + SHA256 over the body, base64, verified against Wise's published public key. `X-Delivery-Id` deduplicates and `X-Test-Notification` marks test events.
- **Retries.** A 2xx is required within 5 s. Wise retries up to 25 times over two weeks. Developer Hub shows history and can retry events manually.
- Docs: https://docs.wise.com/guides/developer/webhooks/event-handling ; https://docs.wise.com/guides/product/accounts/mca-webhooks ; https://docs.wise.com/guides/developer/webhooks/view-retry-events

**3. Third-party access.**
- OAuth 2.0 (client credentials and user tokens) exists only for Wise Platform partners: "During onboarding, Wise provides partners with a client ID and client secret", and partnership needs an agreement.
- SMB business accounts get personal API tokens limited to quotes, recipients, transfers, batch groups, and transfer events. "Retrieving balance statements via API are not supported except for accounts based in the US, Canada, Australia, New Zealand, Singapore, and Malaysia."
- Application-level webhook subscriptions need a client-credentials token. Profile-level subscriptions exist for some events (for example `balances#update`).
- Docs: https://docs.wise.com/guides/developer/auth-and-security/oauth-2-setup ; https://docs.wise.com/guides/developer/auth-and-security/personal-api-token ; https://docs.wise.com/guides/developer/webhooks/subscribe-to-webhooks

**4. Read API.**
- Balance statements: `GET /profiles/{id}/balance-statements/{balanceId}/statement.json?currency&intervalStart&intervalEnd`. Its `referenceNumber` links to the incoming transfer.
- Incoming Transfers: "not publicly available. To get access, contact your Wise implementation manager."
- Docs: https://docs.wise.com/guides/product/receive-money/reconcile-incoming-transfers ; https://docs.wise.com/guides/product/receive-money

**5. Coupons.** Not applicable.

**6. Customer identity.** Only debtor name and account identifiers on the incoming transfer. There is no stable customer id.

**7. Amounts.** Decimal numbers in major units (for example `"amount": 70`, `88.93`). Multi-currency balances.

**8. Gotchas.**
- Attribution would mean fuzzy-matching a payer-typed reference.
- Most useful APIs are partner-gated, and SCA and profile restrictions apply.
- **Better fit for Wise:** our payouts rail (already in use for manual payout files), not conversion ingestion.

---

## 3. Paddle Billing

**1. Reference passthrough.**
- `custom_data` (a JSON object) on transactions and subscriptions, plus "some other entities".
- **Client-side:** `Paddle.Checkout.open({ customData })` or the HTML attribute `data-custom-data`.
- "Where a transaction has custom data … that data is copied to the created subscription", and subscription custom data is copied to transactions created from it, "including renewals, upgrades, downgrades, and one-time charges".
- No size limit is documented; Paddle advises against nesting.
- **Hosted checkout URL parameters** (`price_id`, `discount_code`, `paddle_customer_id`, `user_email`, `app_user_id`, `transaction_id`, …) include no custom-data parameter. Hosted checkouts also need live-account approval.
- **Workaround for links:** create a transaction server-side with `custom_data` and open the checkout with `?_ptxn=txn_…`.
- Docs: https://developer.paddle.com/build/transactions/custom-data ; https://developer.paddle.com/paddlejs/hosted-checkout-url-parameters

**2. Webhooks.**
- **Events:** `transaction.completed` (purchase complete; a subscription is auto-created for recurring items), `transaction.paid`, `subscription.created`, `subscription.activated`, `customer.created`, and `adjustment.created`/`adjustment.updated`.
- **Adjustments** cover refunds and chargebacks. Actions: `refund`, `credit`, `chargeback`, `chargeback_reverse`, `chargeback_warning`, `chargeback_warning_reverse`, `credit_reverse`. Types: `full` or `partial`.
- **Signature.** `Paddle-Signature: ts=…;h1=…`, HMAC-SHA256 over `ts:rawBody` with the destination's secret. SDK default tolerance is 5 s.
- **Retries.** Live: up to 60 attempts over about 2 days. Sandbox: 3 attempts in about 2 minutes.
- **Replay.** `POST /notifications/{id}/replay` replays a failed or delivered notification. Notifications older than 90 days are not retained.
- Docs: https://developer.paddle.com/webhooks/signature-verification ; https://developer.paddle.com/webhooks/respond-to-webhooks ; https://developer.paddle.com/webhooks/overview ; https://developer.paddle.com/webhooks/adjustments/adjustment-created

**3. Third-party access.**
- No OAuth or partner-connect flow found. The merchant creates an API key with granular permissions; keys created before 6 May 2025 are legacy and do not support permissions.
- A key with `notification_setting.write` lets us create the webhook destination ourselves (`POST /notification-settings`, which returns `endpoint_secret_key`).
- Docs: https://developer.paddle.com/api-reference/about/api-keys ; https://developer.paddle.com/api-reference/notification-settings/create-notification-setting

**4. Read API.**
- `GET /transactions` filters by `created_at`/`updated_at`/`billed_at` (`[LT|LTE|GT|GTE]`), `status`, `origin` (`web`, `api`, `subscription_recurring`, `subscription_update`, …), `customer_id`, `subscription_id`. Max 30 per page.
- `GET /events`: rolling 90 days, `event_type` and `from`/`to` filters, ≤200 per page, needs `notification.read`.
- No documented lookback limit on transactions.
- Docs: https://developer.paddle.com/api-reference/transactions/list-transactions ; https://developer.paddle.com/api-reference/events/list-events

**5. Coupons.** `transaction.discount_id`; the discount entity carries the code. Checkouts accept `discount_code`.

**6. Customer identity.** `ctm_…` customer id, plus `sub_…` on renewals and adjustments.

**7. Amounts.** Strings in the lowest denomination ("10 USD = 1000"). Multi-currency.

**8. Gotchas.**
- Paddle is the merchant of record, so revenue figures are Paddle's (fee/earnings breakdown in totals).
- Live refunds usually start `pending_approval`.
- Hosted checkout needs approval.
- Sandbox retry behaviour differs from live.
- Keys must be scoped; ask merchants for read-only plus `notification_setting.write`.

---

## 4. Lemon Squeezy

**1. Reference passthrough.**
- **Checkout URL (client-side):** `?checkout[custom][cref]=01J…`. Through the API: `checkout_data.custom` on `POST /v1/checkouts`.
- Returned in webhook `meta.custom_data` for "all Order, Subscription and License key related events". Values come back as strings.
- No documented limits.
- Docs: https://docs.lemonsqueezy.com/help/checkout/passing-custom-data ; https://docs.lemonsqueezy.com/help/webhooks/webhook-requests

**2. Webhooks.**
- **Events:** `order_created`, `order_refunded` (full or partial), `subscription_created`, `subscription_updated`, `subscription_cancelled`/`resumed`/`expired`/`paused`/`unpaused`, `subscription_payment_success`, `subscription_payment_failed`, `subscription_payment_recovered`, `subscription_payment_refunded`, `license_key_*`, `affiliate_activated`.
- **No dispute event.**
- **Signature.** `X-Signature` = HMAC-SHA256 hex of the raw body with the signing secret.
- **Retries.** Only 3 more attempts (for example at 5 s, 25 s, 125 s), then failed.
- Docs: https://docs.lemonsqueezy.com/help/webhooks/event-types ; https://docs.lemonsqueezy.com/help/webhooks/signing-requests

**3. Third-party access.** API keys only (Bearer; they expire after a year). No OAuth documented. A platform can create webhooks with `POST /v1/webhooks` (url, events, secret, store, `test_mode`). Docs: https://docs.lemonsqueezy.com/api/webhooks/create-webhook ; https://docs.lemonsqueezy.com/api/getting-started/requests

**4. Read API.**
- `GET /v1/orders` filters only by `store_id`, `user_email`, `order_number`, newest first, `page[size]` ≤100. There is **no date-range filter**, so catch-up means paging back.
- No events or webhook-replay API found.
- Docs: https://docs.lemonsqueezy.com/api/orders/list-all-orders

**5. Coupons.** The order has `discount_total` (cents) but not the code. Codes come through the separate Discount Redemptions resource. Docs: https://docs.lemonsqueezy.com/api/orders/the-order-object

**6. Customer identity.** `customer_id` on orders and subscriptions.

**7. Amounts.** Integer cents in the order currency, plus `*_usd` fields. Multi-currency.

**8. Gotchas.**
- Whether `meta.custom_data` is on `subscription_payment_*` (renewal) events is UNVERIFIED; join via `subscription_id`.
- The short retry window means you need your own reconciliation.
- **Platform risk:** Stripe owns Lemon Squeezy and third-party reports say it is migrating sellers to Stripe Managed Payments (status and pricing reports conflict; UNVERIFIED). If SMP runs on Stripe Checkout objects, our Stripe connector may cover those sellers (UNVERIFIED). Source: https://www.lemonsqueezy.com/migration-offer, plus blog coverage.

---

## 5. Shopify

**1. Reference passthrough.**
- **Cart attributes (client-side).** Set them on the storefront with `POST /cart/update.js {attributes:{…}}`; a `__` prefix hides them at checkout. They become order custom attributes: GraphQL `Order.customAttributes`, REST `note_attributes`.
- **Automatic journey data.** `Order.customerJourneySummary.firstVisit`/`lastVisit` includes `landingPage`, `referrerUrl`, `referralCode` (read from the `ref`, `source` or `r` URL parameter), `utmParameters`, `source`, `occurredAt`, and `daysToConversion` (30-day window). Check `ready` before trusting it.
- **Deprecated** order-level `landingPageUrl`, `referrerUrl`, and `referralCode`.
- **Web Pixels `checkout_completed`** exposes `checkout.attributes`, `discountApplications`, order `id`, `totalPrice`, `currencyCode`.
- Docs: https://shopify.dev/docs/api/ajax/reference/cart ; https://shopify.dev/docs/api/admin-graphql/latest/objects/Order ; https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerJourneySummary ; https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerVisit ; https://shopify.dev/docs/api/web-pixels-api/standard-events/checkout_completed

**2. Webhooks.**
- **Topics:** `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled`, `order_transactions/create`, `refunds/create` (supports partial refunds), `disputes/create`, `disputes/update`, `subscription_contracts/create`, `subscription_billing_attempts/success`, `customers/create`, `app/uninstalled`.
- **Headers.** `X-Shopify-Hmac-Sha256` (HMAC-SHA256 base64 with the app secret), `X-Shopify-Webhook-Id` for dedupe, `X-Shopify-Triggered-At`.
- **Retries.** 5 s timeout, then "retries … 8 times over the next 4 hours". After 8 consecutive failures an API-created subscription is deleted.
- **Destinations:** HTTPS, Google Pub/Sub, or Amazon EventBridge.
- Docs: https://shopify.dev/docs/api/webhooks/latest ; https://shopify.dev/docs/apps/build/webhooks ; https://shopify.dev/docs/apps/build/webhooks/subscribe/https ; https://shopify.dev/docs/apps/build/webhooks/troubleshoot

**3. Third-party access.** A full app-install OAuth: authorization-code grant, token exchange, or managed install; offline tokens for background jobs. Webhooks are declared in `shopify.app.toml` or created per shop with `webhookSubscriptionCreate`. Docs: https://shopify.dev/docs/apps/build/authentication-authorization

**4. Read API.**
- GraphQL `orders` query with `created_at`/`updated_at` filters.
- **Only the last 60 days by default.** Older orders need the `read_all_orders` scope, which needs approval for public apps.
- No webhook replay API; Shopify recommends reconciliation jobs.
- REST Admin has been legacy since 1 Oct 2024, and new public apps must be GraphQL-only from 1 Apr 2025.
- Docs: https://shopify.dev/docs/api/admin-graphql/latest/objects/Order ; https://shopify.dev/docs/api/admin-rest

**5. Coupons.** `Order.discountCodes` / `discountCode`, plus `discountApplications`.

**6. Customer identity.** `Order.customer` (`gid://shopify/Customer/…`), which can be null. Subscription contracts have a `customer`, and `SubscriptionContract.customAttributes` are "added to the generated orders", so a click id stamped on the contract follows renewals. Docs: https://shopify.dev/docs/api/admin-graphql/latest/objects/SubscriptionContract

**7. Amounts.** `MoneyBag` with `shopMoney` and `presentmentMoney`, decimal-string amounts. Multi-currency.

**8. Gotchas.**
- **Protected customer data.** Name, email, phone and address need approval for public apps. Without it, those fields come back null in both API responses and webhooks. Dev stores are exempt. Docs: https://shopify.dev/docs/apps/launch/protected-customer-data
- A theme app embed or merchant snippet is needed to write the cart attribute.
- Pixels run sandboxed and are subject to consent (consent behaviour UNVERIFIED in detail).
- Subscriptions are app-driven (Shopify Subscriptions or third-party apps), so renewal orders show up as ordinary `orders/create` events.

---

## 6a. Chargebee

**1. Reference passthrough.**
- **Subscription/customer custom fields `cf_*`** can be pre-filled on hosted checkout through the URL (`subscription[cf_field_id]=value`) or Chargebee.js drop-in `setCustomData`. They must be defined in the merchant's site first.
- **`subscription.meta_data`** is a JSON blob of up to 65,535 chars, set through the API.
- **Hosted pages** take `pass_thru_content` (≤2048 chars), but it lives on the hosted_page object. Whether it reaches webhooks is UNVERIFIED.
- Docs: https://www.chargebee.com/docs/billing/2.0/kb/platform/prefillingpassing-custom-fields-to-hosted-pages-via-plan-url ; https://apidocs.chargebee.com/docs/api/hosted_pages ; https://apidocs.chargebee.com/docs/api/subscriptions

**2. Webhooks.**
- **Events:** `subscription_created`, `subscription_activated`, `subscription_renewed`, `payment_succeeded`, `payment_failed`, `payment_refunded`, `refund_initiated`, `invoice_generated`, `transaction_created`, `customer_created`, coupon events. Disputes: `collections_dispute_created`/`_updated`/`_resolved`/`_withdrawn` (whether these cover gateway chargebacks is UNVERIFIED).
- **Security.** Basic auth or a secret in the URL, plus IP allow-listing. **No HMAC signature.** To verify, re-fetch the event by id.
- **Retries.** Up to 7 retries (2 m, 6 m, 30 m, 1 h, 5 h, 1 d, 2 d). Resend manually from the console.
- **Max 5 webhook endpoints.**
- Docs: https://apidocs.chargebee.com/docs/api/event-types (also https://apidocs.chargebee.com/docs/api/events/event-types) ; https://www.chargebee.com/docs/billing/2.0/site-configuration/webhook_settings ; https://apidocs.chargebee.com/docs/api/events

**3. Third-party access.**
- **OAuth Apps:** a partner redirects to Chargebee's consent screen and gets access plus refresh tokens. Roles include Read Only Access. Marketplace listing needs a partner account (partners@chargebee.com); private apps are allowed.
- **Fallback:** a "Read-only: All" or "Restricted" API key; Impact.com's integration uses this.
- Creating webhooks through the API: UNVERIFIED.
- Docs: https://www.chargebee.com/docs/billing/2.0/site-configuration/oauth-apps ; https://www.chargebee.com/docs/billing/2.0/site-configuration/api_keys

**4. Read API.** `GET /api/v2/events` filters by `occurred_at[after|before|between]`, `event_type[in]`, `source`, `webhook_status` (last 6 days), ≤100 per page. Retention is not stated. Standard list endpoints (subscriptions, invoices, transactions) take date filters. Docs: https://apidocs.chargebee.com/docs/api/events/list-events

**5. Coupons.** `subscription.coupons[]` exists (sub-fields such as `coupon_code`: UNVERIFIED), and invoices carry discounts.

**6. Customer identity.** `customer_id` (≤50) and the subscription id are stable across renewals.

**7. Amounts.** Integer cents (smallest unit); some `*_in_decimal` fields are in major units. Multi-currency.

**8. Gotchas.**
- No HMAC on webhooks.
- The 5-endpoint cap competes with the merchant's other tools.
- Custom fields must be pre-created by the merchant.
- Webhook payloads embed the subscription, so the `cf_` click id rides along on renewals.

## 6b. Recurly

**1. Reference passthrough.**
- **Custom fields** on account, subscription, charge, item and plan: text, 255 chars. Defined in the Admin Console, set through the API or UI.
- **Plan availability:** none on Starter; 5 on Pro or Sandbox; 10 on Elite.
- Recurly Checkout (`*.recurlycheckout.com`) and the deprecated Hosted Payment Pages document no URL parameter for custom fields (UNVERIFIED). Assume server-side only (Recurly.js tokenizes, our server creates the purchase).
- Docs: https://docs.recurly.com/recurly-subscriptions/docs/custom-fields ; https://docs.recurly.com/recurly-subscriptions/docs/checkout ; https://docs.recurly.com/hosted-payment-pages

**2. Webhooks.**
- **JSON notifications carry ids only:** `{id, object_type, site_id, event_type, event_time, uuid}`. You fetch the object.
- **Events:** subscription `created`/`renewed`/`updated`/`canceled`/`expired`; payment `succeeded`/`failed`/`refunded`/`voided`/`transaction_status_updated`; charge-invoice `paid`, among others. No dedicated dispute/chargeback notification found (UNVERIFIED).
- **Signature.** `recurly-signature: <ts>,<sig>[,<sig>]`, HMAC-SHA256 over `ts.rawBody` with the per-endpoint secret. Old and new keys both stay valid for 24 h after rotation.
- **Retries.** Up to 10 retries with exponential backoff (`10 + x·2^(x+5)` s). Up to 10 endpoints.
- **"Webhooks cannot be configured via API."**
- Docs: https://docs.recurly.com/recurly-subscriptions/docs/overview-webhooks ; https://docs.recurly.com/recurly-subscriptions/docs/subscription-notifications ; https://docs.recurly.com/recurly-subscriptions/docs/payment-notifications ; https://docs.recurly.com/recurly-subscriptions/v2.29/docs/signature-verification ; https://docs.recurly.com/docs/webhooks

**3. Third-party access.** Merchant API keys; no OAuth found (UNVERIFIED). The merchant must also add our webhook endpoint by hand.

**4. Read API.** v2021-02-25 list endpoints use `begin_time` (and, per my recollection, `end_time` and `sort=created_at|updated_at`; UNVERIFIED). Rate limit: production 1,000 GET/min, sandbox 400/min, over a sliding 5-minute window. No events API found. Docs: https://docs.recurly.com/recurly-subscriptions/v2021-02-25/reference ; https://support.recurly.com/hc/en-us/articles/360034160731

**5. Coupons.** Coupon redemptions on accounts and subscriptions (field details UNVERIFIED).

**6. Customer identity.** `account_code` is stable and merchant-defined; subscription `uuid`.

**7. Amounts.** Decimal numbers in v3 (UNVERIFIED). Multi-currency.

**8. Gotchas.**
- Starter-plan merchants cannot use custom fields at all. Fallback: store the click id keyed by `account_code` in our DB when the merchant's backend creates the account.
- Id-only webhooks mean extra API calls against the rate limit.

---

## 7. Braintree

**1. Reference passthrough.**
- **Per transaction:** `orderId` (≤255; ≤127 for PayPal, where it maps to the invoice number and must be unique) and `customFields`, which must be set up in the Control Panel first (≤255 per value).
- **Server-side only:** `transaction.sale`.
- **`Subscription.create` has no `customFields` parameter**, so renewal transactions do not carry our reference. Customers do support custom fields (UNVERIFIED detail).
- Docs: https://developer.paypal.com/braintree/docs/reference/request/transaction/sale/node ; https://developer.paypal.com/braintree/docs/reference/request/subscription/create/node

**2. Webhooks.**
- **Subscription kinds:** `subscription_charged_successfully` (the subscription object includes up to 20 recent transactions), `subscription_charged_unsuccessfully`, `subscription_went_active`, `subscription_went_past_due`, `subscription_canceled`, `subscription_expired`, `subscription_trial_ended`, `subscription_billing_skipped`.
- **Disputes:** `dispute_opened`/`_won`/`_lost`/`_accepted`/`_auto_accepted`/`_disputed`/`_expired`/`_under_review`.
- **No webhook for a successful one-off card sale** (it is synchronous). Refund webhooks were not found.
- **Delivery.** Form POST with `bt_signature` + `bt_payload`, verified through the SDK's `webhookNotification.parse`.
- **Retries.** 30 s timeout; resent hourly for up to 24 h in production (3 h in sandbox).
- Docs: https://developer.paypal.com/braintree/docs/reference/general/webhooks/subscription/node ; https://developer.paypal.com/braintree/docs/reference/general/webhooks/dispute/node ; https://developer.paypal.com/braintree/docs/guides/webhooks/parse/node ; https://developer.paypal.com/braintree/docs/guides/webhooks/overview

**3. Third-party access.** Braintree OAuth / Braintree Auth: a connect URL with scopes `read_only`, `read_write`, `manage_disputes`, `oauth_app_receive_dispute_webhooks`. It is "closed beta in production". Otherwise merchants share API keys. Docs: https://developer.paypal.com/braintree/docs/guides/extend/oauth/overview ; https://developer.paypal.com/braintree/docs/guides/braintree-auth/reference/node/

**4. Read API.** Transaction search on `createdAt` (range), `orderId`, `customerId`, `status`, `type` (sale/credit), `refund`. Custom fields are not searchable, and the result cap and retention are not stated. Docs: https://developer.paypal.com/braintree/docs/reference/request/transaction/search/node

**5. Coupons.** Subscription "discounts" are plan modifiers, not codes. No coupon code on transactions.

**6. Customer identity.** Vault `customerId` and `subscriptionId` are stable.

**7. Amounts.** Decimal strings (`"100.00"`). Multi-currency per merchant account.

**8. Gotchas.** Without webhooks for one-off sales and without OAuth, we would need the merchant's keys plus polling. Renewal attribution has to join on `subscriptionId` or `customerId`.

---

## 8. Adyen

**1. Reference passthrough.**
- **`reference`** (merchantReference; no max shown in the v71 spec, historically 80, UNVERIFIED) and **`merchantOrderReference`** (≤1000 on payment links).
- **`metadata`:** at most 20 pairs, 20-char keys, 80-char values. It is returned in the AUTHORISATION webhook `additionalData` as `metadata.<key>`.
- **`shopperReference`:** 3–256 chars, no PII.
- Set server-side through `/sessions`, `/payments` or `/paymentLinks`. No client-side or URL passthrough.
- Docs: https://docs.adyen.com/api-explorer/Checkout/71/post/sessions ; https://docs.adyen.com/api-explorer/Checkout/71/post/paymentLinks ; OpenAPI https://github.com/Adyen/adyen-openapi (CheckoutService-v71, Webhooks-v1)

**2. Webhooks.**
- **Event codes:** `AUTHORISATION`, `CAPTURE`, `REFUND` (partial allowed), `REFUND_FAILED`, `CANCEL_OR_REFUND`, `CHARGEBACK`, `NOTIFICATION_OF_CHARGEBACK`, `CHARGEBACK_REVERSED`, `SECOND_CHARGEBACK`, `PREARBITRATION_*`, `REQUEST_FOR_INFORMATION`, `RECURRING_CONTRACT`, `REPORT_AVAILABLE`, …
- **HMAC.** `additionalData.hmacSignature` is HMAC-SHA256 over concatenated fields (`pspReference`, …), base64. Some webhook types use a `HmacSignature` header instead.
- **Retries.** After the initial attempts, the webhook goes into a retry queue for up to 30 days (2/5/10/15/30 min …). Retry or ignore from the Customer Area.
- Docs: https://docs.adyen.com/development-resources/webhooks ; https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures ; https://docs.adyen.com/development-resources/webhooks/troubleshoot

**3. Third-party access.**
- **OAuth is "only available for partners".** Scopes include `psp.webhook:read` and `psp.webhook:write` (create merchant webhooks through the Management API), `psp.onlinepayment:write`, payment links, and others. There is **no reporting or transaction-read scope**.
- Otherwise the merchant creates an API credential or adds a partner user in the Customer Area.
- Docs: https://docs.adyen.com/partners/oauth ; https://docs.adyen.com/partners/oauth/scopes ; https://docs.adyen.com/account/users/partner-users

**4. Read API.** **No list-payments API.** Reconciliation uses reports (Settlement details report, payment accounting), with `REPORT_AVAILABLE` webhooks plus download by a report user. Docs: https://docs.adyen.com/reporting/settlement-reconciliation/transaction-level/settlement-details-report

**5. Coupons.** None.

**6. Customer identity.** `shopperReference` is merchant-supplied and stable when tokenizing.

**7. Amounts.** Integer minor units (`value`, int64) plus `currency`.

**8. Gotchas.**
- Adyen doesn't bill subscriptions. Recurring charges are merchant-initiated with stored tokens, so the merchant's code must re-send `metadata` or the reference on every renewal.
- Enterprise onboarding.
- Whether `metadata` in webhooks needs an "additional data" setting enabled is UNVERIFIED.

---

## 9. Razorpay (India priority)

**1. Reference passthrough.**
- `notes`: "Maximum 15 key-value pairs, 256 characters (maximum) each". Supported on orders, payments, subscriptions, payment links, invoices, and more.
- **Client-side:** the Standard Checkout `options.notes` (UNVERIFIED in the fetched page, but widely used). Server-side: the order or subscription `notes`.
- Payment links carry notes only through the API. Payment Pages use their own custom fields.
- Docs: https://razorpay.com/docs/api/orders/create/ (read via https://razorpay.com/docs/build/llm-docs/api/orders/create.md)

**2. Webhooks.**
- **Events:** `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`; `subscription.authenticated`, `.activated`, `.charged` (every successful charge; payload contains both `subscription` and `payment`), `.pending`, `.halted`, `.cancelled`, `.completed`, `.updated`, `.paused`, `.resumed`; refund events; dispute events under "Disputes | Subscribe to Webhooks".
- **Signature.** `X-Razorpay-Signature` = HMAC-SHA256 of the raw body with the webhook secret. `x-razorpay-event-id` deduplicates.
- **Retries.** Exponential backoff for 24 h, then the webhook is disabled and an alert email sent.
- Docs: https://razorpay.com/docs/webhooks/ ; https://razorpay.com/docs/webhooks/validate-test/ ; https://razorpay.com/docs/webhooks/best-practices/ ; https://razorpay.com/docs/payments/subscriptions/subscribe-to-webhooks/ ; sample payloads https://razorpay.com/docs/webhooks/subscriptions/

**3. Third-party access.**
- **OAuth for Technology Partners:** `auth.razorpay.com`, scopes `read_only` ("all GET API requests") and `read_write`, plus RazorpayX scopes. Becoming a Technology Partner means applying through support.
- **Partner Webhooks API** (`/v2/accounts/:account_id/webhooks`) creates webhooks for a sub-merchant, plus an authorization-revoked webhook.
- Docs: https://razorpay.com/docs/partners/technology-partners/onboard-businesses/integrate-oauth/ ; https://razorpay.com/docs/api/partners/webhooks/

**4. Read API.** `GET /v1/payments?from&to` (unix seconds), `count` ≤100, `skip`. Also orders, refunds, disputes and "fetch all" endpoints. No events-replay API found. Docs: https://razorpay.com/docs/api/payments/fetch-all-payments/

**5. Coupons.** Offers via `offer_id` on payments and subscriptions. Magic Checkout coupon codes: field UNVERIFIED.

**6. Customer identity.** `customer_id` (`cust_…`), present when a customer is created and always present on subscriptions.

**7. Amounts.** Integers in the smallest sub-unit (paise; 3-decimal currencies ×1000). International currencies are supported.

**8. Gotchas.**
- In the official `subscription.charged` sample, `payment.notes` is `[]` while `subscription.notes` is filled. Attribute renewals from the subscription's notes.
- Partner OAuth needs approval.
- The 24 h retry window is short, then the webhook is disabled.
- Fits the India billing work already shipped (#218).

---

## 10a. Mollie

**1. Reference passthrough.**
- `metadata` holds any JSON up to about 1 kB on payments, subscriptions, and so on. "Any metadata added to the subscription will be automatically forwarded to the payments generated for it."
- Payments are created server-side only (no client-side or URL passthrough).
- Docs: https://docs.mollie.com/reference/create-payment ; https://docs.mollie.com/reference/create-subscription

**2. Webhooks.**
- **Legacy (per-payment `webhookUrl`):** a form POST of `id=tr_…` only, no signature; you fetch the payment, which is Mollie's security model. Retries: 10 attempts over 26 h.
- **Next-gen webhooks:** subscribable event types including `payment.paid`/`.failed`/`.authorized`/`.canceled`/`.expired`/`.pending`, `payment-link.paid`, `sales-invoice.*`, `balance-transaction.created`. `refund.*` and `chargeback.received`/`.reversed` appear in the create-webhook enum, but some events are beta (GA status UNVERIFIED).
- Next-gen offers a full snapshot or a simple payload, and is signed with `X-Mollie-Signature` (HMAC-SHA256).
- A Webhook Events API lets you inspect past events.
- Docs: https://docs.mollie.com/reference/webhooks ; https://docs.mollie.com/reference/webhooks-new ; https://docs.mollie.com/reference/create-webhook

**3. Third-party access.** Mollie Connect OAuth: register an app, then the merchant authorizes scopes (`payments.read`, `refunds.read`, `subscriptions.read`, `customers.read`, `settlements.read`, `balances.read`, …). Access tokens last 60 min, with a persistent refresh token. The `webhooks.write` scope lets us create webhooks. Scopes cannot be added after go-live without re-authorization. Docs: https://docs.mollie.com/docs/authentication-via-oauth

**4. Read API.** `GET /v2/payments` is cursor-based (`from` = payment id, `limit`, `sort`). **No date filter**, so page newest-first. Docs: https://docs.mollie.com/reference/list-payments

**5. Coupons.** None on payments.

**6. Customer identity.** `customerId` (`cst_…`) and `subscriptionId` on recurring payments.

**7. Amounts.** `{currency, value: "10.00"}` decimal strings. Multi-currency.

**8. Gotchas.** Run both webhook systems. Next-gen handles signed events at the account level; legacy per-payment URLs set by the merchant's own code won't reach us.

## 10b. Square

**1. Reference passthrough.**
- `Payment.reference_id` (≤40) and `note` (≤500).
- `Order.reference_id` (≤40) and `Order.metadata` (≤10 entries, keys ≤60, values ≤255, private to the writing app; Beta).
- Payment links (`CreatePaymentLink`) are server-side with `order` or `quick_pay` plus `payment_note`. Dashboard-made links have no reference URL parameter (UNVERIFIED).
- Docs: https://developer.squareup.com/reference/square/objects/Payment ; https://developer.squareup.com/reference/square/objects/Order ; https://developer.squareup.com/reference/square/checkout-api/create-payment-link

**2. Webhooks.**
- **Events:** `payment.created`/`updated`, `order.created`/`updated`, `refund.created`/`updated`, `dispute.*`, `invoice.payment_made`, `subscription.created`/`updated` (exact names UNVERIFIED in fetched pages).
- **Signature.** `x-square-hmacsha256-signature` = HMAC-SHA256 over notification URL + raw body.
- **Retries.** 11 attempts over 24 h with `square-retry-number` and `square-retry-reason` headers.
- Docs: https://developer.squareup.com/docs/webhooks/step3validate ; https://developer.squareup.com/docs/webhooks/overview

**3. Third-party access.** OAuth app (`PAYMENTS_READ`, `ORDERS_READ`, …). Webhook subscriptions are per application and events carry `merchant_id`. Delivery for all authorized sellers is UNVERIFIED in the fetched page but is the documented OAuth model. Docs: https://developer.squareup.com/docs/webhooks/step2subscribe

**4. Read API.** `ListPayments` with `begin_time` (default now − 1 year) and `end_time`, ≤100 per page. The Events API covers the past 28 days only, must be enabled first, needs a personal access token ("cannot use OAuth access tokens"), and requires that the app had OAuth access when each event occurred. Docs: https://developer.squareup.com/reference/square/payments-api/list-payments ; https://developer.squareup.com/docs/events-api/overview

**5. Coupons.** Order `discounts[]` (name or catalog object); no code string.

**6. Customer identity.** `customer_id` (≤191). Omitting it can create "instant profiles".

**7. Amounts.** Integers in the smallest denomination (cents).

**8. Gotchas.** Subscription renewals (invoices → orders → payments) won't carry our `reference_id`; join via `customer_id` or subscription. The 40-char limit is fine for a ULID.

## 10c. Paystack

(Official docs at paystack.com sit behind a bot-challenge page my fetches couldn't load, and I did not try to get around it. Points below come from a Paystack docs preview build and secondary sources. **Treat everything here as UNVERIFIED.**)

**1. Reference passthrough.** `metadata` (free JSON, with `custom_fields[]`) on Initialize Transaction, server-side, or Popup/Inline JS, client-side. It is returned on verify and in `charge.success`. Payment Pages: URL passthrough UNVERIFIED. Sources: https://paystack.com/docs/payments/metadata/ ; https://mctaba.com/learn/paystack/paystack-metadata-passing-custom-data-through-a-transaction

**2. Webhooks.**
- **Events:** `charge.success`, `subscription.create`/`.disable`/`.enable`, `invoice.create`/`.update`/`.payment_failed`, `charge.dispute.create`/`.remind`/`.resolve`, `transfer.*`. `refund.*` is not in the preview list.
- **Signature.** `X-Paystack-Signature` = HMAC-SHA512 of the body with the merchant's **secret key**.
- **Retries.** Hourly for 72 h, per the docs build. Secondary sources say live is every 3 min ×4, then hourly.
- Sources: https://refunds-pilot--documentation-v2.netlify.app/payments/webhooks/ (Paystack docs preview) ; https://paystack.com/docs/payments/webhooks/

**3. Third-party access.** No partner OAuth found. The merchant would have to share a secret key, and read-only keys are not known to exist. This is a security and liability concern.

**4. Read API.** List Transactions with `from`/`to` (dates); detail UNVERIFIED.

**5. Coupons.** UNVERIFIED.

**6. Customer identity.** `customer.customer_code`, `subscription_code`.

**7. Amounts.** Integers in subunits (kobo, pesewas, cents).

**8. Gotchas.** Renewal charges are created by Paystack without a new initialize call, so metadata likely doesn't carry over (UNVERIFIED); join on subscription or customer code. Webhook verification uses the same secret key we'd hold for the API.

## 10d. Gumroad

**1. Reference passthrough.**
- **Any URL parameter added to a Gumroad product URL shows up in the Ping's `url_params` dictionary** (client-side, no code). This is the easiest passthrough in this survey.
- Checkout `custom_fields` are also returned. On recurring charges the payload falls back to the subscription's custom fields (seen in Gumroad's source). Whether `url_params` repeat on recurring charges is UNVERIFIED and likely not.
- Docs: https://gumroad.com/ping (source: https://github.com/antiwork/gumroad/blob/main/app/javascript/pages/Public/Ping.tsx) ; payload builder https://github.com/antiwork/gumroad/blob/main/app/modules/purchase/ping_notification.rb

**2. Webhooks.**
- **Ping** is a form POST with `sale_id`, `subscription_id`, `is_recurring_charge`, `price` (USD cents), `offer_code`, `affiliate`, `refunded`, `disputed`, `dispute_won`, `resource_name`, `retry_count`, …
- Resource subscriptions add `sale`, `refund`, `dispute`, `dispute_won`, `cancellation`, `subscription_updated`, `subscription_ended`, `subscription_restarted`.
- **Unsigned:** "Because the payload is unsigned … treat a ping as a trigger … read the sale back through the API".
- **Retries.** 1 m, 3 m, 10 m, 1 h, and only for 499/500/502/503/504. At-least-once, unordered. 5 s timeout.
- Docs: same as above ; https://github.com/antiwork/gumroad/blob/main/app/models/resource_subscription.rb

**3. Third-party access.** OAuth (Doorkeeper) scopes include `view_sales`, `view_payouts`, `edit_products`, `refund_sales`, `edit_sales`, `mark_sales_as_shipped`. Resource subscriptions belong to an OAuth application, so a platform can register webhooks for a seller. Docs: https://gumroad.com/api ; https://github.com/antiwork/gumroad/blob/main/config/initializers/doorkeeper.rb

**4. Read API.** `GET /v2/sales?after=YYYY-MM-DD&before=YYYY-MM-DD` (plus email, product, order filters; paginated, `view_sales` scope). Source: https://github.com/antiwork/gumroad/blob/main/app/controllers/api/v2/sales_controller.rb

**5. Coupons.** `offer_code` is in the Ping.

**6. Customer identity.** `purchaser_id` (only if the buyer has a Gumroad account), `email`, `subscription_id`.

**7. Amounts.** Always USD cents, "whatever this value is" for `currency`. The listing currency is separate.

**8. Gotchas.** No signature, so always re-fetch the sale. Short retries. Gumroad runs its own affiliate program, which may overlap or conflict with ours.

## 10e. WooCommerce

**1. Reference passthrough.**
- Order `meta_data`, written by a plugin or snippet: for example, read our cookie at checkout and save it as order meta.
- **Built-in Order Attribution** (WooCommerce 8.5+) stores source type, referrer, UTM, device and session entry page in `_wc_order_attribution_*` meta. Whether the entry page keeps the query string, which would hold the click id, is UNVERIFIED.
- Woo Subscriptions copies subscription meta to renewal orders ("will copy all post meta data stored against the 'shop_subscription' post to renewal orders").
- Docs: https://woocommerce.com/document/order-attribution-tracking/ ; https://woocommerce.com/document/subscriptions/orders/ (meta-copy wording from Woo Subscriptions developer docs; exact page UNVERIFIED)

**2. Webhooks.**
- **Topics:** `order.created`, `order.updated`, `order.deleted`, `order.restored`, plus custom action topics. There is **no `order.paid`**; detect paid from status in `order.updated`.
- **Headers.** `X-WC-Webhook-Signature` = base64 HMAC-SHA256 of the payload with the secret, plus `X-WC-Webhook-Topic` and `X-WC-Webhook-Delivery-ID`.
- **"After 5 consecutive failed deliveries … the webhook is disabled."** No retry schedule is documented.
- Docs: https://woocommerce.github.io/woocommerce-rest-api-docs/#webhooks

**3. Third-party access.** The `/wc-auth/v1/authorize?app_name&scope=read|write|read_write&user_id&return_url&callback_url` flow issues REST keys to our callback, which works like an app-install OAuth. Webhooks can be created through `POST /wc/v3/webhooks`. Docs: https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication

**4. Read API.** `GET /wc/v3/orders?after&before&modified_after&modified_before&per_page` (default 10). No lookback limit; it's the merchant's own database.

**5. Coupons.** `coupon_lines[].code`.

**6. Customer identity.** `customer_id` (0 for guests), so fall back to billing email.

**7. Amounts.** Decimal strings with two decimals plus `currency`.

**8. Gotchas.**
- Self-hosted stores vary widely: caching plugins can strip cookies, and the store must be publicly reachable.
- We'd need to ship a small WordPress plugin to write the click id meta reliably.
- Disabled webhooks need re-enabling through the API.

---

## Common connector shape

**Minimum for us to support a provider:**
1. **Reference passthrough that round-trips.** A per-checkout field we (or a snippet) can set to the click id, returned on the payment-success webhook. If it doesn't survive renewals, there must be a stable id we can join on: a subscription or customer id present on renewal events.
2. **Authenticated webhooks.** An HMAC or asymmetric signature, or failing that a fetch-to-verify pattern (Mollie legacy, Gumroad, Chargebee re-fetch) for payment success, refunds (partial amount) and, ideally, disputes.
3. **A read API for catch-up.** List payments or orders by time (or at least newest-first paging) so missed webhooks and back-fill can be reconciled.

**Strongly preferred extras:** platform auth (OAuth or app install) instead of pasted secrets; registering webhooks through the API; an events or replay API; the coupon code on the order; amounts in minor units or exact decimals.

**Who meets the minimum:**

| Provider | (1) Reference | (2) Auth'd webhooks | (3) Read API | Meets minimum? | Platform auth + webhook registration |
|---|---|---|---|---|---|
| Paddle | Yes, plus renewals | Yes | Yes (+ events 90d) | **Yes** | API key only; webhooks via API |
| Shopify | Yes, plus renewals (contracts) | Yes | Yes (60d default) | **Yes** | OAuth; webhooks via API |
| Chargebee | Yes (`cf_`, on subscription) | Basic auth + re-fetch | Yes (events) | **Yes** | OAuth Apps; webhook API UNVERIFIED |
| Razorpay | Yes (subscription notes for renewals) | Yes | Yes | **Yes** | OAuth (partner approval); partner webhooks API |
| Mollie | Yes, plus renewals | Next-gen signed; legacy re-fetch | Yes (cursor) | **Yes** | OAuth; `webhooks.write` |
| PayPal | Yes (`custom_id`; renewals via subscription join) | Yes | Yes (3h lag, 3y) | **Yes, with caveats** | Partner approval; app-scoped webhooks |
| Lemon Squeezy | Yes (renewals UNVERIFIED; join on subscription) | Yes | Weak (no date filter) | **Yes (weak)** | API key; webhooks via API |
| Square | Yes (server-side; renewals via join) | Yes | Yes | **Yes** | OAuth; app-level webhooks |
| WooCommerce | With plugin | Yes | Yes | **Yes** | wc-auth keys; webhooks via API |
| Gumroad | Yes (`url_params`) | Re-fetch only | Yes | **Yes** | OAuth; resource subscriptions |
| Paystack | Yes (renewals UNVERIFIED) | Yes | Yes | **Likely yes (UNVERIFIED)** | Secret key only |
| Recurly | Only on Pro/Elite plans, server-side | Yes (id-only) | Yes | **Partially** | API key; webhooks manual |
| Braintree | One-off only; renewals via join | Yes | Yes | **Partially** (no one-off sale webhook) | OAuth closed beta |
| Adyen | Yes (merchant re-sends on recurring) | Yes | **No list API** (reports) | **No** (unless report ingestion) | OAuth partners only; webhook write scope |
| Wise | Payer-typed text only | Yes | Partner-gated | **No** | Partner-only OAuth |

**Suggested build order:**
1. **Paddle and Shopify.** Highest fit, and both have big SaaS and e-commerce install bases.
2. **PayPal.** It is many brands' second rail. It needs the subscription-join design and a decision between Transaction Search polling and asking merchants to add our webhook to their own app.
3. **Razorpay.** India (pairs with #216 and #218).
4. **Chargebee and Mollie.**
5. **Lemon Squeezy, Gumroad, WooCommerce, Square** as long-tail connectors.

**Skip:** Wise for ingestion (keep it as a payout rail) and Adyen unless an enterprise customer asks.
