/**
 * Commission review queue.
 *
 * Lifecycle: accrued → approved → paid (via payout runner)
 *            accrued → reversed (chargeback, refund, fraud)
 *
 * Only admins can approve or reverse — partners can see their own queue but
 * not change state.
 *
 * A recruiter commission (two-tier, recruiter-commissions.ts) follows the
 * recruit's commission it is a share of: approving or reversing that one
 * does the same to it, and it can't be approved on its own before that one
 * is approved. Status transitions are enforced here; once paid, rows are
 * part of the immutable ledger and this route refuses them. A refund of a
 * paid commission is a compensating CommissionAdjustment instead
 * (refunds.ts, via POST /attribution/refunds or Stripe's charge.refunded).
 */

import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from '../zod.js';
import { TABLES, type CommissionRow } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { dispatchCommissionEvents } from '../commission-events.js';
import { onCommit } from '../on-commit.js';
import { cursorTimestamp, decodeCursor, takePage, whereAfterCursor } from '../pagination.js';
import { tenantOf } from '../tenancy.js';
import { interlockCommissionReversal, whereNotClaimedByOpenIntent } from '../funding/interlocks.js';
import { EFFECTIVE_HOLDBACK_SQL } from '../partner-commission.js';
import {
  approveRecruiterCommissions,
  lockConversionOf,
  recruiterSourceSettled,
  reverseRecruiterCommissions,
  type RecruiterReversal,
  type RecruiterTrace,
} from '../recruiter-commissions.js';

/**
 * List query for both commission lists:
 *   - ?status=…  — filter to one lifecycle state
 *   - ?limit=N   — page size (1-500, default 100)
 *   - ?cursor=…  — opaque cursor returned by the previous page
 *
 * Returns { commissions, nextCursor }; nextCursor is null on the last
 * page. Ordered accruedAt DESC, id DESC — same keyset scheme as
 * GET /partners (see pagination.ts).
 */
export const listQuerySchema = z.object({
  status: z.enum(['accrued', 'approved', 'paid', 'reversed']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  cursor: z.string().optional(),
});

export const commissionsRouter = Router();

commissionsRouter.get(
  '/partners/:id/commissions',
  requireAuth,
  grantScope('commissions:read'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

    const result = await listPage(db, tenantId, q.data, req.params.id);
    if (!result) return res.status(400).json({ error: 'invalid_cursor' });
    res.json(result);
  },
);

commissionsRouter.get('/commissions', requireAuth, grantScope('commissions:read'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const q = listQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

  const result = await listPage(db, tenantId, q.data);
  if (!result) return res.status(400).json({ error: 'invalid_cursor' });
  res.json(result);
});

/** One page of commissions, optionally for a single partner. Null when
 *  the cursor doesn't decode. */
async function listPage(db: Knex, tenantId: string, q: z.infer<typeof listQuerySchema>, partnerId?: string) {
  const query = listQueryBase(db, tenantId).select(cursorTimestamp(db, 'c.accruedAt')).limit(q.limit + 1);
  if (partnerId) query.where('c.partnerId', partnerId);
  if (q.status) query.andWhere('c.status', q.status);
  if (q.cursor) {
    const cursor = decodeCursor(q.cursor);
    if (!cursor) return null;
    whereAfterCursor(query, 'c.accruedAt', 'c.id', cursor);
  }
  const rows = (await query) as Array<Parameters<typeof decorateMaturity>[0] & { _cursorTs: string }>;
  const { page, nextCursor } = takePage(rows, q.limit);
  return { commissions: page.map(decorateMaturity), nextCursor };
}

/** Shared base query — joins Commission → Attribution → Event and
 *  → Campaign (or, for a bonus's commission, Commission → Bonus →
 *  Program), names the partner, and
 *  picks the effective holdback (EFFECTIVE_HOLDBACK_SQL): the partner's
 *  snapshot scoped to this program (pcp) if one exists, falling back to
 *  the program's own value when it leaves holdback unset; else their
 *  partner-wide snapshot (pcw); else the program's value. Same expression
 *  as the auto-approve job (commission-auto-approve.ts). The UI uses this
 *  to show "Matures in N days" badges and to disable the approve button
 *  while holdback is active.
 *
 *  Filters on the tenant explicitly: RLS scopes `db`, but a multi-tenant
 *  pool that bypasses RLS (no app role) would otherwise list every
 *  tenant's commissions. */
function listQueryBase(db: Knex, tenantId: string) {
  // A commission has exactly one of the two (a CHECK says so), so the
  // coalesce is "the commission's program" either way.
  const programId = db.raw('coalesce(a."programId", b."programId")');
  return db(`${TABLES.Commission} as c`)
    .where('c.tenantId', tenantId)
    .leftJoin(`${TABLES.Attribution} as a`, 'a.id', 'c.attributionId')
    .leftJoin(`${TABLES.Event} as e`, (j) => j.on('e.id', 'a.eventId').andOn('e.tenantId', 'c.tenantId'))
    // No foreign key holds a commission's partner, so a left join: a
    // missing partner lists with a null name rather than vanishing.
    .leftJoin(`${TABLES.Partner} as p`, (j) => j.on('p.id', 'c.partnerId').andOn('p.tenantId', 'c.tenantId'))
    .leftJoin(`${TABLES.Bonus} as b`, 'b.id', 'c.bonusId')
    // The recruit, on a recruiter commission: the attribution's partner.
    .leftJoin(`${TABLES.Partner} as rp`, (j) =>
      j.on('rp.id', 'a.partnerId').andOn('rp.tenantId', 'c.tenantId').andOnNotNull('c.sourceCommissionId'),
    )
    .leftJoin(`${TABLES.Bounty} as bt`, 'bt.id', 'b.bountyId')
    .leftJoin(`${TABLES.Program} as cp`, 'cp.id', programId)
    .leftJoin(`${TABLES.PartnerCommission} as pcp`, (j) =>
      j.on('pcp.partnerId', 'c.partnerId').andOn('pcp.programId', programId),
    )
    .leftJoin(`${TABLES.PartnerCommission} as pcw`, (j) =>
      j.on('pcw.partnerId', 'c.partnerId').andOnNull('pcw.programId'),
    )
    .select('c.*')
    .select(db.raw(`${EFFECTIVE_HOLDBACK_SQL} as "_holdbackDays"`))
    .select('cp.id as _campaignId')
    .select('cp.name as _campaignName')
    .select('p.name as _partnerName', 'e.type as _eventType')
    .select(
      'b.source as _bonusSource',
      'b.note as _bonusNote',
      'b.bountyId as _bonusBountyId',
      'bt.name as _bonusBountyName',
      'a.partnerId as _recruitId',
      'rp.name as _recruitName',
    )
    .orderBy([
      { column: 'c.accruedAt', order: 'desc' },
      { column: 'c.id', order: 'desc' },
    ]);
}

interface DecoratedCommission extends CommissionRow {
  /** Who earned it, so an admin list needn't show an id. */
  partnerName: string | null;
  holdbackDays: number | null;
  programId: string | null;
  campaignName: string | null;
  matureAt: string | null;
  /** What it was earned on: an attributed sale, or a bonus. */
  source: 'attribution' | 'bonus';
  /** The attributed event's type (`trial_started`, `invoice_paid`, a
   *  custom type…); null on a bonus's commission. */
  eventType: string | null;
  /** The bonus behind a `bonus` commission; null otherwise. */
  bonus: { id: string; source: string; note: string | null; bountyId: string | null; bountyName: string | null } | null;
  /** A recruiter commission's recruit and share; null otherwise. Its
   *  `source` is `attribution`: it was earned on the recruit's sale. */
  recruiter: {
    sourceCommissionId: string;
    recruitedPartnerId: string | null;
    recruitedPartnerName: string | null;
    percent: number | null;
  } | null;
}

function decorateMaturity(row: CommissionRow & {
  _partnerName: string | null;
  _eventType: string | null;
  _holdbackDays: number | null;
  _campaignId: string | null;
  _campaignName: string | null;
  _bonusSource: string | null;
  _bonusNote: string | null;
  _bonusBountyId: string | null;
  _bonusBountyName: string | null;
  _recruitId: string | null;
  _recruitName: string | null;
}): DecoratedCommission {
  const {
    _partnerName,
    _eventType,
    _holdbackDays,
    _campaignId,
    _campaignName,
    _bonusSource,
    _bonusNote,
    _bonusBountyId,
    _bonusBountyName,
    _recruitId,
    _recruitName,
    ...c
  } = row;
  let matureAt: string | null = null;
  // A recruiter commission matures with its source, not on a clock of its own.
  if (!c.sourceCommissionId && _holdbackDays && _holdbackDays > 0) {
    const m = new Date(c.accruedAt);
    m.setUTCDate(m.getUTCDate() + _holdbackDays);
    matureAt = m.toISOString();
  }
  return {
    ...c,
    partnerName: _partnerName,
    holdbackDays: _holdbackDays,
    programId: _campaignId,
    campaignName: _campaignName,
    matureAt,
    source: c.bonusId ? 'bonus' : 'attribution',
    eventType: c.bonusId ? null : _eventType,
    bonus: c.bonusId
      ? { id: c.bonusId, source: _bonusSource ?? 'manual', note: _bonusNote, bountyId: _bonusBountyId, bountyName: _bonusBountyName }
      : null,
    recruiter: c.sourceCommissionId
      ? {
          sourceCommissionId: c.sourceCommissionId,
          recruitedPartnerId: _recruitId,
          recruitedPartnerName: _recruitName,
          percent: recruiterTraceOf(c.metadata)?.percent ?? null,
        }
      : null,
  };
}

function recruiterTraceOf(metadata: unknown): RecruiterTrace | null {
  const trace = (metadata as { recruiter?: Partial<RecruiterTrace> } | null)?.recruiter;
  return trace && typeof trace.percent === 'number' ? (trace as RecruiterTrace) : null;
}

commissionsRouter.post('/commissions/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);

  // Holdback check: refuse to approve before accruedAt + the effective
  // holdback. Read through listQueryBase so the guard uses exactly the
  // holdback the review queue shows (EFFECTIVE_HOLDBACK_SQL: the partner's
  // own terms first, then the program's), the same expression the auto-approve job
  // applies. Checking only the program's value let an admin approve a
  // commission the partner's own (longer) holdback still covered.
  const row = await listQueryBase(db, tenantId).where('c.id', req.params.id).first();
  if (!row) return res.status(404).json({ error: 'not_found' });
  // The conversion first, as refunds.ts takes it, so approving this and
  // its recruiter's share can't deadlock with a refund of the sale.
  await lockConversionOf(db, tenantId, req.params.id!);
  const { holdbackDays, matureAt } = decorateMaturity(row);
  if ((row as CommissionRow).sourceCommissionId && !(await recruiterSourceSettled(db, tenantId, row as CommissionRow))) {
    return res.status(409).json({
      error: 'source_not_approved',
      detail: "A recruiter commission is approved with the recruit's commission it is a share of. Approve that one first.",
      sourceCommissionId: (row as CommissionRow).sourceCommissionId,
    });
  }
  if (matureAt && new Date(matureAt) > new Date()) {
    return res.status(409).json({
      error: 'holdback_active',
      detail: `Commission can't be approved until ${matureAt} (holdback: ${holdbackDays} days from accrual).`,
      matureAt,
      holdbackDays,
    });
  }

  const updated = await db<CommissionRow>(TABLES.Commission)
    .where({ id: req.params.id, tenantId, status: 'accrued' })
    .update({ status: 'approved' })
    .returning('*');
  if (updated.length === 0) {
    return res.status(409).json({ error: 'not_approvable', detail: 'must be in accrued state' });
  }
  const c = updated[0]!;
  const recruiterCommissions = await approveRecruiterCommissions(db, tenantId, [c]);
  // After COMMIT, so a receiver reading the commission sees it approved.
  // Not awaited: the origin lookup needn't hold up the response.
  onCommit(db, 'commission.approved webhook', () =>
    void dispatchCommissionEvents(tenantId, 'commission.approved', [c, ...recruiterCommissions]),
  );
  res.json({ commission: c, ...(recruiterCommissions.length > 0 ? { recruiterCommissions } : {}) });
});

commissionsRouter.post('/commissions/:id/reverse', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  // The conversion first, as on approve: a refund locks it before the
  // commissions on it, so reversing this and its recruiter's share waits
  // for a refund in progress instead of deadlocking with it.
  await lockConversionOf(db, tenantId, req.params.id!);
  // Funding interlock (spec §8): a commission whose money is mid-transfer
  // cannot be flipped; one still in a reserved allocation gets the
  // allocation canceled first so no charge/transfer fires for it.
  const interlock = await interlockCommissionReversal(db, [req.params.id!]);
  if (interlock.held.length > 0) {
    return res.status(409).json({
      error: 'commission_in_transfer',
      detail:
        'a payout for this commission is in flight (funding transfer, or a committed Connect payout intent); retry once it settles, then claw back via adjustment',
    });
  }
  // Re-assert the interlock INSIDE the update. The check above is a
  // separate statement, and between the two the payout planner can commit
  // an intent and claim this commission — after which reversing it would
  // let the transfer go out for the frozen amount with the commission
  // never marked paid.
  const updated = await whereNotClaimedByOpenIntent(
    db,
    db<CommissionRow>(TABLES.Commission)
      .where({ [`${TABLES.Commission}.id`]: req.params.id, [`${TABLES.Commission}.tenantId`]: tenantId })
      .whereIn('status', ['accrued', 'approved']),
  )
    .update({ status: 'reversed' })
    .returning('*');
  if (updated.length === 0) {
    const current = await db<CommissionRow>(TABLES.Commission).where({ id: req.params.id, tenantId }).first();
    if (current && ['accrued', 'approved'].includes(current.status)) {
      // Status was fine, so the guard is what refused: a payout intent
      // claimed it in the gap.
      return res.status(409).json({
        error: 'commission_in_transfer',
        detail: 'a payout intent claimed this commission while the request was in flight; retry once it settles',
      });
    }
    // Already reversed: finish its recruiter's share if a payout was moving
    // it the first time (recruiter-commissions.ts). Convergent, so a share
    // already reversed or clawed back is left alone.
    if (current?.status === 'reversed') {
      const recruiter = await reverseRecruiterCommissions(db, tenantId, [current]);
      if (recruiterOutcome(recruiter)) {
        onCommit(db, 'commission.reversed webhook', () =>
          void dispatchCommissionEvents(tenantId, 'commission.reversed', recruiter.reversed, { reason: 'manual' }),
        );
        return res.json({ commission: current, recruiterCommissions: recruiterOutcome(recruiter) });
      }
    }
    return res.status(409).json({ error: 'not_reversible', detail: 'only accrued or approved commissions' });
  }
  const c = updated[0]!;
  // Its recruiter's share goes with it (recruiter-commissions.ts).
  const recruiter = await reverseRecruiterCommissions(db, tenantId, [c]);
  onCommit(db, 'commission.reversed webhook', () =>
    void dispatchCommissionEvents(tenantId, 'commission.reversed', [c, ...recruiter.reversed], { reason: 'manual' }),
  );
  const outcome = recruiterOutcome(recruiter);
  res.json({ commission: c, ...(outcome ? { recruiterCommissions: outcome } : {}) });
});

/** The reverse response's recruiterCommissions, or null when there was
 *  no share to act on. */
function recruiterOutcome(r: RecruiterReversal) {
  if (r.reversed.length + r.clawbacks.length + r.held.length === 0) return null;
  return { reversed: r.reversed, clawbacks: r.clawbacks, heldInTransfer: r.held };
}
