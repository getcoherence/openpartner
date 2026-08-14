/**
 * Operator-recovery apply loop — decision B (audit handoff §0.4).
 *
 * Both money rails freeze on ambiguity and wait for a human. The four
 * operator functions that release a freeze verify everything verifiable
 * against Stripe themselves; what was missing is durability, auditability,
 * an API, and serialization with the machinery. That is this file:
 * operators (via routes/recovery.ts) insert an append-only
 * `OperatorRecoveryRequest`, and this loop — wired at the top of the same
 * scheduler jobs that run the rails — claims it and calls the EXISTING
 * function under its own fences. The functions ARE the verification layer;
 * nothing here re-implements or bypasses their checks.
 *
 *   rail 'direct_connect'  release_intent_for_retry → releaseIntentForRetry
 *                          dispose_intent           → disposeIntent
 *                          resolve_duplicate_review → resolveDuplicateReview
 *   rail 'hosted_funding'  force_release_batch      → forceReleaseBatch
 *
 * Outcome mapping (§0.4): the function's success literal → `applied`; its
 * definitive refusals → `refused` with the literal recorded; the retryable
 * trio (`cannot_verify`, `review_moved`, `too_recent`) stays `pending`
 * with paced retries until MAX_APPLY_ATTEMPTS, then `failed` + alert.
 * Terminal rows are never edited into a new decision — a new decision is a
 * new row.
 *
 * TENANCY: this loop runs on the PRIVILEGED pool (the operator functions
 * cannot hold a tenant transaction across Stripe calls), so the tenant
 * check here — target row's tenantId must equal the request row's — is the
 * ONLY boundary between an admin of tenant A and tenant B's payouts. The
 * request row's tenantId is trustworthy because inserts happen through the
 * tenant-scoped API under RLS. It runs before anything else, always.
 *
 * PROVE-ABSENCE CLOSE (§0.2): an applied direct-Connect request is a
 * documented risk decision that no in-flight POST will land later — a
 * thing no listing can prove. The `transfer.created` webhook detector is
 * the primary alarm when one does; the RECHECK pass here is the backstop
 * for a missed webhook: RECHECK_AFTER_MS after apply it re-lists the
 * transfer group and alarms on any live transfer the payout is no longer
 * expecting. Detector only — no payout state is written; disposition stays
 * with a human. The hosted-funding rail needs no equivalent: a late
 * funding PaymentIntent announces itself through the payment_intent.*
 * webhooks into the funding inbox (redelivery-guaranteed), where a
 * succeeded PI for a released batch already freezes and alerts.
 */

import type Stripe from 'stripe';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type HostedFundingBatchRow,
  type OperatorRecoveryKind,
  type OperatorRecoveryRail,
  type OperatorRecoveryRequestRow,
  type PayoutRow,
} from '@openpartner/db';
import { stripe as defaultStripe } from './stripe.js';
import {
  disposeIntent,
  listTransferGroup,
  releaseIntentForRetry,
  resolveDuplicateReview,
} from './payout-transfers.js';
import { forceReleaseBatch } from './funding/release.js';

/** Claims per pass. Small on purpose: every apply is 1–3 Stripe listings,
 *  and the scheduler comes back every 5–15 minutes. */
const APPLY_CLAIM_LIMIT = 20;
/** A claim older than this belongs to a run that died — claimable again.
 *  One apply is seconds of Stripe reads; a whole pass minutes. Writes are
 *  token-fenced regardless, so a takeover cannot be overwritten by the
 *  dead run's ghost. */
const APPLY_LEASE_MS = 15 * 60 * 1000;
/** Pacing for the retryable outcomes. `too_recent` in particular is the
 *  forceReleaseBatch quiet gate (1h) — retrying every scheduler tick would
 *  burn the attempt budget before the gate could open, so retries are
 *  spaced wider than the tick. */
const RETRY_DELAY_MS = 15 * 60 * 1000;
/** Attempts (claims) before a still-retryable request is failed + alerted.
 *  10 × 15-minute pacing ≈ 2.5h of trying — past the quiet gate, past any
 *  plausible Stripe blip. A failed request is closed; the operator files a
 *  new one once the world stops moving. */
const MAX_APPLY_ATTEMPTS = 10;
/** How long after apply the transfer-group recheck runs. Late enough that
 *  a genuinely in-flight POST has almost certainly landed (and its
 *  transfer.created webhook been delivered or exhausted its first retries),
 *  early enough to matter. */
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;
const RECHECK_RETRY_MS = 60 * 60 * 1000;
const MAX_RECHECK_ATTEMPTS = 10;

/** The literal each function returns on success. Anything else is either
 *  retryable (below) or a definitive refusal. */
const SUCCESS_OUTCOME: Record<OperatorRecoveryKind, string> = {
  release_intent_for_retry: 'rearmed',
  dispose_intent: 'disposed',
  resolve_duplicate_review: 'resolved',
  force_release_batch: 'released',
};
/** Outcomes where the world may still settle in our favor: an unreadable
 *  Stripe, a webhook that moved the review nonce mid-resolution, a quiet
 *  gate that has not opened yet. Everything not here and not the success
 *  literal is a definitive refusal — the function verified the premise and
 *  found it false. */
const RETRYABLE_OUTCOMES = new Set(['cannot_verify', 'review_moved', 'too_recent']);

const RAIL_KINDS: Record<OperatorRecoveryRail, Set<OperatorRecoveryKind>> = {
  direct_connect: new Set(['release_intent_for_retry', 'dispose_intent', 'resolve_duplicate_review']),
  hosted_funding: new Set(['force_release_batch']),
};

const OPEN_PAYOUT_STATES = new Set(['intent', 'posted', 'reconcile_required']);

export interface RecoveryApplyDeps {
  rail: OperatorRecoveryRail;
  /** Scope the pass to one tenant (unused by the scheduler; the API's
   *  inline apply passes it together with requestId). */
  tenantId?: string;
  /** Scope the pass to one request — the API's inline apply. */
  requestId?: string;
  /** Test seam. */
  stripe?: Stripe;
}

export interface RecoveryApplyResult {
  processed: number;
  applied: Array<{ requestId: string; targetId: string; outcome: string }>;
  refused: Array<{ requestId: string; targetId: string; outcome: string }>;
  /** Retryable outcome recorded; the request stays pending. */
  retrying: Array<{ requestId: string; targetId: string; outcome: string }>;
  failed: Array<{ requestId: string; targetId: string; outcome: string }>;
  recheck: { processed: number; orphaned: string[]; deferred: number };
  /** No Stripe client — nothing was claimed. */
  skipped?: 'stripe_not_configured';
}

/**
 * One apply pass: claim due pending requests for `rail`, call the operator
 * function for each, settle the outcome, then run the recheck pass for
 * applied direct-Connect requests whose recheck is due.
 *
 * @param db privileged (non-transaction) knex — the operator functions
 *           make Stripe calls between short transactions.
 */
export async function applyRecoveryRequests(
  db: Knex,
  deps: RecoveryApplyDeps,
): Promise<RecoveryApplyResult> {
  const result: RecoveryApplyResult = {
    processed: 0,
    applied: [],
    refused: [],
    retrying: [],
    failed: [],
    recheck: { processed: 0, orphaned: [], deferred: 0 },
  };
  const stripe = deps.stripe ?? defaultStripe;
  if (!stripe) {
    // Never claim what we cannot verify: every kind's function returns
    // cannot_verify without a client, which would just burn the attempt
    // budget. Requests stay pending until Stripe is configured.
    result.skipped = 'stripe_not_configured';
    return result;
  }

  const token = ulid();
  const claimed = await claimRequests(db, deps, token);
  for (const request of claimed) {
    result.processed += 1;
    try {
      await applyOne(db, stripe, request, token, result);
    } catch (err) {
      // Unexpected throw (DB down mid-apply, a bug): same path as a
      // retryable outcome — the underlying functions are idempotent and
      // fenced, so trying again is always safe.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[recovery] apply error on request ${request.id}`, err);
      await settleRetryable(db, request, token, `error:${message}`.slice(0, 500), result);
    }
  }

  await recheckAppliedRequests(db, stripe, deps, token, result);
  return result;
}

/** Single-statement claim (the round-10 sweep-claim pattern): lease via
 *  the DATABASE clock on both sides, `for update skip locked` so the
 *  scheduler tick and an inline API apply cannot double-claim, attempts
 *  counted at claim time so a crash mid-apply still consumes budget. */
async function claimRequests(
  db: Knex,
  deps: RecoveryApplyDeps,
  token: string,
): Promise<OperatorRecoveryRequestRow[]> {
  const sub = db(TABLES.OperatorRecoveryRequest)
    .select('id')
    .where({ status: 'pending', rail: deps.rail })
    .modify((qb) => {
      if (deps.tenantId) qb.where({ tenantId: deps.tenantId });
      if (deps.requestId) qb.where({ id: deps.requestId });
    })
    .whereRaw(`coalesce("nextAttemptAt", to_timestamp(0)) <= now()`)
    .where((qb) =>
      qb
        .whereNull('leaseAt')
        .orWhereRaw(`"leaseAt" < now() - make_interval(secs => ?)`, [APPLY_LEASE_MS / 1000]),
    )
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .limit(APPLY_CLAIM_LIMIT)
    .forUpdate()
    .skipLocked();
  return (await db(TABLES.OperatorRecoveryRequest)
    .whereIn('id', sub)
    .update({
      leaseAt: db.fn.now(),
      leaseToken: token,
      attempts: db.raw('"attempts" + 1'),
      updatedAt: db.fn.now(),
    })
    .returning('*')) as OperatorRecoveryRequestRow[];
}

async function applyOne(
  db: Knex,
  stripe: Stripe,
  request: OperatorRecoveryRequestRow,
  token: string,
  result: RecoveryApplyResult,
): Promise<void> {
  // Kind↔rail pairing first. The API validates this, but the row is jsonb
  // + strings and can be inserted by hand — the loop trusts nothing.
  if (!RAIL_KINDS[request.rail]?.has(request.kind)) {
    await settleTerminal(db, request, token, 'refused', 'invalid_request:kind_rail_mismatch', result);
    return;
  }

  // THE TENANT BOUNDARY — before anything else (see file header).
  const target =
    request.rail === 'direct_connect'
      ? ((await db<PayoutRow>(TABLES.Payout)
          .where({ id: request.targetId })
          .first(['id', 'tenantId'])) as Pick<PayoutRow, 'id' | 'tenantId'> | undefined)
      : ((await db<HostedFundingBatchRow>(TABLES.HostedFundingBatch)
          .where({ id: request.targetId })
          .first(['id', 'tenantId'])) as Pick<HostedFundingBatchRow, 'id' | 'tenantId'> | undefined);
  if (!target) {
    await settleTerminal(db, request, token, 'refused', 'target_not_found', result);
    return;
  }
  if (target.tenantId !== request.tenantId) {
    // A tenant-A admin naming a tenant-B target. The API's existence check
    // (RLS-scoped) makes this unreachable through the front door, so if it
    // fires, someone wrote the row another way — say so loudly.
    console.error(
      `[recovery] ALERT: request ${request.id} (tenant ${request.tenantId}) targets ${request.targetId} which belongs to tenant ${target.tenantId} — refused; investigate how this row was written`,
    );
    await settleTerminal(db, request, token, 'refused', 'tenant_mismatch', result);
    return;
  }

  const operator = `${request.requestedBy}/req_${request.id}`;
  const params = (request.params ?? {}) as Record<string, unknown>;

  let outcome: string;
  switch (request.kind) {
    case 'release_intent_for_retry': {
      // Stricter than readGeneration on purpose: an ABSENT observed
      // generation must refuse, not default to 0 — the fence the operator
      // is asserting against has to be the one they actually observed.
      const g = params.observedGeneration;
      const generation = typeof g === 'number' && Number.isSafeInteger(g) && g >= 0 ? g : null;
      if (generation === null) {
        await settleTerminal(db, request, token, 'refused', 'invalid_request:params', result);
        return;
      }
      outcome = await releaseIntentForRetry(db, request.targetId, generation, operator, stripe);
      break;
    }
    case 'dispose_intent': {
      const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
      if (!reason) {
        await settleTerminal(db, request, token, 'refused', 'invalid_request:params', result);
        return;
      }
      outcome = await disposeIntent(db, request.targetId, operator, reason, stripe);
      break;
    }
    case 'resolve_duplicate_review': {
      const kept = typeof params.keptTransferId === 'string' ? params.keptTransferId.trim() : '';
      const allReversed = params.allReversed === true;
      if ((kept !== '') === allReversed) {
        // exactly one of the two dispositions, never both, never neither
        await settleTerminal(db, request, token, 'refused', 'invalid_request:params', result);
        return;
      }
      outcome = await resolveDuplicateReview(
        db,
        request.targetId,
        operator,
        kept ? { keptTransferId: kept } : { allReversed: true },
        stripe,
      );
      break;
    }
    case 'force_release_batch': {
      const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
      if (!reason) {
        await settleTerminal(db, request, token, 'refused', 'invalid_request:params', result);
        return;
      }
      outcome = await forceReleaseBatch(db, request.targetId, operator, reason, stripe);
      break;
    }
    default: {
      // Unreachable — RAIL_KINDS validated the kind above. Exists so TS's
      // definite-assignment analysis sees every path assign `outcome`.
      await settleTerminal(db, request, token, 'refused', 'invalid_request:kind', result);
      return;
    }
  }

  if (outcome === SUCCESS_OUTCOME[request.kind]) {
    await settleTerminal(db, request, token, 'applied', outcome, result);
    return;
  }
  if (RETRYABLE_OUTCOMES.has(outcome)) {
    await settleRetryable(db, request, token, outcome, result);
    return;
  }
  await settleTerminal(db, request, token, 'refused', outcome, result);
}

/** Terminal write, fenced on the claim token: only the claim holder may
 *  settle, and only while the row is still pending. An applied
 *  direct-Connect request schedules its group recheck here (§0.2). */
async function settleTerminal(
  db: Knex,
  request: OperatorRecoveryRequestRow,
  token: string,
  status: 'applied' | 'refused' | 'failed',
  outcome: string,
  result: RecoveryApplyResult,
): Promise<void> {
  const scheduleRecheck = status === 'applied' && request.rail === 'direct_connect';
  const updated = await db(TABLES.OperatorRecoveryRequest)
    .where({ id: request.id, leaseToken: token, status: 'pending' })
    .update({
      status,
      outcome,
      leaseAt: null,
      leaseToken: null,
      nextAttemptAt: null,
      updatedAt: db.fn.now(),
      ...(status === 'applied' ? { appliedAt: db.fn.now() } : {}),
      ...(scheduleRecheck
        ? { recheckDueAt: db.raw('now() + make_interval(secs => ?)', [RECHECK_AFTER_MS / 1000]) }
        : {}),
    });
  if (updated === 0) return; // lost the fence — the winner recorded its own verdict
  const entry = { requestId: request.id, targetId: request.targetId, outcome };
  if (status === 'applied') {
    console.error(
      `[recovery] request ${request.id} APPLIED: ${request.kind} on ${request.targetId} → ${outcome} (requested by ${request.requestedBy})`,
    );
    result.applied.push(entry);
  } else if (status === 'failed') {
    result.failed.push(entry);
  } else {
    console.error(
      `[recovery] request ${request.id} refused: ${request.kind} on ${request.targetId} → ${outcome}`,
    );
    result.refused.push(entry);
  }
}

/** A retryable outcome: record it, pace the next attempt, or close the
 *  request as failed once the budget is spent. */
async function settleRetryable(
  db: Knex,
  request: OperatorRecoveryRequestRow,
  token: string,
  outcome: string,
  result: RecoveryApplyResult,
): Promise<void> {
  // `attempts` was incremented by our claim, so request.attempts (read
  // back from the claim's returning) is the count INCLUDING this try.
  if (request.attempts >= MAX_APPLY_ATTEMPTS) {
    console.error(
      `[recovery] ALERT: request ${request.id} (${request.kind} on ${request.targetId}) still ${outcome} after ${request.attempts} attempts — closed as failed; file a new request once the target verifies`,
    );
    await settleTerminal(db, request, token, 'failed', outcome, result);
    return;
  }
  const updated = await db(TABLES.OperatorRecoveryRequest)
    .where({ id: request.id, leaseToken: token, status: 'pending' })
    .update({
      outcome,
      leaseAt: null,
      leaseToken: null,
      nextAttemptAt: db.raw('now() + make_interval(secs => ?)', [RETRY_DELAY_MS / 1000]),
      updatedAt: db.fn.now(),
    });
  if (updated > 0) {
    result.retrying.push({ requestId: request.id, targetId: request.targetId, outcome });
  }
}

/**
 * The §0.2 backstop: re-list the transfer group of every applied
 * direct-Connect request whose recheck is due, and ALARM on any live
 * transfer the payout is no longer expecting — a late in-flight POST that
 * landed after the operator's absence-based decision, caught even if its
 * `transfer.created` webhook was missed.
 *
 * DETECTOR ONLY, exactly like the webhook handler: no payout state is
 * written, the benign/orphan predicate is the same, and fully-reversed
 * transfers never alarm (a verified-reversed member was the PREMISE of the
 * dispose/all-reversed decisions, not a violation of them).
 */
async function recheckAppliedRequests(
  db: Knex,
  stripe: Stripe,
  deps: RecoveryApplyDeps,
  token: string,
  result: RecoveryApplyResult,
): Promise<void> {
  if (deps.rail !== 'direct_connect') return;
  const sub = db(TABLES.OperatorRecoveryRequest)
    .select('id')
    .where({ status: 'applied', rail: 'direct_connect' })
    .modify((qb) => {
      if (deps.tenantId) qb.where({ tenantId: deps.tenantId });
      if (deps.requestId) qb.where({ id: deps.requestId });
    })
    .whereNotNull('recheckDueAt')
    .whereRaw(`"recheckDueAt" <= now()`)
    .where((qb) =>
      qb
        .whereNull('leaseAt')
        .orWhereRaw(`"leaseAt" < now() - make_interval(secs => ?)`, [APPLY_LEASE_MS / 1000]),
    )
    .orderBy('recheckDueAt', 'asc')
    .orderBy('id', 'asc')
    .limit(APPLY_CLAIM_LIMIT)
    .forUpdate()
    .skipLocked();
  const due = (await db(TABLES.OperatorRecoveryRequest)
    .whereIn('id', sub)
    .update({
      leaseAt: db.fn.now(),
      leaseToken: token,
      recheckAttempts: db.raw('"recheckAttempts" + 1'),
      updatedAt: db.fn.now(),
    })
    .returning('*')) as OperatorRecoveryRequestRow[];

  for (const request of due) {
    result.recheck.processed += 1;
    let outcome: string;
    let done = true;
    try {
      outcome = await recheckOne(db, stripe, request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[recovery] recheck error on request ${request.id}`, err);
      outcome = `error:${message}`.slice(0, 500);
      done = false;
    }
    if (outcome === 'cannot_verify') done = false;
    if (!done && request.recheckAttempts >= MAX_RECHECK_ATTEMPTS) {
      console.error(
        `[recovery] ALERT: recheck for request ${request.id} (payout ${request.targetId}) could not verify after ${request.recheckAttempts} attempts — giving up; list the transfer group by hand`,
      );
      done = true;
    }
    if (outcome.startsWith('orphan_transfers:')) result.recheck.orphaned.push(request.targetId);
    if (!done) result.recheck.deferred += 1;
    await db(TABLES.OperatorRecoveryRequest)
      .where({ id: request.id, leaseToken: token, status: 'applied' })
      .update({
        recheckOutcome: outcome,
        recheckDueAt: done
          ? null
          : db.raw('now() + make_interval(secs => ?)', [RECHECK_RETRY_MS / 1000]),
        leaseAt: null,
        leaseToken: null,
        updatedAt: db.fn.now(),
      });
  }
}

async function recheckOne(
  db: Knex,
  stripe: Stripe,
  request: OperatorRecoveryRequestRow,
): Promise<string> {
  const payout = (await db<PayoutRow>(TABLES.Payout)
    .where({ id: request.targetId })
    .first()) as PayoutRow | undefined;
  if (!payout || payout.tenantId !== request.tenantId) {
    // The target vanished (or never matched) after an APPLIED request —
    // either way there is nothing to list and something to look at.
    console.error(
      `[recovery] ALERT: recheck for request ${request.id} cannot load payout ${request.targetId} — target missing`,
    );
    return 'target_missing';
  }
  const group = await listTransferGroup(stripe, payout.id, `recovery recheck ${request.id}`);
  if (group === 'cannot_verify') return 'cannot_verify';

  const meta = payout.metadata as { transferState?: string } | null;
  const state = meta?.transferState;
  // Same predicate as the transfer.created detector: an OPEN intent with
  // no recorded transfer is allowed to have live group members (the
  // executor is mid-flight and will finalize them); anything else may hold
  // exactly the transfer it recorded, nothing more. Only LIVE transfers
  // count — money that was moved and fully clawed back is history, and
  // alarming on it forever would bury the real signal.
  const benignOpen =
    state !== undefined && OPEN_PAYOUT_STATES.has(state) && payout.stripeTransferId == null;
  const orphans = benignOpen
    ? []
    : group.filter(
        (t) =>
          Number(t.amount_reversed ?? 0) < Number(t.amount ?? 0) &&
          t.id !== payout.stripeTransferId,
      );
  if (orphans.length > 0) {
    const ids = orphans.map((t) => t.id).join(', ');
    console.error(
      `[recovery] ALERT: recheck for request ${request.id} found ${orphans.length} live transfer(s) (${ids}) for payout ${payout.id} which is ${state ?? 'unknown'}/${payout.status} on transfer ${payout.stripeTransferId ?? 'none'} — money moved outside the ledger after an operator disposition; operator reconciliation required`,
    );
    return `orphan_transfers:${ids}`.slice(0, 500);
  }
  return 'clear';
}
