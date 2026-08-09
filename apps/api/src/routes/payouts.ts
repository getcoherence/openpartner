import { Router } from 'express';
import { TABLES, type PayoutRow } from '@openpartner/db';
import { requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { db as privilegedDb } from '../db.js';
import { runPayouts } from '../payouts.js';
import { executePayoutTransfers } from '../payout-transfers.js';
import { tenantOf, withTenantTransaction } from '../tenancy.js';

export const payoutsRouter = Router();

/**
 * Admin "run payouts". Deliberately does NOT use `req.db`: the request
 * transaction stays open until the response is written, and money must
 * never move inside a transaction that can still roll back (audit #10 —
 * a failed commit after a successful transfer used to re-run under a new
 * payout id, i.e. a new idempotency key, i.e. a double-pay).
 *
 * So: plan in a transaction of its own and COMMIT the intents, then post
 * the transfers outside any transaction, then report the merged outcome.
 */
payoutsRouter.post('/payouts/run', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  const result = await withTenantTransaction(tenantId, (trx) => runPayouts(trx, tenantId));
  // Intents are committed now. Post their transfers on the privileged
  // pool (no transaction can span a Stripe call), scoped to this tenant
  // so an admin's click can't advance another tenant's payouts.
  const transfers = await executePayoutTransfers(privilegedDb, { tenantId });
  // Fold the executor's verdict back into the planner's rows so the
  // response still answers "what happened to each payout".
  for (const p of result.payouts) {
    if (transfers.confirmed.some((c) => c.payoutId === p.payoutId)) {
      p.status = 'paid';
      continue;
    }
    const failed = transfers.failed.find((f) => f.payoutId === p.payoutId);
    if (failed) {
      p.status = 'failed';
      p.error = failed.error;
      continue;
    }
    const canceled = transfers.canceled.find((c) => c.payoutId === p.payoutId);
    if (canceled) {
      p.status = 'failed';
      p.error = canceled.reason;
    }
  }
  res.json({ ...result, transfers });
});

/**
 * Manual-rail confirmation. runPayouts creates manual payouts as
 * 'pending' with commissions already marked paid (the operator accepted
 * responsibility for the transfer); this endpoint is the operator saying
 * "I actually sent it" — the payout becomes 'paid' with a completion
 * timestamp, which is what revenue reporting and the Network payout
 * aggregation count.
 */
payoutsRouter.post('/payouts/:id/confirm', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const updated = await db<PayoutRow>(TABLES.Payout)
    .where({ id: req.params.id, method: 'manual', status: 'pending' })
    .update({ status: 'paid', completedAt: new Date() })
    .returning('*');
  if (updated.length === 0) {
    const existing = await db<PayoutRow>(TABLES.Payout).where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'payout_not_found' });
    return res.status(409).json({
      error: 'not_confirmable',
      detail: `only pending manual payouts can be confirmed (this one is ${existing.method}/${existing.status})`,
    });
  }
  // No webhook here: payout.created + commission.paid already fired when
  // runPayouts wrote the row — confirmation is bookkeeping, not a new event.
  res.json({ payout: updated[0]! });
});

payoutsRouter.get(
  '/partners/:id/payouts',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db } = tenantOf(req);
    const payouts = await db<PayoutRow>(TABLES.Payout)
      .where({ partnerId: req.params.id })
      .orderBy('createdAt', 'desc')
      .limit(200);
    res.json({ payouts });
  },
);
