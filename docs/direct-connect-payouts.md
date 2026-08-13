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
   │                                              │
   │                                   listing finds one ──▶ confirmed
   │                                              │
   │                                   listing finds none ──▶ HELD (stays
   │                                              reconcile_required, frozen)
   └──────────── OPERATOR authorises a fresh key ─┘

intent ──preflight fails──▶ canceled   (nothing was ever sent to Stripe)
```

- **Inside Stripe's ~24h idempotency window**, re-POSTing the frozen key is
  safe: Stripe replays the original outcome instead of creating a second
  transfer. `POST_COOLDOWN_MS` keeps a scheduler tick from racing an
  admin-triggered run into two concurrent POSTs on one key. That is a
  *scheduling* choice and carries no correctness weight — see below.
- **Past the window** the key may be pruned, so a re-POST would be a *new*
  transfer. Instead the executor pages `transfers.list({ transfer_group })` —
  the payout id is the transfer group — and matches the
  `openpartner_payout_id` metadata stamp. Found → finalize with the real
  transfer.
- **Found nothing → the intent is HELD, not re-armed** (round 6). This used to
  re-arm automatically, reasoning that the listing "proved" no transfer
  exists. It proves no such thing. `transfers.list` is read-after-write
  consistent, so it is accurate about requests Stripe has *finished* — but it
  cannot see a POST still in flight, and there is no bound on how long one can
  be. stripe-node implements `timeout` as `req.setTimeout`, a socket
  **inactivity** timeout that resets after every stage of the request (its own
  source says so in `net/FetchHttpClient.js`), so a slow-but-progressing
  request outlives any cooldown. Nor can a local deadline help: aborting the
  await does not retract a request Stripe already received.

  So an empty listing means **unknown**, never **absent**. Re-arming on it is
  precisely the double-pay — the old POST lands under the old key while the
  new generation posts under a fresh one. The intent stays
  `reconcile_required` on the same generation with its commissions frozen,
  later ticks keep listing (a straggler still finalizes normally), and only an
  operator may authorise a fresh key.

  The cost is **liveness, not money**: a transfer whose POST genuinely never
  reached Stripe waits for a human. That combination is rare — ambiguous POST
  *and* past the retention window *and* nothing in the group — and it fails
  loudly instead of paying twice.
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

To dispose: reverse the surplus transfer(s) in Stripe, then call
`resolveDuplicateReview` with what is now true — `{ keptTransferId }` if
the partner keeps one transfer (the commissions ARE paid and are recorded
against it), or `{ allReversed: true }` if every transfer was reversed
(the commissions go back to the pool). **Never release the claims by
hand "so the payout re-plans": if any transfer was kept, those
commissions are already paid, and re-planning pays them a second time —
that is the exact double-pay this function exists to prevent.** The
function verifies the disposition against Stripe either way, refuses
while any unaccounted transfer still holds money, and — if a reversal
lands while you are mid-resolution — loses its fenced commit and asks
you to re-verify (`review_moved`).

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

**Disposing of a HELD intent.** An intent that reconciled to "nothing found"
sits in `reconcile_required` forever by design — the executor will not
authorise a new key on its own. There are two supported ways out, and both
are code rather than hand-written SQL:

**Every one of these takes a Stripe client, and it is required.** They verify
their own premise rather than trusting yours — round 8 found that an operator
tool which acts on an unverified human assertion is strictly weaker than the
automatic paths, which were just purged of exactly that. A typo'd transfer id
or a mistaken "I reversed them all" is silent; Stripe is not.

```ts
import {
  releaseIntentForRetry,
  disposeIntent,
  resolveDuplicateReview,
} from './payout-transfers.js';

// "No transfer exists and I want it paid." Lists the transfer group first
// and REFUSES ('transfer_exists') if anything is there — the executor will
// finalize that instead. Bumps the key generation on success, because
// Stripe's retention is anchored to the key's first use.
await releaseIntentForRetry(db, payoutId, observedGeneration, 'keith', stripe);

// "This should not be paid." With a stamped transfer, retrieves it and
// refuses ('money_with_partner') unless FULLY reversed — a partial
// clawback still leaves money with the partner, and releasing those
// commissions would pay the full amount again. With NO stamped transfer
// (the ambiguous held case) it lists the whole group instead and refuses
// while any member still holds money; proceeding on an empty listing is
// your documented risk decision, taken with every verifiable check passed.
// A stamped id Stripe answers resource_missing for (a hand repair, a
// pre-round-8 typo) falls back to the same group verification instead of
// wedging on cannot_verify forever.
await disposeIntent(db, payoutId, 'keith', 'confirmed_no_transfer', stripe);

// A duplicate_review payout. disposeIntent REFUSES this state on purpose.
await resolveDuplicateReview(db, payoutId, 'keith', { keptTransferId: 'tr_...' }, stripe);
await resolveDuplicateReview(db, payoutId, 'keith', { allReversed: true }, stripe);
```

`releaseIntentForRetry` is fenced on the generation you observed, so two
operators — or an operator and a concurrent reconcile — cannot both hand out
an epoch.

`resolveDuplicateReview` checks the disposition you give it: a kept
transfer must be in the payout's group, unreversed, and match the
intent's **frozen amount, currency and destination** — "present and
unreversed" alone would let a one-cent transfer mark a $50 payout paid;
every OTHER transfer in the group must be fully reversed first. And
`allReversed` is refused while any transfer still holds money. A
`review_moved` answer means a reversal landed while you were resolving —
re-run `stripe transfers list` and try again with what is now true.

Membership in the group is by `transfer_group` — immutable at Stripe —
never by metadata, which anyone with dashboard access can clear. A
transfer with wiped metadata still counts against every disposition.

Any of them returns `cannot_verify` if Stripe cannot be read, or if the
transfer group is larger than the listing will page. That is deliberate —
running out of pages is not the same as finding nothing.

**Look first anyway**, so you know what you are asserting:

```bash
stripe transfers list --transfer-group <payoutId>
```

## Staging run — PASSED against Stripe test mode

Executed against **real Stripe test mode** (platform `acct_1TQ1rLLjeKaK2m8k`,
destination `acct_1TQH8tLte7Y6cCMU`). Latest run after the round-6 rework:
**50 assertions, 0 failures**, covering the six scenarios below plus two added
in round 6:

- **7 — two executors racing one intent.** Genuinely concurrent, against real
  Stripe. Exactly one transfer, exactly one executor records it, the
  commission is paid once. This is the first concurrency coverage the matrix
  has had; earlier runs were single-threaded, which is why the CAS and lease
  went unexercised.
- **8 — past the window with nothing at Stripe.** Three ticks must not post,
  the intent must stay `reconcile_required` on generation 0 with commissions
  frozen, and only after `releaseIntentForRetry` may it post — exactly once.

Re-run it with:

```bash
cd apps/api
set -a && . ../../.env && set +a
export OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS=1 OPENPARTNER_TENANCY=single
export STAGING_READY_ACCT=acct_...      # onboarded, transfers: active
export STAGING_UNREADY_ACCT=acct_...    # not onboarded — scenario 6
pnpm exec tsx scripts/staging-direct-connect.ts
```

The script refuses to run against a live key or a non-local `DATABASE_URL`
(it truncates tables and moves money). Transfers need available platform
balance; top up test mode with
`stripe post /v1/charges -d amount=200000 -d currency=usd -d source=tok_bypassPending`.

What the run actually proved, beyond what the mocks could:

- **Scenario 3** — the transfer was really created at Stripe and the response
  then thrown away. The error carried no `statusCode`, classified ambiguous,
  the intent stayed `posted` and the commissions stayed claimed. Replaying the
  frozen key after the cooldown returned **the same transfer** — Stripe's
  idempotency replay behaves as the design assumes, and only one transfer
  exists for the group.
- **Scenario 4** — 25 hours on, the executor called `transfers.list` and
  **never** called `transfers.create` (asserted by counting calls), then
  finalized against the transfer that already existed.
- **Scenario 6** — a real Stripe 400 (`Your destination account needs to have
  at least one of the following capabilities enabled: transfers…`), correctly
  classified definite, payout `failed`, commissions returned to the pool.

Not covered by this script, and still open: a genuine multi-process race (two
executors on one intent). The cooldown/lease is exercised here single-process
only.

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
