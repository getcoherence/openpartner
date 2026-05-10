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
import { TABLES, type AttributionRow, type ProgramRow, type CommissionRow } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { dispatchEvent } from '../webhook-dispatcher.js';
import { tenantOf } from '../tenancy.js';

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
    const { db } = tenantOf(req);
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

    const query = listQueryBase(db).where('c.partnerId', req.params.id).limit(q.data.limit ?? 100);
    if (q.data.status) query.andWhere('c.status', q.data.status);
    const commissions = await query;
    res.json({ commissions: commissions.map(decorateMaturity) });
  },
);

commissionsRouter.get('/commissions', requireAuth, grantScope('commissions:read'), requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const q = listQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

  const query = listQueryBase(db).limit(q.data.limit ?? 100);
  if (q.data.status) query.andWhere('c.status', q.data.status);
  const commissions = await query;
  res.json({ commissions: commissions.map(decorateMaturity) });
});

/** Shared base query — joins Commission → Attribution → Campaign and
 *  picks the effective holdback. Effective = the partner's snapshotted
 *  value (from approval-time federation) with fallback to the
 *  campaign's value for legacy / non-Network partners. The UI uses
 *  this to show "Matures in N days" badges and to disable the approve
 *  button while holdback is active. */
function listQueryBase(db: import('knex').Knex) {
  return db(`${TABLES.Commission} as c`)
    .leftJoin(`${TABLES.Attribution} as a`, 'a.id', 'c.attributionId')
    .leftJoin(`${TABLES.Program} as cp`, 'cp.id', 'a.programId')
    .leftJoin(`${TABLES.PartnerCommission} as pc`, 'pc.partnerId', 'c.partnerId')
    .select('c.*')
    .select(db.raw('coalesce("pc"."holdbackDays", "cp"."holdbackDays") as "_holdbackDays"'))
    .select('cp.id as _campaignId')
    .select('cp.name as _campaignName')
    .orderBy('c.accruedAt', 'desc');
}

interface DecoratedCommission extends CommissionRow {
  holdbackDays: number | null;
  programId: string | null;
  campaignName: string | null;
  matureAt: string | null;
}

function decorateMaturity(row: CommissionRow & {
  _holdbackDays: number | null;
  _campaignId: string | null;
  _campaignName: string | null;
}): DecoratedCommission {
  const { _holdbackDays, _campaignId, _campaignName, ...c } = row;
  let matureAt: string | null = null;
  if (_holdbackDays && _holdbackDays > 0) {
    const m = new Date(c.accruedAt);
    m.setUTCDate(m.getUTCDate() + _holdbackDays);
    matureAt = m.toISOString();
  }
  return {
    ...c,
    holdbackDays: _holdbackDays,
    programId: _campaignId,
    campaignName: _campaignName,
    matureAt,
  };
}

commissionsRouter.post('/commissions/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);

  // Holdback check: if the campaign tied to this commission has a
  // holdbackDays > 0, refuse to approve before accruedAt + holdbackDays.
  // Lookup is Commission → Attribution → Campaign (Attribution carries
  // programId directly).
  const c0 = await db<CommissionRow>(TABLES.Commission).where({ id: req.params.id }).first();
  if (!c0) return res.status(404).json({ error: 'not_found' });
  const attr = await db<AttributionRow>(TABLES.Attribution).where({ id: c0.attributionId }).first();
  if (attr) {
    const camp = await db<ProgramRow>(TABLES.Program).where({ id: attr.programId }).first();
    const holdback = camp?.holdbackDays ?? 0;
    if (holdback > 0) {
      const matureAt = new Date(c0.accruedAt);
      matureAt.setUTCDate(matureAt.getUTCDate() + holdback);
      if (matureAt > new Date()) {
        return res.status(409).json({
          error: 'holdback_active',
          detail: `Commission can't be approved until ${matureAt.toISOString()} (campaign holdback: ${holdback} days from accrual).`,
          matureAt: matureAt.toISOString(),
          holdbackDays: holdback,
        });
      }
    }
  }

  const updated = await db<CommissionRow>(TABLES.Commission)
    .where({ id: req.params.id, status: 'accrued' })
    .update({ status: 'approved' })
    .returning('*');
  if (updated.length === 0) {
    return res.status(409).json({ error: 'not_approvable', detail: 'must be in accrued state' });
  }
  const c = updated[0]!;
  dispatchEvent(tenantId, 'commission.approved', {
    commissionId: c.id,
    partnerId: c.partnerId,
    amount: c.amount,
    currency: c.currency,
    attributionId: c.attributionId,
  });
  res.json({ commission: c });
});

commissionsRouter.post('/commissions/:id/reverse', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const updated = await db<CommissionRow>(TABLES.Commission)
    .where({ id: req.params.id })
    .whereIn('status', ['accrued', 'approved'])
    .update({ status: 'reversed' })
    .returning('*');
  if (updated.length === 0) {
    return res.status(409).json({ error: 'not_reversible', detail: 'only accrued or approved commissions' });
  }
  const c = updated[0]!;
  dispatchEvent(tenantId, 'commission.reversed', {
    commissionId: c.id,
    partnerId: c.partnerId,
    amount: c.amount,
    currency: c.currency,
  });
  res.json({ commission: c });
});
