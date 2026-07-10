# Hosted Payout Funding — Implementation Spec (DRAFT, pre-review)

**Status:** Draft for adversarial review · **Author:** Lead architect · **Date:** 2026-07-10
**Tracking:** issue #45 · **Interim guard:** PR #44 (hosted Connect payouts fail closed)
**Audit basis:** two independent reviews (in-repo trace + external Codex audit of `main@5440ee3`), both CONFIRMED.

---

## 1. Problem

On the hosted `stripe_connect` rail, `runPayouts` (`apps/api/src/payouts.ts`) transfers the
**full commission principal from the platform's Stripe balance** to partners' Connect
Standard accounts. The only money ever collected from the brand is the metered service fee
(Flex 1.5% / RevShare 3% of attributed GMV). Nothing collects the principal.

Worked example (RevShare, $100 GMV, 20% partner commission):

| Flow | Amount |
|---|---|
| Brand billed (3% × GMV, metered) | **+$3.00** |
| Platform → partner transfer | **−$20.00** |
| `Payout.metadata.platformFee` (recorded, never billed) | $0.60 |
| **Net platform cash per conversion** | **≈ −$17** |

Self-host is unaffected: there the "platform" Stripe account *is* the brand's own account,
so the transfer is correctly funded. The gap is exclusive to hosted multi-tenant.

The audit also identified an integrity cluster in the same code path (double-pay risks,
DB transactions held across Stripe calls, reversal handling, manual-rail semantics). This
spec fixes those **in the same rework** because the funding flow forces the payout runner
to be rebuilt around a durable state machine anyway.

## 2. Constraints (non-negotiable)

1. **Connect Standard only** (CLAUDE.md §4). No Express/Custom accounts.
2. **Not merchant of record for brand consumer revenue** (CLAUDE.md non-goals). The
   funding charge is a separate B2B payment from the brand to the platform — it does not
   route the brand's consumer sales through us.
3. **Portability** (CLAUDE.md §2/§5): all new tables are hosted-only **sidecars**. No
   Stripe IDs or funding state on core tables. A hosted export re-imports into self-host
   with funding rows inert (self-host never runs the funding flow).
4. The existing per-tenant knobs stay meaningful: `payoutRailPreference`,
   `payoutThresholdCents`, `payoutCadence`. Manual rail keeps working (with one semantic
   fix, §7).

## 3. Design overview — invoice-before-transfer

```
approved commissions
   │  (Monday cadence tick, per tenant × currency)
   ▼
[reserve] HostedFundingBatch + allocations        ← short DB trx, FOR UPDATE
   │
   ▼
[invoice] Stripe Invoice to the brand's existing customer
   │        line item: "Partner commission funding — <period>"
   │        auto-collect, off-session, metadata.openpartner_funding_batch_id
   ▼
[funded]  invoice.paid webhook (settled money — ACH included)
   │
   ▼
[transfer] executor job: per-partner transfers.create
   │        source_transaction = funding charge, transfer_group = batch id
   │        deterministic idempotency key, one short DB trx per transfer
   ▼
[paid]    Payout rows paid, commissions paid, webhooks fire
```

The state machine (persisted on the batch):

```
reserved → funding_pending → funded → transferring → settled
   │             │
   │             └── funding_failed ──→ released   (allocations freed,
   └──────────────────────────────────→ released    commissions → approved)
```

Money only ever moves **after** money has arrived. A batch that never gets funded
releases its commissions back to `approved` — nothing is lost, nothing is fronted.

## 4. Data model (sidecar tables, hosted-only)

### `HostedFundingBatch`

| column | type | notes |
|---|---|---|
| `id` | ulid pk | also the `transfer_group` |
| `tenantId` | fk Tenant, cascade | |
| `currency` | text | one batch per tenant × currency per run |
| `principal` | numeric | frozen sum of allocated commissions |
| `status` | text | the state machine above; CHECK-constrained |
| `stripeInvoiceId` | text nullable, unique | |
| `stripeChargeId` | text nullable | the funding charge; `source_transaction` for transfers |
| `failureReason` | text nullable | |
| `fundedAt` / `settledAt` / `releasedAt` | timestamps nullable | |
| `createdAt` / `updatedAt` | timestamps | |

### `HostedFundingAllocation`

| column | type | notes |
|---|---|---|
| `id` | ulid pk | |
| `batchId` | fk HostedFundingBatch, cascade | |
| `commissionId` | fk Commission | **UNIQUE among live batches** (partial unique index `WHERE released = false`) — a commission can only ever be reserved once |
| `partnerId` | fk Partner | denormalized for the per-partner transfer grouping |
| `amount` | numeric | frozen at reservation |
| `released` | boolean default false | set on batch release |

RLS on both tables, same tenant-isolation policy as every tenanted table. Grants for
`openpartner_app`. Both are exported as documented sidecars (like `PortalCustomDomain`);
importers ignore them on self-host.

**Core-table changes (portable, minimal):**
- `Payout.stripeTransferId` gains a **unique index** (audit: nothing prevented double
  recording). Already a plain column today.
- `Payout.status` gains `'reversed'` (audit: reversal currently recorded as `failed`
  while commissions stay `paid`). `CommissionStatus` already has `'reversed'`.
- No new columns on `Commission`. Reservation lives entirely in the allocation table —
  the partial unique index is the mutual exclusion, and "approved AND not allocated to a
  live batch" is the selectable set.

## 5. Phase 1 — reserve + invoice (cadence tick)

Replaces the transfer half of today's `runPayouts` for hosted Connect tenants. Runs from
the existing Monday scheduler tick (per-tenant cadence gate unchanged) and from the admin
"run payouts" endpoint — both **serialized by the same pg advisory lock** keyed
`payouts:<tenantId>` (audit: admin + scheduler could double-run; today's lock only covers
scheduler-vs-scheduler).

Per tenant × currency, in **one short committed transaction**:

1. `SELECT … FOR UPDATE SKIP LOCKED` the `approved` commissions with no live allocation,
   grouped as today (threshold gate, rail resolution, Connect-readiness preflight all
   unchanged — groups that are connect-blocked or below threshold are skipped exactly as
   now, before reservation).
2. Insert `HostedFundingBatch{status:'reserved', principal}` + one allocation per
   commission. The partial unique index makes a concurrent duplicate reservation a
   constraint violation, not a double-spend.
3. Commit. **No Stripe call inside this transaction.**

Then, outside the transaction (state-machine step, idempotent):

4. Create the Stripe Invoice on the brand's existing `stripeCustomerId`:
   - one invoice item: principal, description "Partner commission funding — <n> partners,
     <period>", `metadata.openpartner_funding_batch_id`
   - `collection_method: 'charge_automatically'`, off-session against the subscription's
     default payment method
   - idempotency key `funding_invoice:<batchId>` — a crashed worker retries into the
     same invoice, never a second one
5. Stamp `stripeInvoiceId`, move batch → `funding_pending`. If invoice creation itself
   fails permanently (no payment method, deleted customer), batch → `funding_failed`.

**Batch sizing:** one batch per tenant × currency per tick covering *all* eligible
commissions — not per partner. One funding charge fans out to N partner transfers
(Stripe allows multiple transfers against one `source_transaction` up to its amount,
same currency).

## 6. Phase 2 — fund + transfer (webhook + executor)

### Funding confirmation

`stripe-webhook.ts` gains a branch **ahead of** the conversion-event mapping: an
`invoice.paid` carrying `metadata.openpartner_funding_batch_id` is a funding settlement,
not an attribution event (today's handler would try to map it — the metadata gate keeps
the two worlds separate; same guard on `invoice.payment_failed` → increment dunning
count, and on final failure → `funding_failed`). On funding: stamp `stripeChargeId` from
the invoice's charge, batch → `funded`.

`invoice.paid` is the **settled** signal for both cards (instant) and ACH/SEPA debit
(fires after actual settlement), which is exactly the property we need before releasing
transfers.

### Transfer executor

New scheduler job (every 5 minutes, advisory-locked, `protect: true`): for each `funded`
batch, per partner allocation group:

1. Deterministic idempotency key: `fb:<batchId>:p:<partnerId>:<currency>`. **Never
   regenerated** — a retry after any ambiguous failure replays the same key and Stripe
   returns the original transfer instead of creating a second one (audit: today's key is
   a fresh Payout id per attempt).
2. `transfers.create({ amount, currency, destination, source_transaction: stripeChargeId,
   transfer_group: batchId })`. `source_transaction` ties the transfer to settled funding
   money rather than the general platform balance.
3. **One short DB transaction per transfer result** (audit: today the whole tenant run
   shares one transaction around all Stripe calls): insert `Payout{status:'paid',
   stripeTransferId}` (unique index makes double-recording impossible), flip the
   allocation's commissions → `paid`, fire `commission.paid` webhooks.
4. When every allocation in the batch is paid → batch `settled`.
5. A transfer failure records the error on the batch and leaves that allocation for the
   next executor tick — same key, so retries are safe. A partner whose Connect account
   broke *after* reservation stays in `transferring` until fixed or manually released.

### Reversals

`transfer.reversed` webhook: Payout → `'reversed'` **and its commissions → `'reversed'`**
(audit: today commissions stay `paid`, blocking any retry while asserting payment). The
admin review queue shows reversed payouts; re-approval is an explicit human action.

## 7. Failure and edge semantics

| Case | Behavior |
|---|---|
| Funding invoice unpaid (dunning) | Stripe retries per its schedule. After `FUNDING_TIMEOUT_DAYS` (default 10) or final `invoice.payment_failed`, batch → `funding_failed` → `released`; allocations freed; commissions back in the pool. The invoice is voided. Brand's admin Billing page shows the failed funding invoice loudly. |
| Brand cancels subscription with reserved/funded batches | Reserved/funding_pending → released + invoice voided. **Funded batches always finish transferring** — money already collected belongs to partners. Cancellation stops *new* batches (the hosted rail requires `hasActivePlan`, which this rework also tightens to check the webhook-mirrored subscription status, closing the audit's past-due gap). |
| Partial executor crash | Deterministic keys + per-transfer transactions: replay-safe from any point. |
| Currency mismatch / FX | Batch is per-currency; funding invoice and transfers share the currency. No FX inside the flow. |
| Manual rail | Unchanged flow, one semantic fix: manual payouts are created `pending` and commissions stay `approved` until an admin hits the new `POST /payouts/:id/confirm` ("I paid this out-of-band") which flips both to paid. Fixes the audit's "paid on faith" finding and unblocks Network payout metering for manual tenants. |
| Self-host | Entire funding flow is bypassed: `mode === 'selfhost'` keeps today's direct-transfer path (their account, their money), plus the idempotency/transaction fixes which apply everywhere. |
| Guard interaction | PR #44's fail-closed guard is replaced by the reservation flow; the env escape hatch is removed. |

## 8. Brand-facing surface

- **Billing page**: funding invoices appear in the existing invoice list (they're normal
  Stripe invoices); a new "Partner payouts" card shows pending/funded batches and the
  next expected payout date, with plain copy: *"Commission payouts are collected from
  your payment method first, then sent to your partners — typically within X days."*
- **Partner-facing**: no change; payouts arrive as today, slightly later (card funding:
  minutes; ACH: days). Payout timeline copy in partner docs updated.
- **Docs**: `docs/brands/billing` gains a "How partner payouts are funded" section;
  white-label setup guide unaffected.

## 9. Rollout

1. Migrations + code behind `HOSTED_FUNDING_ENABLED=1` (default off) — the #44 guard
   stays authoritative until the flag flips.
2. Enable on a staging tenant; run the full loop with Stripe test clocks (card + ACH,
   dunning path, reversal path).
3. Enable in prod; first real batch supervised. Remove the flag + the #44 guard after
   two clean weekly cycles.

## 10. Open questions (founder)

1. **Stripe processing fees on the funding charge** (~2.9% + 30¢ card / 0.8% capped
   ACH): absorb, or pass through as an invoice line? Proposal: absorb at launch, revisit
   with volume; nudge brands to ACH/SEPA for funding.
2. **Funding cadence**: per payout tick (weekly-ish, small invoices) vs monthly
   consolidated (fewer invoices, longer partner wait)? Proposal: per tick.
3. **Minimum batch principal** to avoid $3 invoices (fold into the existing per-tenant
   threshold, or a platform floor like $25)?
4. **Brand refuses to pay / churns with owed commissions**: partners were promised money
   the brand never funded. Terms-of-service language needed ("commissions are obligations
   of the brand; the platform facilitates"), and a partner-facing status so unfunded ≠
   silently missing.
5. **Legal review**: collecting-then-forwarding funds is not MoR for consumer sales, but
   brief counsel review of the custodial window (funds settle to platform, transfer out
   within minutes/hours) per Stripe's own guidance.

## 11. Explicitly rejected alternatives

- **Prepaid tenant wallet** — more custody/reconciliation/refund complexity and a worse
  brand UX (idle cash) for no correctness gain at current volume. Revisit at scale.
- **Direct charges on each partner's Standard account** — zero-custody but pushes
  payment/SCA/tax/invoicing complexity onto every partner relationship and breaks batch
  UX. Wrong trade at our stage.
- **Destination charges on consumer revenue** — violates the not-MoR constraint outright.
- **Express accounts / embedded payouts** — different feature (white-label onboarding
  UX), separately tracked; doesn't solve funding and crosses the Standard-only line.
