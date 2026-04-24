/**
 * Commission review queue.
 *
 * Lifecycle: accrued → approved → paid (via payout runner)
 *            accrued → reversed (chargeback, refund, fraud)
 *
 * Only admins can approve or reverse — partners can see their own queue but
 * not change state. Status transitions are enforced here; once paid, rows are
 * considered part of the immutable ledger (reversal should be a compensating
 * entry, not a mutation — TODO when we add refund handling).
 */

import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type CommissionRow } from '@openpartner/db';
import { db } from '../db.js';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';

const listQuerySchema = z.object({
  status: z.enum(['accrued', 'approved', 'paid', 'reversed']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const commissionsRouter = Router();

commissionsRouter.get(
  '/partners/:id/commissions',
  requireAuth,
  grantScope('commissions:read'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

    const query = db<CommissionRow>(TABLES.Commission)
      .where({ partnerId: req.params.id })
      .orderBy('accruedAt', 'desc')
      .limit(q.data.limit ?? 100);
    if (q.data.status) query.andWhere({ status: q.data.status });

    const commissions = await query;
    res.json({ commissions });
  },
);

commissionsRouter.get('/commissions', requireAuth, requireAdmin, async (req, res) => {
  const q = listQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

  const query = db<CommissionRow>(TABLES.Commission).orderBy('accruedAt', 'desc').limit(q.data.limit ?? 100);
  if (q.data.status) query.andWhere({ status: q.data.status });

  const commissions = await query;
  res.json({ commissions });
});

commissionsRouter.post('/commissions/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const updated = await db<CommissionRow>(TABLES.Commission)
    .where({ id: req.params.id, status: 'accrued' })
    .update({ status: 'approved' })
    .returning('*');
  if (updated.length === 0) {
    return res.status(409).json({ error: 'not_approvable', detail: 'must be in accrued state' });
  }
  res.json({ commission: updated[0] });
});

commissionsRouter.post('/commissions/:id/reverse', requireAuth, requireAdmin, async (req, res) => {
  const updated = await db<CommissionRow>(TABLES.Commission)
    .where({ id: req.params.id })
    .whereIn('status', ['accrued', 'approved'])
    .update({ status: 'reversed' })
    .returning('*');
  if (updated.length === 0) {
    return res.status(409).json({ error: 'not_reversible', detail: 'only accrued or approved commissions' });
  }
  res.json({ commission: updated[0] });
});
