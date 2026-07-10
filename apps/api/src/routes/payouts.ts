import { Router } from 'express';
import { TABLES, type PayoutRow } from '@openpartner/db';
import { requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { runPayouts } from '../payouts.js';
import { tenantOf } from '../tenancy.js';

export const payoutsRouter = Router();

payoutsRouter.post('/payouts/run', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const result = await runPayouts(db, tenantId);
  res.json(result);
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
