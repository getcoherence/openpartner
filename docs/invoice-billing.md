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
optional address for the invoice emails, an optional promotion code, and,
for an Indian brand, the GSTIN. It calls `POST /billing/invoice-subscription`
(`invoice-billing.ts startInvoiceSubscription`).

Unlike a Checkout Session, a `send_invoice` subscription bills the moment
it exists, so the app must never lose track of one. None of this runs in
the request's transaction, whose rollback would lose the pointer:

1. **Customer step**, in a transaction of its own: create or reuse the
   Stripe customer, save the GSTIN, commit. Then the tax details go on the
   customer.
2. **Subscription step**, in a second transaction that locks the tenant
   row, so a double submit waits and then sees the pointer. If the
   customer already has a live subscription this tenant started (stamped
   `openpartner_tenant_id` + `openpartner_collection: send_invoice`), it is
   **adopted**; that covers a crash or a lost response before the pointer
   committed. Otherwise the subscription is created: the plan's prices
   (plus the white-label add-on when asked), `collection_method:
   send_invoice`, `days_until_due`, payment methods `card` and
   `customer_balance` (US bank transfer), and the promotion code as a
   discount. The pointer, the status mirror and white-label commit
   together.
3. **Compensation**: if that transaction fails after Stripe created the
   subscription, the subscription is cancelled. Its draft first invoice is
   finalized without sending and voided, because Stripe won't delete a
   subscription's invoice and would otherwise email it an hour later
   (checked in test mode: no `invoice.sent`, ends `void`). A retry starts
   clean.
4. The first invoice is finalized at once (Flex: the first month's $49;
   Revshare: a $0 invoice). Stripe would otherwise wait about an hour.
   Finalizing emails the invoice and returns its pay link.

A process that dies between steps 2 and 3 leaves a subscription with no
pointer. The `customer.subscription.created` webhook adopts it when the
tenant has no pointer and the customer matches, and logs an ALERT when the
tenant already points at another subscription. **Destination A must carry
`customer.subscription.created`** for this net to work.

`POST /billing/checkout` answers `409 invoice_billing` for these brands,
and `POST /billing/invoice-subscription` answers `409 card_billing` for
everyone else. An unknown promotion code is `400 invalid_promotion_code`;
one Stripe refuses (first-time only, a minimum amount) is
`400 promotion_code_not_applicable`.

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

- **Every** Indian brand must give its **GSTIN**, by invoice
  (`400 gstin_required` on the invoice form) or by card (`409
  gstin_required` from `POST /billing/checkout`, including a brand ops moved
  to card). The check character is verified (`normalizeGstin`). Stripe only
  checks a GSTIN's shape: its `in_gst` verification status is always
  `unavailable`.
- The GSTIN goes on the Stripe customer as tax ID `in_gst`, with the
  invoice footer **"Reverse charge applicable"** and the address country
  `IN` when none is set. Every invoice finalized afterwards prints them.
  They go on the customer before the subscription is created (and before a
  Checkout Session), because an invoice copies them only when it's
  finalized.
- A brand corrects its GSTIN on the Billing page (`PUT /billing/tax-details`).
  The new one replaces the old on the Stripe customer.
- Ops can't move a subscribed Indian brand between card and invoice until
  it has a GSTIN on file (`409 gstin_required`).
- Indian brands already subscribed by card before this shipped have no
  GSTIN. The Billing page shows them a Tax details card asking for one, and
  the Invoicing tab lists every Indian brand with "needed" in the GSTIN
  column, sorted near the top. Their service isn't interrupted.
- A brand that never declared a country can't be recognised as Indian.
  Existing brands get the one-time location prompt
  ([country-access.md](country-access.md)), after which this applies.

## Overdue invoices

Stripe never charges a `send_invoice` invoice, so there is no dunning and
no `invoice.payment_failed`. And the subscription status is no guide:
Stripe derives it from the **latest** invoice only, so paying February's
turns the subscription `active` while January's is still owed (checked with
a test clock). Overdue therefore follows the invoices:

- The mirror (`HostedBillingState`) keeps the **oldest open pay-by-invoice
  invoice** with an amount due, and its due date. `refreshInvoiceDue`
  re-reads the customer's open `send_invoice` invoices on every invoice
  webhook (`invoice.paid`, `.finalized`, `.voided`, `.marked_uncollectible`,
  `.overdue`), on `customer.subscription.updated`, after a subscribe, and
  in the nightly reconcile.
- It also keeps `invoicePaidAt`: when a non-zero invoice (card or invoice)
  was first seen paid. It never clears.
- Once the oldest open invoice's due date passes, service continues
  through the grace (`graceDays`, default 30, per brand), counted from
  that **due date**. After it, `hasActivePlan` is false, whatever the
  subscription status says.
- A brand that has **never paid** a non-zero invoice gets **no grace**:
  onboarding pauses the day its first invoice is overdue. See "Abuse".

| When | OpenPartner |
|---|---|
| Subscription created | Plan active; partners can be onboarded; the first invoice is tracked |
| Invoice open, not yet due | Nothing changes |
| Due date passes unpaid | Ops gets one "Invoice overdue" email for that invoice; the Billing page shows the overdue banner and the date onboarding pauses |
| Within the grace (paying brands only) | Service continues |
| Grace runs out, or first invoice overdue | Every plan-required route (partner onboarding, bonuses, storefront bookings) answers `402 plan_required` with `reason: "invoice_overdue"`, and white-label stops being entitled. Clicks, attribution, commissions and the dashboard keep working |
| The overdue invoice is paid | The next open invoice (if any) becomes the one that counts; otherwise everything resumes |

The ops email is never sent inside a transaction that can roll back: the
webhook queues it and sends after its transaction commits, the nightly
reconcile sends it outside any. Its dedupe marker (Config
`billing_overdue_notice`, keyed by invoice) is **claimed** with an atomic
upsert before sending, so concurrent deliveries send once, and released if
the send fails, so the next pass retries.

The grace runs on OpenPartner's side, because Stripe may leave the
subscription `past_due` for good. In the test account, at 35 days overdue
with a second invoice issued, it was still `past_due`. In Stripe, under
**Billing → Revenue recovery → Manage invoices sent to customers**, leave
"mark the subscription as past due" selected rather than cancelling. A
cancellation ends the plan (the normal `customer.subscription.deleted`
path) and stops new invoices. Do switch on Stripe's **reminder emails** for
invoices that are about to fall due and for overdue ones: they are the
brand's only reminders. Subscribing destination A to the four extra
invoice events is optional: without them, a voided or overdue invoice is
picked up by the nightly reconcile within a day.

Card subscriptions are unchanged: they never have a `send_invoice`
invoice open, so `past_due` keeps service while Stripe retries, and its
settings decide when the subscription becomes `unpaid` or `canceled`. Funding eligibility is unchanged too: a new funding batch needs
an `active` or `trialing` subscription, so an overdue invoice pauses new
batches from the first day.

## Abuse

Invoice terms start a plan with nothing paid, the country is
self-declared, and a GSTIN can only be checked for typos (anyone can
generate one with a valid check character). So a made-up Indian brand
could start a plan and onboard partners without paying. What limits it:

- **Brand approval** ([brand review](../apps/api/src/middleware/approval-gate.ts)):
  every hosted brand is reviewed by ops before it can onboard partners,
  run bonuses or book creators. Unpaid service needs a brand that passed
  review. The Invoicing tab shows each Indian brand's GSTIN for that
  review.
- **No grace before the first paid invoice**: until a brand has paid a
  non-zero invoice, onboarding pauses the day an invoice is overdue. The
  most a new brand gets unpaid is the payment term: 15 days on Flex (its
  first invoice is the $49 month), or the first month plus 15 days on
  Revshare, whose first non-zero invoice is the metered one. That is the
  same exposure as a Revshare card subscription, whose first charge also
  comes at the end of the month.

The more conservative option, making ops approve invoice terms per brand
instead of a country default, was not taken: ops already reviews every
brand, and the brands this exists for (India, where card renewals fail)
would wait twice. Clearing the country list on the Invoicing tab gives that
behaviour if it's ever wanted: invoice terms then only come from ops.

## Switching a subscribed brand

On the **Invoicing** tab, saving a different way to pay for a brand with a
live subscription updates that subscription in Stripe first; a refused
move saves nothing. The profile, the status mirror and the audit row then
commit in one transaction. If that transaction fails, the subscription is
moved back to how it was, so Stripe and the profile never disagree
silently (an ALERT is logged if even that fails). The next edit reads the
live subscription from Stripe, not the profile, to decide whether to move
it.

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
| `POST /billing/invoice-subscription` | brand admin | start the plan by invoice (body: `legalName?`, `billingEmail?`, `gstin?`, `promotionCode?`, `whiteLabel?`) |
| `POST /billing/checkout` | brand admin | unchanged, plus `409 gstin_required` for an Indian brand without a GSTIN, and the GSTIN put on the customer first |
| `PUT /billing/tax-details` | brand admin | set or correct an Indian brand's GSTIN |
| `GET /billing/invoices` | brand admin | adds `dueDate`, `amountRemaining`, `collectionMethod` |
| `GET /platform-admin/invoice-billing` | operator | default countries, defaults, brands |
| `PUT /platform-admin/invoice-billing/settings` | operator (admin) | `{ defaultCountries }` |
| `PUT /platform-admin/invoice-billing/tenants/:idOrSlug` | operator (admin) | `{ collectionMethod?, daysUntilDue?, graceDays? }`; `null` method = country default. Stripe moves first; the profile, mirror and audit row then commit together, and if they can't, the subscription is moved back |

None of these are in the public OpenAPI document. They're portal and
console routes, like the rest of billing.

## Data

- `HostedBillingProfile` (migration `20261019050000`): a hosted billing
  sidecar with one row per brand that ops or the brand set something for.
  `updatedByEmail` is the operator who set the terms; the brand's GSTIN
  edits are recorded apart, in `gstinUpdatedByEmail` / `gstinUpdatedAt`.
  It is not exported ([data-portability.md](data-portability.md)), is
  purged with the tenant, and has tenant RLS.
- `HostedBillingState.collectionMethod`, `.oldestOpenInvoiceId`,
  `.oldestOpenInvoiceDueAt` and `.invoicePaidAt`: how the live subscription
  is collected, the oldest open pay-by-invoice invoice, and when the brand
  first paid.
- PlatformSetting `invoiceBilling`: `{ defaultCountries }`.
- Config `billing_overdue_notice`: the overdue-email dedupe marker, keyed by
  invoice.
