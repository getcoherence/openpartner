/**
 * Payout transfer EXECUTOR — the money-moving half of the direct-Connect
 * rail (audit #10). Consumes the durable intents `runPayouts` committed
 * (payouts.ts) and posts the Stripe transfers OUTSIDE any transaction,
 * one short transaction per state change.
 *
 * This is the legacy/self-host sibling of `funding/executor.ts` and follows
 * the same discipline, because the same failure modes apply:
 *
 *   - The intent (the Payout row) is COMMITTED before any Stripe call, so
 *     its id — and the idempotency key `payout_<id>` derived from it — is
 *     durable. A crash retries the SAME key instead of minting a new one.
 *   - The commission set is frozen by the planner (`Commission.payoutId`
 *     stamped while status stays 'approved'), so a retry can't silently
 *     grow the transfer to include commissions approved in the meantime.
 *     That is exactly the double-pay a "deterministic key over the
 *     commission set" would cause.
 *   - An ambiguous outcome (network error / timeout — the transfer may or
 *     may not exist) NEVER leads to a blind re-POST once Stripe's ~24h
 *     idempotency-key window has passed. Past the window we list transfers
 *     by `transfer_group` and match our metadata stamp.
 *
 * State lives in `Payout.metadata.transferState`:
 *
 *   intent   → committed, nothing sent to Stripe yet
 *   posted   → a transfers.create was issued; outcome may be unknown
 *   confirmed→ transfer exists, Payout paid, commissions paid
 *   reconcile_required → posted, past the idempotency window, needs listing
 *   canceled → abandoned before any Stripe call; claims released
 *
 * Every transition is a compare-and-set on that field, so two workers
 * racing the same intent can't both act on it.
 *
 * Runs on the PRIVILEGED db (like the funding executor): it processes
 * every tenant's intents in one pass and cannot hold a tenant-scoped
 * transaction open across Stripe calls. Pass `tenantId` to scope it — the
 * admin "run payouts" endpoint does, so its response reflects the outcome.
 */

import type Stripe from 'stripe';
import type { Knex } from 'knex';
import { TABLES, type CommissionRow, type PartnerRow, type PayoutRow } from '@openpartner/db';
import { requireStripe } from './stripe.js';
import { dispatchEvent } from './webhook-dispatcher.js';

/** Stripe replays a key for ~24h; past that a re-POST is a NEW charge, so
 *  ambiguity has to be resolved by listing instead. Matches
 *  funding/executor.ts. */
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Stop trusting the key this long BEFORE Stripe's retention runs out.
 *  Checking the age and then POSTing is a time-of-check/time-of-use gap:
 *  without a margin, a worker that measured "23h59m, still fine" can have
 *  its request arrive after Stripe pruned the key — which creates a
 *  SECOND transfer instead of replaying the first. */
const KEY_SAFETY_MARGIN_MS = 60 * 60 * 1000;
/** Keep the money call on a short leash so a wedged request doesn't tie up
 *  a worker: stripe-node otherwise defaults to an 80s timeout with 2
 *  network retries. This is resource hygiene ONLY.
 *
 *  It is NOT a wall-clock bound, and nothing about correctness may rest on
 *  it. stripe-node implements `timeout` as `req.setTimeout`, which is a
 *  socket INACTIVITY timeout that resets after every stage of the request
 *  — its own source says so, contrasting Node with fetch in
 *  net/FetchHttpClient.js. A request that keeps making slow progress never
 *  trips it and can outlive any figure written here. */
const TRANSFER_TIMEOUT_MS = 20_000;
const TRANSFER_MAX_RETRIES = 1;
/** How long a just-posted intent is left alone before another worker will
 *  look at it. Purely a SCHEDULING choice — it stops a scheduler tick and
 *  an admin-triggered run from stampeding the same key.
 *
 *  This used to carry the safety argument ("the lease outlives the
 *  request"), which was false for the reason above: no cooldown can
 *  guarantee an in-flight POST has finished. Safety now comes from the
 *  fact that a cold lease never authorises a NEW key — reconcile holds
 *  the intent for an operator instead of re-arming (see reconcileIntent).
 *  Changing this number cannot cause a double-pay; it only changes how
 *  soon a stuck intent is looked at. */
const POST_COOLDOWN_MS = 180_000;
/** After this many attempts, a transfer we can see at Stripe but cannot
 *  re-read stops being a transient blip and becomes an operator alert. */
const RETRIEVE_ALERT_ATTEMPTS = 5;

export type PayoutTransferState =
  | 'intent'
  | 'posted'
  | 'confirmed'
  | 'reconcile_required'
  /** More than one transfer exists, or one from a superseded epoch does.
   *  Terminal for the executor — deliberately NOT in OPEN_STATES — and
   *  awaiting an operator. The commissions stay claimed so nothing can
   *  re-pay them. */
  | 'duplicate_review'
  | 'canceled';

/** The transfer-intent slice of `Payout.metadata`. Written by the planner,
 *  advanced only through `casTransferState`. */
export interface PayoutTransferMeta {
  transferState: PayoutTransferState;
  /** Bumped only when a listing has PROVEN no transfer exists, so the
   *  next attempt gets a key Stripe has never seen. Absent = 0 = the
   *  original `payout_<id>`. */
  keyGeneration?: number;
  /** Frozen at plan time — the destination can't drift mid-flight. */
  destinationAccountId: string;
  /** Frozen at plan time; equals the sum of the claimed commissions. */
  amountMinor: number;
  mode: string;
  attempts: number;
  /** When the frozen key was FIRST posted. Anchors Stripe's ~24h
   *  idempotency window and never moves. */
  postedAt?: string;
  /** When the last attempt claimed the intent. Moves on every retry and
   *  is the compare-and-swap token that keeps two workers off one key. */
  leaseAt?: string;
  /** Moved (to the Stripe event id) by the reversal webhook whenever
   *  reversal activity lands on ANY transfer in this payout's group while
   *  it is parked in `duplicate_review`. `resolveDuplicateReview` fences
   *  its commit on the value it observed, so a resolution validated
   *  against a pre-reversal listing loses its CAS and must re-look. */
  duplicateReviewNonce?: string;
  /** Transfer ids whose reversal activity (full or partial) the webhook
   *  recorded while the payout was parked. Operator information only —
   *  validation always re-reads Stripe rather than trusting this list. */
  reversedTransferIds?: string[];
  lastError?: string;
}

export interface PayoutTransferDeps {
  stripe?: Stripe;
  now?: () => Date;
}

export interface PayoutTransferResult {
  processed: number;
  confirmed: Array<{ payoutId: string; stripeTransferId: string }>;
  failed: Array<{ payoutId: string; error: string }>;
  /** Outcome unknown — left posted for the next tick (replay or reconcile). */
  ambiguous: string[];
  /** Ambiguous past the idempotency window; resolved by listing. */
  reconciled: string[];
  /** Abandoned before any Stripe call (set changed / partner unready). */
  canceled: Array<{ payoutId: string; reason: string }>;
  /** Left untouched this pass (cooldown, or another worker holds it). */
  skipped: number;
}

const OPEN_STATES: PayoutTransferState[] = ['intent', 'posted', 'reconcile_required'];

/** Generation 0 keeps the original key so anything already posted under
 *  it still replays. */
export function idempotencyKeyFor(payoutId: string, generation = 0): string {
  return generation > 0 ? `payout_${payoutId}_g${generation}` : `payout_${payoutId}`;
}

/** Decode a stored generation defensively. `Payout.metadata` is
 *  unconstrained jsonb, and a non-integer there must never reach the
 *  idempotency key or a fence — anything unusable is "unknown", which
 *  callers turn into a reconcile rather than a POST. */
export function readGeneration(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Test seam: finalize a transfer as if produced under `generation`, to
 *  stage "a worker holding a result from a superseded epoch". */
export async function __testFinalizeStale(
  db: Knex,
  stripe: Stripe,
  payoutId: string,
  transfer: Stripe.Transfer,
  generation: number,
): Promise<void> {
  const payout = (await db<PayoutRow>(TABLES.Payout).where({ id: payoutId }).first()) as PayoutRow;
  const sink: PayoutTransferResult = {
    processed: 0, confirmed: [], failed: [], ambiguous: [], reconciled: [], canceled: [], skipped: 0,
  };
  await finalizeTransfer(db, stripe, payout, transfer, generation, sink);
}

/** Test seam. The CAS is where the ABA guard lives, and calling it
 *  directly is the only way to stage "a stale worker acts on a row that
 *  has since been re-armed and re-posted". */
export function __testCasTransferState(
  db: Knex,
  payoutId: string,
  from: PayoutTransferState | PayoutTransferState[],
  to: PayoutTransferState,
  expect: { postedAt?: string } = {},
): Promise<PayoutRow | null> {
  return casTransferState(db, payoutId, from, to, {}, {}, expect);
}

/**
 * Advance every open Connect payout intent.
 *
 * @param db     privileged (non-transaction) knex — Stripe calls happen
 *               between short transactions, so this must NOT be a trx
 * @param opts   `tenantId` scopes the pass; `stripe`/`now` are test seams
 */
export async function executePayoutTransfers(
  db: Knex,
  opts: PayoutTransferDeps & { tenantId?: string } = {},
): Promise<PayoutTransferResult> {
  const result: PayoutTransferResult = {
    processed: 0,
    confirmed: [],
    failed: [],
    ambiguous: [],
    reconciled: [],
    canceled: [],
    skipped: 0,
  };

  const intents = (await db<PayoutRow>(TABLES.Payout)
    .whereRaw(`("metadata"->>'transferState') = any(?::text[])`, [`{${OPEN_STATES.join(',')}}`])
    .modify((qb) => {
      if (opts.tenantId) qb.where({ tenantId: opts.tenantId });
    })
    // Least-recently-attempted first. Ordering by createdAt let 500 stuck
    // old intents monopolize every pass — including other tenants' — since
    // the scan is global and capped. Every attempt bumps leaseAt, so a
    // stuck intent naturally falls to the back of the queue.
    // All three keys rendered in the SAME ISO shape before comparing.
    // `"createdAt"::text` renders as `2026-08-09 20:04:15.501+00` — space,
    // no `T`, offset suffix — and a space sorts before `T`, so every
    // never-attempted row jumped ahead of every attempted row sharing a
    // date regardless of the actual times. With a 500-row cap that is
    // queue starvation, not just cosmetics. to_char also pins UTC, which
    // the session timezone otherwise wouldn't.
    .orderByRaw(
      `coalesce(
         "metadata"->>'leaseAt',
         "metadata"->>'postedAt',
         to_char("createdAt" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ) asc`,
    )
    .limit(500)) as PayoutRow[];

  if (intents.length === 0) return result;

  const stripe = opts.stripe ?? requireStripe();
  const now = opts.now ?? (() => new Date());

  for (const payout of intents) {
    result.processed += 1;
    try {
      await advanceIntent(db, stripe, payout, now(), result);
    } catch (err) {
      // An intent that throws is left exactly as it was — the next tick
      // re-reads it. Never swallow it into a "failed" payout: we may not
      // know whether Stripe saw the request.
      console.error(`[payouts] executor error on intent ${payout.id}`, err);
    }
  }
  return result;
}

async function advanceIntent(
  db: Knex,
  stripe: Stripe,
  payout: PayoutRow,
  now: Date,
  result: PayoutTransferResult,
): Promise<void> {
  let meta = payout.metadata as unknown as PayoutTransferMeta;
  const generation = readGeneration(meta.keyGeneration);
  if (generation === null) {
    // Unusable epoch: never guess one, and never POST with it.
    console.error(
      `[payouts] ALERT: intent ${payout.id} has an unreadable keyGeneration (${String(meta.keyGeneration)}) — refusing to act; operator repair required`,
    );
    result.failed.push({ payoutId: payout.id, error: 'unreadable_key_generation' });
    return;
  }

  if (meta.transferState === 'reconcile_required') {
    await reconcileIntent(db, stripe, payout, result);
    return;
  }

  if (meta.transferState === 'posted') {
    // TWO clocks, deliberately. `postedAt` is when the key was FIRST used
    // and never moves — it's what Stripe's ~24h retention is measured
    // against. `leaseAt` is the last attempt and moves on every retry.
    // Measuring the window from a value the retry bumps would refresh it
    // forever: the intent would never reconcile, and once Stripe pruned
    // the key a re-POST would create a SECOND transfer.
    const postedAt = new Date(meta.postedAt ?? payout.createdAt).getTime();
    const leaseAt = new Date(meta.leaseAt ?? meta.postedAt ?? payout.createdAt).getTime();

    // COOLDOWN FIRST, deliberately. A warm lease means another worker is
    // very likely inside transfers.create right now, and stealing the
    // intent from under it — which the reconcile transition below would
    // do, since it only checks transferState — lets that worker resume
    // and POST after we have already finalized from a listing. Leave a
    // warm intent alone whatever its age; the next tick picks it up.
    if (!Number.isNaN(leaseAt) && now.getTime() - leaseAt < POST_COOLDOWN_MS) {
      result.skipped += 1;
      return;
    }
    // The margin is what makes the check safe to act on: a worker that
    // leases just inside the boundary still has to make its Stripe call,
    // and Stripe may prune the key any time after 24h. Treating the key
    // as spent an hour early means every POST we authorize lands with
    // room to spare, instead of racing the expiry we just measured.
    // An unparseable timestamp yields NaN, and EVERY comparison against
    // NaN is false — so a malformed `postedAt` sailed past both safety
    // checks and reached the re-POST path, which is the one place we must
    // never go on a guess. Unknown age is treated as expired: reconcile
    // by listing, which is always safe.
    if (Number.isNaN(postedAt) || now.getTime() - postedAt >= IDEMPOTENCY_WINDOW_MS - KEY_SAFETY_MARGIN_MS) {
      // The key may have been pruned, so a re-POST could create a SECOND
      // transfer. Find out what really happened instead.
      //
      // Scoped to the postedAt we READ, not just to the state. Without
      // that this is an ABA: a worker holding a stale scan snapshot can
      // arrive after the intent has been reconciled, re-armed and posted
      // afresh by someone else, see `posted` again, and steal that new
      // generation out from under a live transfers.create.
      const moved = await casTransferState(db, payout.id, 'posted', 'reconcile_required', {}, {}, {
        postedAt: meta.postedAt,
      });
      if (!moved) return;
      result.reconciled.push(payout.id);
      await reconcileIntent(db, stripe, moved, result);
      return;
    }
    // Inside the window: re-POSTing the frozen key is safe — Stripe
    // replays the original outcome rather than creating a second transfer.
    // Take the retry as a LEASE first, though. The swap is on the exact
    // leaseAt we read, so of two workers scanning together only one wins;
    // the loser sees a fresh timestamp and backs off on the cooldown
    // instead of POSTing the same key concurrently (which Stripe answers
    // with a 409 that tells us nothing about the first request's outcome).
    const leased = await leaseRetry(db, payout.id, meta.leaseAt, now, (meta.attempts ?? 0) + 1);
    if (!leased) {
      result.skipped += 1;
      return;
    }
    // Adopt the row we actually wrote. Keeping the pre-CAS snapshot is how
    // a worker ends up POSTing generation N's key while the database says
    // N+1 — the epoch, the Stripe stamp and every later fence all derive
    // from this object.
    payout = leased;
    meta = payout.metadata as unknown as PayoutTransferMeta;
  }

  if (meta.transferState === 'intent') {
    // Nothing has reached Stripe yet, so this is the one moment where
    // abandoning the intent is free. Re-verify what the planner froze.
    const blocker = await preflight(db, payout, meta);
    if (blocker) {
      await cancelIntent(db, payout, blocker, result);
      return;
    }
    // Fenced on the epoch we observed: a worker resuming from a stale
    // scan could otherwise win this CAS against a row that has since been
    // reconciled and re-armed, then post under the OLD generation.
    const moved = await casTransferState(
      db,
      payout.id,
      'intent',
      'posted',
      { postedAt: now.toISOString(), leaseAt: now.toISOString(), attempts: (meta.attempts ?? 0) + 1 },
      {},
      { keyGeneration: generation },
    );
    if (!moved) return; // another worker claimed it, or our epoch is stale
    payout = moved;
    meta = payout.metadata as unknown as PayoutTransferMeta;
  }

  await postTransfer(db, stripe, payout, meta, result);
}

/**
 * Re-check the frozen intent against live state before the first POST.
 * Returns a reason string when the intent must be abandoned, else null.
 */
async function preflight(
  db: Knex,
  payout: PayoutRow,
  meta: PayoutTransferMeta,
): Promise<string | null> {
  const claimed = (await db<CommissionRow>(TABLES.Commission).where({
    payoutId: payout.id,
  })) as CommissionRow[];
  if (claimed.length === 0) return 'commission_set_empty';
  // A refund/dispute/manual reversal between planning and execution
  // changes what we owe. The frozen amount is now wrong, so drop the
  // intent and let the next planning run regroup what's still approved.
  if (claimed.some((c) => c.status !== 'approved')) return 'commission_set_changed';
  const total = claimed.reduce((s, c) => s + Math.round(Number(c.amount) * 100), 0);
  if (total !== Number(meta.amountMinor)) return 'commission_amount_changed';

  const partner = (await db<PartnerRow>(TABLES.Partner)
    .where({ id: payout.partnerId })
    .first()) as PartnerRow | undefined;
  const stripeMeta = (partner?.metadata ?? {}) as { stripe?: { payoutsEnabled?: boolean } };
  if (
    !partner ||
    partner.stripeConnectAccountId !== meta.destinationAccountId ||
    stripeMeta.stripe?.payoutsEnabled !== true
  ) {
    return 'stripe_onboarding_incomplete';
  }
  return null;
}

async function postTransfer(
  db: Knex,
  stripe: Stripe,
  payout: PayoutRow,
  meta: PayoutTransferMeta,
  result: PayoutTransferResult,
): Promise<void> {
  // The epoch this attempt belongs to, taken from the row we hold AFTER
  // its CAS. Everything written post-Stripe is fenced on it: a result
  // from a superseded generation must never be recorded as current.
  const generation = readGeneration(meta.keyGeneration) ?? 0;
  let transfer: Stripe.Transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount: Number(meta.amountMinor),
        currency: payout.currency.toLowerCase(),
        destination: meta.destinationAccountId,
        // transfer_group is what makes the ambiguous case recoverable:
        // it's the only way to find "did my transfer land?" without a
        // usable idempotency key. Stamped with the payout id, which is
        // unique per intent.
        transfer_group: payout.id,
        metadata: {
          openpartner_payout_id: payout.id,
          openpartner_tenant_id: payout.tenantId,
          // Which key generation produced this transfer. transfer_group
          // stays the payout id so ONE listing finds every generation —
          // that is what makes duplicates detectable rather than
          // invisible. Absent on transfers created before generations.
          openpartner_key_generation: String(generation),
          mode: meta.mode ?? '',
        },
      },
      {
        idempotencyKey: idempotencyKeyFor(payout.id, generation),
        timeout: TRANSFER_TIMEOUT_MS,
        maxNetworkRetries: TRANSFER_MAX_RETRIES,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDefiniteStripeError(err)) {
      // Stripe answered with semantics that prove no transfer exists —
      // either the first POST was rejected outright, or this is a replay
      // of that same rejection. Concurrency (409) and throttling (429)
      // are excluded; see isDefiniteStripeError.
      await failIntent(db, payout, message, generation, result);
      return;
    }
    // Ambiguous: the transfer may exist. Stay 'posted' — the next tick
    // replays the frozen key inside the window, or reconciles past it.
    await db(TABLES.Payout)
      .where({ id: payout.id })
      .whereRaw(`coalesce("metadata"->>'keyGeneration', '0') = ?`, [String(generation)])
      .update({
        metadata: mergeMeta(db, { lastError: message.slice(0, 500) }),
      });
    console.error(`[payouts] transfer post ambiguous, intent ${payout.id} held: ${message}`);
    result.ambiguous.push(payout.id);
    return;
  }

  await finalizeTransfer(db, stripe, payout, transfer, generation, result);
}

/**
 * The only place a direct-Connect payout becomes real: intent →
 * confirmed, Payout paid, commissions paid — one short transaction,
 * webhooks strictly after the commit.
 */
async function finalizeTransfer(
  db: Knex,
  stripe: Stripe,
  payout: PayoutRow,
  transfer: Stripe.Transfer,
  /** The generation this transfer was produced under. */
  generation: number,
  result: PayoutTransferResult,
): Promise<void> {
  // ALWAYS re-read the live transfer before believing it.
  //
  // Two different staleness problems, and the first fix only covered one:
  //  - A REPLAYED object is stale by construction. Stripe answers a
  //    retried idempotency key with the response it stored at creation,
  //    so `reversed` there is false even if the transfer was since
  //    clawed back.
  //  - The FIRST response goes stale too. It describes the transfer at
  //    the instant Stripe created it; a reversal landing between that
  //    response and this DB write is invisible in the body we hold. The
  //    old `attempts > 1` guard skipped the re-read on exactly the
  //    attempt where nothing else could catch it, because the reversal
  //    webhook cannot match a payout whose stripeTransferId is not
  //    stamped yet (round-6 review).
  //
  // The re-read does not close the window entirely — a reversal can still
  // land between the retrieve and the commit — so it is defence in depth,
  // not the guarantee. The guarantee is that the reversal webhook can
  // always find this payout: it matches on the transfer's immutable
  // metadata, so it works before the id is stamped. See
  // routes/stripe-webhook.ts.
  const attempts = Number((payout.metadata as { attempts?: number }).attempts ?? 1);
  {
    try {
      transfer = await stripe.transfers.retrieve(transfer.id);
    } catch (err) {
      // Couldn't confirm ⇒ don't finalize. The intent stays posted and
      // the next tick tries again; nothing is recorded on a guess.
      //
      // This is a "money moved, ledger not written" state, so it has to be
      // visible rather than just quiet: persist the reason and escalate
      // once retrying has clearly stopped helping. There is no automatic
      // way out — a transfer we cannot read is an operator's problem.
      const message = err instanceof Error ? err.message : String(err);
      // Only while WE still hold it: another worker may have finalized
      // and cleared lastError, and writing a stale failure onto a
      // confirmed payout would be a false diagnostic on a paid row.
      await db(TABLES.Payout)
        .where({ id: payout.id })
        .whereRaw(`("metadata"->>'transferState') = 'posted'`)
        .whereRaw(`coalesce("metadata"->>'keyGeneration', '0') = ?`, [String(generation)])
        .update({ metadata: mergeMeta(db, { lastError: `retrieve_failed:${message}`.slice(0, 500) }) });
      if (attempts >= RETRIEVE_ALERT_ATTEMPTS) {
        console.error(
          `[payouts] ALERT: intent ${payout.id} has failed to re-read transfer ${transfer.id} on ${attempts} attempts — the transfer exists but the ledger cannot be finalized; operator action required`,
        );
      } else {
        console.error(`[payouts] intent ${payout.id}: could not re-read transfer ${transfer.id}`, err);
      }
      result.ambiguous.push(payout.id);
      return;
    }
  }

  // The transfer exists but has been (partly) reversed — an operator
  // clawback in the Stripe dashboard, or a reversal webhook that beat us
  // here. Recording "paid" would be a lie and would mark the commissions
  // paid on money that came back. Close the intent, leave the payout
  // failed, and leave the commissions claimed for a human to dispose of.
  if (transfer.reversed || Number(transfer.amount_reversed ?? 0) > 0) {
    await casTransferState(
      db,
      payout.id,
      ['posted', 'reconcile_required'],
      'confirmed',
      { lastError: 'transfer_reversed' },
      { status: 'failed', stripeTransferId: transfer.id },
      { keyGeneration: generation },
    );
    console.error(
      `[payouts] ALERT: transfer ${transfer.id} for payout ${payout.id} is reversed — commissions held, operator disposition required`,
    );
    result.failed.push({ payoutId: payout.id, error: 'transfer_reversed' });
    return;
  }

  const written = await db.transaction(async (trx) => {
    // CAS on transferState only — NOT on Payout.status. A transfer.updated
    // webhook can legitimately have flipped status to 'paid' before we got
    // here; that must not block the ledger from being completed.
    const moved = await casTransferState(
      trx,
      payout.id,
      ['posted', 'reconcile_required'],
      'confirmed',
      { lastError: undefined },
      { status: 'paid', stripeTransferId: transfer.id, completedAt: new Date() },
      // Fenced on the epoch: a worker holding a transfer from generation
      // N must not record it against an intent that has since re-armed
      // to N+1 — that transfer belongs to a generation we already proved
      // absent, and N+1 may have produced its own.
      { keyGeneration: generation },
    );
    if (!moved) return false; // another worker finalized first, or we are stale
    await trx(TABLES.Commission)
      .where({ payoutId: payout.id, status: 'approved' })
      .update({ status: 'paid', paidAt: new Date() });
    return true;
  });
  if (!written) {
    result.skipped += 1;
    return;
  }

  const commissions = (await db<CommissionRow>(TABLES.Commission).where({
    payoutId: payout.id,
  })) as CommissionRow[];
  const platformFee = (payout.metadata as { platformFee?: number }).platformFee;
  dispatchEvent(payout.tenantId, 'payout.created', {
    payoutId: payout.id,
    partnerId: payout.partnerId,
    amount: payout.amount,
    currency: payout.currency,
    method: payout.method,
    commissionIds: commissions.map((c) => c.id),
    platformFee: platformFee || undefined,
  });
  for (const c of commissions) {
    dispatchEvent(payout.tenantId, 'commission.paid', {
      commissionId: c.id,
      partnerId: c.partnerId,
      amount: c.amount,
      currency: c.currency,
      payoutId: payout.id,
    });
  }
  result.confirmed.push({ payoutId: payout.id, stripeTransferId: transfer.id });
}

/**
 * Resolve an ambiguous intent by asking Stripe what exists, paging the
 * whole transfer_group (PR #71's lesson: the first page is not the set).
 * Found → finalize with the real transfer. Proven absent → back to
 * 'intent', which makes the next POST a genuine first attempt.
 */
async function reconcileIntent(
  db: Knex,
  stripe: Stripe,
  payout: PayoutRow,
  result: PayoutTransferResult,
): Promise<void> {
  const meta = payout.metadata as unknown as PayoutTransferMeta;
  const generation = meta.keyGeneration ?? 0;

  // Collect EVERY match across every page, not the first. Generations
  // share a transfer_group precisely so one listing sees all of them —
  // taking the first hid the case this whole mechanism can produce: a
  // late transfer from generation N materialising after N+1 already
  // succeeded. Stripe lists newest-first, so "first match" would have
  // reported the newest and left the older duplicate unrecorded.
  //
  // Membership is the transfer_group itself — set at creation, immutable,
  // and stamped with the payout ULID nothing else uses. Do NOT re-filter
  // on `metadata.openpartner_payout_id`: metadata is MUTABLE at Stripe,
  // so that filter made a transfer whose metadata was cleared in the
  // dashboard invisible to every listing-based decision (round 9). A
  // cleared-metadata transfer now reads as generation 0, which either
  // finalizes normally (row on generation 0) or parks in duplicate_review
  // (row moved on) — fail closed, never invisible.
  const matches: Stripe.Transfer[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const listed = await stripe.transfers.list({
      transfer_group: payout.id,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    matches.push(...listed.data);
    if (!listed.has_more || listed.data.length === 0) break;
    startingAfter = listed.data[listed.data.length - 1]!.id;
  }

  if (matches.length > 1) {
    // Two real transfers for one commission set. Never pick one and move
    // on — that records a payout as cleanly paid while a duplicate sits
    // unaccounted for at Stripe. Freeze loudly and leave it to a human.
    const ids = matches.map((t) => t.id).join(', ');
    await markDuplicateReview(db, payout, `duplicate_transfers:${ids}`, generation);
    console.error(
      `[payouts] ALERT: payout ${payout.id} has ${matches.length} transfers in its transfer_group (${ids}) — the partner has been paid more than once; ledger NOT written, operator reconciliation required`,
    );
    result.failed.push({ payoutId: payout.id, error: 'duplicate_transfers' });
    return;
  }

  if (matches.length === 1) {
    const found = matches[0]!;
    // Use the generation the TRANSFER carries, not the row's current one.
    // Stamping it and then ignoring it was worse than not stamping at
    // all: a generation-0 transfer discovered while the row is on
    // generation 1 would pass the generation-1 fence and be recorded as
    // the current epoch's — and if generation 1's own POST later lands,
    // that becomes an undetected duplicate.
    const stamped = readGeneration(found.metadata?.openpartner_key_generation);
    if (stamped === null) {
      console.error(
        `[payouts] ALERT: transfer ${found.id} for payout ${payout.id} has an unreadable generation stamp — not finalizing`,
      );
      result.failed.push({ payoutId: payout.id, error: 'unreadable_transfer_generation' });
      return;
    }
    if (stamped !== generation) {
      // A transfer from an epoch we already proved absent. Money moved
      // under a key we abandoned; the current epoch may also produce one.
      // This is the duplicate case in slow motion — freeze it.
      await markDuplicateReview(
        db,
        payout,
        `superseded_generation_transfer:${found.id}:g${stamped}`,
        generation,
      );
      console.error(
        `[payouts] ALERT: payout ${payout.id} found transfer ${found.id} from generation ${stamped} while on generation ${generation} — a superseded attempt DID move money; operator reconciliation required`,
      );
      result.failed.push({ payoutId: payout.id, error: 'superseded_generation_transfer' });
      return;
    }
    // AUTHENTICATE before recording it as THE payment (round 10). Group
    // membership is unauthenticated — anything on this Stripe account can
    // set transfer_group to our ULID — and the generation stamp above is
    // mutable metadata. Two immutable references pin the real payment:
    //
    //  - the intent's FROZEN amount, currency and destination; and
    //  - `transfer.created` (Stripe-stamped, immutable) against
    //    `postedAt`, which is stamped BEFORE this generation's first
    //    POST — a genuine current-generation transfer cannot predate it
    //    (5 min grace for clock skew). A forged generation stamp on an
    //    OLDER transfer fails this even when everything else matches.
    //
    // A member that fails either is never finalized — it parks the payout
    // for a human, exactly like a duplicate.
    const expectedAmount = frozenAmountMinor(meta, payout);
    const foundDestination =
      typeof found.destination === 'string' ? found.destination : found.destination?.id;
    const authentic =
      expectedAmount !== null &&
      Number(found.amount) === expectedAmount &&
      found.currency === payout.currency.toLowerCase() &&
      !!meta.destinationAccountId &&
      foundDestination === meta.destinationAccountId;
    const postedAtMs = meta.postedAt ? new Date(meta.postedAt).getTime() : NaN;
    const backdated =
      typeof found.created === 'number' &&
      !Number.isNaN(postedAtMs) &&
      found.created * 1000 < postedAtMs - 5 * 60 * 1000;
    if (!authentic || backdated) {
      await markDuplicateReview(
        db,
        payout,
        `unauthenticated_group_transfer:${found.id}`,
        generation,
      );
      console.error(
        `[payouts] ALERT: payout ${payout.id} found transfer ${found.id} in its group that does not match the frozen intent (authentic=${authentic}, backdated=${backdated}) — NOT finalized; operator review required`,
      );
      result.failed.push({ payoutId: payout.id, error: 'unauthenticated_group_transfer' });
      return;
    }
    await finalizeTransfer(db, stripe, payout, found, stamped, result);
    return;
  }

  // NOTHING FOUND. This used to bump the key generation and re-arm the
  // intent, on the reasoning that "listing just proved no transfer
  // exists". It proves no such thing (round-6 review).
  //
  // `transfers.list` is read-after-write consistent, so the listing is
  // accurate — but only about requests Stripe has already FINISHED. It
  // cannot see a POST that is still in flight, and we have no way to
  // bound how long one can be: stripe-node's `timeout` is a socket
  // INACTIVITY timeout that resets after each stage of the request (see
  // its own note in net/FetchHttpClient.js), so a slow-but-progressing
  // request has no wall-clock limit. No cooldown arithmetic fixes that;
  // a local timer cannot bound a remote side effect, and aborting the
  // await does not retract a request Stripe already received.
  //
  // So an empty listing means UNKNOWN, never ABSENT. Re-arming on it is
  // exactly the double-pay: the old POST lands under the old key while
  // the new generation posts under a fresh one.
  //
  // We therefore hold. The intent stays `reconcile_required` on the SAME
  // generation with its commissions still frozen, and later ticks keep
  // listing — if the slow POST does land, `finalizeTransfer` accepts a
  // `reconcile_required` intent and records it normally. Only an
  // operator may authorise a fresh-key attempt (see
  // `releaseIntentForRetry` and docs/direct-connect-payouts.md).
  //
  // The cost is liveness, not money: a transfer whose POST genuinely
  // never reached Stripe sits until a human says so. That case is rare
  // (ambiguous POST *and* past the retention window *and* nothing in the
  // group), and it fails loudly rather than paying twice.
  //
  // `leaseAt` still moves, under the generation fence, so repeated
  // checks rotate fairly through the scan cap instead of one stuck row
  // monopolising it.
  await db(TABLES.Payout)
    .where({ id: payout.id })
    .whereRaw(`("metadata"->>'transferState') = 'reconcile_required'`)
    .whereRaw(`coalesce("metadata"->>'keyGeneration', '0') = ?`, [String(generation)])
    .update({
      metadata: mergeMeta(db, {
        leaseAt: new Date().toISOString(),
        lastError: 'awaiting_operator:no_transfer_found_past_window',
      }),
    });
  console.error(
    `[payouts] ALERT: intent ${payout.id} found no transfer in its group past the idempotency window — HELD on generation ${generation} awaiting operator disposition; commissions stay frozen. An empty listing does not prove the POST never landed.`,
  );
  result.failed.push({ payoutId: payout.id, error: 'awaiting_operator_disposition' });
}

/**
 * Park an intent for human review, in a state the executor does NOT scan.
 *
 * Leaving it `reconcile_required` meant re-listing at Stripe and
 * re-alerting on every 15-minute pass forever — and a human reversing the
 * duplicate doesn't make it stop, because reversed transfers still appear
 * in the listing. 500 such rows would also consume the whole scan cap and
 * starve every other tenant. Disposition is manual either way; this makes
 * "a human owns it now" a state rather than a hope.
 */
async function markDuplicateReview(
  db: Knex,
  payout: PayoutRow,
  reason: string,
  generation: number,
): Promise<void> {
  // Fenced on the generation the CALLER observed (round-6 review). This
  // CASed on state alone, which let a reconciler resuming from a stale
  // snapshot quarantine a live, newer generation: it would list, see that
  // generation's legitimate transfer, judge it "superseded" relative to
  // its own stale view, and park a payout whose single transfer had
  // genuinely moved money — leaving the commissions frozen forever while
  // the real finalizer lost its CAS.
  await casTransferState(
    db,
    payout.id,
    ['posted', 'reconcile_required'],
    'duplicate_review',
    { lastError: reason.slice(0, 500) },
    { status: 'failed' },
    { keyGeneration: generation },
  );
}

/** Test seam for the fence above: stage "a stale reconciler tries to
 *  quarantine a row that has since moved on". */
export async function __testMarkDuplicateReview(
  db: Knex,
  payoutId: string,
  reason: string,
  observedGeneration: number,
): Promise<void> {
  const payout = (await db<PayoutRow>(TABLES.Payout).where({ id: payoutId }).first()) as PayoutRow;
  await markDuplicateReview(db, payout, reason, observedGeneration);
}

/** Definite failure: release the frozen commissions so the next planning
 *  run can regroup them, and record why on the Payout. */
async function failIntent(
  db: Knex,
  payout: PayoutRow,
  message: string,
  generation: number,
  result: PayoutTransferResult,
): Promise<void> {
  await db.transaction(async (trx) => {
    const moved = await casTransferState(
      trx,
      payout.id,
      ['posted', 'intent'],
      'canceled',
      { lastError: message.slice(0, 500) },
      { status: 'failed' },
      { keyGeneration: generation },
    );
    if (!moved) return;
    await releaseClaims(trx, payout.id);
  });
  console.error(`[payouts] transfer failed definitively, intent ${payout.id}: ${message}`);
  result.failed.push({ payoutId: payout.id, error: message });
}

/** Abandon an intent that never reached Stripe. */
async function cancelIntent(
  db: Knex,
  payout: PayoutRow,
  reason: string,
  result: PayoutTransferResult,
): Promise<void> {
  await db.transaction(async (trx) => {
    const moved = await casTransferState(trx, payout.id, 'intent', 'canceled', { lastError: reason }, {
      status: 'failed',
    });
    if (!moved) return;
    await releaseClaims(trx, payout.id);
  });
  console.error(`[payouts] intent ${payout.id} abandoned before any Stripe call: ${reason}`);
  result.canceled.push({ payoutId: payout.id, reason });
}

/**
 * OPERATOR ACTION — authorise a fresh attempt on a held intent.
 *
 * The executor never re-arms by itself: an empty `transfers.list` cannot
 * prove an in-flight POST will never land, so an intent that reconciles to
 * "nothing found" is HELD rather than retried (see reconcileIntent). This
 * is the only way out, and it exists because a hold with no release is
 * just a leak.
 *
 * The operator is asserting the thing we cannot: that no transfer for this
 * payout exists or ever will. The runbook tells them to confirm with
 * `stripe transfers list --transfer-group <payoutId>` first. We bump the
 * generation so the next POST uses a genuinely fresh key, because Stripe's
 * retention is anchored to when `payout_<id>` was FIRST used — reusing it
 * would replay the stored outcome forever.
 *
 * Fenced on the generation the caller observed, so two operators (or an
 * operator and a concurrent reconcile) cannot both hand out an epoch.
 */
export async function releaseIntentForRetry(
  db: Knex,
  payoutId: string,
  observedGeneration: number,
  operator: string,
  /** REQUIRED. Was optional in round 7, and the documented operator call in
   *  docs/direct-connect-payouts.md omitted it — so the guard below did not
   *  run in the one usage operators would actually copy (round 8). An
   *  optional security parameter is a security parameter someone forgets. */
  stripe: Stripe,
): Promise<'rearmed' | 'not_held' | 'generation_moved' | 'transfer_exists' | 'cannot_verify'> {
  const row = (await db(TABLES.Payout).where({ id: payoutId }).first()) as PayoutRow | undefined;
  if (!row) return 'not_held';
  const meta = row.metadata as unknown as PayoutTransferMeta;
  if (meta.transferState !== 'reconcile_required') return 'not_held';
  if ((meta.keyGeneration ?? 0) !== observedGeneration) return 'generation_moved';

  // Look before re-arming (round 7).
  //
  // The generation fence alone does not protect this. `reconcileIntent`
  // does not claim the row before it lists, so a scheduler tick can be
  // holding a transfer it just found — still on generation N, because it
  // has not written anything yet — while the operator re-arms N→N+1 from
  // the same observed generation. The reconciler then loses its finalize
  // CAS, and generation N+1 posts a SECOND transfer for a set the first
  // one already paid.
  //
  // We cannot prove absence (that is the whole premise of the hold), but we
  // can refuse on positive evidence. A listing that finds anything means
  // the operator's assertion is already false: let the executor finalize it
  // instead. This is cheap and it closes the race, because the transfer the
  // reconciler found is by definition visible to a listing.
  //
  // ANY transfer in the group refuses — not just ones whose metadata still
  // carries our stamp. Metadata is mutable at Stripe, so filtering on it
  // let a live transfer with cleared metadata pass this guard invisibly,
  // and the fresh generation then posted a second transfer for a set the
  // invisible one had already paid (round 9). The transfer_group is
  // immutable and uniquely ours; membership in it IS the evidence — which
  // also collapses the old 20-page walk: the first non-empty page settles
  // the question, so only the degenerate empty-but-has_more answer is left
  // to fail closed on.
  let listed: Stripe.ApiList<Stripe.Transfer>;
  try {
    listed = await stripe.transfers.list({ transfer_group: payoutId, limit: 100 });
  } catch (err) {
    // Could not ask ⇒ do not authorise. Same rule as everywhere else.
    console.error(`[payouts] OPERATOR ${operator} re-arm of ${payoutId} refused — listing failed`, err);
    return 'cannot_verify';
  }
  if (listed.data.length > 0) {
    console.error(
      `[payouts] OPERATOR ${operator} tried to re-arm ${payoutId} but ${listed.data.length} transfer(s) exist in its group (${listed.data
        .map((t) => t.id)
        .join(', ')}) — refusing; the executor will finalize it`,
    );
    return 'transfer_exists';
  }
  if (listed.has_more) {
    // An empty page that claims more pages should not happen for an
    // indexed transfer_group query; whatever produced it, it is not proof
    // of absence.
    console.error(
      `[payouts] OPERATOR ${operator} re-arm of ${payoutId} refused — listing returned no rows but has_more, absence unproven`,
    );
    return 'cannot_verify';
  }

  const rearmed = await casTransferState(
    db,
    payoutId,
    'reconcile_required',
    'intent',
    {
      postedAt: undefined,
      leaseAt: undefined,
      keyGeneration: observedGeneration + 1,
      lastError: `operator_rearm:${operator}`.slice(0, 500),
    },
    { status: 'pending' },
    { keyGeneration: observedGeneration },
  );
  if (!rearmed) return 'generation_moved';
  console.error(
    `[payouts] OPERATOR ${operator} re-armed intent ${payoutId} at generation ${observedGeneration + 1} — asserting no transfer exists for it`,
  );
  return 'rearmed';
}

/**
 * Page a payout's whole transfer_group. Membership is the group itself —
 * set at creation, immutable, stamped with the payout ULID — never the
 * mutable metadata (round 9). Returns 'cannot_verify' when Stripe cannot
 * be read or the group is larger than the page budget: running out of
 * pages is not the same as finding nothing.
 */
async function listTransferGroup(
  stripe: Stripe,
  payoutId: string,
  logContext: string,
): Promise<Stripe.Transfer[] | 'cannot_verify'> {
  const group: Stripe.Transfer[] = [];
  try {
    let startingAfter: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const listed = await stripe.transfers.list({
        transfer_group: payoutId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      group.push(...listed.data);
      if (!listed.has_more) break;
      if (listed.data.length === 0) {
        // An empty page that claims more pages is not a complete group —
        // treating it as one turned a partial listing into "verified
        // empty" (round 10). Whatever produced it, refuse.
        console.error(`[payouts] ${logContext} refused — empty page with has_more, group incomplete`);
        return 'cannot_verify';
      }
      if (page === 19) {
        console.error(`[payouts] ${logContext} refused — more transfers than this listing will page`);
        return 'cannot_verify';
      }
      startingAfter = listed.data[listed.data.length - 1]!.id;
    }
  } catch (err) {
    console.error(`[payouts] ${logContext} refused — listing failed`, err);
    return 'cannot_verify';
  }
  return group;
}

/**
 * The amount this intent froze at plan time, in minor units — or null when
 * nothing trustworthy exists. `metadata` is unconstrained jsonb, and
 * Number() coercion accepted booleans: `amountMinor: true` became 1, and a
 * one-cent transfer then validated against a $50 payout (round 10). Only
 * an actual finite number counts; the payout row's own amount is the
 * fallback for pre-metadata rows.
 */
function frozenAmountMinor(meta: PayoutTransferMeta, row: PayoutRow): number | null {
  if (typeof meta.amountMinor === 'number' && Number.isFinite(meta.amountMinor)) {
    return meta.amountMinor;
  }
  const fromRow = Math.round(Number(row.amount) * 100);
  return Number.isFinite(fromRow) ? fromRow : null;
}

/**
 * OPERATOR ACTION — give up on an intent and return its commissions.
 *
 * For a held intent the operator has confirmed produced no transfer, or a
 * `duplicate_review` payout whose surplus transfers they have reversed by
 * hand. Releasing the claims makes the commissions payable again, so this
 * must never be automatic: doing it while a transfer is alive is precisely
 * the double-pay the whole design prevents.
 */
export async function disposeIntent(
  db: Knex,
  payoutId: string,
  operator: string,
  reason: string,
  /** REQUIRED — this function verifies its own premise against Stripe.
   *  Optional-with-a-runtime-refusal was how the round-8 guard ended up
   *  absent from the one call operators would copy (round 9). */
  stripe: Stripe,
): Promise<'disposed' | 'not_disposable' | 'money_with_partner' | 'cannot_verify'> {
  // VERIFY THE PREMISE, don't take the operator's word for it (round 8).
  //
  // Round 6 removed "an empty search proves absence" from the automatic
  // paths. Round 7 then built operator paths that trust an unverified human
  // assertion — which is strictly weaker than what we just removed. This is
  // that rule applied here: releasing commissions claims the partner does
  // not have the money, so check.
  //
  // The specific hole: `finalizeTransfer` records confirmed+failed for ANY
  // non-zero `amount_reversed`, including a PARTIAL reversal. A $10 clawback
  // on a $50 transfer leaves $40 with the partner, and releasing those
  // commissions let the planner pay the full $50 again — $90 out for $50
  // owed. `status !== 'paid'` was never sufficient: `failed` can still mean
  // money with the partner.
  const row = (await db(TABLES.Payout).where({ id: payoutId }).first()) as PayoutRow | undefined;
  if (!row) return 'not_disposable';
  if (!stripe) return 'cannot_verify';
  if (row.stripeTransferId) {
    let transfer: Stripe.Transfer | null = null;
    try {
      transfer = await stripe.transfers.retrieve(row.stripeTransferId);
    } catch (err) {
      if ((err as { code?: string }).code === 'resource_missing') {
        // The stamp names a transfer Stripe says does not exist — garbage
        // from a hand repair or a pre-round-8 typo resolution. Refusing
        // forever on it wedged the payout with no exit but raw SQL
        // (round 9). A stamp that cannot be dereferenced proves nothing
        // either way; the group verification below decides.
        console.error(
          `[payouts] OPERATOR ${operator} dispose of ${payoutId}: stamped transfer ${row.stripeTransferId} does not exist at Stripe — verifying by transfer group instead`,
        );
      } else {
        console.error(
          `[payouts] OPERATOR ${operator} dispose of ${payoutId} refused — cannot read transfer ${row.stripeTransferId}`,
          err,
        );
        return 'cannot_verify';
      }
    }
    if (transfer) {
      const reversedMinor = Number(transfer.amount_reversed ?? 0);
      if (reversedMinor < Number(transfer.amount ?? 0)) {
        console.error(
          `[payouts] OPERATOR ${operator} dispose of ${payoutId} REFUSED — transfer ${transfer.id} is only reversed ${reversedMinor}/${transfer.amount}; the partner still holds the remainder, so releasing these commissions would pay it twice`,
        );
        return 'money_with_partner';
      }
    }
  }
  // ALWAYS verify the whole group — never only the stamped transfer
  // (round 10). A fully-reversed stamped transfer says nothing about its
  // SIBLINGS: a late duplicate can hold the entire payment while the
  // confirmed/failed state makes this payout look disposable. Any member
  // still holding money refuses the release.
  //
  // An EMPTY listing is still not proof of absence — that is the whole
  // reason held intents exist. Proceeding on empty is the operator's
  // documented risk decision, taken with every verifiable check passed;
  // what this guard closes is releasing against POSITIVE evidence. The
  // `transfer.created` detector in routes/stripe-webhook.ts is the alarm
  // for the residual case where an unbounded in-flight POST lands after
  // this decision.
  {
    const group = await listTransferGroup(
      stripe,
      payoutId,
      `OPERATOR ${operator} dispose of ${payoutId}`,
    );
    if (group === 'cannot_verify') return 'cannot_verify';
    const live = group.filter((t) => Number(t.amount_reversed ?? 0) < Number(t.amount ?? 0));
    if (live.length > 0) {
      console.error(
        `[payouts] OPERATOR ${operator} dispose of ${payoutId} REFUSED — ${live.length} transfer(s) in its group still hold money (${live
          .map((t) => t.id)
          .join(', ')}); releasing these commissions would pay them twice`,
      );
      return 'money_with_partner';
    }
  }

  let ok = false;
  await db.transaction(async (trx) => {
    const moved = await casTransferState(
      trx,
      payoutId,
      // ONLY states where no transfer moved money that these commissions
      // still owe. `duplicate_review` used to be in this list and that was
      // a double-pay (round 7): a duplicate is disposed of by REVERSING the
      // surplus and KEEPING one transfer, so the commissions have been paid
      // — releasing them let the planner pay them a second time. Use
      // `resolveDuplicateReview` for that state instead.
      //
      // `confirmed` is included, but only via the status guard below: a
      // reversed transfer leaves confirmed+failed with the money returned,
      // so the commissions genuinely are unpaid and releasing them is the
      // correct disposition. A confirmed+PAID payout must never be released.
      ['reconcile_required', 'confirmed'],
      'canceled',
      { lastError: `operator_dispose:${operator}:${reason}`.slice(0, 500) },
      { status: 'failed' },
      undefined,
      // Guard: never dispose a payout whose money reached the partner.
      { notStatus: 'paid' },
    );
    if (!moved) return;
    await releaseClaims(trx, payoutId);
    ok = true;
  });
  if (ok) {
    console.error(
      `[payouts] OPERATOR ${operator} disposed intent ${payoutId} (${reason}) — commissions returned to the payable pool`,
    );
  }
  return ok ? 'disposed' : 'not_disposable';
}

/**
 * OPERATOR ACTION — resolve a `duplicate_review` payout.
 *
 * The executor parks here when it finds more than one transfer in a payout's
 * group, or one from a superseded generation: the partner has been paid more
 * than once and no automatic rule can be right. The operator reverses the
 * surplus in Stripe, then tells us which of two things is now true.
 *
 * This exists because `disposeIntent` used to accept this state and simply
 * release the claims, which was a double-pay whenever a transfer was kept
 * (round 7): the kept transfer had already paid those commissions, and
 * releasing them let the next planning run pay them again.
 *
 *   { keptTransferId }  the partner keeps this transfer — the commissions
 *                       ARE paid, so record the ledger against it and do
 *                       NOT return them to the pool.
 *   { allReversed }     every transfer was reversed — the money came back,
 *                       so the commissions are unpaid and go back.
 */
export async function resolveDuplicateReview(
  db: Knex,
  payoutId: string,
  operator: string,
  disposition: { keptTransferId: string } | { allReversed: true },
  /** REQUIRED. Both dispositions are checked against Stripe — see below. */
  stripe: Stripe,
): Promise<
  | 'resolved'
  | 'not_in_duplicate_review'
  | 'review_moved'
  | 'cannot_verify'
  | 'kept_transfer_invalid'
  | 'transfers_still_live'
> {
  // VERIFY BOTH DISPOSITIONS (round 8). As written, this function took the
  // operator's assertion at face value and moved money state on it — the
  // same "trust an unverifiable claim" the automatic paths had just been
  // purged of, and worse, because a human typo is silent.
  //
  //   { allReversed } while transfers are still live → releases the
  //     commissions → the planner pays them again.
  //   { keptTransferId: <typo> } → records the payout paid against a
  //     transfer that does not exist, and then NO operator function accepts
  //     the resulting state: a wedge only raw SQL can clear.
  if (!stripe) return 'cannot_verify';

  // Read the row FIRST and remember the review nonce we saw. The listing
  // below is a snapshot, and a reversal can land after it — the webhook
  // records that by moving `duplicateReviewNonce` (routes/stripe-webhook.ts),
  // and both commits below are fenced on the value observed HERE. Listing
  // first and fencing on nothing was round 9's list→write gap: a reversal
  // arriving mid-resolution was dropped as unmatched while the stale
  // validation recorded the reversed transfer as kept, paid.
  const row = (await db(TABLES.Payout).where({ id: payoutId }).first()) as PayoutRow | undefined;
  if (!row) return 'not_in_duplicate_review';
  const meta = row.metadata as unknown as PayoutTransferMeta;
  if (meta.transferState !== 'duplicate_review') return 'not_in_duplicate_review';
  const observedNonce =
    typeof meta.duplicateReviewNonce === 'string' ? meta.duplicateReviewNonce : null;

  // Membership by immutable transfer_group, never by mutable metadata —
  // same round-9 rule as the other listings: a cleared-metadata transfer
  // must count against every disposition, not vanish from it.
  const group = await listTransferGroup(
    stripe,
    payoutId,
    `OPERATOR ${operator} resolve of ${payoutId}`,
  );
  if (group === 'cannot_verify') return 'cannot_verify';

  if ('keptTransferId' in disposition) {
    // The kept transfer must exist, still hold the money, and BE the
    // payment this ledger is about to record.
    const kept = group.find((t) => t.id === disposition.keptTransferId);
    if (!kept) {
      console.error(
        `[payouts] OPERATOR ${operator} named kept transfer ${disposition.keptTransferId} for ${payoutId}, but no such transfer is in its group — refusing`,
      );
      return 'kept_transfer_invalid';
    }
    if (Number(kept.amount_reversed ?? 0) > 0) {
      console.error(
        `[payouts] OPERATOR ${operator} named kept transfer ${kept.id} for ${payoutId}, but it is reversed — refusing`,
      );
      return 'kept_transfer_invalid';
    }
    // Amount, currency and destination must match the FROZEN intent —
    // "present and unreversed" alone let a one-cent transfer mark a $50
    // payout fully paid (round 9). amountMinor and destinationAccountId
    // were frozen at plan time precisely so this comparison has an
    // immutable reference; the payout row's own amount is the fallback
    // for pre-metadata rows so an unusable blob cannot wedge the review.
    const expectedAmount = frozenAmountMinor(meta, row);
    if (expectedAmount === null) {
      console.error(
        `[payouts] OPERATOR ${operator} resolve of ${payoutId} refused — no trustworthy frozen amount to validate the kept transfer against`,
      );
      return 'cannot_verify';
    }
    const expectedCurrency = row.currency.toLowerCase();
    const keptDestination =
      typeof kept.destination === 'string' ? kept.destination : kept.destination?.id;
    if (Number(kept.amount) !== expectedAmount || kept.currency !== expectedCurrency) {
      console.error(
        `[payouts] OPERATOR ${operator} named kept transfer ${kept.id} for ${payoutId}, but it is ${kept.amount} ${kept.currency} where the intent froze ${expectedAmount} ${expectedCurrency} — refusing; that transfer is not this payment`,
      );
      return 'kept_transfer_invalid';
    }
    if (!meta.destinationAccountId || keptDestination !== meta.destinationAccountId) {
      console.error(
        `[payouts] OPERATOR ${operator} named kept transfer ${kept.id} for ${payoutId}, but its destination ${String(keptDestination)} does not match the frozen ${String(meta.destinationAccountId)} — refusing`,
      );
      return 'kept_transfer_invalid';
    }
    // Every OTHER member must be FULLY reversed before the ledger settles
    // on the kept one. Resolving while a sibling still holds money records
    // this set paid and forgets the sibling — the partner keeps the
    // surplus with nothing left flagging it.
    const liveSiblings = group.filter(
      (t) => t.id !== kept.id && Number(t.amount_reversed ?? 0) < Number(t.amount ?? 0),
    );
    if (liveSiblings.length > 0) {
      console.error(
        `[payouts] OPERATOR ${operator} kept ${kept.id} for ${payoutId}, but ${liveSiblings.length} other transfer(s) still hold money (${liveSiblings
          .map((t) => t.id)
          .join(', ')}) — reverse the surplus first`,
      );
      return 'transfers_still_live';
    }
  } else {
    // Every transfer in the group must be FULLY reversed before the
    // commissions can go back in the pool.
    const live = group.filter((t) => Number(t.amount_reversed ?? 0) < Number(t.amount ?? 0));
    if (live.length > 0) {
      console.error(
        `[payouts] OPERATOR ${operator} claimed all transfers reversed for ${payoutId}, but ${live.length} still hold money (${live
          .map((t) => t.id)
          .join(', ')}) — refusing`,
      );
      return 'transfers_still_live';
    }
  }

  let ok = false;
  await db.transaction(async (trx) => {
    if ('keptTransferId' in disposition) {
      const moved = await casTransferState(
        trx,
        payoutId,
        'duplicate_review',
        'confirmed',
        { lastError: `operator_kept_transfer:${operator}` },
        {
          status: 'paid',
          stripeTransferId: disposition.keptTransferId,
          completedAt: new Date(),
        },
        // Fenced on the nonce observed before the listing: if the webhook
        // recorded reversal activity since, this loses and the operator
        // re-verifies against the world as it now is.
        { duplicateReviewNonce: observedNonce },
      );
      if (!moved) return;
      // The kept transfer paid these. Mark them paid rather than freeing
      // them — this is the whole point of the function.
      await trx(TABLES.Commission)
        .where({ payoutId, status: 'approved' })
        .update({ status: 'paid', paidAt: new Date() });
      ok = true;
      return;
    }
    const moved = await casTransferState(
      trx,
      payoutId,
      'duplicate_review',
      'canceled',
      { lastError: `operator_all_reversed:${operator}` },
      { status: 'failed' },
      { duplicateReviewNonce: observedNonce },
    );
    if (!moved) return;
    await releaseClaims(trx, payoutId);
    ok = true;
  });
  if (ok) {
    console.error(
      `[payouts] OPERATOR ${operator} resolved duplicate_review on ${payoutId}: ${
        'keptTransferId' in disposition
          ? `kept ${disposition.keptTransferId}, commissions recorded PAID`
          : 'all transfers reversed, commissions returned to the pool'
      }`,
    );
    return 'resolved';
  }
  // Distinguish "someone else resolved it" from "the webhook moved the
  // nonce under us" — the second means re-verify and try again, not stop.
  const after = (await db(TABLES.Payout).where({ id: payoutId }).first()) as PayoutRow | undefined;
  const afterState = (after?.metadata as { transferState?: string } | undefined)?.transferState;
  if (afterState === 'duplicate_review') {
    console.error(
      `[payouts] OPERATOR ${operator} resolve of ${payoutId} lost to new reversal activity recorded by the webhook — re-verify and retry`,
    );
    return 'review_moved';
  }
  return 'not_in_duplicate_review';
}

/** Un-claim commissions frozen onto a dead intent. 'paid' rows are never
 *  touched — a paid commission's payoutId is its ledger link. */
async function releaseClaims(trx: Knex.Transaction, payoutId: string): Promise<void> {
  await trx(TABLES.Commission)
    .where({ payoutId })
    .whereNot({ status: 'paid' })
    .update({ payoutId: null });
}

/** jsonb patch that preserves the rest of `metadata`. A key set to
 *  `undefined` is DELETED: JSON.stringify drops it from the merge, and the
 *  `- text[]` removes whatever was stored. */
function mergeMeta(db: Knex, patch: Record<string, unknown>): Knex.Raw {
  const drop = Object.keys(patch).filter((k) => patch[k] === undefined);
  const json = JSON.stringify(patch);
  if (drop.length === 0) {
    return db.raw(`coalesce("metadata", '{}'::jsonb) || ?::jsonb`, [json]);
  }
  return db.raw(`(coalesce("metadata", '{}'::jsonb) - ?::text[]) || ?::jsonb`, [
    `{${drop.join(',')}}`,
    json,
  ]);
}

/**
 * Claim the right to re-POST an already-`posted` intent, by swapping the
 * exact `postedAt` we read for a fresh one. Unlike a plain state CAS this
 * is genuinely exclusive: `posted → posted` matches for every worker, but
 * only one can swap a given timestamp.
 *
 * Returns the updated row on a win, null when someone else got there.
 */
async function leaseRetry(
  db: Knex,
  payoutId: string,
  expectedLeaseAt: string | undefined,
  now: Date,
  attempts: number,
): Promise<PayoutRow | null> {
  const q = db(TABLES.Payout)
    .where({ id: payoutId })
    .whereRaw(`("metadata"->>'transferState') = 'posted'`);
  // `== null` on purpose: a metadata blob repaired by hand can carry JSON
  // null, and `field = NULL` never matches, which would wedge the intent
  // out of every within-window retry.
  if (expectedLeaseAt == null) {
    q.whereRaw(`("metadata"->>'leaseAt') is null`);
  } else {
    q.whereRaw(`("metadata"->>'leaseAt') = ?`, [expectedLeaseAt]);
  }
  // postedAt is deliberately NOT touched — it anchors the idempotency
  // window and must survive every retry.
  const [row] = (await q
    .update({ metadata: mergeMeta(db, { leaseAt: now.toISOString(), attempts }) })
    .returning('*')) as PayoutRow[];
  return row ?? null;
}

/**
 * Compare-and-set on `metadata.transferState`. Returns the updated row on
 * a win, null on a loss (someone else moved it first — the caller must
 * NOT proceed as if it owned the intent).
 */
async function casTransferState(
  db: Knex,
  payoutId: string,
  from: PayoutTransferState | PayoutTransferState[],
  to: PayoutTransferState,
  patch: Record<string, unknown> = {},
  columns: Record<string, unknown> = {},
  /** Equality predicates on the metadata the caller OBSERVED. Without
   *  these the state alone is an ABA: a row can leave and re-enter a
   *  state between a worker's read and its write. `keyGeneration` is the
   *  epoch — every mutation that follows a Stripe call must be fenced on
   *  it, or a worker holding a result from generation N can write it
   *  against generation N+1. */
  expect: { postedAt?: string; keyGeneration?: number; duplicateReviewNonce?: string | null } = {},
  /** Column-level guard. `notStatus` refuses the transition when the payout
   *  already carries that status — the operator disposals use it so a payout
   *  whose money reached the partner can never be released back into the
   *  payable pool, whatever its transferState says. */
  guard: { notStatus?: string } = {},
): Promise<PayoutRow | null> {
  const fromList = Array.isArray(from) ? from : [from];
  const q = db(TABLES.Payout)
    .where({ id: payoutId })
    .whereRaw(`("metadata"->>'transferState') = any(?::text[])`, [`{${fromList.join(',')}}`]);
  if ('postedAt' in expect) {
    if (expect.postedAt == null) {
      q.whereRaw(`("metadata"->>'postedAt') is null`);
    } else {
      q.whereRaw(`("metadata"->>'postedAt') = ?`, [expect.postedAt]);
    }
  }
  if (expect.keyGeneration !== undefined) {
    // TEXT comparison, not `::int`. A cast RAISES on a non-numeric value
    // and `coalesce` cannot catch a failed cast — so one malformed
    // metadata blob (hand repair, SQL import) would make every fenced CAS
    // throw and wedge the intent permanently, possibly after money moved.
    // Absent means generation 0: rows written before generations existed.
    q.whereRaw(`coalesce("metadata"->>'keyGeneration', '0') = ?`, [String(expect.keyGeneration)]);
  }
  if ('duplicateReviewNonce' in expect) {
    // Same presence-sensitive shape as postedAt: null means "I observed no
    // nonce", which only matches a row the webhook has not touched.
    if (expect.duplicateReviewNonce == null) {
      q.whereRaw(`("metadata"->>'duplicateReviewNonce') is null`);
    } else {
      q.whereRaw(`("metadata"->>'duplicateReviewNonce') = ?`, [expect.duplicateReviewNonce]);
    }
  }
  if (guard.notStatus !== undefined) {
    q.whereNot({ status: guard.notStatus });
  }
  const [row] = (await q
    .update({
      ...columns,
      metadata: mergeMeta(db, { ...patch, transferState: to }),
    })
    .returning('*')) as PayoutRow[];
  return row ?? null;
}

/**
 * A DEFINITE error is one that proves the transfer does not exist, so the
 * intent can be failed and its commissions released.
 *
 * Not every 4xx qualifies, and getting this wrong double-pays (audit
 * review): a **409 idempotency conflict** means another request is using
 * this key *right now* — its transfer may well succeed — and a **429**
 * means Stripe throttled us before doing anything but may also arrive
 * mid-flight. Releasing the claims on either lets the planner regroup the
 * commissions under a NEW key while the first transfer lands.
 *
 * Both are therefore treated as ambiguous: the intent stays `posted` and
 * the retry replays the frozen key (or reconciles by listing past the
 * window), which is the only way to learn what really happened.
 */
function isDefiniteStripeError(err: unknown): boolean {
  const e = err as { type?: string; rawType?: string; code?: string; statusCode?: number };
  // stripe-node puts the wrapper class name on `type`
  // ('StripeIdempotencyError') and the API's own string on `rawType`
  // ('idempotency_error'). Checking `type` for the API string never
  // matched — which mattered for the idempotency errors that arrive as
  // 400 rather than 409 (a key reused with different parameters), since
  // those would have been treated as proof no transfer exists.
  if (
    e?.type === 'StripeIdempotencyError' ||
    e?.rawType === 'idempotency_error' ||
    e?.code === 'idempotency_key_in_use'
  ) {
    return false;
  }
  if (typeof e?.statusCode !== 'number') return false;
  if (e.statusCode === 409 || e.statusCode === 429) return false;
  return e.statusCode >= 400 && e.statusCode < 500;
}
