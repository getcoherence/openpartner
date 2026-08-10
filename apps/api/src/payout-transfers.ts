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
/** A just-posted intent is left alone briefly: the worker that posted it
 *  may still be waiting on Stripe. Without this, an admin-triggered run
 *  overlapping a scheduler tick would fire two concurrent POSTs on one key
 *  (safe — Stripe 409s — but noisy). */
const POST_COOLDOWN_MS = 60_000;
/** After this many attempts, a transfer we can see at Stripe but cannot
 *  re-read stops being a transient blip and becomes an operator alert. */
const RETRIEVE_ALERT_ATTEMPTS = 5;

export type PayoutTransferState =
  | 'intent'
  | 'posted'
  | 'confirmed'
  | 'reconcile_required'
  | 'canceled';

/** The transfer-intent slice of `Payout.metadata`. Written by the planner,
 *  advanced only through `casTransferState`. */
export interface PayoutTransferMeta {
  transferState: PayoutTransferState;
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
    .orderByRaw(
      `coalesce("metadata"->>'leaseAt', "metadata"->>'postedAt', "createdAt"::text) asc`,
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
  const meta = payout.metadata as unknown as PayoutTransferMeta;

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
    if (now.getTime() - leaseAt < POST_COOLDOWN_MS) {
      result.skipped += 1;
      return;
    }
    // The margin is what makes the check safe to act on: a worker that
    // leases just inside the boundary still has to make its Stripe call,
    // and Stripe may prune the key any time after 24h. Treating the key
    // as spent an hour early means every POST we authorize lands with
    // room to spare, instead of racing the expiry we just measured.
    if (now.getTime() - postedAt >= IDEMPOTENCY_WINDOW_MS - KEY_SAFETY_MARGIN_MS) {
      // The key may have been pruned, so a re-POST could create a SECOND
      // transfer. Find out what really happened instead.
      const moved = await casTransferState(db, payout.id, 'posted', 'reconcile_required');
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
    payout = leased;
  }

  if (meta.transferState === 'intent') {
    // Nothing has reached Stripe yet, so this is the one moment where
    // abandoning the intent is free. Re-verify what the planner froze.
    const blocker = await preflight(db, payout, meta);
    if (blocker) {
      await cancelIntent(db, payout, blocker, result);
      return;
    }
    const moved = await casTransferState(db, payout.id, 'intent', 'posted', {
      postedAt: now.toISOString(),
      leaseAt: now.toISOString(),
      attempts: (meta.attempts ?? 0) + 1,
    });
    if (!moved) return; // another worker claimed it
    payout = moved;
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
          mode: meta.mode ?? '',
        },
      },
      { idempotencyKey: `payout_${payout.id}` },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDefiniteStripeError(err)) {
      // Stripe answered with semantics that prove no transfer exists —
      // either the first POST was rejected outright, or this is a replay
      // of that same rejection. Concurrency (409) and throttling (429)
      // are excluded; see isDefiniteStripeError.
      await failIntent(db, payout, message, result);
      return;
    }
    // Ambiguous: the transfer may exist. Stay 'posted' — the next tick
    // replays the frozen key inside the window, or reconciles past it.
    await db(TABLES.Payout)
      .where({ id: payout.id })
      .update({
        metadata: mergeMeta(db, { lastError: message.slice(0, 500) }),
      });
    console.error(`[payouts] transfer post ambiguous, intent ${payout.id} held: ${message}`);
    result.ambiguous.push(payout.id);
    return;
  }

  await finalizeTransfer(db, stripe, payout, transfer, result);
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
  result: PayoutTransferResult,
): Promise<void> {
  // A REPLAYED transfer object is stale. Stripe answers a retried
  // idempotency key with the response it stored at creation time, so
  // `reversed` there is always false even if the transfer has since been
  // clawed back — and finalizing on that would overwrite a reversal
  // webhook's `failed` with `paid`. Any attempt past the first therefore
  // re-reads the live object before believing it (audit review).
  const attempts = Number((payout.metadata as { attempts?: number }).attempts ?? 1);
  if (attempts > 1) {
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
      await db(TABLES.Payout)
        .where({ id: payout.id })
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
    await casTransferState(db, payout.id, ['posted', 'reconcile_required'], 'confirmed', {
      lastError: 'transfer_reversed',
    }, { status: 'failed', stripeTransferId: transfer.id });
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
    const moved = await casTransferState(trx, payout.id, ['posted', 'reconcile_required'], 'confirmed', {
      lastError: undefined,
    }, {
      status: 'paid',
      stripeTransferId: transfer.id,
      completedAt: new Date(),
    });
    if (!moved) return false; // another worker finalized first
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
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const listed = await stripe.transfers.list({
      transfer_group: payout.id,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const match = listed.data.find((t) => t.metadata?.openpartner_payout_id === payout.id);
    if (match) {
      await finalizeTransfer(db, stripe, payout, match, result);
      return;
    }
    if (!listed.has_more || listed.data.length === 0) break;
    startingAfter = listed.data[listed.data.length - 1]!.id;
  }
  console.error(
    `[payouts] intent ${payout.id}: no transfer found in group after the idempotency window — re-arming for a fresh post`,
  );
  await casTransferState(db, payout.id, 'reconcile_required', 'intent', {
    postedAt: undefined,
    leaseAt: undefined,
  });
}

/** Definite failure: release the frozen commissions so the next planning
 *  run can regroup them, and record why on the Payout. */
async function failIntent(
  db: Knex,
  payout: PayoutRow,
  message: string,
  result: PayoutTransferResult,
): Promise<void> {
  await db.transaction(async (trx) => {
    const moved = await casTransferState(trx, payout.id, ['posted', 'intent'], 'canceled', {
      lastError: message.slice(0, 500),
    }, { status: 'failed' });
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
): Promise<PayoutRow | null> {
  const fromList = Array.isArray(from) ? from : [from];
  const [row] = (await db(TABLES.Payout)
    .where({ id: payoutId })
    .whereRaw(`("metadata"->>'transferState') = any(?::text[])`, [`{${fromList.join(',')}}`])
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
