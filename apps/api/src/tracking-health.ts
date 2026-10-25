/**
 * Tracking health: where partner clicks and conversions go missing, so a
 * leak shows up as a number instead of a dashboard that merely looks
 * plausible. Admin → Tracking health (routes/tracking-health.ts).
 *
 * Everything is derived from the raw tables on every read. Nothing is
 * stored, so a re-import or a replay reads the same answer, and the export
 * carries nothing extra (ClickLanding is raw and exported; TrackingIssue is
 * a deployment log and isn't).
 *
 *   funnel       the window's partner-link clicks, minus bots: how many
 *                landed on a page running the SDK (ClickLanding), were
 *                stitched to a user (Identity) and were credited with a
 *                conversion (Attribution). Coupon redemptions' synthetic
 *                clicks are left out: nobody clicked them.
 *   byBrowser    the same funnel per browser family and device. A browser
 *                whose stitch rate trails the others is where storage is
 *                being lost: Safari's 7-day cap, an in-app browser
 *                (Instagram, TikTok) with storage of its own.
 *   unattributed the window's conversions that credited nobody, by why:
 *                  no_click        the customer was never linked to a
 *                                  partner click. Includes every organic
 *                                  customer, so it's a ceiling on loss,
 *                                  not a measure of it.
 *                  excluded        linked only to clicks that can't earn:
 *                                  flagged as fraud, or a revoked partner.
 *                  outside_window  linked, but no click inside the
 *                                  program's attribution window.
 *                  other           a usable click in the window and still
 *                                  no credit: the event was recorded before
 *                                  the click was stitched, by a path that
 *                                  doesn't replay the backlog (a conversion
 *                                  call with the brand's own userId).
 *                The same order the engine checks in (attributeEvent).
 *                Account-wide, whatever the program filter: an event
 *                belongs to no program until it attributes.
 *   coupons      conversions a coupon took from a link: credited to a
 *                coupon's partner while the customer also had an in-window
 *                link click from another partner who could have earned it
 *                and got nothing.
 *   codes        per partner credited through a code, the customers credited
 *                in the window and how many of them came through the
 *                partner's code with no link click of the partner's behind
 *                it. A code that's nearly all clickless may have spread past
 *                the partner's audience (coupon sites, extensions); for a
 *                podcast it's normal.
 *   stripe       distinct Stripe events the catch-up job recovered after
 *                the webhook missed them (metadata.recoveredBy), when it runs.
 *   issues       input OpenPartner dropped (tracking-issues.ts).
 *   signals      when each integration last delivered anything.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import { CORRECTIVE_EVENT_TYPES } from './attribution.js';
import { parseUserAgent } from './ua-parse.js';
import { trackingIssuesSince, type TrackingIssueSummary } from './tracking-issues.js';

export const TRACKING_HEALTH_MAX_DAYS = 90;

/** attribution.ts's grace for a click stamped just after its conversion. */
const CLICK_AFTER_EVENT_GRACE = "interval '5 minutes'";

/** Browser rows shown; the rest fold into one "other" row. */
const MAX_BROWSER_ROWS = 12;

/** Partners listed in `codes`, most clickless customers first. */
const MAX_CODE_ROWS = 20;

export interface FunnelCounts {
  clicks: number;
  landed: number;
  stitched: number;
  converted: number;
}

export interface BrowserFunnel extends FunnelCounts {
  browser: string;
  device: string;
}

export type UnattributedReason = 'no_click' | 'excluded' | 'outside_window' | 'other';

export interface UnattributedRow {
  reason: UnattributedReason;
  events: number;
  /** Σ value per currency, for the events that carry one. Never summed across currencies. */
  value: Array<{ currency: string; amount: number }>;
}

export interface CodeShareRow {
  partnerId: string;
  partnerName: string;
  /** Distinct customers credited to the partner in the window. */
  customers: number;
  /** Of those, customers credited through the partner's code with no link
   *  click of the partner's before it. */
  codeOnly: number;
}

export interface TrackingHealth {
  window: { days: number; since: string; programId: string | null };
  funnel: FunnelCounts & { flagged: number; bots: number };
  /** False until any click has ever landed: the SDK's landing report
   *  isn't installed (or is turned off), so `landed` means nothing yet. */
  landingReported: boolean;
  byBrowser: BrowserFunnel[];
  unattributed: { events: number; byReason: UnattributedRow[] };
  coupons: { overrodeLink: number };
  codes: CodeShareRow[];
  stripe: { recovered: number };
  issues: TrackingIssueSummary[];
  signals: {
    lastClickAt: string | null;
    lastLandingAt: string | null;
    lastStitchAt: string | null;
    lastStripeEventAt: string | null;
    lastPostbackAt: string | null;
  };
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function trackingHealth(
  db: Knex,
  tenantId: string,
  opts: { days: number; programId?: string | null; now?: Date },
): Promise<TrackingHealth> {
  const days = Math.min(Math.max(Math.trunc(opts.days), 1), TRACKING_HEALTH_MAX_DAYS);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const programId = opts.programId ?? null;

  // One after another: `db` is usually the request's transaction, a single
  // connection, which pg runs one query at a time anyway.
  const clickRows = await clicksByUserAgent(db, tenantId, since, programId);
  const unattributed = await unattributedConversions(db, tenantId, since);
  const coupons = await couponOverrides(db, tenantId, since, programId);
  const codes = await codeShare(db, tenantId, since, programId);
  const recovered = await stripeRecovered(db, tenantId, since);
  const issues = await trackingIssuesSince(db, tenantId, since);
  const signals = await lastSignals(db, tenantId);
  const landingReported = await db(TABLES.ClickLanding).where({ tenantId }).first('clickId');

  const funnel = { clicks: 0, landed: 0, stitched: 0, converted: 0, flagged: 0, bots: 0 };
  const browsers = new Map<string, BrowserFunnel>();
  for (const row of clickRows) {
    funnel.flagged += row.flagged;
    const ua = parseUserAgent(row.userAgent);
    const clean = row.clicks - row.flagged;
    if (ua.device === 'bot') {
      funnel.bots += clean;
      continue;
    }
    funnel.clicks += clean;
    funnel.landed += row.landed;
    funnel.stitched += row.stitched;
    funnel.converted += row.converted;
    const key = `${ua.browser}|${ua.device}`;
    const b = browsers.get(key) ?? { browser: ua.browser, device: ua.device, clicks: 0, landed: 0, stitched: 0, converted: 0 };
    b.clicks += clean;
    b.landed += row.landed;
    b.stitched += row.stitched;
    b.converted += row.converted;
    browsers.set(key, b);
  }

  const sorted = [...browsers.values()].filter((b) => b.clicks > 0).sort((a, b) => b.clicks - a.clicks);
  const byBrowser = sorted.slice(0, MAX_BROWSER_ROWS);
  const rest = sorted.slice(MAX_BROWSER_ROWS);
  if (rest.length > 0) {
    byBrowser.push(
      rest.reduce<BrowserFunnel>(
        (acc, b) => ({
          ...acc,
          clicks: acc.clicks + b.clicks,
          landed: acc.landed + b.landed,
          stitched: acc.stitched + b.stitched,
          converted: acc.converted + b.converted,
        }),
        { browser: 'other', device: 'other', clicks: 0, landed: 0, stitched: 0, converted: 0 },
      ),
    );
  }

  return {
    window: { days, since: since.toISOString(), programId },
    funnel,
    landingReported: !!landingReported,
    byBrowser,
    unattributed,
    coupons: { overrodeLink: coupons },
    codes,
    stripe: { recovered },
    issues,
    signals,
  };
}

interface ClickAggregate {
  userAgent: string | null;
  clicks: number;
  flagged: number;
  landed: number;
  stitched: number;
  converted: number;
}

/**
 * The window's partner-link clicks grouped by user agent (far fewer rows
 * than clicks), each with how many landed, stitched and were credited.
 * Credited clicks come from one pass over the window's Attribution rows:
 * Attribution has no clickId index, and its rows for these clicks were all
 * computed after the window opened.
 */
async function clicksByUserAgent(
  db: Knex,
  tenantId: string,
  since: Date,
  programId: string | null,
): Promise<ClickAggregate[]> {
  const programFilter = programId ? 'and c."programId" = ?' : '';
  const { rows } = await db.raw<{ rows: ClickAggregate[] }>(
    `with credited as (
       select distinct a."clickId"
         from ?? a
        where a."tenantId" = ? and a."computedAt" >= ?
     )
     select c."userAgent",
            count(*)::int as clicks,
            count(*) filter (where c."fraudFlag" is not null)::int as flagged,
            count(l."clickId") filter (where c."fraudFlag" is null)::int as landed,
            count(*) filter (
              where c."fraudFlag" is null
                and exists (select 1 from ?? i where i."clickId" = c.id and i."tenantId" = c."tenantId")
            )::int as stitched,
            count(cr."clickId") filter (where c."fraudFlag" is null)::int as converted
       from ?? c
       left join ?? l on l."clickId" = c.id and l."tenantId" = c."tenantId"
       left join credited cr on cr."clickId" = c.id
      where c."tenantId" = ? and c.ts >= ? and c."linkId" is not null ${programFilter}
      group by c."userAgent"`,
    [
      TABLES.Attribution,
      tenantId,
      since,
      TABLES.Identity,
      TABLES.Click,
      TABLES.ClickLanding,
      tenantId,
      since,
      ...(programId ? [programId] : []),
    ],
  );
  return rows;
}

/**
 * The window's conversions with no Attribution row, each given the first
 * reason the engine would have stopped at. Corrective events (refunds,
 * disputes) are never attributed by design and are left out.
 */
async function unattributedConversions(
  db: Knex,
  tenantId: string,
  since: Date,
): Promise<TrackingHealth['unattributed']> {
  const corrective = [...CORRECTIVE_EVENT_TYPES];
  // Every Click and Program read names the tenant, so the plan uses the
  // tenant indexes whatever pool runs it (an RLS policy alone doesn't).
  const linked = `
    from ?? i
    join ?? c on c.id = i."clickId" and c."tenantId" = i."tenantId"
   where i."tenantId" = ev."tenantId" and i."userId" = ev."userId"`;
  const usable = `${linked}
     and c."fraudFlag" is null
     and not exists (select 1 from ?? p where p.id = c."partnerId" and p."tenantId" = c."tenantId" and p."revokedAt" is not null)`;
  const { rows } = await db.raw<{ rows: Array<{ reason: UnattributedReason; currency: string | null; events: number; amount: string | null }> }>(
    `with ev as (
       select e.id, e."tenantId", e."userId", e.ts, e.value, e.currency
         from ?? e
        where e."tenantId" = ? and e.ts >= ?
          and e.type not in (${corrective.map(() => '?').join(', ')})
          and not exists (select 1 from ?? a where a."eventId" = e.id and a."tenantId" = e."tenantId")
     ),
     reasoned as (
       select ev.*,
              case
                when not exists (select 1 ${linked}) then 'no_click'
                when not exists (select 1 ${usable}) then 'excluded'
                when not exists (
                  select 1 ${usable}
                     and exists (
                       select 1 from ?? pr
                        where pr.id = c."programId" and pr."tenantId" = c."tenantId"
                          and c.ts >= ev.ts - pr."attributionWindowDays" * interval '1 day'
                          and c.ts <= ev.ts + ${CLICK_AFTER_EVENT_GRACE}
                     )
                ) then 'outside_window'
                else 'other'
              end as reason
         from ev
     )
     select reason, upper(coalesce(currency, 'USD')) as currency,
            count(*)::int as events,
            sum(value) as amount
       from reasoned
      group by reason, upper(coalesce(currency, 'USD'))`,
    [
      TABLES.Event,
      tenantId,
      since,
      ...corrective,
      TABLES.Attribution,
      // linked
      TABLES.Identity,
      TABLES.Click,
      // usable = linked + partner
      TABLES.Identity,
      TABLES.Click,
      TABLES.Partner,
      // outside_window: usable + program
      TABLES.Identity,
      TABLES.Click,
      TABLES.Partner,
      TABLES.Program,
    ],
  );

  const order: UnattributedReason[] = ['no_click', 'excluded', 'outside_window', 'other'];
  const byReason = new Map<UnattributedReason, UnattributedRow>();
  let events = 0;
  for (const row of rows) {
    const entry = byReason.get(row.reason) ?? { reason: row.reason, events: 0, value: [] };
    entry.events += row.events;
    events += row.events;
    if (row.amount != null && Number(row.amount) !== 0) {
      entry.value.push({ currency: row.currency ?? 'USD', amount: Math.round(Number(row.amount) * 100) / 100 });
    }
    byReason.set(row.reason, entry);
  }
  for (const entry of byReason.values()) entry.value.sort((a, b) => b.amount - a.amount);
  return { events, byReason: order.filter((r) => byReason.has(r)).map((r) => byReason.get(r)!) };
}

/**
 * Conversions a coupon took from a link: the credited click is a coupon
 * redemption's synthetic click (no Link, landingUrl coupon://), and the
 * customer also had a link click inside that link's program window from
 * another partner who could have earned it (click not flagged, partner not
 * revoked) and got nothing on the conversion. A multi-touch split that
 * credits both isn't counted. Under last-click the redemption, stamped at
 * the moment of purchase, always wins that race.
 */
async function couponOverrides(db: Knex, tenantId: string, since: Date, programId: string | null): Promise<number> {
  const programFilter = programId ? 'and a."programId" = ?' : '';
  const { rows } = await db.raw<{ rows: Array<{ n: number }> }>(
    `select count(distinct a."eventId")::int as n
       from ?? a
       join ?? cc on cc.id = a."clickId" and cc."tenantId" = a."tenantId"
       join ?? e on e.id = a."eventId" and e."tenantId" = a."tenantId"
      where a."tenantId" = ? and e.ts >= ? ${programFilter}
        and cc."linkId" is null and cc."landingUrl" like 'coupon://%'
        and exists (
          select 1
            from ?? i
            join ?? lc on lc.id = i."clickId" and lc."tenantId" = i."tenantId"
            join ?? pr on pr.id = lc."programId" and pr."tenantId" = lc."tenantId"
           where i."tenantId" = a."tenantId" and i."userId" = e."userId"
             and lc."linkId" is not null and lc."fraudFlag" is null
             and lc."partnerId" <> cc."partnerId"
             and lc.ts <= e.ts + ${CLICK_AFTER_EVENT_GRACE}
             and lc.ts >= e.ts - pr."attributionWindowDays" * interval '1 day'
             and not exists (
               select 1 from ?? p where p.id = lc."partnerId" and p."tenantId" = lc."tenantId" and p."revokedAt" is not null
             )
             and not exists (
               select 1 from ?? a2 where a2."eventId" = a."eventId" and a2."tenantId" = a."tenantId" and a2."partnerId" = lc."partnerId"
             )
        )`,
    [
      TABLES.Attribution,
      TABLES.Click,
      TABLES.Event,
      tenantId,
      since,
      ...(programId ? [programId] : []),
      TABLES.Identity,
      TABLES.Click,
      TABLES.Program,
      TABLES.Partner,
      TABLES.Attribution,
    ],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Per partner credited through a code in the window: the customers credited
 * to them, and how many came through the partner's code (every touch the
 * partner holds on the conversion is a coupon redemption's synthetic click)
 * with no link click of the partner's, not flagged, before that conversion.
 * A conversion's rows under its first-computed model only, the live one
 * (priorConversions in attribution.ts), so a re-run under another model
 * doesn't blur it. Customers, not conversions, so one clickless customer's
 * renewals count once. Only partners with a code-credited conversion are
 * listed.
 */
async function codeShare(db: Knex, tenantId: string, since: Date, programId: string | null): Promise<CodeShareRow[]> {
  const corrective = [...CORRECTIVE_EVENT_TYPES];
  const programFilter = programId ? 'and a."programId" = ?' : '';
  const { rows } = await db.raw<{ rows: CodeShareRow[] }>(
    `with credited as (
       select a."partnerId", e."userId", e.ts,
              bool_and(c."linkId" is null and c."landingUrl" like 'coupon://%') as "viaCode"
         from ?? a
         join ?? e on e.id = a."eventId" and e."tenantId" = a."tenantId"
         join ?? c on c.id = a."clickId" and c."tenantId" = a."tenantId"
        where a."tenantId" = ? and e.ts >= ?
          and e.type not in (${corrective.map(() => '?').join(', ')})
          and a.model = (
            select a0.model from ?? a0
             where a0."eventId" = a."eventId" and a0."tenantId" = a."tenantId"
             order by a0."computedAt", a0.id
             limit 1
          )
          ${programFilter}
        group by a."partnerId", e.id, e."userId", e.ts
     ),
     code_only as (
       select distinct cr."partnerId", cr."userId"
         from credited cr
        where cr."viaCode"
          and not exists (
            select 1
              from ?? i
              join ?? lc on lc.id = i."clickId" and lc."tenantId" = i."tenantId"
             where i."tenantId" = ? and i."userId" = cr."userId"
               and lc."partnerId" = cr."partnerId"
               and lc."linkId" is not null and lc."fraudFlag" is null
               and lc.ts <= cr.ts + ${CLICK_AFTER_EVENT_GRACE}
          )
     )
     select cr."partnerId", p.name as "partnerName",
            count(distinct cr."userId")::int as customers,
            count(distinct co."userId")::int as "codeOnly"
       from credited cr
       join ?? p on p.id = cr."partnerId" and p."tenantId" = ?
       left join code_only co on co."partnerId" = cr."partnerId" and co."userId" = cr."userId"
      group by cr."partnerId", p.name
     having bool_or(cr."viaCode")
      order by count(distinct co."userId") desc, p.name
      limit ${MAX_CODE_ROWS}`,
    [
      TABLES.Attribution,
      TABLES.Event,
      TABLES.Click,
      tenantId,
      since,
      ...corrective,
      TABLES.Attribution,
      ...(programId ? [programId] : []),
      TABLES.Identity,
      TABLES.Click,
      tenantId,
      TABLES.Partner,
      tenantId,
    ],
  );
  return rows;
}

/** Stripe events the catch-up recorded after the webhook missed them:
 *  distinct Stripe events, not Event rows (a paid checkout records two). */
async function stripeRecovered(db: Knex, tenantId: string, since: Date): Promise<number> {
  const [row] = (await db(TABLES.Event)
    .where({ tenantId })
    .andWhere('ts', '>=', since)
    .whereRaw(`"metadata"->>'recoveredBy' = 'stripe_catchup'`)
    .countDistinct({ n: db.raw(`"metadata"->>'stripeEventId'`) })) as Array<{ n: string | number }>;
  return Number(row?.n ?? 0);
}

async function lastSignals(db: Knex, tenantId: string): Promise<TrackingHealth['signals']> {
  const click = await db(TABLES.Click).where({ tenantId }).whereNotNull('linkId').max({ at: 'ts' }).first();
  const landing = await db(TABLES.ClickLanding).where({ tenantId }).max({ at: 'landedAt' }).first();
  const stitch = await db(TABLES.Identity).where({ tenantId }).max({ at: 'stitchedAt' }).first();
  const stripe = await db(TABLES.Event)
    .where({ tenantId })
    .whereRaw(`"metadata"->>'stripeEventId' is not null`)
    .max({ at: 'ts' })
    .first();
  const postback = await db(TABLES.ConversionPostbackToken)
    .where({ tenantId })
    .whereNull('revokedAt')
    .max({ at: 'lastUsedAt' })
    .first();
  return {
    lastClickAt: iso(click?.at),
    lastLandingAt: iso(landing?.at),
    lastStitchAt: iso(stitch?.at),
    lastStripeEventAt: iso(stripe?.at),
    lastPostbackAt: iso(postback?.at),
  };
}
