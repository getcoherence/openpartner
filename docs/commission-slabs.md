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
- **`marginal`:** works like tax brackets, and is for percent rules only. Each slice of the value pays its own band's rate, so a 60,000 invoice pays 50,000 × 10% + 10,000 × 15% = 6,500. The arithmetic runs in integer cents and rounds once at the end, to the nearest cent.
- **Events with no value, zero or a negative value** sit in the base band.
- **Multi-touch:** the band is chosen from the event's full value, and the result is then multiplied by the touch's attribution weight, like every other rule. A 60,000 invoice split 50/50 pays each partner 15% × 60,000 × 0.5.

## Performance tiers

The tier for an event is a pure function of raw history. The engine reads it at accrual time from `Attribution ⋈ Event ⋈ Click`, filtered as follows:

- the same partner **and** the same program (`Attribution.programId`) as the touch being paid
- events of the counted type: `tiers.eventType`, or else the rule's `eventType`. Validation requires one of the two. "Every event" would count signups as conversions, and refunds' negative values as revenue.
- events **strictly before** this one: `ts` earlier than this event's, or the same `ts` with a lower `id`, so that two events stamped in the same instant still order deterministically
- inside the window. `lifetime` has no start. `calendar_month` covers the event's UTC month. `rolling_days` covers the `windowDays` before the event.
- clicks not flagged as fraud. A partner can't climb a tier on traffic the program has rejected.

The metric is weighted, like the commission itself:

| metric | value |
|---|---|
| `revenue` | Σ `Event.value × Attribution.weight`, over events in the threshold currency only |
| `conversions` | Σ `Attribution.weight`. A 50/50 split counts as half a conversion. |

The tier applied is the highest level whose `atLeast` is less than or equal to the metric.

### Crossing a tier is not retroactive

The event that pushes a partner over a threshold pays the **old** rate, and the events after it pay the new one. Earlier commissions are never recomputed, because the ledger is immutable. Brands get a rule they can explain ("once you've driven 100,000 this month, every further invoice pays 15%"), and the tier never depends on events that hadn't happened yet.

### Re-derivation

Nothing about tiers is cached or stored on a partner row, so re-running attribution over the same raw tables picks the same tier. The one caveat is data that arrives late. If an earlier event is attributed after a later one has already accrued, the later commission was computed without it. A backlog replay is the usual cause, for example a user identifying weeks after converting. The Commission row records the metric value it used (below), so the difference stays visible instead of silent.

Gross, not net: tiers count the counted event type's attributed value. Refunds and disputes are separate event types and don't reduce it. A refund claws back the commission it refunds, through the existing reversal path.

## Currency

The engine does no FX. A sub-rule's `currency`, when set, is the currency of its money amounts: the fixed value, band thresholds and revenue-tier thresholds. When it isn't set, thresholds are read in each event's own currency, which is right for every single-currency program.

- **Bands:** if the rule's currency differs from the event's, the thresholds can't be compared. The base rate applies, and the Commission row records `currencyMismatch: true`.
- **Revenue tiers:** only prior events in the threshold currency are summed. The rate that results applies to the current event whatever its currency.
- The accrued Commission is in the event's currency, as it always has been.

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

The legacy single-object rule and the legacy override columns are still accepted unchanged.

## The Network

`buildTermsPayload` sends the program's rules verbatim, slabs included, and mirrors the **base** rate into the legacy `commissionType`/`commissionValue`. The derived `commissionDescription` shows a slab rule as the range it pays, such as "10–15% on every invoice (slabs by invoice value)". It never shows the top rate alone, and it is trimmed to the Network's 200-character limit.

A Network that predates slabs strips `bands`/`tiers` from offering terms. Its approval snapshot of a tiered program would then be the base rate alone, and a snapshot outranks the live program rule permanently. So `POST /partners` refuses to store a slab-less snapshot when any granted program uses slabs, and the partner accrues on the live, tiered rule instead. A snapshot that carries its slabs is stored as usual.

## Portability

Slabs are plain JSON inside `Program.commissionRule` and `PartnerCommission.commissionRules`, and the trace is plain JSON in `Commission.metadata`. All three round-trip through the JSON and SQL exports, which is covered in `export-roundtrip.test.ts`. A bundle exported before `Commission.metadata` existed imports with `{}`.
