/**
 * Performance bounties (performance-bounties.ts, docs/bounties.md §7).
 *
 *   GET    /bounties               admin: list, optionally for one program
 *   POST   /bounties               admin: create (draft or active)
 *   GET    /bounties/:id           admin: one bounty
 *   PATCH  /bounties/:id           admin: edit; the goal locks once it pays
 *   GET    /bounties/:id/progress  admin: each eligible partner's metric
 *   GET    /me/bounties            partner: bounties they can earn, with
 *                                  their progress
 *
 * Once a bounty has awarded anything, only name, description, endsAt
 * (extend only) and status can change: the partners who earned it were
 * measured against the goal as it stood. Admin sessions and admin keys
 * only; no scope opens these.
 */

import { Router } from 'express';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { utcDateTime, z } from '../zod.js';
import { TABLES, renderBountySummary, type BonusRow, type BountyRow, type BountyStatus, type CommissionRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { currencyInputSchema } from '../currency.js';
import { CORRECTIVE_EVENT_TYPES } from '../performance-metric.js';
import {
  BOUNTY_GOAL_FIELDS,
  BOUNTY_METRICS,
  BOUNTY_SCOPES,
  BOUNTY_STATUSES,
  MAX_BOUNTY_DESCRIPTION_LENGTH,
  bountyProgress,
  eligiblePartners,
  reachesThreshold,
} from '../performance-bounties.js';
import { tenantOf } from '../tenancy.js';

export const bountiesRouter = Router();

const MONEY_METRICS = new Set(['revenue', 'commissions']);
/** Progress rows returned, highest first. */
const PROGRESS_LIMIT = 500;
/** Partners see an ended bounty for this long. */
const ENDED_VISIBLE_MS = 30 * 24 * 60 * 60 * 1000;

const twoDecimals = (v: number) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6;

const goalFields = {
  metric: z.enum(BOUNTY_METRICS),
  eventType: z.string().trim().min(1).max(255).nullable().optional(),
  threshold: z.number().positive().max(1e12),
  scope: z.enum(BOUNTY_SCOPES),
  rewardAmount: z.number().positive().max(999_999_999.99).refine(twoDecimals, 'at most two decimals'),
  currency: currencyInputSchema,
};

const editableFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().max(MAX_BOUNTY_DESCRIPTION_LENGTH).nullable().optional(),
  startsAt: utcDateTime(),
  endsAt: utcDateTime().nullable(),
  partnerIds: z.array(z.string().min(1).max(64)).min(1).max(10_000).nullable(),
};

export const createBountySchema = z.object({
  programId: z.string().min(1).max(64),
  ...editableFields,
  ...goalFields,
  scope: goalFields.scope.default('new'),
  startsAt: editableFields.startsAt.optional(),
  endsAt: editableFields.endsAt.optional(),
  partnerIds: editableFields.partnerIds.optional(),
  status: z.enum(['draft', 'active']).default('active'),
});

export const updateBountySchema = z
  .object({ ...editableFields, ...goalFields, status: z.enum(BOUNTY_STATUSES) })
  .partial();

interface GoalCheck {
  metric: (typeof BOUNTY_METRICS)[number];
  eventType?: string | null;
  threshold?: number;
  startsAt: Date;
  endsAt: Date | null;
}

/** Cross-field rules the column CHECKs also enforce, as readable 400s. */
function goalProblem(g: GoalCheck): string | null {
  if (g.eventType && !['conversions', 'revenue'].includes(g.metric)) return 'eventType applies to conversions and revenue only';
  if (g.eventType && (CORRECTIVE_EVENT_TYPES as readonly string[]).includes(g.eventType)) {
    return `${g.eventType} corrects a conversion; it can't be one`;
  }
  if (g.threshold !== undefined && !MONEY_METRICS.has(g.metric) && !Number.isInteger(g.threshold)) {
    return 'a count threshold must be a whole number';
  }
  if (g.threshold !== undefined && MONEY_METRICS.has(g.metric) && !twoDecimals(g.threshold)) {
    return 'an amount threshold has at most two decimals';
  }
  if (g.endsAt && g.endsAt <= g.startsAt) return 'endsAt must be after startsAt';
  return null;
}

/** Every id must be a partner of this tenant. */
async function unknownPartnerIds(db: Knex, tenantId: string, ids: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = (await db(TABLES.Partner).where({ tenantId }).whereIn('id', ids.slice(i, i + 1000)).select('id')) as Array<{ id: string }>;
    for (const r of rows) found.add(r.id);
  }
  return ids.filter((id) => !found.has(id));
}

/** The API shape: the row, its goal in words, and how many earned it. */
function view(b: BountyRow, awardedCount: number) {
  return { ...b, threshold: Number(b.threshold), summary: renderBountySummary(b), awardedCount };
}

async function awardCounts(db: Knex, tenantId: string, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = (await db(TABLES.Bonus)
    .where({ tenantId })
    .whereIn('bountyId', ids)
    .groupBy('bountyId')
    .select('bountyId')
    .count({ n: '*' })) as Array<{ bountyId: string; n: string | number }>;
  return new Map(rows.map((r) => [r.bountyId, Number(r.n)]));
}

// ---------- Admin ----------

bountiesRouter.get('/bounties', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const q = z
    .object({ programId: z.string().min(1).optional(), status: z.enum(BOUNTY_STATUSES).optional() })
    .safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const query = db<BountyRow>(TABLES.Bounty).where({ tenantId }).orderBy([
    { column: 'createdAt', order: 'desc' },
    { column: 'id', order: 'desc' },
  ]);
  if (q.data.programId) query.andWhere({ programId: q.data.programId });
  if (q.data.status) query.andWhere({ status: q.data.status });
  const rows = (await query) as BountyRow[];
  const counts = await awardCounts(db, tenantId, rows.map((b) => b.id));
  res.json({ bounties: rows.map((b) => view(b, counts.get(b.id) ?? 0)) });
});

bountiesRouter.post('/bounties', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createBountySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const d = body.data;
  const startsAt = d.startsAt ? new Date(d.startsAt) : new Date();
  const endsAt = d.endsAt ? new Date(d.endsAt) : null;
  const problem = goalProblem({ metric: d.metric, eventType: d.eventType, threshold: d.threshold, startsAt, endsAt });
  if (problem) return res.status(400).json({ error: 'invalid_bounty', detail: problem });

  const program = await db(TABLES.Program).where({ id: d.programId, tenantId }).first('id');
  if (!program) return res.status(404).json({ error: 'program_not_found' });
  const partnerIds = d.partnerIds ? [...new Set(d.partnerIds)] : null;
  if (partnerIds) {
    const unknown = await unknownPartnerIds(db, tenantId, partnerIds);
    if (unknown.length > 0) return res.status(400).json({ error: 'unknown_partner_ids', detail: unknown.slice(0, 20) });
  }

  const now = new Date();
  const [row] = (await db(TABLES.Bounty)
    .insert({
      id: ulid(),
      tenantId,
      programId: d.programId,
      name: d.name,
      description: d.description?.trim() || null,
      metric: d.metric,
      eventType: d.eventType ?? null,
      threshold: d.threshold,
      scope: d.scope,
      startsAt,
      endsAt,
      rewardAmount: d.rewardAmount.toFixed(2),
      currency: d.currency,
      partnerIds: partnerIds ? JSON.stringify(partnerIds) : null,
      status: d.status,
      createdAt: now,
      updatedAt: now,
    })
    .returning('*')) as BountyRow[];
  res.status(201).json({ bounty: view(row!, 0) });
});

bountiesRouter.get('/bounties/:id', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const b = await db<BountyRow>(TABLES.Bounty).where({ id: req.params.id, tenantId }).first();
  if (!b) return res.status(404).json({ error: 'not_found' });
  const counts = await awardCounts(db, tenantId, [b.id]);
  res.json({ bounty: view(b, counts.get(b.id) ?? 0) });
});

/** Where a status may go. An ended bounty comes back only while its end is
 *  still ahead (it was extended). */
const TRANSITIONS: Record<BountyStatus, BountyStatus[]> = {
  draft: ['active', 'archived'],
  active: ['ended', 'archived'],
  ended: ['active', 'archived'],
  archived: [],
};

bountiesRouter.patch('/bounties/:id', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = updateBountySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const d = body.data;
  const b = await db<BountyRow>(TABLES.Bounty).where({ id: req.params.id, tenantId }).forUpdate().first();
  if (!b) return res.status(404).json({ error: 'not_found' });

  const awarded = (await awardCounts(db, tenantId, [b.id])).get(b.id) ?? 0;
  if (awarded > 0) {
    const locked = [...BOUNTY_GOAL_FIELDS, 'startsAt', 'partnerIds'].filter((f) => f in d);
    const changed = locked.filter((f) => {
      const next = (d as Record<string, unknown>)[f];
      const current = (b as unknown as Record<string, unknown>)[f];
      if (f === 'startsAt') return new Date(next as string).getTime() !== new Date(current as Date).getTime();
      if (f === 'threshold' || f === 'rewardAmount') return Number(next) !== Number(current);
      return JSON.stringify(next ?? null) !== JSON.stringify(current ?? null);
    });
    if (changed.length > 0) {
      return res.status(409).json({
        error: 'bounty_locked',
        detail: `This bounty has paid ${awarded} ${awarded === 1 ? 'partner' : 'partners'}, so its goal can't change: ${changed.join(', ')}. Only the name, description, end date (later only) and status can.`,
      });
    }
    if ('endsAt' in d) {
      const next = d.endsAt ? new Date(d.endsAt) : null;
      const shortened = b.endsAt !== null && next !== null && next < new Date(b.endsAt);
      if (shortened) {
        return res.status(409).json({ error: 'bounty_locked', detail: "Partners have earned this bounty, so its end date can only move later." });
      }
    }
  }

  const startsAt = d.startsAt ? new Date(d.startsAt) : new Date(b.startsAt);
  const endsAt = 'endsAt' in d ? (d.endsAt ? new Date(d.endsAt) : null) : b.endsAt ? new Date(b.endsAt) : null;
  const problem = goalProblem({
    metric: d.metric ?? b.metric,
    eventType: 'eventType' in d ? d.eventType : b.eventType,
    threshold: d.threshold ?? Number(b.threshold),
    startsAt,
    endsAt,
  });
  if (problem) return res.status(400).json({ error: 'invalid_bounty', detail: problem });

  const now = new Date();
  const patch: Record<string, unknown> = { updatedAt: now };
  if (d.status && d.status !== b.status) {
    if (!TRANSITIONS[b.status].includes(d.status)) {
      return res.status(409).json({ error: 'invalid_transition', detail: `A ${b.status} bounty can't become ${d.status}.` });
    }
    if (d.status === 'active' && b.status === 'ended' && endsAt && endsAt <= now) {
      return res.status(409).json({ error: 'invalid_transition', detail: 'Move the end date later to reopen this bounty.' });
    }
    patch.status = d.status;
    patch.endedAt = d.status === 'ended' ? now : d.status === 'active' ? null : b.endedAt;
  }
  if (d.partnerIds !== undefined && d.partnerIds !== null) {
    const ids = [...new Set(d.partnerIds)];
    const unknown = await unknownPartnerIds(db, tenantId, ids);
    if (unknown.length > 0) return res.status(400).json({ error: 'unknown_partner_ids', detail: unknown.slice(0, 20) });
    patch.partnerIds = JSON.stringify(ids);
  } else if (d.partnerIds === null) {
    patch.partnerIds = null;
  }
  for (const f of ['name', 'metric', 'scope', 'currency'] as const) if (d[f] !== undefined) patch[f] = d[f];
  if ('description' in d) patch.description = d.description?.trim() || null;
  if ('eventType' in d) patch.eventType = d.eventType ?? null;
  if (d.threshold !== undefined) patch.threshold = d.threshold;
  if (d.rewardAmount !== undefined) patch.rewardAmount = d.rewardAmount.toFixed(2);
  if (d.startsAt) patch.startsAt = startsAt;
  if ('endsAt' in d) {
    patch.endsAt = endsAt;
    // A new end date gets its own "ending soon" email.
    if ((endsAt?.getTime() ?? null) !== (b.endsAt ? new Date(b.endsAt).getTime() : null)) patch.endingSoonNotifiedAt = null;
  }

  const [row] = (await db(TABLES.Bounty).where({ id: b.id, tenantId }).update(patch).returning('*')) as BountyRow[];
  res.json({ bounty: view(row!, awarded) });
});

bountiesRouter.get('/bounties/:id/progress', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const b = await db<BountyRow>(TABLES.Bounty).where({ id: req.params.id, tenantId }).first();
  if (!b) return res.status(404).json({ error: 'not_found' });

  const eligible = await eligiblePartners(db, b);
  const awards = (await db(`${TABLES.Bonus} as bo`)
    .join(`${TABLES.Commission} as c`, 'c.bonusId', 'bo.id')
    .join(`${TABLES.Partner} as p`, 'p.id', 'bo.partnerId')
    .where('bo.tenantId', tenantId)
    .andWhere('bo.bountyId', b.id)
    .select('bo.id as bonusId', 'bo.partnerId', 'bo.createdAt', 'c.id as commissionId', 'c.status', 'p.name', 'p.email')) as Array<{
    bonusId: string;
    partnerId: string;
    createdAt: Date;
    commissionId: string;
    status: CommissionRow['status'];
    name: string;
    email: string;
  }>;
  const awardOf = new Map(awards.map((a) => [a.partnerId, a]));
  // Everyone who can still earn it, plus anyone who already did.
  const people = new Map<string, { id: string; name: string; email: string }>();
  for (const p of eligible) people.set(p.id, p);
  for (const a of awards) if (!people.has(a.partnerId)) people.set(a.partnerId, { id: a.partnerId, name: a.name, email: a.email });
  const values = await bountyProgress(db, b, [...people.keys()]);

  const rows = [...people.values()]
    .map((p) => {
      const value = values.get(p.id) ?? 0;
      const award = awardOf.get(p.id);
      return {
        partnerId: p.id,
        name: p.name,
        email: p.email,
        value,
        reached: reachesThreshold(b, value),
        award: award
          ? { bonusId: award.bonusId, commissionId: award.commissionId, status: award.status, awardedAt: award.createdAt }
          : null,
      };
    })
    .sort((x, y) => y.value - x.value || x.name.localeCompare(y.name));
  res.json({
    bounty: view(b, awards.length),
    totals: {
      eligible: eligible.length,
      reached: rows.filter((r) => r.reached).length,
      awarded: awards.length,
    },
    partners: rows.slice(0, PROGRESS_LIMIT),
    truncated: rows.length > PROGRESS_LIMIT,
  });
});

// ---------- Partner ----------

/**
 * The bounties the calling partner can earn (or recently could), with
 * their progress. Only for a partner: the list is scoped to who is asking.
 */
bountiesRouter.get('/me/bounties', requireAuth, async (req, res) => {
  const p = req.principal;
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  if (p.role !== 'partner') return res.status(403).json({ error: 'forbidden' });
  const { db, tenantId } = tenantOf(req);
  const partnerId = p.partnerId;
  const now = new Date();

  const candidates = (await db(`${TABLES.Bounty} as b`)
    .join(`${TABLES.PartnerProgram} as pp`, (j) => j.on('pp.programId', 'b.programId').andOnVal('pp.partnerId', partnerId))
    .join(`${TABLES.Program} as pr`, 'pr.id', 'b.programId')
    .where('b.tenantId', tenantId)
    .whereIn('b.status', ['active', 'ended'])
    .andWhere('b.startsAt', '<=', now)
    .select('b.*', 'pr.name as programName')
    .orderBy([
      { column: 'b.endsAt', order: 'asc', nulls: 'last' },
      { column: 'b.id', order: 'asc' },
    ])) as Array<BountyRow & { programName: string }>;
  const mine = candidates.filter((b) => {
    if (b.partnerIds && !b.partnerIds.includes(partnerId)) return false;
    if (b.status !== 'ended') return true;
    const ended = b.endedAt ?? b.endsAt;
    return !ended || now.getTime() - new Date(ended).getTime() <= ENDED_VISIBLE_MS;
  });

  const awards = mine.length
    ? ((await db(`${TABLES.Bonus} as bo`)
        .join(`${TABLES.Commission} as c`, 'c.bonusId', 'bo.id')
        .where('bo.tenantId', tenantId)
        .andWhere('bo.partnerId', partnerId)
        .whereIn(
          'bo.bountyId',
          mine.map((b) => b.id),
        )
        .select('bo.bountyId', 'bo.id', 'bo.amount', 'bo.currency', 'bo.createdAt', 'c.status')) as Array<
        Pick<BonusRow, 'id' | 'amount' | 'currency' | 'createdAt'> & { bountyId: string; status: CommissionRow['status'] }
      >)
    : [];
  const awardOf = new Map(awards.map((a) => [a.bountyId, a]));

  const out = [];
  for (const b of mine) {
    const value = (await bountyProgress(db, b, [partnerId])).get(partnerId) ?? 0;
    const award = awardOf.get(b.id);
    out.push({
      id: b.id,
      programId: b.programId,
      programName: b.programName,
      name: b.name,
      description: b.description,
      summary: renderBountySummary(b),
      metric: b.metric,
      eventType: b.eventType,
      threshold: Number(b.threshold),
      scope: b.scope,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      rewardAmount: b.rewardAmount,
      currency: b.currency,
      status: b.status,
      progress: value,
      reached: reachesThreshold(b, value),
      award: award ? { bonusId: award.id, status: award.status, awardedAt: award.createdAt } : null,
    });
  }
  res.json({ bounties: out });
});
