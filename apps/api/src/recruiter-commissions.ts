/**
 * Two-tier (recruiter) commissions — docs/two-tier-commissions.md.
 *
 * A partner who recruited another (Partner.recruitedByPartnerId) earns a
 * share of each commission the recruit earns in a program with
 * recruiterCommissionPercent set. The share is a Commission of its own:
 *
 *   partnerId           the recruiter
 *   attributionId       the recruit's commission's, so it belongs to the
 *                       same conversion. Refunds prorate it (refunds.ts walks
 *                       every commission on the conversion), fraud review
 *                       drops it with the rest, the platform fee counts it
 *                       on the commission side, and per-program reporting
 *                       books it under the program it was earned in.
 *   sourceCommissionId  the recruit's commission it is a share of
 *   metadata            { rateType: 'recruiter', recruiter: RecruiterTrace }
 *
 * Two levels only. A recruiter commission is computed from a recruit's own
 * commission and never spawns one, so the recruiter's own recruiter earns
 * nothing on it.
 *
 * It follows its source through the lifecycle:
 *   approval  approved together with the source, never before
 *             (approveRecruiterCommissions), so a recruiter isn't paid on a
 *             sale still inside the recruit's holdback.
 *   reversal  an admin reversing the source reverses it too, or records a
 *             refund_clawback when it was already paid
 *             (reverseRecruiterCommissions). A refund needs nothing here:
 *             applyRefund cuts both by the same share.
 *
 * Who earns: the recruit's recruiter, unless revoked when the commission
 * accrues; only on the recruit's events at or after recruitedAt, so setting
 * a recruiter never pays on past sales; and, when the program sets
 * recruiterCommissionMonths, only that long after recruitedAt.
 */

import { randomInt } from 'node:crypto';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type CommissionAdjustmentRow,
  type CommissionRow,
  type PartnerRow,
  type ProgramRow,
} from '@openpartner/db';
import { interlockCommissionReversal, whereNotClaimedByOpenIntent } from './funding/interlocks.js';

/** Commission.metadata.rateType on a recruiter commission. The fee meter
 *  reads rateType = 'percent' to tell a sale's commission; a recruiter's
 *  share never decides that, its source does. */
export const RECRUITER_RATE_TYPE = 'recruiter';

/** Commission.metadata.recruiter: what the share was worked out from. */
export interface RecruiterTrace {
  /** The program's recruiterCommissionPercent when it accrued. */
  percent: number;
  /** The recruit whose commission it is a share of. */
  recruitedPartnerId: string;
}

/** CommissionAdjustment.metadata.cause on the clawback recorded when the
 *  recruit's commission is reversed after the recruiter was paid. */
export const SOURCE_REVERSED_CAUSE = 'recruit_commission_reversed';

// Same month as attribution.ts's recurringMonths cap (365.25 / 12 days).
const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;

/** IN-list headroom: Postgres caps a statement at 65535 parameters. */
const CHUNK = 1000;

type SourceCommission = Pick<CommissionRow, 'id' | 'tenantId' | 'attributionId' | 'partnerId' | 'amount' | 'currency'>;

/** The program's recruiter share as a number, or null when it's off. */
export function recruiterPercent(program: Pick<ProgramRow, 'recruiterCommissionPercent'>): number | null {
  if (program.recruiterCommissionPercent == null) return null;
  const n = Number(program.recruiterCommissionPercent);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Does an event at `eventTs` pay the recruiter? From recruitedAt on, and
 *  within `months` of it when the program caps it. */
export function withinRecruitment(recruitedAt: Date, eventTs: Date, months: number | null): boolean {
  const start = new Date(recruitedAt).getTime();
  const at = new Date(eventTs).getTime();
  if (at < start) return false;
  return months == null || at - start <= months * MONTH_MS;
}

/** The recruiter's share of `amount`, in hundredths (Commission.amount's
 *  storage precision whatever the currency), rounded to the nearest. */
export function recruiterShareMinor(amount: string | number, percent: number): number {
  return Math.round((Math.round(Number(amount) * 100) * percent) / 100);
}

/**
 * Accrue the recruiter's share of `source`, a commission attributeEvent has
 * just written for the recruit. Null when nothing is owed: the program has
 * no recruiter share, the recruit has no recruiter (or the event predates
 * the recruitment or falls past its months), the recruiter is revoked, or
 * the share rounds to nothing.
 *
 * Reads the partners for the source's tenant explicitly, as attributeEvent
 * does, so a pool that bypasses RLS can't pay another brand's partner.
 */
export async function accrueRecruiterCommission(
  db: Knex,
  source: SourceCommission,
  program: Pick<ProgramRow, 'recruiterCommissionPercent' | 'recruiterCommissionMonths'>,
  eventTs: Date,
): Promise<CommissionRow | null> {
  const percent = recruiterPercent(program);
  if (percent === null || !source.attributionId) return null;

  const recruit = (await db<PartnerRow>(TABLES.Partner)
    .where({ tenantId: source.tenantId, id: source.partnerId })
    .first('recruitedByPartnerId', 'recruitedAt')) as Pick<PartnerRow, 'recruitedByPartnerId' | 'recruitedAt'> | undefined;
  if (!recruit?.recruitedByPartnerId || !recruit.recruitedAt) return null;
  if (!withinRecruitment(recruit.recruitedAt, eventTs, program.recruiterCommissionMonths)) return null;

  const recruiter = await db<PartnerRow>(TABLES.Partner)
    .where({ tenantId: source.tenantId, id: recruit.recruitedByPartnerId })
    .whereNull('revokedAt')
    .first('id');
  if (!recruiter) return null;

  const minor = recruiterShareMinor(source.amount, percent);
  if (minor <= 0) return null;

  const trace: RecruiterTrace = { percent, recruitedPartnerId: source.partnerId };
  const [row] = (await db(TABLES.Commission)
    .insert({
      id: ulid(),
      tenantId: source.tenantId,
      attributionId: source.attributionId,
      sourceCommissionId: source.id,
      partnerId: recruiter.id,
      amount: (minor / 100).toFixed(2),
      currency: source.currency,
      status: 'accrued',
      metadata: { rateType: RECRUITER_RATE_TYPE, recruiter: trace },
    })
    .returning('*')) as CommissionRow[];
  return row ?? null;
}

/**
 * Lock the conversion an attributed commission was earned on, before
 * approving or reversing it. refunds.ts locks the conversion first and then
 * every commission on it in id order; a recruiter's share can sort before
 * its source, so an approval or reversal that locked the source and then
 * its share could deadlock with a refund holding them the other way round.
 * Taking the conversion lock first serialises them. Nothing to lock for a
 * bonus's commission.
 */
export async function lockConversionOf(db: Knex, tenantId: string, commissionId: string): Promise<void> {
  const row = (await db(`${TABLES.Commission} as c`)
    .join(`${TABLES.Attribution} as a`, 'a.id', 'c.attributionId')
    .where('c.tenantId', tenantId)
    .andWhere('c.id', commissionId)
    .first('a.eventId')) as { eventId: string } | undefined;
  if (row) await db(TABLES.Event).where({ tenantId, id: row.eventId }).forUpdate().first('id');
}

/** The first commission of `c`'s refund chain (refunds.ts): itself, or the
 *  one a partial refund's replacement names as its root. A recruiter
 *  commission's sourceCommissionId always names a root. */
export function chainRootId(c: Pick<CommissionRow, 'id' | 'metadata'>): string {
  const root = (c.metadata as { refund?: { rootCommissionId?: unknown } } | null)?.refund?.rootCommissionId;
  return typeof root === 'string' && root ? root : c.id;
}

/** The roots of the recruits' own commissions among `commissions`. */
function sourceRoots(commissions: readonly CommissionRow[]): string[] {
  return [...new Set(commissions.filter((c) => !c.sourceCommissionId && c.attributionId).map(chainRootId))];
}

/**
 * Approve the accrued recruiter commissions of `approved`, commissions that
 * have just been approved (by an admin or the holdback sweep), in the same
 * transaction. Returns them, for commission.approved once it commits.
 */
export async function approveRecruiterCommissions(
  db: Knex,
  tenantId: string,
  approved: readonly CommissionRow[],
): Promise<CommissionRow[]> {
  const roots = sourceRoots(approved);
  const out: CommissionRow[] = [];
  for (let i = 0; i < roots.length; i += CHUNK) {
    const rows = (await db<CommissionRow>(TABLES.Commission)
      .where({ tenantId, status: 'accrued' })
      .whereIn('sourceCommissionId', roots.slice(i, i + CHUNK))
      .update({ status: 'approved' })
      .returning('*')) as CommissionRow[];
    out.push(...rows);
  }
  return out;
}

/**
 * May an admin approve this recruiter commission on its own? Only once the
 * recruit's commission is approved or paid: normally it is approved with
 * that commission, so this is the way out for one left behind. Checks the
 * whole source chain, since a partial refund may have replaced the root.
 */
export async function recruiterSourceSettled(db: Knex, tenantId: string, commission: CommissionRow): Promise<boolean> {
  if (!commission.sourceCommissionId) return true;
  const root = (await db<CommissionRow>(TABLES.Commission)
    .where({ tenantId, id: commission.sourceCommissionId })
    .first()) as CommissionRow | undefined;
  if (!root) return false;
  if (root.status === 'approved' || root.status === 'paid') return true;
  // Replacements sit on the root's attribution and partner (refunds.ts).
  const chain = (await db<CommissionRow>(TABLES.Commission)
    .where({ tenantId, partnerId: root.partnerId, attributionId: root.attributionId })
    .whereIn('status', ['approved', 'paid'])) as CommissionRow[];
  return chain.some((c) => chainRootId(c) === root.id);
}

export interface RecruiterReversal {
  /** Recruiter commissions flipped to reversed, for commission.reversed. */
  reversed: CommissionRow[];
  /** Paid ones: the refund_clawback each recorded, as a negative decimal. */
  clawbacks: Array<{ commissionId: string; partnerId: string; amount: string; currency: string }>;
  /** Ones a payout is moving right now. Reversing the source again once
   *  the payout settles finishes them (a paid one gets its clawback). */
  held: string[];
}

/**
 * Reverse the recruiter commissions of `reversed`, commissions an admin has
 * just reversed, in the same transaction. An accrued or approved one goes
 * through the same funding and payout-intent interlocks as the admin
 * reverse; a paid one stays paid (ledger history) and gets a
 * `refund_clawback` for what the recruiter still holds, which their next
 * manual or direct-Connect payout nets off (clawback-netting.ts).
 *
 * Convergent, like applyRefund: what a paid share still holds is worked out
 * from its adjustments, so running it again records nothing twice. The
 * reverse route runs it again for a source that is already reversed, which
 * finishes a share a payout was moving the first time.
 */
export async function reverseRecruiterCommissions(
  db: Knex,
  tenantId: string,
  reversed: readonly CommissionRow[],
): Promise<RecruiterReversal> {
  const out: RecruiterReversal = { reversed: [], clawbacks: [], held: [] };
  const roots = sourceRoots(reversed);
  if (roots.length === 0) return out;

  const live: CommissionRow[] = [];
  for (let i = 0; i < roots.length; i += CHUNK) {
    live.push(
      ...((await db<CommissionRow>(TABLES.Commission)
        .where({ tenantId })
        .whereIn('sourceCommissionId', roots.slice(i, i + CHUNK))
        .whereIn('status', ['accrued', 'approved', 'paid'])
        .orderBy('id')
        .forUpdate()) as CommissionRow[]),
    );
  }

  const flippable = live.filter((c) => c.status !== 'paid');
  if (flippable.length > 0) {
    const interlock = await interlockCommissionReversal(db, flippable.map((c) => c.id));
    const flipped = interlock.flippable.length
      ? ((await whereNotClaimedByOpenIntent(
          db,
          db<CommissionRow>(TABLES.Commission)
            .whereIn(`${TABLES.Commission}.id`, interlock.flippable)
            .where(`${TABLES.Commission}.tenantId`, tenantId)
            .whereIn('status', ['accrued', 'approved']),
        )
          .update({ status: 'reversed' })
          .returning('*')) as CommissionRow[])
      : [];
    out.reversed.push(...flipped);
    const done = new Set(flipped.map((c) => c.id));
    for (const c of flippable) {
      if (done.has(c.id)) continue;
      out.held.push(c.id);
      console.error(
        `[recruiter] ALERT: recruiter commission ${c.id} is in a payout, so it stayed ${c.status} when its source ${c.sourceCommissionId} was reversed — reverse the source again once the payout settles`,
      );
    }
  }

  const paid = live.filter((c) => c.status === 'paid');
  if (paid.length > 0) {
    const adjustments = (await db<CommissionAdjustmentRow>(TABLES.CommissionAdjustment)
      .where({ tenantId })
      .whereIn('commissionId', paid.map((c) => c.id))) as CommissionAdjustmentRow[];
    const adjustedMinor = new Map<string, number>();
    for (const a of adjustments) {
      adjustedMinor.set(a.commissionId, (adjustedMinor.get(a.commissionId) ?? 0) + Math.round(Number(a.amount) * 100));
    }
    for (const c of paid) {
      const heldMinor = Math.round(Number(c.amount) * 100) + (adjustedMinor.get(c.id) ?? 0);
      if (heldMinor <= 0) continue;
      const amount = (-heldMinor / 100).toFixed(2);
      await db(TABLES.CommissionAdjustment).insert({
        id: ulid(),
        tenantId,
        commissionId: c.id,
        amount,
        currency: c.currency,
        reason: 'refund_clawback',
        metadata: { cause: SOURCE_REVERSED_CAUSE, sourceCommissionId: c.sourceCommissionId },
        createdAt: new Date(),
      });
      out.clawbacks.push({ commissionId: c.id, partnerId: c.partnerId, amount, currency: c.currency });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recruitment
// ---------------------------------------------------------------------------

/**
 * Lock a partner and the recruiter about to be set on them, in id order,
 * before recruiterProblem reads them. Two requests making A and B each
 * other's recruiter at once would otherwise both pass the cycle check.
 */
export async function lockRecruitment(db: Knex, tenantId: string, partnerId: string, recruiterId: string): Promise<void> {
  await db(TABLES.Partner)
    .where({ tenantId })
    .whereIn('id', [partnerId, recruiterId])
    .orderBy('id')
    .forUpdate()
    .select('id');
}

/** Lowercase, without the look-alikes 0/o, 1/l/i. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 10;

function newRecruitCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** What a recruit code from a URL may look like before it is looked up. */
export const RECRUIT_CODE_PATTERN = /^[a-z0-9]{4,32}$/;

/**
 * The partner's recruit code, minted the first time it's asked for. Null
 * when the partner doesn't exist in this tenant. A collision with another
 * partner's code (31^10 codes) is retried inside a savepoint, so it can't
 * abort the caller's transaction.
 */
export async function ensureRecruitCode(db: Knex, tenantId: string, partnerId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = (await db<PartnerRow>(TABLES.Partner).where({ tenantId, id: partnerId }).first('recruitCode')) as
      | Pick<PartnerRow, 'recruitCode'>
      | undefined;
    if (!current) return null;
    if (current.recruitCode) return current.recruitCode;
    try {
      const code = newRecruitCode();
      const rows = (await db.transaction((trx) =>
        trx<PartnerRow>(TABLES.Partner)
          .where({ tenantId, id: partnerId })
          .whereNull('recruitCode')
          .update({ recruitCode: code })
          .returning('recruitCode'),
      )) as Array<Pick<PartnerRow, 'recruitCode'>>;
      if (rows[0]?.recruitCode) return rows[0].recruitCode;
      // Someone else minted one first: read theirs on the next pass.
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  throw new Error(`[recruiter] could not mint a recruit code for partner ${partnerId}`);
}

/** The partner a join-page `?ref=` names, if it names one that may still
 *  recruit (not revoked). */
export async function findRecruiterByCode(
  db: Knex,
  tenantId: string,
  code: string,
): Promise<Pick<PartnerRow, 'id' | 'name'> | undefined> {
  const normalized = code.trim().toLowerCase();
  if (!RECRUIT_CODE_PATTERN.test(normalized)) return undefined;
  return (await db<PartnerRow>(TABLES.Partner)
    .where({ tenantId, recruitCode: normalized })
    .whereNull('revokedAt')
    .first('id', 'name')) as Pick<PartnerRow, 'id' | 'name'> | undefined;
}

export type RecruiterProblem = 'recruiter_not_found' | 'recruiter_is_partner' | 'recruiter_revoked' | 'recruiter_cycle';

/**
 * Why `recruiterId` can't be set as `partnerId`'s recruiter, or null when it
 * can. `partnerId` is null for a partner not created yet. A pair recruiting
 * each other would each earn on the other's sales, so that's refused; with
 * two levels nothing longer can loop.
 */
export async function recruiterProblem(
  db: Knex,
  tenantId: string,
  partnerId: string | null,
  recruiterId: string,
): Promise<RecruiterProblem | null> {
  if (partnerId && recruiterId === partnerId) return 'recruiter_is_partner';
  const recruiter = (await db<PartnerRow>(TABLES.Partner)
    .where({ tenantId, id: recruiterId })
    .first('id', 'revokedAt', 'recruitedByPartnerId')) as
    | Pick<PartnerRow, 'id' | 'revokedAt' | 'recruitedByPartnerId'>
    | undefined;
  if (!recruiter) return 'recruiter_not_found';
  if (recruiter.revokedAt) return 'recruiter_revoked';
  if (partnerId && recruiter.recruitedByPartnerId === partnerId) return 'recruiter_cycle';
  return null;
}

export const RECRUITER_PROBLEM_DETAIL: Record<RecruiterProblem, string> = {
  recruiter_not_found: 'No partner with that id in this program.',
  recruiter_is_partner: 'A partner cannot recruit themselves.',
  recruiter_revoked: 'That partner is revoked, so they cannot recruit.',
  recruiter_cycle: 'That partner was recruited by this one. Two partners cannot recruit each other.',
};

// ---------------------------------------------------------------------------
// The recruiter's view
// ---------------------------------------------------------------------------

export interface RecruitSummary {
  id: string;
  name: string;
  /** When the recruitment started. */
  recruitedAt: string;
  status: 'active' | 'pending' | 'revoked';
  /** What the recruit has earned the recruiter so far, per currency: live
   *  recruiter commissions net of clawbacks, as decimal strings. */
  earned: Record<string, string>;
}

/** How many recruits one listing returns, newest first. */
export const RECRUITS_LIMIT = 200;

/** The recruiter's recruits, newest first, with what each earned them. */
export async function listRecruits(
  db: Knex,
  tenantId: string,
  recruiterId: string,
): Promise<{ recruits: RecruitSummary[]; total: number }> {
  const [count] = (await db(TABLES.Partner)
    .where({ tenantId, recruitedByPartnerId: recruiterId })
    .count({ n: '*' })) as Array<{ n: string | number }>;
  const partners = (await db<PartnerRow>(TABLES.Partner)
    .where({ tenantId, recruitedByPartnerId: recruiterId })
    .orderBy([
      { column: 'recruitedAt', order: 'desc' },
      { column: 'id', order: 'desc' },
    ])
    .limit(RECRUITS_LIMIT)
    .select('id', 'name', 'recruitedAt', 'activatedAt', 'revokedAt')) as Array<
    Pick<PartnerRow, 'id' | 'name' | 'recruitedAt' | 'activatedAt' | 'revokedAt'>
  >;

  const earned = new Map<string, Record<string, string>>();
  if (partners.length > 0) {
    const rows = (await db(`${TABLES.Commission} as o`)
      .join(`${TABLES.Commission} as s`, (j) => j.on('s.id', 'o.sourceCommissionId').andOn('s.tenantId', 'o.tenantId'))
      .leftJoin(
        db(TABLES.CommissionAdjustment)
          .where({ tenantId, reason: 'refund_clawback' })
          .groupBy('commissionId')
          .select('commissionId', db.raw('sum(amount) as clawback'))
          .as('adj'),
        'adj.commissionId',
        'o.id',
      )
      .where('o.tenantId', tenantId)
      .andWhere('o.partnerId', recruiterId)
      .whereNot('o.status', 'reversed')
      .whereIn('s.partnerId', partners.map((p) => p.id))
      .groupBy('s.partnerId', 'o.currency')
      .select(
        's.partnerId as recruitId',
        db.raw('upper(o.currency) as currency'),
        db.raw('sum(o.amount + coalesce(adj.clawback, 0)) as amount'),
      )) as Array<{ recruitId: string; currency: string; amount: string }>;
    for (const r of rows) {
      const byCurrency = earned.get(r.recruitId) ?? {};
      byCurrency[r.currency] = Number(r.amount).toFixed(2);
      earned.set(r.recruitId, byCurrency);
    }
  }

  return {
    total: Number(count?.n ?? 0),
    recruits: partners.map((p) => ({
      id: p.id,
      name: p.name,
      recruitedAt: new Date(p.recruitedAt!).toISOString(),
      status: p.revokedAt ? 'revoked' : p.activatedAt ? 'active' : 'pending',
      earned: earned.get(p.id) ?? {},
    })),
  };
}
