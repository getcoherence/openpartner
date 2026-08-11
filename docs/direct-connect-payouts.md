# Direct-Connect payouts — intent, execution, recovery

This is the rail that pays partners straight from the platform's own Stripe
balance: **self-host installs** (where the platform account *is* the brand's
account) and the deliberate `OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS=1`
operator override. Hosted tenants use the funded rail instead
(`docs/payout-funding.md`) — money is collected from the brand first.

Both rails now follow the same discipline, for the same reason.

## Why it is split in two

`runPayouts` runs inside the caller's tenant transaction (the scheduler tick,
or the admin request). Until August 2026 it also called
`stripe.transfers.create` from in there, with an idempotency key derived from
a payout id minted in that same transaction. Two ways that double-pays:

1. **The transfer succeeds, the COMMIT then fails.** The Payout row and the
   `status='paid'` commissions roll back; the money is gone. The next run
   groups the same commissions under a **new** payout id → a **new**
   idempotency key → a **second** transfer.
2. **Stripe answers ambiguously** (timeout / socket error — the transfer may
   or may not exist). The old code marked the payout `failed`, left the
   commissions `approved`, and the next run retried under a new key. Same
   duplicate.

Making the key deterministic over the commission set does *not* fix this: if
any commission is approved between the two attempts, the set changes, the key
changes, and the second transfer pays the overlap again.

The fix is the one `funding/executor.ts` already used — **freeze an intent,
commit it, then talk to Stripe**.

## The two halves

| | |
|---|---|
| `payouts.ts` → `runPayouts(db, tenantId)` | **Planner.** Inside the caller's transaction. Groups approved commissions, writes the `Payout` row, and for the Connect rail freezes an intent. Never calls Stripe. |
| `payout-transfers.ts` → `executePayoutTransfers(db, opts)` | **Executor.** Outside any transaction, on the privileged pool. Posts the transfers, reconciles ambiguity, finalizes the ledger. |

**What "frozen" means:**

- The intent *is* the `Payout` row, committed with
  `metadata.transferState='intent'`, its `amountMinor`, and its destination
  account. Its id is durable, so the idempotency key `payout_<payoutId>` is
  durable — a retry re-uses it instead of minting a new one.
- Its commission set is frozen by claiming the rows: `Commission.payoutId` is
  stamped while `status` stays `approved`. Every planner lookup filters
  `payoutId is null`, so claimed rows are invisible to the next run and can
  never be regrouped into a second, larger transfer. Commissions approved
  after the freeze simply form their own intent.

## Intent states

Stored in `Payout.metadata.transferState`, advanced only by compare-and-set,
so two workers racing one intent cannot both act on it.

```
intent ──preflight ok──▶ posted ──success──▶ confirmed        (paid; commissions paid)
   ▲                       │
   │                       ├──definite 4xx──▶ canceled        (payout failed; claims released)
   │                       │
   │                       ├──ambiguous─────▶ stays posted    (retry replays the frozen key)
   │                       │
   │                       └──>24h──────────▶ reconcile_required
   └───────────listing proves no transfer────────────┘
                    (listing finds one → confirmed)

intent ──preflight fails──▶ canceled   (nothing was ever sent to Stripe)
```

- **Inside Stripe's ~24h idempotency window**, re-POSTing the frozen key is
  safe: Stripe replays the original outcome instead of creating a second
  transfer. A 60-second cooldown keeps a scheduler tick from racing an
  admin-triggered run into two concurrent POSTs on one key.
- **Past the window** the key may be pruned, so a re-POST would be a *new*
  transfer. Instead the executor pages `transfers.list({ transfer_group })` —
  the payout id is the transfer group — and matches the
  `openpartner_payout_id` metadata stamp. Found → finalize with the real
  transfer. Proven absent → re-arm as `intent`, which makes the next POST a
  genuine first attempt.
- **Preflight** (before the first POST only, when abandoning is still free)
  re-checks that every claimed commission is still `approved`, that they still
  sum to the frozen amount, and that the partner is still Connect-ready. Any
  drift cancels the intent and releases the claims so the next planning run
  regroups what remains.
- Preflight can only catch drift *before* the first POST, so the frozen
  commissions are also protected from the other side: `interlockCommissionReversal`
  holds any commission claimed by an open intent, which is what makes the
  admin reverse endpoint and the refund clawback refuse it with a 409
  instead of shrinking a set Stripe is about to be paid for.
- A **409 idempotency conflict** or a **429** is treated as ambiguous, not
  as proof of absence: another request may be mid-flight with the same key.
  Releasing the claims on those would let the planner regroup under a new
  key while the first transfer lands — a double-pay.
- A transfer that comes back **reversed** is never recorded as paid: the
  intent closes, the payout stays `failed`, and its commissions stay claimed
  for an operator decision (an ALERT is logged). See *Disposing of a reversed
  payout* below — this is the one case with no automatic path back.
- Any attempt past the first **re-reads the transfer from Stripe** before
  finalizing. A retried idempotency key replays the response Stripe stored
  at creation time, so `reversed` in that body is stale by definition;
  believing it would overwrite a reversal with "paid".

## Who runs the executor

- `payout-transfers` scheduler job, every 15 minutes — retries and reconciles
  anything left open by a crash, a timeout, or an unready partner.
- The weekly `payouts` job, immediately after every tenant's planning
  transaction has committed.
- `POST /payouts/run`, which plans in a transaction of its own, commits, then
  executes scoped to that tenant so the admin sees the outcome in the
  response. It deliberately does **not** use the request transaction.

## Operating it

**Find open intents:**

```sql
select id, "tenantId", "partnerId", amount, status,
       metadata->>'transferState' as state,
       metadata->>'postedAt'      as posted_at,
       metadata->>'lastError'     as last_error
from "Payout"
where metadata->>'transferState' in ('intent','posted','reconcile_required')
order by "createdAt";
```

**A stuck `posted` intent** is not an emergency: the next executor tick either
replays the key (inside 24h) or reconciles by listing (past it). Do **not**
create a transfer by hand for it — that is the one action the whole design
exists to prevent. If you must, first confirm via
`stripe transfers list --transfer-group <payoutId>` that none exists.

**Disposing of a `duplicate_review` payout.** The executor found more
than one transfer in the payout's `transfer_group`, or one from a key
generation it had already proved absent. The partner has been paid more
than once. This state is deliberately NOT scanned again — re-listing and
re-alerting every 15 minutes forever helps nobody, and reversed
duplicates still appear in Stripe's listing so the count never drops.
The ledger is untouched, the payout is `failed`, and its commissions stay
claimed so nothing can re-pay them.

To dispose: reverse the surplus transfer(s) in Stripe, decide whether the
partner keeps the correct one, then either release the claims (SQL below)
so the payout re-plans, or reverse the commissions if the money is not
owed. Nothing automatic will touch it.

**Disposing of a reversed payout.** When a transfer is reversed, the payout
is `failed`, the intent is `confirmed`, and its commissions stay `approved`
**and claimed** — deliberately, so nothing re-pays money that came back. They
are invisible to the planner until an operator decides. Two dispositions:

- *The partner should still be paid* (the reversal was a mistake): release
  the claims with the SQL below; the next run plans a fresh intent.
- *The partner should not be paid*: reverse the commissions
  (`POST /commissions/:id/reverse` — release the claims first, or the
  in-flight interlock refuses) or record a `CommissionAdjustment`.

Doing nothing is also a decision, and a safe one: the money is not moving.
The commissions simply sit out of the payable pool until someone acts.

**Releasing an intent manually** (when Stripe listing proves no transfer
exists, or after disposing of a reversed payout as above):

```sql
update "Payout"
   set status = 'failed',
       metadata = metadata || '{"transferState":"canceled","lastError":"manual release"}'
 where id = $1 and metadata->>'transferState' <> 'confirmed';
update "Commission" set "payoutId" = null where "payoutId" = $1 and status <> 'paid';
```

## Staging checklist before trusting it with real money

Run against Stripe **test mode** with `OPENPARTNER_ENABLE_SCHEDULER=1`:

1. **Happy path** — approve commissions, run payouts, confirm exactly one
   transfer, `Payout.status='paid'`, commissions `paid`.
2. **Injected commit failure** — kill the API between the planner's commit and
   the executor (stop the process after `transferState='intent'`). Restart;
   the 15-minute job must post exactly one transfer.
3. **Injected timeout** — point the executor at a proxy that drops the
   response to `transfers.create`. The intent must stay `posted` and the
   commissions must stay claimed. Restart the executor: within 24h it replays
   the key (Stripe returns the *same* transfer id — verify in the dashboard
   that only one exists).
4. **Past the window** — set `postedAt` back 25 hours on that intent and let
   the executor run. It must call `transfers.list`, not `transfers.create`,
   and finalize with the transfer that already exists.
5. **Set change** — approve another commission while an intent is open, then
   run the planner. Two intents, two transfers, no overlapping amount.
6. **Definite failure** — de-onboard the destination account so Stripe 400s.
   The payout must go `failed` and the commissions must return to the pool
   (`payoutId is null`, still `approved`).
