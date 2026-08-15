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
 * tenant-scoped API under RLS (the table's app-role grant is SELECT +
 * INSERT only, and the RLS with-check pins tenantId to the session's
 * tenant). It runs before anything else, always. What this does NOT
 * defend against — deliberately — is a writer on the privileged pool
 * hand-inserting a row that self-asserts another tenant: that writer can
 * already do anything to any row directly, so the request queue adds no
 * privilege it lacks. `requestedBy` is audit text, not authentication.
 *
 * EXACTLY-ONCE, honestly stated: the lease + token fence make the SETTLE
 * at-most-once, and the operator functions' own CAS fences make the money
 * action at-most-once. What no fence can give is a truthful outcome when
 * a claim dies BETWEEN its action committing and its settle: the takeover
 * pass re-calls the function, which now refuses ("not_disposable",
 * "not_stuck", ...) because the world already reflects the action. So a
 * takeover of an EXPIRED lease treats definitive refusals with suspicion:
 * the operator functions stamp their audit marker (which embeds this
 * request's id) on the target, and if the target carries OUR marker the
 * refusal is re-read as "the prior attempt applied it" and settled
 * `applied`. If the marker is absent the refusal settles annotated as
 * ambiguous, with an alert — never as a clean refusal.
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
    // budget. Requests stay pending until Stripe is configured — but a
    // pending request on an instance with no Stripe client is a
    // misconfiguration someone must hear about, not a quiet hold.
    result.skipped = 'stripe_not_configured';
    const pending = (await db(TABLES.OperatorRecoveryRequest)
      .where({ status: 'pending', rail: deps.rail })
      .count({ n: '*' })) as Array<{ n: string | number }>;
    const n = Number(pending[0]?.n ?? 0);
    if (n > 0) {
      console.error(
        `[recovery] ALERT: ${n} pending ${deps.rail} recovery request(s) cannot be applied — STRIPE_SECRET_KEY is not configured on this instance`,
      );
    }
    return result;
  }

  const token = ulid();
  let claimed: ClaimedRequest[];
  try {
    claimed = await claimRequests(db, deps, token);
  } catch (err) {
    // The claim failing must cost the recovery pass, never the rail: this
    // runs at the top of the scheduler job that moves money.
    console.error(`[recovery] claim failed for rail ${deps.rail}`, err);
    return result;
  }
  for (const { request, takeover } of claimed) {
    result.processed += 1;
    try {
      await applyOne(db, stripe, request, token, takeover, result);
    } catch (err) {
      // Unexpected throw (DB down mid-apply, a bug): same path as a
      // retryable outcome — the underlying functions are idempotent and
      // fenced, so trying again is always safe.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[recovery] apply error on request ${request.id}`, err);
      await settleRetryable(db, request, token, `error:${message}`.slice(0, 500), result);
    }
  }

  try {
    await recheckAppliedRequests(db, stripe, deps, token, result);
  } catch (err) {
    console.error(`[recovery] recheck pass failed for rail ${deps.rail}`, err);
  }
  return result;
}

interface ClaimedRequest {
  request: OperatorRecoveryRequestRow;
  /** True when this claim took over an EXPIRED lease — the prior holder
   *  died (or stalled) mid-apply, so its action may have committed
   *  without settling. Definitive refusals on such a claim are treated
   *  with suspicion (see the file header). */
  takeover: boolean;
}

/** Claim (the round-10 sweep-claim pattern): lease via the DATABASE clock
 *  on both sides, `for update skip locked` so the scheduler tick and an
 *  inline API apply cannot double-claim, attempts counted at claim time so
 *  a crash mid-apply still consumes budget. Runs as select-then-update in
 *  one transaction (rather than one statement) so the OLD leaseAt — the
 *  takeover signal — survives; the row lock spans both statements.
 *
 *  The attempts increment is clamped before adding: a hand-poisoned
 *  counter at int4 max would otherwise make the claim STATEMENT raise on
 *  every pass, which — since this runs at the top of the rail's scheduler
 *  job — would starve every other request AND stop the money rail itself.
 *  One bad row must never cost more than itself. */
async function claimRequests(
  db: Knex,
  deps: RecoveryApplyDeps,
  token: string,
): Promise<ClaimedRequest[]> {
  return db.transaction(async (trx) => {
    const rows = (await trx(TABLES.OperatorRecoveryRequest)
      .select('*')
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
      .skipLocked()) as OperatorRecoveryRequestRow[];
    if (rows.length === 0) return [];
    const updated = (await trx(TABLES.OperatorRecoveryRequest)
      .whereIn(
        'id',
        rows.map((r) => r.id),
      )
      .update({
        leaseAt: trx.fn.now(),
        leaseToken: token,
        // Clamped on BOTH sides: least() alone still overflows-in-spirit
        // for a hand-poisoned NEGATIVE counter, which would hold the cap
        // check false for ~2^31 claims (round 12).
        attempts: trx.raw(`greatest(least("attempts", ${MAX_APPLY_ATTEMPTS * 100}), 0) + 1`),
        updatedAt: trx.fn.now(),
      })
      .returning('*')) as OperatorRecoveryRequestRow[];
    const byId = new Map(updated.map((r) => [r.id, r]));
    return rows
      .filter((r) => byId.has(r.id))
      .map((r) => ({ request: byId.get(r.id)!, takeover: r.leaseAt != null }));
  });
}

async function applyOne(
  db: Knex,
  stripe: Stripe,
  request: OperatorRecoveryRequestRow,
  token: string,
  takeover: boolean,
  result: RecoveryApplyResult,
): Promise<void> {
  // THE TENANT BOUNDARY — before anything else (see file header). The
  // read is by rail, which the table's CHECK constraint pins to the two
  // known values, so it is safe even for otherwise-malformed rows. This
  // deliberately runs BEFORE the id-shape gate (round 15): a malformed id
  // must not suppress the cross-tenant ALERT a well-formed hand-insert
  // would have raised — shape problems refuse quietly, boundary problems
  // refuse loudly.
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

  // ID shape next, and always before any operator-function call or marker
  // use: the audit marker namespace is only unambiguous when the id
  // segment is a fixed-length, delimiter-free token. An arbitrary
  // varchar(32) id let two generations of forgery through (round 13:
  // <A>+'X' extended past a startsWith; round 14: <A>+':B' recreated the
  // reason-prefix ambiguity). Refusing non-ULID ids closes the id-shaped
  // class outright; the exact/prefix marker logic stays as
  // defense-in-depth.
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(request.id)) {
    await settleTerminal(db, request, token, 'refused', 'invalid_request:id', result);
    return;
  }
  // Kind↔rail pairing. The API validates this, but the row is jsonb +
  // strings and can be inserted by hand — the loop trusts nothing.
  if (!RAIL_KINDS[request.rail]?.has(request.kind)) {
    await settleTerminal(db, request, token, 'refused', 'invalid_request:kind_rail_mismatch', result);
    return;
  }

  const operator = operatorStringFor(request);
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

  // A definitive refusal on a TAKEN-OVER claim is suspect: the dead
  // holder's action may have committed unsettled, and the function now
  // refuses because the world already reflects it (see the file header).
  // The operator functions stamp `req_<id>` (via the operator string) on
  // the target's lastError / failureReason — our own marker there means
  // THIS request applied, whoever's process died.
  if (takeover && (await targetCarriesOurMarker(db, request))) {
    console.error(
      `[recovery] request ${request.id} refused as ${outcome} on a taken-over lease, but ${request.targetId} carries this request's marker — the interrupted attempt applied it; settling applied`,
    );
    await settleTerminal(
      db,
      request,
      token,
      'applied',
      `${SUCCESS_OUTCOME[request.kind]}:by_interrupted_attempt`,
      result,
    );
    return;
  }
  if (takeover) {
    // Marker absent but the doubt stands (a rearm's marker, for one, is
    // cleared once the executor confirms). Refuse — but never as a CLEAN
    // refusal, and loudly enough that a human reads the target.
    console.error(
      `[recovery] ALERT: request ${request.id} refused as ${outcome} on a taken-over lease — a prior attempt died mid-apply, so this refusal may be the echo of that attempt succeeding; read ${request.targetId} before filing a new request`,
    );
    await settleTerminal(db, request, token, 'refused', `${outcome}:after_interrupted_attempt`, result);
    return;
  }
  await settleTerminal(db, request, token, 'refused', outcome, result);
}

/** The audit string the operator functions stamp for this request.
 *
 *  `requestedBy` is SANITIZED before it enters the string: `/` and `:` —
 *  the two delimiters the marker check anchors on — are squashed to `_`.
 *  Without that, a requestedBy shaped like `env_admin_key/req_<A>:x`
 *  (arbitrary text is insertable by anything holding app-role INSERT; the
 *  API derives it, the schema does not enforce it) would make request B's
 *  stamp start with request A's expected prefix, forging A's
 *  "my interrupted attempt applied it" verdict (round 12). With `/`
 *  banned from the name and the fixed-length id terminated by our own
 *  delimiter, the first `/req_` in the stamp is always OURS. */
function operatorStringFor(request: OperatorRecoveryRequestRow): string {
  const safe = request.requestedBy.replace(/[/:]/g, '_').slice(0, 254);
  return `${safe}/req_${request.id}`;
}
// Compatibility note (round 13): stamps written by the brief pre-sanitizer
// build would not match the sanitized expectation and would settle as an
// annotated refusal — the SAFE branch, with an alert pointing a human at
// the target. Verified empirically: no OperatorRecoveryRequest row has
// ever existed in any deployment (prod count 0 on 2026-08-14), so no
// legacy stamp exists to mismatch. No legacy-form fallback is added on
// purpose — matching the unsanitized shape would re-open the round-12
// forgery for names containing '/'.

/** Does the target's operator-audit field carry THIS request's marker?
 *
 *  ANCHORED at the start of the string, per kind, on purpose. The stamped
 *  value is `operator_<action>:<sanitized requestedBy>/req_<id>[:<reason>]`,
 *  and the REASON is operator-controlled free text that lands in the same
 *  string — a bare `includes('req_<id>')` let a second request against the
 *  same target embed another request's id in its reason and forge that
 *  request's "my interrupted attempt applied it" verdict. The prefix up
 *  through `/req_<id>` sits entirely BEFORE any attacker-influenced text,
 *  the sanitizer (operatorStringFor) keeps `/` and `:` out of the name
 *  segment, and ULIDs are fixed-length — so a startsWith match can only be
 *  produced by this request's own stamp. The 500-char server-side
 *  truncation cuts only the reason tail, never the prefix. */
async function targetCarriesOurMarker(
  db: Knex,
  request: OperatorRecoveryRequestRow,
): Promise<boolean> {
  const operator = operatorStringFor(request);
  // The kinds whose stamp has NO reason suffix are matched by EXACT
  // equality — their full stored value is `operator_<action>:<operator>`
  // and nothing else, always shorter than the 500-char truncation. A
  // startsWith here was still forgeable (round 13): the schema does not
  // constrain request ids to ULIDs, so an app-role insert with
  // id = <A's id> + "X" produced a stamp of which A's marker was a strict
  // prefix. The reason-carrying kinds keep the prefix form — their `:`
  // after the id terminates it, so an extended id cannot collide.
  const exact: Record<string, string[]> = {
    release_intent_for_retry: [`operator_rearm:${operator}`],
    resolve_duplicate_review: [
      `operator_kept_transfer:${operator}`,
      `operator_all_reversed:${operator}`,
    ],
  };
  const prefix: Record<string, string[]> = {
    dispose_intent: [`operator_dispose:${operator}:`],
    force_release_batch: [`operator_force_release:${operator}:`],
  };
  const matches = (stored: string | null | undefined): boolean =>
    typeof stored === 'string' &&
    ((exact[request.kind] ?? []).some((m) => stored === m) ||
      (prefix[request.kind] ?? []).some((p) => stored.startsWith(p)));
  if (request.rail === 'direct_connect') {
    const payout = (await db<PayoutRow>(TABLES.Payout)
      .where({ id: request.targetId })
      .first()) as PayoutRow | undefined;
    return matches((payout?.metadata as { lastError?: string } | null)?.lastError);
  }
  const batch = (await db<HostedFundingBatchRow>(TABLES.HostedFundingBatch)
    .where({ id: request.targetId })
    .first(['failureReason'])) as Pick<HostedFundingBatchRow, 'failureReason'> | undefined;
  return matches(batch?.failureReason);
}

/** Terminal write, fenced on the claim token: only the claim holder may
 *  settle, and only while the row is still pending. Direct-Connect
 *  requests schedule the §0.2 group recheck when APPLIED — and also on a
 *  takeover-ANNOTATED refusal (round 14): a rearm whose interrupted
 *  attempt succeeded has its marker legitimately cleared once the
 *  executor finalizes the new generation, so the takeover cannot tell
 *  "never acted" from "acted and completed" — and the superseded
 *  generation's in-flight POST is exactly the late-lander the recheck
 *  exists to catch. Ambiguity earns the backstop, never loses it. */
async function settleTerminal(
  db: Knex,
  request: OperatorRecoveryRequestRow,
  token: string,
  status: 'applied' | 'refused' | 'failed',
  outcome: string,
  result: RecoveryApplyResult,
): Promise<void> {
  const scheduleRecheck =
    request.rail === 'direct_connect' &&
    (status === 'applied' ||
      (status === 'refused' && outcome.endsWith(':after_interrupted_attempt')));
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
    // 'refused' rows carry a recheck too when the refusal was a takeover
    // annotation (settleTerminal) — only rows with recheckDueAt set are
    // ever claimed, so plain refusals stay untouched.
    .whereIn('status', ['applied', 'refused'])
    .where({ rail: 'direct_connect' })
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
      // Clamped for the same reason as the apply claim: a poisoned
      // counter must neither raise in the claim statement (positive
      // overflow) nor hold the give-up check false forever (negative).
      recheckAttempts: db.raw(`greatest(least("recheckAttempts", ${MAX_RECHECK_ATTEMPTS * 100}), 0) + 1`),
      updatedAt: db.fn.now(),
    })
    .returning('*')) as OperatorRecoveryRequestRow[];

  for (const request of due) {
    result.recheck.processed += 1;
    let outcome: string;
    let alert: string | null = null;
    let done = true;
    try {
      const checked = await recheckOne(db, stripe, request);
      outcome = checked.outcome;
      alert = checked.alert;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[recovery] recheck error on request ${request.id}`, err);
      outcome = `error:${message}`.slice(0, 500);
      done = false;
    }
    if (outcome === 'cannot_verify') done = false;
    if (!done && request.recheckAttempts >= MAX_RECHECK_ATTEMPTS) {
      alert = `[recovery] ALERT: recheck for request ${request.id} (payout ${request.targetId}) could not verify after ${request.recheckAttempts} attempts — giving up; list the transfer group by hand`;
      done = true;
    }
    // Fence FIRST, side effects only on a win: a stale pass that lost its
    // lease mid-listing must not re-emit an alarm the winner already
    // settled — that is how one orphan becomes an unbounded alert stream.
    //
    // Accepted residual (round 12): a process killed between this commit
    // and the console.error below loses the LOG LINE, not the finding —
    // `recheckOutcome` durably records the orphan on the row (visible in
    // GET /recovery-requests), and the transfer.created webhook detector
    // remains the primary alarm. Making the emit itself durable would
    // mean an alarm outbox, which is more mechanism than a
    // milliseconds-wide crash window justifies in this codebase.
    const settled = await db(TABLES.OperatorRecoveryRequest)
      .where({ id: request.id, leaseToken: token })
      .whereIn('status', ['applied', 'refused'])
      .update({
        recheckOutcome: outcome,
        recheckDueAt: done
          ? null
          : db.raw('now() + make_interval(secs => ?)', [RECHECK_RETRY_MS / 1000]),
        leaseAt: null,
        leaseToken: null,
        updatedAt: db.fn.now(),
      });
    if (settled === 0) continue; // another pass owns this recheck now
    if (alert) console.error(alert);
    if (outcome.startsWith('orphan_transfers:')) result.recheck.orphaned.push(request.targetId);
    if (!done) result.recheck.deferred += 1;
  }
}

/** Pure check: computes the outcome and the alert to emit, but emits
 *  nothing — the caller fences on the lease token first, so a pass that
 *  lost its claim mid-listing never re-raises a settled alarm. */
async function recheckOne(
  db: Knex,
  stripe: Stripe,
  request: OperatorRecoveryRequestRow,
): Promise<{ outcome: string; alert: string | null }> {
  const payout = (await db<PayoutRow>(TABLES.Payout)
    .where({ id: request.targetId })
    .first()) as PayoutRow | undefined;
  if (!payout || payout.tenantId !== request.tenantId) {
    // The target vanished (or never matched) after an APPLIED request —
    // either way there is nothing to list and something to look at.
    return {
      outcome: 'target_missing',
      alert: `[recovery] ALERT: recheck for request ${request.id} cannot load payout ${request.targetId} — target missing`,
    };
  }
  const group = await listTransferGroup(stripe, payout.id, `recovery recheck ${request.id}`);
  if (group === 'cannot_verify') return { outcome: 'cannot_verify', alert: null };

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
    return {
      outcome: `orphan_transfers:${ids}`.slice(0, 500),
      alert: `[recovery] ALERT: recheck for request ${request.id} found ${orphans.length} live transfer(s) (${ids}) for payout ${payout.id} which is ${state ?? 'unknown'}/${payout.status} on transfer ${payout.stripeTransferId ?? 'none'} — money moved outside the ledger after an operator disposition; operator reconciliation required`,
    };
  }
  return { outcome: 'clear', alert: null };
}
