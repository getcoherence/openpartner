# Netting refund clawbacks off the next payout — design

**Status (Oct 17 2026): design only. Not built.** The manual and
direct-Connect rails can net safely. The hosted-funding rail can't, not
without a new kind of allocation row that its executor, interlocks,
reconcile sweep and reversal webhook would all have to learn (§4). The brief
was to build only if all three rails are safe, so this stops here. §5 is
the build plan for the two safe rails if netting on two of three is
accepted.

Branch `feat/refund-clawback-netting`, stacked on `feat/refunds-api`.

## 1. The gap

A refund of a paid commission can't reverse it: paid commissions are
immutable ledger history. `applyRefund` (apps/api/src/refunds.ts) records a
negative `CommissionAdjustment` (`reason = 'refund_clawback'`,
`metadata.refundEventId`) and reports `clawback_recorded`. Nothing deducts
it later, so the partner keeps commission on refunded revenue unless the
brand recovers it by hand.

## 2. Shared mechanics

**Marker.** `CommissionAdjustment.appliedPayoutId`, nullable `varchar(32)`,
no FK (like `Commission.payoutId`), partial index `where "appliedPayoutId"
is not null`. Null = outstanding. Set = netted into that payout.

*Portability.* `CommissionAdjustment` is a core exported table. A nullable
column needs no `schemaVersion` bump: the `Commission.metadata` column
(Oct 2026) set the precedent. An older bundle imports with null, and a
newer bundle needs the migration first. One catch: an instance running
refunds-api *without* netting tells brands `actionRequired`, so some may
recover clawbacks by hand. Netting deployed later would then recover them
a second time. **Ship netting in the same release as refunds-api**, which
the stacked branch allows. Then no clawback ever exists before netting does.
(`main` writes no `refund_clawback` rows today, so prod has none.)

**What may be netted.** Only `refund_clawback` rows with
`appliedPayoutId is null`, `amount < 0`, in the payout's currency, on a
commission of the payout's partner. Never `transfer_reversed`: that money
already came back, so netting it would recover it twice.

**Per-commission cap (no double recovery).** For the clawback's paid
commission *c*, the partner still holds

    holds(c) = c.amount + Σ non-clawback adjustments(c) + Σ applied clawbacks(c)

Open clawbacks on *c* are netted whole, oldest first, while they fit under
`holds(c)`. A full transfer reversal writes `transfer_reversed = −amount`
(funding/webhook.ts `handleTransferReversed`), which drives `holds` to 0.
A clawback recorded *before* such a reversal is therefore never netted.
The partner returned everything, so the clawback is reported as
unrecoverable, not deducted.

**Lock order.** The planner takes `FOR UPDATE` on the clawbacks' paid
commissions before it reads their adjustments. `applyRefund` and the
funding reversal handler take that same lock before they write
adjustments. So a `transfer_reversed` can't land between the cap read and
the stamp.

**Carry-over, never negative.** For a (partner, currency) group with gross
*G* (Σ approved, unclaimed commissions) and nettable *K*:

- `K ≥ G`: no payout this run. Commissions stay `approved` and unclaimed,
  and clawbacks stay open. Report it as `heldForClawback`, a sibling of
  `skippedBelowThreshold`. The partner is paid once accrual exceeds the
  debt. A zero or negative transfer is impossible by construction.
- `K < G`: the payout amount is `G − K > 0`. The tenant's payout threshold
  applies to the net amount, since that is what moves.

**Stamp.** In the planner's transaction, as a compare-and-set:
`update … set appliedPayoutId = X where id in (…) and appliedPayoutId is
null`. A short count aborts the run, exactly like the commission claim.
Nothing has been announced or sent at that point.

**Ledger.** `Payout.amount` is the net amount. `Payout.metadata.netting =
{ grossMinor, clawbackMinor, adjustmentIds }` is an audit copy; the column
stays the source of truth. `payout.created` gains optional `grossAmount`
and `clawbackAdjustmentIds`, so a subscriber can reconcile Σ commissions
against the amount (OpenAPI regeneration needed).

**Invariant N, kept on every rail that nets:**

    payout.amountMinor = Σ commissions(payoutId = X) + Σ adjustments(appliedPayoutId = X)

Also: `appliedPayoutId = X` only while X is live or has paid the partner.
Every path that ends with the partner holding nothing from X clears it.

## 3. Rails that can net

### Manual

Planning is terminal. Commissions flip to `paid` in the run, and no path
cancels a manual payout (`POST /payouts/:id/confirm` only moves `pending →
paid`). The stamps commit in the same transaction as the commission
compare-and-set, so invariant N holds from commit. The operator pays
`Payout.amount`, which is the net amount. Nothing needs releasing.

### Direct Connect (payouts.ts → payout-transfers.ts)

- **Planner.** The intent's frozen `amountMinor` is the net amount.
  Commission claims and adjustment stamps go in one transaction.
- **`preflight`.** Becomes `Σ claimed commissions + Σ applied adjustments
  == amountMinor` and `amountMinor > 0`. Otherwise the intent is canceled
  with `commission_amount_changed`, as today.
- **`releaseClaims`** also runs `update CommissionAdjustment set
  appliedPayoutId = null where appliedPayoutId = X`. It is the single
  release that `cancelIntent`, `failIntent`, `disposeIntent` and
  `resolveDuplicateReview({ allReversed })` use, and through them operator
  recovery (`applyOne`). Each of those runs inside the state compare-and-set's
  transaction and means the partner holds nothing from X.
- **Unchanged:** `finalizeTransfer`, `resolveDuplicateReview({
  keptTransferId })` and `releaseIntentForRetry`. The stamps stay, and every
  Stripe-side check already compares against the frozen `amountMinor`,
  which now *is* the transfer amount.
- **Paid, then fully reversed in Stripe.** The commissions stay `paid`, as
  today (a documented gap on this rail). Once the operator disposes the
  payout, its clawbacks are released and net again. The partner received
  nothing from X, so the debt was never recovered.
- **Interlocks unchanged.** Adjustments never change status, and the
  claimed commissions are still held by the open intent.

## 4. Hosted funding: cannot net safely in this change

The batch charges the brand `principal = Σ allocations`. Each allocation
is one commission: `commissionId` is NOT NULL with an FK, and
`HostedFundingAllocation_live_commission` covers every state except
released and canceled. Each partner's transfer is `Σ` of that partner's
allocations. To net, the clawback has to lower both the brand charge and
the partner transfer, which means a **negative allocation that is not a
commission**. Each consumer then breaks:

1. **Pre-charge interlock shrink** (`interlockCommissionReversal`). A refund
   of one of the partner's reserved commissions shrinks the principal by
   that amount and leaves the negative row. That can take the partner's
   group to ≤ 0, and the executor then posts a zero or negative
   `transfers.create`. Stripe answers 400, the intent goes `failed`, and
   `failed` retries the same key every tick, so the batch never settles.
2. **In-flight cancel.** The charge is frozen at `G − K`. The canceled
   allocation becomes a residual of its own amount. If the partner's group
   then falls to ≤ 0, the offset can't be satisfied, and the §6 invariant
   (`principal = transferred + pending + residual + refunded`) needs a
   negative residual. None of the residual dispositions models one
   (`refund` / `manual_payout` / `credit_next_batch`).
3. **Finalize.** `finalizeTransfer` sets every allocation's commission to
   `paid` with the new `payoutId`. Keyed to the paid commission, a clawback
   allocation would overwrite that commission's ledger link. And its
   `transferred` allocation is still "live" under the unique index, so the
   insert fails anyway.
4. **Reversal webhook.** `handleTransferReversed` compares reversals with
   `payout.amount`, which would now be the net amount. It then writes
   `transfer_reversed = −commission.amount` for every commission.
   Σ adjustments would overstate what came back by *K*, and the clawback
   would stay applied to a payout the partner returned in full.

Each fix lands in the funding executor, interlocks, reconcile sweep and
reversal handler: the pipeline that took 14 audit rounds. That is a large,
separately audited change for a rail that is flag-OFF in prod with zero
batches.

**What two-rail netting would mean here.** The planner never nets a
funding candidate, and no funding code reads or writes `appliedPayoutId`,
so funding invariants are untouched. Clawbacks of funding-rail partners
stay outstanding, which is today's behaviour, until a manual or
direct-Connect payout for that partner nets them. Recovering a clawback on
a different rail than the original payment is legitimate: same brand, same
partner. The cost is a product one. Inside a hosted tenant, Connect
partners (funding) are paid gross while manual partners are paid net.

## 5. Build plan if two-rail netting is accepted

- Migration `20261017000000_commission_adjustment_applied_payout.ts`:
  column and partial index. `CommissionAdjustmentRow.appliedPayoutId`.
  Add a data-portability.md note (no version bump).
- New `apps/api/src/clawback-netting.ts`: `openClawbacks(trx, tenantId,
  partnerId, currency)` (lock, cap, oldest first) and
  `stampClawbacks(trx, payoutId, ids)` (compare-and-set). One home, called
  from the planner.
- payouts.ts: resolve the rail before the threshold. Net only on the
  manual and `canTransfer` paths, never on funding candidates, unfunded
  refusals or `connectBlocked` failure rows. Add `heldForClawback`,
  threshold on net, `metadata.netting`. `platformFee` (ledger note) on net.
- payout-transfers.ts: the `preflight` sum, and the release in
  `releaseClaims`.
- refunds.ts: doc comment. The clawback now nets off the partner's next
  manual or direct payout. `actionRequired` stays true, because the rail
  isn't known at refund time.
- webhook-events.ts and the OpenAPI spec: optional `payout.created`
  fields.
- Do not touch usage-billing.ts. Platform fee is GMV-based and has its own
  refund work.

**Tests**, in the refunds.test.ts / payout-transfer-intent.test.ts style,
on a scratch DB:

- manual nets, and the amount equals invariant N
- `K ≥ G` holds the group, and the next run nets once accrual exceeds K
- threshold measured on the net amount
- `transfer_reversed` is never netted, and a clawback on a fully reversed
  commission is skipped
- the clawback's currency must match the payout's
- direct intent `amountMinor` is the net amount, and preflight passes
- preflight cancels when a stamp was cleared underneath it
- `failIntent`, `cancelIntent`, `disposeIntent` and `allReversed` each
  release the stamps, and `keptTransferId` and re-arm keep them
- two concurrent runs can't stamp one clawback twice
- a funding candidate is never netted

## 6. Blast radius (gitnexus, index 5 commits behind HEAD)

| Symbol | Risk | Reach |
|---|---|---|
| `runPayouts` | HIGH | 6 direct (scheduler tick, `POST /payouts/run`, staging-direct-connect and staging-two-process-races scripts), 22 total |
| `releaseClaims` | HIGH | `cancelIntent`, `failIntent`, `disposeIntent`, `resolveDuplicateReview` → operator recovery `applyOne` / `applyRecoveryRequests`, `executePayoutTransfers` |
| `preflight` | LOW | `advanceIntent` only |
| `executePayoutTransfers` | MEDIUM | 10 direct |
| `reserveFundingBatch` | HIGH | 32, if the funding rail were changed |
| `interlockCommissionReversal` | LOW | admin reverse and refund paths |
