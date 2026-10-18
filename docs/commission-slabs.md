# Commission slabs: value bands and performance tiers

A commission sub-rule can pay a rate that varies instead of a flat one:

- **Value bands** vary the rate with the event's own value. For example, an invoice up to 50,000 pays 10% and anything above pays 15%.
- **Performance tiers** vary the rate with what the partner has already driven in the program. For example, once a partner's attributed revenue this month reaches 100,000, they earn 15%.

Both are optional fields on an ordinary sub-rule in `Program.commissionRule` or `PartnerCommission.commissionRules`. A rule without them behaves exactly as before.

Code:
- Engine: `apps/api/src/commission-slabs.ts`, called from `evaluateSubRule` in `attribution.ts`.
- Validation: `apps/api/src/commission-rule-schema.ts`.
- Types: `CommissionBands` and `CommissionTiers` in `packages/db/src/types.ts`.
- Editor: `apps/portal/src/lib/CompoundRuleEditor.tsx`.

## Shape

```jsonc
// Value bands. `value` is the base rate: it applies from 0 up to and including the first threshold.
{
  "trigger": "every", "eventType": "invoice_paid", "type": "percent", "value": 10,
  "currency": "INR",                         // optional: the currency of the thresholds
  "bands": {
    "mode": "whole",                         // "whole" (default) | "marginal"
    "levels": [{ "above": 50000, "value": 15 },
               { "above": 200000, "value": 20 }]
  }
}

// Performance tiers. `value` is the rate until the first tier is reached.
{
  "trigger": "every", "eventType": "invoice_paid", "type": "percent", "value": 10,
  "tiers": {
    "metric": "revenue",                     // "revenue" | "conversions"
    "window": "calendar_month",              // "lifetime" | "calendar_month" | "rolling_days"
    "windowDays": 30,                        // rolling_days only, 1–3650
    "eventType": "invoice_paid",             // optional: which events count; defaults to the rule's eventType
    "levels": [{ "atLeast": 100000, "value": 15 }]
  }
}
```

The sub-rule's `value` is always the base rate. A consumer that ignores `bands` or `tiers`, such as an older Network or the legacy `commissionType`/`commissionValue` mirror, still reads a valid rule that pays the base rate.

## Value bands

- **A threshold is the top of the band below it.** With `above: 50000`, an event of exactly 50,000 pays the base rate, and 50,000.01 pays 15%. This matches how slabs are usually written: "≤ 50,000 → 10%, > 50,000 → 15%".
- **`whole` (default):** the whole event pays the rate of the band its value falls in. A 60,000 invoice pays 15% × 60,000 = 9,000. This mode works for both percent and fixed rules. A fixed rule pays the band's amount.
- **`marginal`:** works like tax brackets, and is for percent rules only. Each slice of the value pays its own band's rate, so a 60,000 invoice pays 50,000 × 10% + 10,000 × 15% = 6,500. The arithmetic is exact: slices are integer cents, rates are scaled to integers (exact for up to six decimals), and the sum rounds once, half-up, to the cent. A 305.00 invoice at 5% up to 100 and 8.7% above pays 22.84, where floating-point arithmetic would give 22.83.
- **Flat percent and whole-mode bands still use the long-standing formula**, which multiplies floats. That formula can land a cent low on an exact half-cent: 12.5% of 1.16 pays 0.14, not 0.15. Whole-mode bands match it on purpose, so a band rule paying its base rate equals the flat rule it replaced. As a result, a marginal rule below its first threshold can pay one cent more than the same flat rate on those values. Fixing the flat formula would move existing payouts by a cent, so it is a separate decision.
- **Events with no value, zero or a negative value** sit in the base band.
- **Multi-touch:** the band is chosen from the event's full value, and the result is then multiplied by the touch's attribution weight, like every other rule. A 60,000 invoice split 50/50 pays each partner 15% × 60,000 × 0.5.

## Performance tiers

The tier for an event is a pure function of raw history. The engine reads it at accrual time from `Attribution ⋈ Event ⋈ Click`, filtered as follows:

- the same partner **and** the same program (`Attribution.programId`) as the touch being paid
- events of the counted type: `tiers.eventType`, or else the rule's `eventType`. Validation requires one of the two. "Every event" would count signups as conversions, and refunds' negative values as revenue.
- events **strictly before** this one: `ts` earlier than this event's, or the same `ts` with a lower `id`, so that two events stamped in the same instant still order deterministically
- inside the window. `lifetime` has no start. `calendar_month` covers the event's UTC month. `rolling_days` covers the `windowDays` before the event.
- clicks not flagged as fraud. A partner can't climb a tier on traffic the program has rejected.

The metric counts each touch as its **share** of its event, like the commission itself:

| metric | value |
|---|---|
| `revenue` | Σ `Event.value × share`, over events in the threshold currency only |
| `conversions` | Σ `share`. A 50/50 split counts as half a conversion. |

A touch's share is its `Attribution.weight` divided by the sum of that event's weights under the same model. Weights are stored to 4 decimals, so summing them raw drifts. A conversion a partner owns outright through three linear touches is stored as 3 × 0.3333 = 0.9999, so ten of them never reach "at least 10". Six touches store as 1.0002, which tips a partner over a threshold early. Dividing by the event's total restores exactly 1, the share the commission was paid on. The metric is rounded to 4 decimals before it is compared.

The tier applied is the highest level whose `atLeast` is less than or equal to the metric.

Renewals count. A renewal that keeps its partner past the attribution window ([renewal-attribution.md](renewal-attribution.md)) is an ordinary Attribution row with the original weights, so it adds to the partner's revenue and conversions like any other event.

### Crossing a tier is not retroactive

The event that pushes a partner over a threshold pays the **old** rate, and the events after it pay the new one. Earlier commissions are never recomputed, because the ledger is immutable. Brands get a rule they can explain ("once you've driven 100,000 this month, every further invoice pays 15%"), and the tier never depends on events that hadn't happened yet.

### Re-derivation

Nothing about tiers is cached or stored on a partner row, so re-running attribution over the same raw tables picks the same tier. The tier reflects the history that had been **committed** when the event accrued. That leaves two known gaps, and in both the later commission was computed without the earlier event:

- **Late data.** An earlier event is attributed after a later one has already accrued. A backlog replay is the usual cause, for example a user identifying weeks after converting.
- **Concurrency.** Two events for the same partner accrue in overlapping transactions. Neither can see the other's uncommitted Attribution row, so the later one may pay the lower tier. A per-partner lock would close this, but a multi-touch event takes several partners' locks in click order, which risks deadlocks and serialises a busy partner's webhooks. It is deliberately not done.

The Commission row records the metric value it used (below), so either difference stays visible rather than silent.

Gross, not net: tiers count the counted event type's attributed value. Refunds and disputes are separate event types and don't reduce it. A refund claws back the commission it refunds, through the existing reversal path. A commission reversed by hand still counts toward the tier unless its click is flagged as fraud.

## Currency

The engine does no FX. A sub-rule's `currency`, when set, is the currency of its money amounts: the fixed value, band thresholds and revenue-tier thresholds. When it isn't set, thresholds are read in each event's own currency, which is right for every single-currency program.

- **Bands:** if the rule's currency differs from the event's, the thresholds can't be compared. The base rate applies, and the Commission row records `currencyMismatch: true`.
- **Revenue tiers:** only prior events in the threshold currency are summed. The rate that results applies to the current event whatever its currency.
- Currency codes compare upper-cased (`inr` is `INR`). Every ingest path stores them upper case. An event sent without a currency is stored in the tenant's default currency (Settings → Brand info, USD unless changed). A legacy row with no currency counts as USD.

### Which currency the Commission is in

| Sub-rule | Commission currency |
| --- | --- |
| `fixed` with `currency` | The rule's currency. |
| `fixed` without `currency` | The event's currency. |
| `percent` (with or without `currency`) | The event's currency. A percent is a share of the event's value, and the rule's `currency` only says what its thresholds are in. |

A fixed amount is a bounty in the currency the brand wrote it in. "₹100 per lead" pays ₹100 whatever the event says: a lead sent with no currency, or a sale reported in USD. Before Oct 2026 the amount was booked in the event's currency, so that lead earned "100.00 USD".

We considered and rejected two alternatives:
- **Convert the amount to the event's currency.** The engine has no FX, by design. A commission is a raw-data derivation that has to come out the same on every re-derivation, and a rate feed would make it depend on the day it ran. FX exists only in platform billing (`fx.ts`), which converts OpenPartner's own fee, never a partner's earnings.
- **Skip or reject a mismatched event.** A lead or demo event usually carries no money at all, so its currency says nothing. Refusing to pay a ₹100 bounty because the CRM didn't send `INR` would drop a commission the rule plainly promises.

A partner who earns in two currencies has two balances and gets one payout per currency. Banded and tiered `fixed` rules follow the table too: their amounts, and the base amount paid on a `currencyMismatch`, are in the rule's currency.

## Audit trail: `Commission.metadata`

Every Commission row has a `metadata` jsonb column, `{}` by default. When a band or tier set the rate, `metadata.slab` records how:

```jsonc
{ "slab": {
    "kind": "tier", "ruleIndex": 0, "type": "percent",
    "level": 1, "threshold": 100000, "value": 15, "currency": "INR",
    "metric": "revenue", "window": "calendar_month",
    "windowStart": "2026-10-01T00:00:00.000Z",
    "countedEventType": "invoice_paid", "metricValue": 123456.78 } }
```

- `level` is the step that applied. 0 is the rule's base `value`, and n is `levels[n-1]`.
- `ruleIndex` is the sub-rule's position in the rule array the engine resolved. That is the partner's override when one exists, otherwise the program's rules.
- Bands record the `basis`, meaning the event value compared. Marginal bands also record every slice in `slices`.

The commissions API returns `metadata` with each row, so a headless integration can show a partner which tier they're in.

## Validation

`POST/PATCH /programs` and `PUT /partners/:id/commission-snapshot` run the same checks:

- A table has 1–10 steps, and its thresholds are positive and strictly ascending.
- A step's value is ≥ 0, and ≤ 100 on percent rules. The top-level `value` keeps its old limits, so stored rules still save.
- A rule can't have both `bands` and `tiers`. Brands that want both effects use two sub-rules, which add up as always.
- `marginal` needs a percent rule.
- `rolling_days` needs `windowDays`, and other windows reject it.
- Tiers need a counted event type, from `tiers.eventType` or the rule's `eventType`.
- `currency` must be three letters. Anything else could never match an event's currency, so it would silently pin a slab rule to its base rate.

The legacy single-object rule and the legacy override columns are still accepted. The single-object form can't carry slabs: `{type, value, bands}` is rejected with a pointer to the array form, rather than being saved flat.

## The Network

`buildTermsPayload` sends the program's rules verbatim, slabs included, and mirrors the **base** rate into the legacy `commissionType`/`commissionValue`. The derived `commissionDescription` shows a slab rule as the range it pays, such as "10–15% on every invoice (slabs by invoice value)". It never shows the top rate alone, and it is trimmed to the Network's 200-character limit.

A snapshot outranks the live program rule permanently, so `POST /partners` (`vetApprovalSnapshot`) doesn't store one that would mis-price the partner. In both cases below, the partner accrues on the live rule instead:

- **Stripped by the Network.** A Network that predates slabs strips `bands`/`tiers` from offering terms, so its approval snapshot of a tiered program is the base rate alone. Such a snapshot is detected only when it **exactly** matches a granted program's live rule with the slabs removed, comparing the fields the Network keeps (or the legacy single-rule mirror). A snapshot that differs in any other way is what the partner applied to, and is kept. For example, the offering may still show an older flat 20% because a sync failed.
- **A bad slab table.** It fails the same checks a program's own rule must pass: a 500% step, bands and tiers together, a tier with nothing to count. Refusing the whole approval would fail it over terms the brand never typed.

A snapshot whose slabs pass is stored with them.

One known gap remains, and it is not specific to slabs. A snapshot is per partner, not per program, so a partner whose snapshot came from a flat program is paid that rate on any program granted to them later, tiered or not. Per-(partner, program) overrides are the fix for that.

## Portability

Slabs are plain JSON inside `Program.commissionRule` and `PartnerCommission.commissionRules`, and the trace is plain JSON in `Commission.metadata`. All three round-trip through the JSON and SQL exports, which is covered in `export-roundtrip.test.ts`. A bundle exported before `Commission.metadata` existed imports with `{}`.
