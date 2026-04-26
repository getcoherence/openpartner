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
