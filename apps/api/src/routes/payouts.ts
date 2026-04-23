import { Router } from 'express';
import { TABLES, type PayoutRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { runPayouts } from '../payouts.js';

export const payoutsRouter = Router();

payoutsRouter.post('/payouts/run', requireAuth, requireAdmin, async (_req, res) => {
  const result = await runPayouts();
  res.json(result);
});

payoutsRouter.get(
  '/partners/:id/payouts',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const payouts = await db<PayoutRow>(TABLES.Payout)
      .where({ partnerId: req.params.id })
      .orderBy('createdAt', 'desc')
      .limit(200);
    res.json({ payouts });
  },
);
