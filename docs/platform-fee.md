# The hosted platform fee

How OpenPartner Cloud bills the Flex and Revshare usage fee, and why it's
built so a brand can't shrink it by renaming events, under-reporting values
or refunding on paper. Code: `apps/api/src/usage-ledger.ts` (the rule),
`fee-terms.ts` (who is on which rule), `usage-billing.ts` (the reporter),
`fee-notice.ts` and `fee-review.ts` (the ops console). Self-hosted
installs aren't metered, so none of this applies to them.

## The rule

For every attributed conversion (a non-corrective event a partner was
credited for):

```
fee = max( revenueRate × revenue , commissionRate × commissions )
```

| Plan     | revenueRate | commissionRate | Break-even commission |
| -------- | ----------- | -------------- | --------------------- |
| Revshare | 3%          | 10%            | 30% of revenue        |
| Flex     | 1.5%        | 5%             | 30% of revenue        |

These are defaults. Operators change them under **/platform → Fees → Rule
settings** (PlatformSetting `feeRule`); nothing is hard-coded but the
Stripe meter prices (below).

A program paying up to 30% commission on honest revenue pays exactly the
advertised 3% / 1.5%, because `10% × 30% = 3%`. The commission floor only
matters when revenue is missing, understated, or paid as fixed bounties.

Worked examples on Revshare:

| Conversion                                     | Revenue part | Floor part   | Fee    |
| ---------------------------------------------- | ------------ | ------------ | ------ |
| `invoice_paid` $1,000, 20% commission ($200)   | $30          | $20          | $30    |
| `order_paid` $100, 20% commission ($20)        | $3           | $2           | $3     |
| `signup`, no value, $50 bounty                 | $0           | $5           | $5     |
| `order_paid` declared revenue, $10, $50 bounty | $0.30        | $5           | $5     |
| `invoice_paid` $1,000, 35% commission ($350)   | $30          | $35          | $35    |
| `invoice_paid` $100, no commission rule fired  | $3           | $0           | $3     |
| `pageview`, no value, no commission            | $0           | $0           | $0     |

### Revenue

`revenue` is the conversion's `Event.value` when it counts as revenue, which
it does if **any** of these holds:

1. Its type is `invoice_paid` or `subscription_created`.
2. It paid a **percent** commission. You can't pay a percentage of
   something that isn't an amount, so renaming a sale (`order_paid`,
   `deal_won`, `loan_funded`) doesn't move it off the revenue basis.
   Accruals stamp `Commission.metadata.rateType`. For commissions accrued
   before that stamp existed, a percent sub-rule in the program's rule that
   matches the event type decides.
3. The brand declared its type as revenue on the program: **Programs →
   Revenue event types** (`Program.revenueEventTypes`). This is for sales
   paid with fixed bounties, such as an `order_paid` with a $20 bounty.

Otherwise it's 0. Revenue is counted **once per conversion**, however many
partners shared it.

### Commissions

`commissions` is what partners hold on the conversion: the sum of its live
(not reversed) `Commission` amounts **over every touch**, fixed and percent,
net of `refund_clawback` adjustments.

### Refunds and reversals

A refund (`POST /attribution/refunds`, or Stripe `charge.refunded` on
self-host) takes revenue out in proportion, **but only as far as the
partner lost commission on it too**. A conversion that earned commission
keeps at least the share of its value that partners still hold commission
on: live commissions net of clawbacks, over what was first credited. That
allows half a cent a row of slack for the prorated replacement's rounding.
So:

- A full refund that reverses the commission: revenue 0, commissions 0,
  fee 0.
- A partial refund where `refunds.ts` prorates the commission: the kept
  share is billed.
- A refund the partner keeps the commission on (a paid commission with no
  clawback, or a refund reported with nothing reversed): the fee doesn't
  drop. Without this, a brand could report refunds and cut its fee while the
  partner kept the money.

Once every commission a conversion earned is reversed (full refund,
chargeback, or an admin reverse for fraud or a terms breach), it bills
nothing: no partner keeps credit for it. A Stripe dispute alone changes
nothing, because a dispute can be won.

This guard applies on both rules. Refund credits were new in the same
release, so it never raises what anyone paid before.

### Bonuses

A bonus ([bounties.md](bounties.md): a manual bonus, a performance bounty,
a Network bounty) is a reward with no sale behind it, paid through one
commission. The fee treats it like a fixed commission on a conversion with
no revenue:

- **Commission-floor rule:** `commissionRate × amount`, the "flat bounties
  with no sale amount" line (10% on Revshare, 5% on Flex). A bonus is on
  this rule when it was awarded at or after the tenant's effective date.
- **Old rule:** nothing. That rule bills revenue only, and a bonus has
  none.
- **Reversed** (by an admin, or a performance bounty that no longer
  qualifies): its basis drops to 0 and the next report credits it, like a
  refund, at the rate it was billed at.

The meter books it on its own ledger row (`UsageLedger.bonusId` instead of
`eventId`). The shadow comparison, the ops estimates and contract
statements include its fee, but don't count it as a conversion.

## Metering: one meter, revenue-equivalent units

Both plans keep the one Stripe meter (`openpartner_attributed_gmv`) and
their existing metered prices: 3¢ per unit on Revshare and 1.5¢ on Flex
(`scripts/setup-stripe.mjs`, mirrored as `METER_RATES` in `fee-terms.ts`).
The reporter sends the **billable basis**, the fee in revenue-equivalent
dollars:

```
basis = fee / meterRate
      = max( revenue × revenueRate / meterRate , commissions × commissionRate / meterRate )
```

With the defaults, revenueRate equals the meter rate, so

```
basis = max( revenue , commissions × commissionRate / revenueRate )
Revshare: 0.10 / 0.03  = 10/3
Flex:     0.05 / 0.015 = 10/3
```

Both plans use the same multiplier, and Stripe's charge
`basis × meterRate` equals the fee exactly.
`usage-fee-rule.test.ts` checks both plans to the cent.

Rate overrides and changed platform rates need no new Stripe prices,
because the division is by the meter's own rate. A Revshare contract at
2% / 8% sends `max(2% × revenue, 8% × commissions) / 0.03`. **If a metered
price in Stripe ever changes, change `METER_RATES` in the same deploy.**

Each conversion's basis lives in the `UsageLedger` (see "Refunds after a
report" in [deploy.md](deploy.md)). Every report bills the difference
between what each conversion is worth now and what it was billed, so
refunds and reversals after a report are credited.

### Collected by card or by invoice

The meter and prices are the same however the fee is collected. Most
brands are charged automatically on a saved card. Brands that can't be
(Indian cards, under RBI's e-mandate rules) pay each monthly invoice from
Stripe's hosted invoice page by card or bank transfer instead, on a
`send_invoice` subscription with the same prices and meter. See
[invoice-billing.md](invoice-billing.md).

### Frozen terms

The terms a conversion is first billed under are stored on its ledger rows
(`UsageLedger.terms`): the rule version, whether it counted as revenue, and
the rates. Later reports re-derive that conversion's basis with the same
terms. A rate change, a program declaring or dropping a revenue type, or a
moved effective date affects **new** conversions only and never re-bills or
credits history.

A conversion with no ledger rows is only picked up when it was first
attributed after the previous report, less a day's grace for transactions
that committed late. One that was worth nothing when it happened isn't
billed later because a setting changed.

## Who is on which rule

Every tenant starts on the **old rule**: revenue only, for `invoice_paid`,
`subscription_created` and declared types. It moves to the commission-floor
rule at its **effective date** (`HostedFeeTerms.effectiveAt`, a hosted
sidecar, never on `Tenant`). Conversions first attributed before that date
stay on the old rule for good. A usage report that spans the date bills
each conversion under the rule of its own time.

The effective date is set one of three ways:

| Source     | When                                                                     | Effective date |
| ---------- | ------------------------------------------------------------------------ | -------------- |
| `new_plan` | Paid Stripe plan started at or after the cutover (`feeRule.cutoverAt`) | From its first conversion. If the tenant was billed before (it cancelled and came back), from the new plan's start. |
| `notice`   | Paid plan started before the cutover, pricing notice sent               | Notice + 30 days, then the start of its next Stripe billing period |
| `contract` | An operator set contract terms with a date                              | That date |

The key is the **plan start** (Stripe `subscription.start_date`), not tenant
creation, so an approved brand that never subscribed gets the new pricing
when it subscribes. Enterprise moves only by contract. With no cutover set,
nobody moves automatically and Stripe isn't asked anything.

### The pricing-change notice

The Terms say: *"We may change pricing with at least 30 days' notice.
Changes apply at the start of your next billing cycle."* Under **/platform →
Fees → Pricing-change notice**, the operator previews the notice. The
preview lists every brand whose paid plan started before the cutover, the
admins who'd get the email, each brand's effective date, and the email
itself. Nothing is sent until an operator clicks send.

The email is an **essential contractual notice**, not marketing. It goes to
every active admin and has no unsubscribe link, like a security or invoice
notice; `EmailOptOut` only covers setup reminders. Each brand is claimed
(`noticeSentAt`) before its email goes out, so a double click or a second
operator can't send it twice. If no admin could be reached, the claim is
released and the brand stays un-noticed. Sends are audited
(`fees.pricing_notice`).

### Shadow comparison

With **Shadow comparison** on, every usage report of a tenant still on the
old rule (including during its notice period) also records what the new rule
would have billed for the same conversions (`UsageFeeShadow`). Billing
doesn't change. The Brands table sums the last 30 days.
**Estimate** computes the same comparison live over any trailing window,
for every hosted brand, without waiting for shadow rows.

## Contracts: rate overrides and monthly minimums

Contract terms (**Brands → Contract**) set a tenant's revenue rate,
commission rate, monthly minimum and effective date. A typical case is a
network operator whose event values would otherwise be loan principals: on
commission only, at revenueRate 0, commissionRate 5%, with a $299 monthly
minimum.

- **Stripe-metered plans** (Flex, Revshare) take rate overrides: the meter
  basis is scaled to them, as above. They can't take a minimum.
- **A monthly minimum requires the Enterprise plan.** Enterprise is already
  billed outside Stripe, so the operator invoices from the contract
  **Statement** for the month: the fee
  `max(revenueRate × revenue, commissionRate × commissions)` per conversion
  first attributed in the month, then topped up to the minimum.

Why the statement, not Stripe? Metering a minimum through Stripe would need
a per-tenant price or a top-up event at each period's end. That means a
period-boundary race, and a double charge if a top-up and a late report
collide. The statement is derived from the raw tables, can be re-run and
can't double-bill. Enterprise invoicing is already manual. The statement is
live, so a refund recorded later changes a past month. Invoice once the
month's refund window has closed.

## Review signals

**/platform → Fees → Review signals**, over the last 60 days. These are
reasons to look, never automatic actions:

- Brands with identified signups, or 100+ clicks, but no commission-bearing
  conversion at all.
- Revenue conversions whose live commissions exceed their value: an
  understated or missing value next to a fixed bounty.
- Brands whose commission-bearing conversions per click are under a fifth
  of the peer median. The median is over brands with 200+ clicks and needs
  at least 3 of them.

## Settings and data

- `PlatformSetting` key `feeRule`: `{ shadow, cutoverAt, rates: { flat,
  revshare } }`. Defaults: shadow off, no cutover, the rates above.
- `Program.revenueEventTypes` is **core** and exported.
  `Commission.metadata.rateType` is core.
- `HostedFeeTerms`, `UsageFeeShadow` and `UsageLedger.terms` are hosted
  billing sidecars and are not exported ([data-portability.md](data-portability.md)).
- `OPENPARTNER_BILLABLE_EVENT_TYPES_EXTRA` is retired. Migration
  `20261017020000_platform_fee_rule` copies its types onto every program
  that exists when it runs. The API warns at boot while the variable is
  still set. Programs created later declare their own types.

## Rollout runbook

1. Publish the pricing page and Terms copy. This is a separate
   openpartner-marketing change, "Publish the new fee rule on pricing and
   Terms", built on draft openpartner-marketing#15.
2. Deploy this. Nothing changes for anyone: shadow is off and there's no
   cutover.
3. Optional: turn on **Shadow comparison** and run **Estimate** to see the
   impact per brand.
4. Set **Cutover** to when the published copy went live (at most a day in
   the past). New paid plans from then on are on the new rule.
5. **Preview**, then **Send** the pricing-change notices. Each noticed brand
   moves at its own effective date, shown in the Brands table.

## Pricing page and Terms wording (for openpartner-marketing#15)

What the copy needs to say for the rule above to match the contract:

- Revshare: *"3% of partner-attributed revenue, minimum 10% of the
  commissions your partners earn."* Flex: *"$49/month + 1.5% of
  partner-attributed revenue, minimum 5% of commissions earned."*
- A line making the break-even explicit: *"If you pay partners up to 30%
  of revenue, you pay exactly 3% (1.5% on Flex). The minimum only applies
  to bounties and conversions reported without their full value."*
- Define partner-attributed revenue: *"Invoice and subscription payments,
  conversions that pay a percentage commission, and event types you mark
  as revenue."*
- Tighten *"Refunded transactions don't count"* to *"Refunded transactions
  don't count once the partner's commission on them is reversed."*
- Terms, Pricing and billing: *"Usage-based fees (percentage of
  partner-attributed revenue, with a minimum based on commissions earned,
  and Network fees) are calculated monthly and billed in arrears."* The
  existing 30-days' notice clause already covers moving current customers.
  Keep it.
