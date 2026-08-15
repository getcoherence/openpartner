# Hosted Payout Funding — Implementation Spec (v2, post-adversarial-review)

**Status:** Amended per adversarial review · **Author:** Lead architect · **Reviewer:** external audit (Codex), 14 findings — 5 blockers, 8 must-fix, 1 consider — all incorporated · **Date:** 2026-07-10
**Tracking:** issue #45 · **Interim guard:** PR #44 (hosted Connect payouts fail closed) — stays until this ships
**Verdict adopted:** invoice/charge-before-transfer is the right architecture; the *guarantee* is corrected: **OpenPartner collects principal before transferring, while retaining residual payment-return and chargeback exposure** (blocker 4). "Nothing is fronted" was overclaimed and is retracted.

---

## 1. Problem

On the hosted `stripe_connect` rail, `runPayouts` transfers the **full commission
principal from the platform's Stripe balance**; only the metered service fee (Flex 1.5% /
RevShare 3% of GMV) is ever billed to the brand. RevShare example, $100 GMV at 20%
commission: brand billed $3, platform sends $20 → **≈ −$17 per conversion**. Self-host is
unaffected (platform account = brand's own account).

The same code path carries an integrity cluster (per-attempt idempotency keys, one DB
transaction wrapping Stripe calls, boolean reversal semantics, manual-rail
"paid-on-faith"). This spec rebuilds the runner around a durable state machine and fixes
those in the same rework.

## 2. Constraints and the honest guarantee

1. **Connect Standard only**; never merchant of record for brand consumer revenue.
2. **Portability**: all funding state lives in hosted-only sidecar tables; core tables
   gain only portable, generic changes (a unique index; ledger-compatible statuses).
3. **The guarantee**: money is *collected before it is transferred*, and every state is
   crash-replayable — but a funding payment can later be refunded, returned (ACH), or
   disputed (SEPA up to 13 months). That residual exposure is managed (risk controls,
   reversal attempts, receivables ledger — §8), not eliminated. Launch posture: hosted
   funding is **USD-only and bank-debit-only** (§12); an explicit operating reserve covers
   ACH failed-payment/dispute fees ($4/$15, tracked as rail cost) and dispute exposure.
4. Per-tenant knobs stay meaningful: `payoutRailPreference`, `payoutThresholdCents`
   (plus a **$25 platform floor** per batch), `payoutCadence`. Manual rail continues,
   with confirmation semantics fixed (§11).

## 3. Architecture

**Collection primitive: a dedicated off-session `PaymentIntent`, not a Stripe Invoice**
(review finding 6/3: invoice semantics are too permissive — pending-item attachment to
subscription invoices, discountable items, customer-credit satisfaction, out-of-band
"paid" all create funding that isn't money). A PI has none of those; dunning is a simple
owned retry schedule; the brand-facing record is a "Partner payout funding" entry in
Billing plus Stripe's receipt email. (If invoice UX is later wanted, it can render *from*
the PI — presentation, not collection.)

```
approved commissions ──(cadence tick)──▶ RESERVE batch + allocations   (§5)
        ▼
  create funding PaymentIntent (off-session, deterministic intents)    (§5)
        ▼  payment_intent.succeeded + charge verification              (§6)
      FUNDED
        ▼  executor: per-partner HostedFundingTransfer intents →
           transfers.create(source_transaction, transfer_group)        (§6)
     SETTLED            — or SETTLED_WITH_RESIDUAL (§7)
```

### Batch states (normative table in §9)

`reserved → invoicing → payment_processing → funded → transferring →
settled | settled_with_residual`, with exception states `funding_failed`,
`release_requested → released`, `funding_disputed`, `recovery_required`.

### Allocation states (finding 5/9 — allocations own their lifecycle)

`reserved | canceled | transfer_pending | transferred | released | recovery_required`

## 4. Data model

All sidecar tables: RLS tenant-isolation, `openpartner_app` grants, and a DESIGN
intent to export inertly on self-host import. NOTE: as of schemaVersion 2 these
tables are not yet in `EXPORT_TABLES` — `HostedFundingAuthorization.adminId` is an
FK to `Admin`, which is deliberately never exported, so wiring them up needs that
decision first. Tracked in docs/data-portability.md. **All money columns are integer minor units** with canonical
lowercase currency (finding 12); launch currencies are USD (ACH) with GBP (Bacs)
as the designed-in fast-follow — both 2-decimal, so exponent handling stays trivial and
asserted; the currency column and rail selection are scheme-aware from day one.

### `HostedFundingBatch`
`id` (ulid, also `transfer_group`) · `tenantId` · `currency` · `principalMinor` bigint ·
`status` (CHECK) · `stripePaymentIntentId` unique nullable · `stripeChargeId` nullable ·
`grossChargeMinor` bigint (= principal + any funding fee; launch: equals principal) ·
`quotedFeeMinor` bigint default 0 · `actualStripeFeeMinor` bigint nullable (from the
charge's `balance_transaction.fee`, recorded at funding confirmation for rail-cost
tracking and any future true-up) · `paymentMethodType` text · `pricingVersion` text ·
`residualMinor` bigint default 0 · `failureReason` · timestamps per transition.

### `HostedFundingAllocation`
`id` · `batchId` · `commissionId` · `partnerId` · `amountMinor` · `state` (CHECK) ·
**partial unique index on `commissionId` WHERE state NOT IN ('released','canceled')**.
Release is a *protocol* (§7), not a flag-flip — the index prevents live/live double
reservation; the release protocol prevents the released/late-payment race (blocker 1).

### `HostedFundingTransfer` (finding 2 — the transfer intent)
Created and committed **before** any `transfers.create` call:
`id` · `batchId` · `partnerId` · `currency` · `amountMinor` · `destinationAccountId`
(snapshotted — changing destination under a retained key is a Stripe parameter-mismatch
error) · `idempotencyKey` (`fbt:<transferIntentId>`, frozen) · `state`
(`pending | posted | confirmed | failed | reconcile_required`) · `stripeTransferId`
unique nullable · `postedAt` · unique `(batchId, partnerId, currency)`.

**Retry discipline (finding 2):** within Stripe's idempotency window, retry the same key.
After an ambiguous outcome older than ~24h (keys are pruned) or any lost-response case,
the intent moves to `reconcile_required`: resolve by listing transfers by
`transfer_group` + metadata (`openpartner_transfer_intent_id`, tenant, batch) — **never
blindly POST again**. Every Stripe object we create carries those metadata keys, which
also fixes webhook tenant-resolution for transfers (finding 7).

### `PayoutReversal` (finding 11)
`id` · `payoutId` · `stripeReversalId` unique · `amountMinor` · `reason` ·
`balanceTransactionId` · `createdAt`. Payout state is **derived**: `partially_reversed`
when `Σ reversals < amount`, `reversed` when equal. Commissions are never flipped
`paid → reversed` in place; a compensating `CommissionAdjustment` row records the
clawback (consistent with the existing ledger's compensating-entry doctrine), and
re-payout requires the prior allocation epoch explicitly closed.

### `StripeWebhookInbox` (finding 7)
`stripeEventId` pk · `type` · `processedAt` · `outcome`. Every funding-relevant webhook
is recorded here first; duplicates and replays become no-ops. All state transitions are
compare-and-set (`UPDATE … WHERE status = <expected>`); a stale or out-of-order event
that loses the CAS re-fetches the live Stripe object before deciding (finding 7's
regression sequence).

### `HostedBillingState` (finding 13)
Webhook-mirrored subscription status per tenant: `status`
(`active|trialing|past_due|unpaid|paused|canceled`) · `delinquentFundingCount` ·
timestamps. `hasActivePlan` upgrades from "subscription id non-null" to this mirror.
**Funding eligibility is separate from service eligibility**: new batches require
`active|trialing` AND no delinquent/`release_requested` funding; already-`funded`
batches always finish transferring regardless of subscription state.

### Core-table changes (portable)
- `Payout.stripeTransferId`: **unique index**.
- `CommissionAdjustment` table (generic ledger table — compensating entries; useful to
  self-host too, so it is core and portable).
- No new Commission columns; no Stripe IDs on core tables.

## 5. Phase 1 — reserve + collect

Runs on the existing cadence tick and the admin endpoint, both serialized by a pg
advisory lock `payouts:<tenantId>` (covers admin-vs-scheduler, finding from audit).
**At most one non-terminal batch per tenant × currency** (founder decision): eligible
commissions accumulate while a batch is open.

**Reservation (finding 10 — corrected SQL):** in one short transaction:
1. Take the advisory xact lock.
2. `SELECT c.* FROM "Commission" c LEFT JOIN live_alloc a ON a."commissionId" = c.id
   WHERE c.status='approved' AND a.id IS NULL ORDER BY c.id FOR UPDATE OF c SKIP LOCKED`
   — row locks on plain rows; grouping/threshold/floor math happens in application code
   over the locked set (no `FOR UPDATE` with `GROUP BY`).
3. Apply rail resolution + Connect preflight + `payoutThresholdCents` + the $25 floor;
   below-floor groups are simply not reserved (roll forward).
4. Insert batch (`reserved`, exact `principalMinor = Σ amountMinor`) + allocations
   (`reserved`). A unique-allocation conflict aborts and retries cleanly — never a
   partially created batch (the insert is atomic in this transaction).
5. Commit. **No Stripe call inside.**

**Collection (finding 6 — every external step has its own intent):**
1. CAS batch `reserved → invoicing`.
2. `paymentIntents.create` — amount `grossChargeMinor` (at launch = `principalMinor`:
   bank-debit-only, no funding fee — §12), currency, customer, the tenant's **bank-debit
   payment method** (`payment_method_types: ['us_bank_account']` at launch; card path is
   counsel-gated, §12), `off_session: true`, `confirm: true`,
   `setup_future_usage` untouched, metadata `{openpartner_funding_batch_id, tenantId}`,
   idempotency key `fbpi:<batchId>` (frozen; ambiguous-after-window ⇒ reconcile by
   metadata search, never re-POST).
3. Stamp `stripePaymentIntentId`; CAS `invoicing → payment_processing`.
   - Immediate card success may race the webhook — the webhook's CAS handles either
     order.
   - Hard synchronous failure (no payment method, card declined, `authentication_required`
     off-session): schedule owned retries (day 1, 3, 7 — notify brand admin each time via
     the mailer); after `FUNDING_TIMEOUT_DAYS` (10) → `funding_failed` → release protocol.

## 6. Phase 2 — verify funding, transfer

**Funding confirmation** (`payment_intent.succeeded`, gated by batch metadata, recorded
in the inbox): before CAS `payment_processing → funded`, verify against the live PI
(finding 3): status `succeeded`; `amount_received === grossChargeMinor`; currency matches;
latest charge exists, is `paid`, not refunded/disputed; **no** out-of-band or
customer-balance satisfaction (impossible with a PI, asserted anyway). Stamp
`stripeChargeId` from the latest charge.

**Executor** (scheduler job, every 5 min, advisory-locked, `protect: true`): for each
`funded`/`transferring` batch:
1. CAS batch → `transferring`.
2. Per allocation group: **re-verify the commissions are still `approved`-frozen** — i.e.
   allocation still `reserved` and no reversal/refund/fraud adjustment touched them
   (finding 5; those paths gain allocation-aware interlocks, §8). CAS allocation
   `reserved → transfer_pending`; create the `HostedFundingTransfer` intent row; commit.
3. `transfers.create({amountMinor, currency, destination, source_transaction:
   stripeChargeId, transfer_group: batchId, metadata})` with the frozen key.
4. **New short transaction per result**: intent → `confirmed` + `stripeTransferId`;
   insert `Payout{paid, stripeTransferId}` (unique index); allocation → `transferred`;
   commissions → `paid`; enqueue `commission.paid` on the **transactional outbox**
   (delivered by the existing webhook-dispatcher after commit — never fired inside the
   transaction; finding 7).
5. All allocations `transferred` → batch `settled`. Any allocation stuck
   `transfer_pending` past `TRANSFER_DEADLINE_DAYS` (14) escalates (§7).

Multiple transfers against one `source_transaction` are valid up to the charge amount in
the same currency (verified). The invariant is asserted before every transfer:

```
principalMinor(funded) = Σ transferredMinor + Σ pendingMinor + residualMinor + refundedMinor
```

## 7. Release protocol and residuals (blockers 1, 9)

Releasing reserved money is where the double-pay race lived. The protocol:

1. Any release path (funding timeout, cancellation, operator action) first CAS-es the
   batch to `release_requested`. Allocations are **not** touched yet.
2. Terminalize the money side: cancel the PaymentIntent
   (`paymentIntents.cancel`, idempotent). **If cancellation races a success** — the PI
   reports `succeeded` — the release LOSES: batch CAS `release_requested → funded` and
   proceeds to transfer. A late `payment_intent.succeeded` webhook against a
   `release_requested` batch does the same. Money that arrived is never orphaned.
3. Only after the PI is terminally `canceled` do allocations flip `reserved → released`
   and the batch `release_requested → released`. Released allocations never change
   Commission status (reservation never changed it — commissions were `approved`
   throughout and simply become selectable again).
4. **Residuals** (funded but a specific allocation can't transfer): release of a
   funded-but-untransferred allocation requires an explicit disposition recorded on the
   batch: `refund` (partial refund of the funding charge), `manual_payout`
   (operator pays out-of-band, confirmation required), or `credit_next_batch`
   (residualMinor offsets the tenant's next funding PI). Batch ends
   `settled_with_residual`; the same commission cannot re-batch until the residual
   disposition is closed (blocker-1 variant and finding 9).

## 8. Refunds, disputes, fraud (blocker 4, finding 5)

- Webhooks on the funding charge (`charge.refunded`, `charge.dispute.*` scoped by batch
  metadata): batch → `funding_disputed`; attempt deterministic transfer reversals for its
  transfers; every unrecovered cent lands in a **brand receivables ledger**
  (`residualMinor`/adjustment entries) and an ops alert. Dispute on a settled batch does
  not silently rewrite partner history — reversals + compensating adjustments only.
- **Risk controls** (launch defaults): hosted funding per-tenant caps — new tenants
  (< 60 days or < 2 clean funding cycles) capped at $500/batch and $1,500/month on the
  Connect rail, manual rail above that; caps lift with clean history. Funding PIs run
  with Radar; 3DS if required. High-risk/new brands can be pinned to manual rail
  entirely.
- **Commission lifecycle interlocks** (finding 5): the admin reverse endpoint, the
  consumer-refund reversal path, and fraud flag/unflag all gain an allocation check —
  a commission in a live allocation state (`reserved`/`transfer_pending`) cannot be
  status-flipped; the operation instead cancels the allocation (pre-funding) or records
  a compensating adjustment + recovery entry (post-funding). `transferred` commissions
  are immutable history; adjustments only.

## 9. Normative transition table

Any (state, event) pair not listed is an explicit logged no-op. All transitions are CAS.

| State | Event | → | Side effects |
|---|---|---|---|
| reserved | collector picks up | invoicing | — |
| invoicing | PI created | payment_processing | stamp PI id |
| invoicing | PI creation hard-fails | funding_failed | schedule release |
| payment_processing | verified `payment_intent.succeeded` | funded | stamp charge id |
| payment_processing | `payment_intent.payment_failed` | payment_processing | owned retry schedule; count++ |
| payment_processing | retries exhausted / timeout | funding_failed | schedule release |
| payment_processing | release requested | release_requested | cancel PI |
| release_requested | PI canceled confirmed | released | allocations → released |
| release_requested | PI turns out succeeded | funded | release loses; proceed |
| funded | executor starts | transferring | — |
| funded / any | funding charge refunded/disputed | funding_disputed | reversals + receivables |
| transferring | all allocations transferred | settled | — |
| transferring | deadline residual disposition chosen | settled_with_residual | record disposition |
| transferring | transfer intent ambiguous > window | (allocation) reconcile_required | reconcile by group/metadata |
| funding_failed | release protocol completes | released | — |
| settled / settled_with_residual | `transfer.reversed` | (payout) derived partial/reversed | PayoutReversal + adjustments |

Late `payment_intent.succeeded` on `released` is the one designed-impossible event (PI
was confirmed canceled first); if Stripe ever delivers it, it CAS-fails, alerts, and
lands in `recovery_required` for a human.

## 10. Brand & partner surface

- **Billing page**: "Partner payout funding" card — open batch, exact dollar amount
  (principal and, when a fee path exists, the fee as its own line) shown BEFORE the
  authorization step and after collection; failed-funding warnings; an OpenPartner-
  generated receipt per funding charge (PaymentIntents have no invoice-style line
  items); bank statement shows `OPENPARTNER PAYOUTS` (statement descriptor suffix).
- **Partner side** (founder decision): commissions in a batch awaiting brand funding
  show as `awaiting brand funding` — visibly the brand's obligation, not silently
  missing and not an OpenPartner debt. ToS language added: commissions are obligations
  of the brand; the platform facilitates collection and disbursement.
- **Manual rail fix**: manual payouts stay `pending` until
  `POST /payouts/:id/confirm` (admin, idempotent, audited); only then commissions →
  `paid` + webhooks. Unblocks Network payout metering for manual tenants.

## 11. Reconciliation, rollout, tests (finding 14)

- **Daily reconciliation job**: per batch, compare Stripe (PI, charge, transfers by
  `transfer_group`, reversals) against DB; alert on any invariant breach (transferred >
  funded; allocation states inconsistent with intents; inbox gaps). Age alerts:
  `reserved`>2d, `payment_processing`>10d, `transferring`>14d.
- **Rollout**: behind `HOSTED_FUNDING_ENABLED` (default off; #44 guard authoritative
  until removal). Staging with Stripe test clocks through: card + ACH success, dunning →
  release, cancel-vs-payment race, duplicate/permuted webhooks, >24h-old idempotency
  retry, partial refund, partial reversal, dispute after settle, fraud flag while
  reserved/funded/transferring, manual-confirm idempotency + authz. Two supervised prod
  cycles (xispark first), then remove flag + guard.
- **Counsel review before prod enable** (founder-approved): custodial window,
  off-session authorization, bank-debit mandates, chargeback allocation, residual/
  unclaimed funds, licensing implications of collect-and-forward, and whether the flat
  card "funding processing fee" line (§12) is compliant as a platform fee vs. card-network
  surcharge rules in target jurisdictions. Does not block #43/#44.

## 12. Decisions recorded

| Question | Decision |
|---|---|
| Processing fees | **ACH-first (founder-revised ×2, review-corrected):** launch is **bank-debit-only** — no funding fee, Stripe's ACH cost (0.8% capped $5, plus $4 failed-payment / $15 dispute fees) absorbed and **tracked explicitly as rail cost** via `actualStripeFeeMinor`. The **card path is disabled at launch** and hard-gated on counsel (surcharge classification: credit-vs-debit rules, disclosure, network registration, caps). If/when enabled it uses either exact gross-up `F = (0.029·P + 0.30)/(1 − 0.029)` **plus** a `balance_transaction.fee` true-up on the next batch, or a published fixed "card funding fee" with **no "at cost"/"no markup" language** — the naive principal-based 2.9%+30¢ under-collects (Stripe's percentage applies to the gross charge: ~$8.42 short on a $10k batch) and premium/international variance makes "at cost" unkeepable. Fee shown in dollars before any authorization; every funding charge gets an OpenPartner-generated receipt (a PaymentIntent has no line items) |
| Funding authorization & disclosure | **One-time per-tenant authorization gate** before the first funding batch: an admin (a) explicitly accepts "collect commission funding from my payment method" in Billing (stored: adminId, timestamp, terms version) and (b) **completes bank-debit setup** — subscriptions are card-paid, so no tenant has a bank account on file: ACH via Stripe Financial Connections SetupIntent, Bacs via mandate flow. Satisfies off-session prior-agreement + scheme mandate requirements and covers EXISTING tenants whose cards predate the feature. New brands additionally accept ToS at plan Checkout (`consent_collection.terms_of_service: 'required'`). No funding batch without recorded authorization + verified funding instrument |
| Funding rails & regions | Rail is selected per **(brand bank country × batch currency)**: launch = **ACH/USD** (US brands); **Bacs Direct Debit/GBP is the designed-in fast-follow** (UK brands — ~1% capped ~£4; Direct Debit Guarantee indemnity window added to the dispute-exposure model and counsel list). A brand with no bank-debit rail for its batch currency (e.g. UK brand, USD commissions) stays on the **manual rail**, or — for supervised early runs on known brands — cost-absorbed card funding at operator discretion (per review recommendation), pending the counsel-gated card path. **xispark launches on the manual rail** regardless; funding onboards them once their currency/rail pairing is confirmed |
| Cadence | Per payout tick; max one open batch per tenant × currency; eligible commissions roll forward |
| Batch floor | $25 USD platform floor (in addition to partner thresholds); revisit $50; hosted funding launches USD-only |
| Unfunded obligations | ToS language + partner-visible `awaiting brand funding` status |
| Collection primitive | PaymentIntent (invoice semantics too permissive); invoice rendering later if wanted, presentation-only |
| High-risk fallback | Manual rail (or future direct-charge-on-partner-account) for tenants above risk caps |

## 13. Rejected alternatives (unchanged from v1, plus)

Prepaid wallet (custody complexity); direct charges on partner Standard accounts (kept
as documented **high-risk fallback**, not default — per-partner payment/SCA/tax burden);
destination charges on consumer revenue (violates not-MoR); Express/embedded (different
feature, crosses Standard-only). **Stripe Invoice as the collection primitive** — demoted
by review findings 3/6 (pending-item leakage, discountable items, credit-balance and
out-of-band satisfaction all decouple "invoice paid" from "money arrived").
