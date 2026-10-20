# Pay-by-invoice billing

**Status:** built Oct 2026. Hosted only: self-hosted installs have no
OpenPartner billing. Code: `apps/api/src/invoice-billing.ts` (terms,
GSTIN, Stripe helpers), `billing-plan.ts` (the overdue grace),
`routes/billing.ts` (brand routes), `routes/platform-admin.ts` (ops
routes), `billing-lifecycle.ts` and `routes/stripe-webhook.ts` (overdue
notices).

## Why

A hosted plan is normally a Stripe subscription charged to a saved card.
That fails for brands in India. Under RBI's e-mandate rules, a recurring
cross-border card or UPI debit over ₹15,000 (about $170) needs the
cardholder to approve each debit from the bank's pre-debit notice. Stripe
holds an Indian card renewal for 26 hours and attempts it only once, and
RuPay and Amex cards get no mandate at all. The metered fee crosses ₹15,000
at roughly $6k of attributed GMV a month, so the brands that grow are the
ones whose renewals fail.

So those brands pay by invoice instead. The subscription has the same plan
prices and the same usage meter as a card one, with
`collection_method: send_invoice`. Stripe emails each monthly invoice, and
the brand pays it from Stripe's hosted invoice page. Nothing is charged
automatically. OpenPartner stays on Stripe; it doesn't move to a merchant
of record.

## Who pays by invoice

In order:

1. **Ops' choice for the brand**: `HostedBillingProfile.collectionMethod`,
   set in the ops console under **Invoicing**.
2. **The declared-country default**: a brand whose declared country
   (`LocationDeclaration`, [country-access.md](country-access.md)) is on
   the list in PlatformSetting `invoiceBilling`. The list is India (`IN`)
   out of the box and is edited on the same tab.
3. Otherwise **a card**, through Checkout as before.

The default applies to **new** subscriptions only. A brand already
subscribed by card stays on card until ops switches it explicitly, which
moves the live subscription (see below).

Per brand, ops also sets the payment terms (`daysUntilDue`, default 15)
and the overdue grace (`graceDays`, default 30).

## How a brand starts

The Billing page shows a pay-by-invoice form instead of the Checkout
button. It asks for the legal business name printed on invoices, an
optional address for the invoice emails, and, for an Indian brand, the
GSTIN. It calls `POST /billing/invoice-subscription`, which:

1. locks the tenant row, so a double submit can't start two subscriptions;
2. creates or reuses the Stripe customer and puts the tax details on it;
3. creates the subscription: the plan's prices (plus the white-label
   add-on when asked), `collection_method: send_invoice`,
   `days_until_due`, and payment methods `card` and `customer_balance`
   (US bank transfer);
4. stores the subscription pointer and mirrors its status, just as the
   Checkout webhook does;
5. finalizes the first invoice at once (Flex: the first month's $49;
   Revshare: a $0 invoice). Stripe would otherwise wait about an hour.
   Finalizing emails the invoice and returns its pay link.

`POST /billing/checkout` answers `409 invoice_billing` for these brands,
and `POST /billing/invoice-subscription` answers `409 card_billing` for
everyone else.

From then on the Billing page lists open invoices with their pay links and
due dates, and shows "update billing details" wording instead of "update
card". The Stripe Customer Portal still works for invoice history and plan
changes. Usage metering is unchanged: meter events go to the customer
whatever the collection method.

### What the invoice page offers

Checked in Stripe test mode on Oct 19 2026, for a USD invoice to a customer
in India: the hosted invoice page offers exactly **Card** and **Bank
transfer**. Bank transfer reads "send an ACH or a wire transfer to" and
lists the account holder, routing number, account number, **SWIFT code**,
bank name, and a reference equal to the invoice number. A transfer quoting
that reference is matched to the invoice automatically (`invoice.paid`).
A card payment there is a one-off payment the cardholder authorizes with
3-D Secure, not a recurring mandate, so the RBI rule doesn't block it.

## Indian brands: GSTIN and reverse charge

A GST-registered Indian business that buys OpenPartner pays the GST itself
under **reverse charge**. OpenPartner is not registered under OIDAR, so it
can't invoice Indian buyers who aren't GST-registered. Therefore:

- An Indian brand on invoice billing must give its **GSTIN** before it can
  start (`400 gstin_required`). The check character is verified
  (`normalizeGstin`). Stripe only checks a GSTIN's shape: its `in_gst`
  verification status is always `unavailable`.
- The GSTIN goes on the Stripe customer as tax ID `in_gst`, with the
  invoice footer **"Reverse charge applicable"** and the address country
  `IN` when none is set. Every invoice finalized afterwards prints them.
  They go on the customer before the subscription is created, because an
  invoice copies them only when it's finalized.
- A brand corrects its GSTIN on the Billing page (`PUT /billing/tax-details`).
  The new one replaces the old on the Stripe customer.
- Ops can't move a subscribed Indian brand to invoices until it has a GSTIN
  on file (`409 gstin_required`).

## Overdue invoices

Stripe never charges a `send_invoice` invoice, so there is no dunning and
no `invoice.payment_failed`. What happens instead, checked with a Stripe
test clock:

| When | Stripe | OpenPartner |
|---|---|---|
| Subscription created | `active`; first invoice sent | Plan active; partners can be onboarded |
| Invoice open, not yet due | `active` | Nothing changes |
| Due date passes unpaid | `customer.subscription.updated` → `past_due` | Mirror records `pastDueSince`; ops gets one "Invoice overdue" email for the stretch; the Billing page shows the overdue banner and the date onboarding pauses |
| Up to `graceDays` (30) past due | still `past_due` | Service continues |
| Grace runs out | still `past_due` | `hasActivePlan` is false: partner onboarding and bonuses answer `402 plan_required` with `reason: "invoice_overdue"`, and white-label stops being entitled. Clicks, attribution, commissions and the dashboard keep working |
| Latest invoice paid | `active` | `pastDueSince` clears; everything resumes |

Paying an older overdue invoice alone doesn't end the stretch: the
subscription returns to `active` only once its latest invoice is paid.

The grace runs on OpenPartner's side, because Stripe may leave the
subscription `past_due` for good. In the test account, at 35 days overdue
with a second invoice issued, it was still `past_due`. In Stripe, under
**Billing → Revenue recovery → Manage invoices sent to customers**, leave
"mark the subscription as past due" selected rather than cancelling. A
cancellation ends the plan (the normal `customer.subscription.deleted`
path) and stops new invoices. Do switch on Stripe's **reminder emails** for
invoices that are about to fall due and for overdue ones: they are the
brand's only reminders.

Card subscriptions are unchanged: `past_due` keeps service while Stripe
retries, and its settings decide when the subscription becomes `unpaid` or
`canceled`. Funding eligibility is unchanged too: a new funding batch needs
an `active` or `trialing` subscription, so an overdue invoice pauses new
batches from the first day.

The nightly subscription reconcile (`reconcileTenantSubscriptions`)
refreshes the mirror, including the collection method and `pastDueSince`,
and sends any overdue email the webhook missed. The email is deduped per
stretch by Config key `billing_overdue_notice` and recorded only after a
successful send.

## Switching a subscribed brand

On the **Invoicing** tab, saving a different way to pay for a brand with a
live subscription updates that subscription in Stripe first, and the
profile only if that worked:

- **To invoice**: the GSTIN (if Indian) goes on the customer, then
  `collection_method: send_invoice` with the brand's terms and payment
  methods. Changing only the due days updates them the same way.
- **To card**: refused (`409 no_payment_method`) unless the customer or
  the subscription has a default card. The brand can add one in the Stripe
  Customer Portal. The update clears both invoice-only settings
  (`payment_method_types` and the `customer_balance` option). Stripe
  rejects `charge_automatically` while the bank-transfer option is set.

Either way it takes effect from the next invoice. An invoice already
finalized keeps its terms. Both directions were run in Stripe test mode.

## Ops: tax documents Indian buyers ask for

An Indian company paying a foreign supplier withholds income tax (TDS)
from the payment unless it can apply the India–US tax treaty. To apply the
treaty, its finance team usually asks for:

- **IRS Form 6166**: the US certificate of tax residency. Request it from
  the IRS with Form 8802, a few weeks ahead. It covers one calendar year.
- **Form 10F**: a declaration of the details the Indian tax rules require
  alongside the residency certificate. It is filed electronically on the
  Indian income-tax portal, where a non-resident without a PAN can
  register.
- **A no-PE letter**: a signed statement that OpenPartner has no permanent
  establishment in India (no office, staff or dependent agent there), so
  its fees are business profits taxable only in the US under the treaty.

Without them the buyer may withhold a share of each invoice, and the
invoice is then short-paid in Stripe. Keep the current year's documents
ready before an Indian brand's first invoice. Have a tax adviser confirm
the wording; this note is a pointer, not tax advice.

## API

| Route | Who | What |
|---|---|---|
| `GET /billing/status` | brand admin | adds `collection` (method, source, daysUntilDue, country, gstin, gstinRequired), `subscriptionCollectionMethod`, `invoiceOverdue` |
| `POST /billing/invoice-subscription` | brand admin | start the plan by invoice (body: `legalName?`, `billingEmail?`, `gstin?`, `whiteLabel?`) |
| `PUT /billing/tax-details` | brand admin | set or correct an Indian brand's GSTIN |
| `GET /billing/invoices` | brand admin | adds `dueDate`, `amountRemaining`, `collectionMethod` |
| `GET /platform-admin/invoice-billing` | operator | default countries, defaults, brands |
| `PUT /platform-admin/invoice-billing/settings` | operator (admin) | `{ defaultCountries }` |
| `PUT /platform-admin/invoice-billing/tenants/:idOrSlug` | operator (admin) | `{ collectionMethod?, daysUntilDue?, graceDays? }`; `null` method = country default |

None of these are in the public OpenAPI document. They're portal and
console routes, like the rest of billing.

## Data

- `HostedBillingProfile` (migration `20261019050000`): a hosted billing
  sidecar with one row per brand that ops or the brand set something for.
  It is not exported ([data-portability.md](data-portability.md)), is
  purged with the tenant, and has tenant RLS.
- `HostedBillingState.collectionMethod` and `.pastDueSince`: the webhook
  mirror of the live subscription.
- PlatformSetting `invoiceBilling`: `{ defaultCountries }`.
- Config `billing_overdue_notice`: the overdue-email dedupe marker.
