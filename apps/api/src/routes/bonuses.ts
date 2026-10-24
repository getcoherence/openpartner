/**
 * Bonuses: pay a partner a reward that isn't tied to an attributed sale
 * (bonuses.ts, docs/bounties.md §5).
 *
 *   POST /bonuses      award one. Idempotent on `externalRef`.
 *   GET  /bonuses      list, newest first, keyset-paginated.
 *   GET  /bonuses/:id  one bonus and its commission.
 *
 * `bonuses:write` (admin sessions have it implicitly) awards; reads also
 * take `commissions:read`, which the Network federation key holds. The
 * source is never taken from the body: the brand's Network federation key
 * awards `network` bonuses, everyone else `manual` ones. Performance-bounty
 * bonuses come only from the bounty sweep.
 *
 * POST /bonuses moves money, so it sits behind the go-live and
 * plan-required gates (middleware/approval-gate.ts, trial-gate.ts).
 */

import { Router, type Request } from 'express';
import type { Knex } from 'knex';
import { z } from '../zod.js';
import { TABLES, type BonusRow, type CommissionRow } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth } from '../auth.js';
import {
  BONUS_SOURCES,
  MAX_BONUS_EXTERNAL_REF_LENGTH,
  MAX_BONUS_NOTE_LENGTH,
  awardBonus,
  type AwardBonusError,
} from '../bonuses.js';
import { currencyInputSchema } from '../currency.js';
import { getNetworkMembership } from '../network-client.js';
import { cursorTimestamp, decodeCursor, takePage, whereAfterCursor } from '../pagination.js';
import { tenantOf } from '../tenancy.js';

export const bonusesRouter = Router();

/** Positive, under a billion. At most two decimals (the ledger's
 *  precision) is checked in the handler (`invalid_amount`): JSON Schema's
 *  multipleOf 0.01 fails on binary floats such as 0.07, so the published
 *  spec couldn't say it, and money is never silently rounded. */
const bonusAmount = z.number().positive().max(999_999_999.99);

function hasAtMostTwoDecimals(v: number): boolean {
  return Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
}

export const createBonusSchema = z.object({
  partnerId: z.string().min(1).max(64),
  /** The program it's paid under: its holdback applies, and earnings by
   *  program count it. */
  programId: z.string().min(1).max(64).optional(),
  amount: bonusAmount,
  currency: currencyInputSchema,
  /** Shown to the partner. */
  note: z.string().trim().min(1).max(MAX_BONUS_NOTE_LENGTH).optional(),
  /** Your idempotency key: a retry with the same value returns the
   *  original bonus (`replayed: true`) instead of paying twice. */
  externalRef: z.string().min(1).max(MAX_BONUS_EXTERNAL_REF_LENGTH).optional(),
  /** true: hold it for the program's holdback before it's approved.
   *  Default: approved now, paid in the next payout run. */
  hold: z.boolean().optional(),
});

export const listBonusesQuerySchema = z.object({
  partnerId: z.string().min(1).optional(),
  programId: z.string().min(1).optional(),
  bountyId: z.string().min(1).optional(),
  source: z.enum(BONUS_SOURCES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  cursor: z.string().optional(),
});

const ERROR_DETAIL: Record<AwardBonusError, string> = {
  partner_not_found: 'No partner with this id in this tenant.',
  partner_revoked: 'This partner is revoked. Reinstate them to pay a bonus.',
  program_not_found: 'No program with this id in this tenant.',
  external_ref_conflict:
    'externalRef was already used for a bonus with a different partner, program, amount or currency.',
};

bonusesRouter.post('/bonuses', requireAuth, grantScope('bonuses:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createBonusSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  if (!hasAtMostTwoDecimals(body.data.amount)) {
    return res.status(400).json({ error: 'invalid_amount', detail: 'amount must have at most two decimals.' });
  }

  const source = (await isNetworkKey(db, tenantId, req)) ? 'network' : 'manual';
  const result = await awardBonus(db, tenantId, { ...body.data, source, createdBy: actorOf(req) });
  if (!result.ok) {
    return res.status(result.status).json({
      error: result.error,
      detail: ERROR_DETAIL[result.error],
      ...(result.bonus ? { bonusId: result.bonus.id } : {}),
    });
  }
  res.status(result.replayed ? 200 : 201).json({
    ...(result.replayed ? { replayed: true } : {}),
    bonus: result.bonus,
    commission: result.commission,
  });
});

bonusesRouter.get('/bonuses', requireAuth, grantScope('commissions:read', 'bonuses:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const q = listBonusesQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

  const query = withCommission(db, tenantId).select(cursorTimestamp(db, 'b.createdAt')).limit(q.data.limit + 1);
  if (q.data.partnerId) query.andWhere('b.partnerId', q.data.partnerId);
  if (q.data.programId) query.andWhere('b.programId', q.data.programId);
  if (q.data.bountyId) query.andWhere('b.bountyId', q.data.bountyId);
  if (q.data.source) query.andWhere('b.source', q.data.source);
  if (q.data.cursor) {
    const cursor = decodeCursor(q.data.cursor);
    if (!cursor) return res.status(400).json({ error: 'invalid_cursor' });
    whereAfterCursor(query, 'b.createdAt', 'b.id', cursor);
  }
  const rows = (await query) as Array<BonusListRow & { _cursorTs: string }>;
  const { page, nextCursor } = takePage(rows, q.data.limit);
  res.json({ bonuses: page.map(withCommissionView), nextCursor });
});

bonusesRouter.get('/bonuses/:id', requireAuth, grantScope('commissions:read', 'bonuses:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const row = (await withCommission(db, tenantId).where('b.id', req.params.id).first()) as BonusListRow | undefined;
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ bonus: withCommissionView(row) });
});

type BonusListRow = BonusRow & {
  _commissionId: string;
  _status: CommissionRow['status'];
  _payoutId: string | null;
  _paidAt: Date | null;
};

/** A bonus with its commission's id and status. Tenant named explicitly as
 *  well as by RLS, like the commission lists. */
function withCommission(db: Knex, tenantId: string) {
  return db(`${TABLES.Bonus} as b`)
    .join(`${TABLES.Commission} as c`, 'c.bonusId', 'b.id')
    .where('b.tenantId', tenantId)
    .select('b.*', 'c.id as _commissionId', 'c.status as _status', 'c.payoutId as _payoutId', 'c.paidAt as _paidAt')
    .orderBy([
      { column: 'b.createdAt', order: 'desc' },
      { column: 'b.id', order: 'desc' },
    ]);
}

function withCommissionView(row: BonusListRow) {
  const { _commissionId, _status, _payoutId, _paidAt, ...bonus } = row;
  return {
    ...bonus,
    commission: { id: _commissionId, status: _status, payoutId: _payoutId, paidAt: _paidAt },
  };
}

/** The scoped key this brand registered with the OpenPartner Network
 *  (network-consent.ts isNetworkFederationCall, minus the metadata check). */
async function isNetworkKey(db: Knex, tenantId: string, req: Request): Promise<boolean> {
  const p = req.principal;
  if (!p || p.role !== 'admin' || p.source !== 'db') return false;
  const m = await getNetworkMembership(db, tenantId);
  return !!m?.scopedKeyId && m.scopedKeyId === p.apiKeyId;
}

/** Who awarded it: the admin's id for a portal session, else the API key's. */
function actorOf(req: Request): string | null {
  const p = req.principal;
  if (!p) return null;
  if (p.source === 'session' && p.role === 'admin') return p.adminId;
  if (p.source === 'db') return p.apiKeyId;
  return 'admin_api_key';
}
