/**
 * Operator-recovery API — decision B (audit handoff §0.4).
 *
 * The durable half of a 2am incident: an admin records the recovery
 * decision as an append-only `OperatorRecoveryRequest`, gets ONE inline
 * apply for instant feedback, and the scheduler retries anything the
 * inline pass could not settle. Durability is the INSERT, not the
 * response — a request that answers `cannot_verify` at 2am is not lost,
 * it is pending, and the machinery keeps trying with the operator's
 * decision on the record.
 *
 * Tenant scoping: the insert goes through the tenant transaction (RLS
 * enforced), and the target-exists check runs on `req.db` so an admin can
 * only ever name a target in their own tenant. The apply loop re-checks
 * the same boundary on the privileged pool (operator-recovery.ts).
 *
 * Like /payouts/run, the inline apply deliberately does NOT use `req.db`:
 * money-adjacent state must never move inside a transaction that can still
 * roll back, and the operator functions call Stripe between their own
 * short transactions.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  TABLES,
  type HostedFundingBatchRow,
  type OperatorRecoveryKind,
  type OperatorRecoveryRail,
  type OperatorRecoveryRequestRow,
  type PayoutRow,
} from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { db as privilegedDb } from '../db.js';
import { applyRecoveryRequests } from '../operator-recovery.js';
import { tenantOf, withTenantTransaction } from '../tenancy.js';

export const recoveryRouter = Router();

const payoutRecoverySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('release_intent_for_retry'),
    /** The keyGeneration the operator OBSERVED on the held intent — the
     *  fence that keeps two operators (or an operator and a concurrent
     *  reconcile) from both handing out an epoch. */
    observedGeneration: z.number().int().min(0),
    note: z.string().max(2000).optional(),
  }),
  z.object({
    kind: z.literal('dispose_intent'),
    reason: z.string().min(1).max(500),
    note: z.string().max(2000).optional(),
  }),
  z.object({
    kind: z.literal('resolve_duplicate_review'),
    keptTransferId: z.string().min(1).max(64).optional(),
    allReversed: z.literal(true).optional(),
    note: z.string().max(2000).optional(),
  }),
]);

const batchRecoverySchema = z.object({
  kind: z.literal('force_release_batch'),
  reason: z.string().min(1).max(500),
  note: z.string().max(2000).optional(),
});

/** Who is asking, as a stable audit string. Session admins resolve to
 *  their email (the id survives in the session row either way); API keys
 *  and the bootstrap env key are named as what they are. */
async function requestedByOf(req: Request): Promise<string> {
  const principal = req.principal;
  if (principal && principal.role === 'admin') {
    if (principal.source === 'session') {
      const { db } = tenantOf(req);
      const admin = (await db(TABLES.Admin)
        .where({ id: principal.adminId })
        .first(['email'])) as { email: string } | undefined;
      return admin?.email ?? `admin:${principal.adminId}`;
    }
    if (principal.source === 'db') return `api_key:${principal.apiKeyId}`;
    return 'env_admin_key';
  }
  return 'unknown';
}

interface InsertSpec {
  rail: OperatorRecoveryRail;
  kind: OperatorRecoveryKind;
  targetId: string;
  params: Record<string, unknown>;
  note: string | undefined;
}

/**
 * Shared tail of both POST routes: duplicate-pending guard, durable
 * insert, one inline apply scoped to the new request, synchronous verdict.
 */
async function createAndApply(req: Request, res: Response, spec: InsertSpec): Promise<void> {
  const { db, tenantId } = tenantOf(req);

  // One pending decision per (target, kind). Not a fence — the apply loop
  // serializes for real — just a guard against a double-submitted form
  // producing two rows that both claim the same decision.
  const existing = (await db(TABLES.OperatorRecoveryRequest)
    .where({ tenantId, targetId: spec.targetId, kind: spec.kind, status: 'pending' })
    .first(['id'])) as { id: string } | undefined;
  if (existing) {
    res.status(409).json({ error: 'request_already_pending', requestId: existing.id });
    return;
  }

  const requestedBy = await requestedByOf(req);
  const id = ulid();
  // Durability is THIS commit. Everything after it is best-effort feedback.
  await withTenantTransaction(tenantId, async (trx) => {
    await trx(TABLES.OperatorRecoveryRequest).insert({
      id,
      tenantId,
      rail: spec.rail,
      kind: spec.kind,
      targetId: spec.targetId,
      params: JSON.stringify(spec.params),
      requestedBy,
      note: spec.note ?? null,
      status: 'pending',
    });
  });

  // ONE inline apply, scoped to this request, on the privileged pool. The
  // response reports whatever it settled to — including "still pending"
  // (retryable outcome, or the scheduler tick won the claim race).
  await applyRecoveryRequests(privilegedDb, {
    rail: spec.rail,
    tenantId,
    requestId: id,
  });

  const request = (await db(TABLES.OperatorRecoveryRequest)
    .where({ id })
    .first()) as OperatorRecoveryRequestRow | undefined;
  res.status(201).json({ request: request ? publicRequest(request) : { id, status: 'pending' } });
}

/** The row minus operational plumbing (lease columns). */
function publicRequest(row: OperatorRecoveryRequestRow): Record<string, unknown> {
  return {
    id: row.id,
    rail: row.rail,
    kind: row.kind,
    targetId: row.targetId,
    params: row.params,
    requestedBy: row.requestedBy,
    note: row.note,
    status: row.status,
    outcome: row.outcome,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    recheckDueAt: row.recheckDueAt,
    recheckOutcome: row.recheckOutcome,
    appliedAt: row.appliedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

recoveryRouter.post('/payouts/:id/recovery', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = payoutRecoverySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  }
  const data = body.data;
  if (data.kind === 'resolve_duplicate_review') {
    // Exactly one disposition. zod can't express the XOR across two
    // optionals without contorting the shape, so it's checked here.
    if ((data.keptTransferId !== undefined) === (data.allReversed === true)) {
      return res.status(400).json({
        error: 'invalid_body',
        detail: 'provide exactly one of keptTransferId or allReversed: true',
      });
    }
  }

  // Existence check, tenant-filtered explicitly AND scoped by RLS — this
  // is what makes a cross-tenant target unreachable through the front
  // door (the apply loop re-checks the same boundary on the privileged
  // pool regardless).
  const targetId = req.params.id!;
  const payout = (await db<PayoutRow>(TABLES.Payout)
    .where({ id: targetId, tenantId })
    .first(['id'])) as Pick<PayoutRow, 'id'> | undefined;
  if (!payout) return res.status(404).json({ error: 'payout_not_found' });

  const params: Record<string, unknown> =
    data.kind === 'release_intent_for_retry'
      ? { observedGeneration: data.observedGeneration }
      : data.kind === 'dispose_intent'
        ? { reason: data.reason }
        : data.keptTransferId !== undefined
          ? { keptTransferId: data.keptTransferId }
          : { allReversed: true };
  await createAndApply(req, res, {
    rail: 'direct_connect',
    kind: data.kind,
    targetId,
    params,
    note: data.note,
  });
});

recoveryRouter.post('/funding/batches/:id/recovery', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = batchRecoverySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  }
  const targetId = req.params.id!;
  const batch = (await db<HostedFundingBatchRow>(TABLES.HostedFundingBatch)
    .where({ id: targetId, tenantId })
    .first(['id'])) as Pick<HostedFundingBatchRow, 'id'> | undefined;
  if (!batch) return res.status(404).json({ error: 'batch_not_found' });

  await createAndApply(req, res, {
    rail: 'hosted_funding',
    kind: 'force_release_batch',
    targetId,
    params: { reason: body.data.reason },
    note: body.data.note,
  });
});

recoveryRouter.get('/recovery-requests', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const targetId = typeof req.query.targetId === 'string' ? req.query.targetId : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const requests = (await db(TABLES.OperatorRecoveryRequest)
    .where({ tenantId })
    .modify((qb) => {
      if (targetId) qb.where({ targetId });
      if (status) qb.where({ status });
    })
    .orderBy('createdAt', 'desc')
    .limit(200)) as OperatorRecoveryRequestRow[];
  res.json({ requests: requests.map(publicRequest) });
});
