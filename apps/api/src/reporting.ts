/**
 * Windowed reporting queries, shared by GET /admin/overview (optionally
 * filtered to one program) and GET /programs/stats (every program at
 * once), so a program's row on the Programs page matches the dashboard
 * filtered to that program.
 *
 * What belongs to a program:
 *   - a click, by Click.programId;
 *   - an attributed event, by Attribution.programId;
 *   - a commission, through its attribution's program, or for a bonus's
 *     commission (which has no attribution) through Bonus.programId, the
 *     convention GET /partners/:id/timeseries uses. A bonus with no
 *     program counts toward the tenant's totals only;
 *   - a partner, when enrolled in the program now (PartnerProgram) or with
 *     clicks, conversions or commission in it during the window, so a
 *     partner removed from a program after earning in it still shows up.
 *
 * Every query names tenantId itself rather than leaving tenant scope to
 * RLS: the privileged-pool fallback (DATABASE_URL_APP unset) bypasses RLS,
 * and under RLS only a query that says tenantId reaches a tenant-leading
 * index. The window is [since, until); `until` omitted means now.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import { byCurrency, byCurrencyAndStatus, currencySql } from './currency.js';

export interface ReportWindow {
  tenantId: string;
  since: Date;
  until?: Date;
  /** Only this program's activity. */
  programId?: string;
}

export const EVENT_CURRENCY = currencySql('"e"."currency"');
export const COMMISSION_CURRENCY = currencySql('"c"."currency"');
/** The program a commission belongs to, over commissionsIn's joins. */
export const COMMISSION_PROGRAM = 'coalesce("ca"."programId", "cb"."programId")';

export const COMMISSION_STATUSES = ['accrued', 'approved', 'paid', 'reversed'] as const;

/** Clicks in the window (unaliased "Click"). */
export function clicksIn(db: Knex, w: ReportWindow) {
  const q = db(TABLES.Click).where({ tenantId: w.tenantId }).where('ts', '>=', w.since);
  if (w.until) q.where('ts', '<', w.until);
  if (w.programId) q.where({ programId: w.programId });
  return q;
}

/** Attribution rows ("a") computed in the window. */
export function attributionsIn(db: Knex, w: ReportWindow) {
  const q = db(`${TABLES.Attribution} as a`).where('a.tenantId', w.tenantId).where('a.computedAt', '>=', w.since);
  if (w.until) q.where('a.computedAt', '<', w.until);
  if (w.programId) q.where('a.programId', w.programId);
  return q;
}

/** attributionsIn joined to each row's Event ("e"), for value and currency. */
export function attributedIn(db: Knex, w: ReportWindow) {
  return attributionsIn(db, w).join(`${TABLES.Event} as e`, 'e.id', 'a.eventId');
}

/** Commissions ("c") accrued in the window. With a program filter, or
 *  `joinProgram` for grouping by COMMISSION_PROGRAM, each is joined to its
 *  attribution ("ca") or bonus ("cb"). */
export function commissionsIn(db: Knex, w: ReportWindow, opts: { joinProgram?: boolean } = {}) {
  const q = db(`${TABLES.Commission} as c`).where('c.tenantId', w.tenantId).where('c.accruedAt', '>=', w.since);
  if (w.until) q.where('c.accruedAt', '<', w.until);
  if (w.programId || opts.joinProgram) {
    q.leftJoin(`${TABLES.Attribution} as ca`, function () {
      this.on('ca.id', 'c.attributionId').andOn('ca.tenantId', 'c.tenantId');
    }).leftJoin(`${TABLES.Bonus} as cb`, function () {
      this.on('cb.id', 'c.bonusId').andOn('cb.tenantId', 'c.tenantId');
    });
  }
  if (w.programId) q.whereRaw(`${COMMISSION_PROGRAM} = ?`, [w.programId]);
  return q;
}

/** Program enrollments (unaliased "PartnerProgram"). */
export function enrollmentsIn(db: Knex, w: ReportWindow) {
  const q = db(TABLES.PartnerProgram).where({ tenantId: w.tenantId });
  if (w.programId) q.where({ programId: w.programId });
  return q;
}

/** Each program's partner count, as the header defines it: its enrolled
 *  partners, plus the ones active in it during the window without being
 *  enrolled. Counting the remainder (an anti-join on the enrollment) keeps
 *  the window's clicks from being deduplicated wholesale, which sorts on
 *  disk at tens of thousands of partners. */
export async function programPartnerCounts(db: Knex, w: ReportWindow): Promise<Map<string, number>> {
  const activity = clicksIn(db, w)
    .select('programId', 'partnerId')
    .unionAll(attributionsIn(db, w).select('a.programId', 'a.partnerId'))
    .unionAll(
      commissionsIn(db, w, { joinProgram: true })
        .whereRaw(`${COMMISSION_PROGRAM} is not null`)
        .select(db.raw(`${COMMISSION_PROGRAM} as "programId"`), 'c.partnerId'),
    );
  const unenrolled = db
    .from(activity.as('act'))
    .distinct('act.programId', 'act.partnerId')
    .whereNotExists(
      db(`${TABLES.PartnerProgram} as g`)
        .where('g.tenantId', w.tenantId)
        .whereRaw('"g"."programId" = "act"."programId" and "g"."partnerId" = "act"."partnerId"')
        .select(db.raw('1')),
    );
  const rows = (await db
    .from(enrollmentsIn(db, w).select('programId', 'partnerId').unionAll(unenrolled).as('pp'))
    .groupBy('pp.programId')
    .select('pp.programId as programId')
    .count({ count: '*' })) as Array<{ programId: string; count: string }>;
  return new Map(rows.map((r) => [r.programId, Number(r.count)]));
}

export interface ProgramStats {
  programId: string;
  name: string;
  partners: number;
  clicks: number;
  /** Attribution rows, as GET /admin/overview counts them. */
  attributedEvents: number;
  attributedRevenueByCurrency: Record<string, number>;
  commissionByCurrency: Record<string, Record<string, number>>;
}

/** Every program in the tenant, newest first, with its activity over the
 *  window: five grouped queries, however many programs there are. Amounts
 *  stay per currency. */
export async function programStats(db: Knex, w: ReportWindow): Promise<ProgramStats[]> {
  const programs = (await db(TABLES.Program)
    .where({ tenantId: w.tenantId })
    .modify((q) => {
      if (w.programId) q.where({ id: w.programId });
    })
    .orderBy('createdAt', 'desc')
    .select('id', 'name')) as Array<{ id: string; name: string }>;
  const partners = await programPartnerCounts(db, w);
  const clicks = (await clicksIn(db, w).groupBy('programId').select('programId').count({ count: '*' })) as Array<{
    programId: string;
    count: string;
  }>;
  const attributed = (await attributedIn(db, w)
    .groupByRaw(`"a"."programId", ${EVENT_CURRENCY}`)
    .select(
      'a.programId as programId',
      db.raw(`${EVENT_CURRENCY} as currency`),
      db.raw('count(*) as events'),
      db.raw('sum(e.value * a.weight) as amount'),
    )) as Array<{ programId: string; currency: string; events: string; amount: string | null }>;
  const commissions = (await commissionsIn(db, w, { joinProgram: true })
    .whereRaw(`${COMMISSION_PROGRAM} is not null`)
    .groupByRaw(`${COMMISSION_PROGRAM}, "c"."status", ${COMMISSION_CURRENCY}`)
    .select(
      db.raw(`${COMMISSION_PROGRAM} as "programId"`),
      'c.status as status',
      db.raw(`${COMMISSION_CURRENCY} as currency`),
      db.raw('sum("c"."amount") as amount'),
    )) as Array<{ programId: string; status: string; currency: string; amount: string | null }>;

  const clicksBy = new Map(clicks.map((r) => [r.programId, Number(r.count)]));
  return programs.map((p) => {
    const mine = attributed.filter((r) => r.programId === p.id);
    return {
      programId: p.id,
      name: p.name,
      partners: partners.get(p.id) ?? 0,
      clicks: clicksBy.get(p.id) ?? 0,
      attributedEvents: mine.reduce((n, r) => n + Number(r.events), 0),
      attributedRevenueByCurrency: byCurrency(mine),
      commissionByCurrency: byCurrencyAndStatus(commissions.filter((r) => r.programId === p.id)),
    };
  });
}
