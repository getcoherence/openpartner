/**
 * Performance bounties: a goal on a program that pays a bonus once a partner
 * reaches it (docs/bounties.md §7), e.g. "10 new sales between Nov 1 and
 * Dec 31 earns $500".
 *
 * Measured by an hourly sweep, never inline in attributeEvent: that would
 * put a cross-row aggregate on the conversion hot path, with the same race
 * tiers have. The sweep runs per tenant through the scheduler's
 * forEachActiveTenant (one transaction each):
 *
 *   1. Every `active` bounty that has started, until 7 days after its
 *      endsAt (the grace catches late conversions and backlog replays), is
 *      measured for each eligible partner without an award. Reaching the
 *      threshold pays the reward through awardBonus with source
 *      'performance_bounty' and externalRef bounty:<bountyId>:<partnerId>.
 *      That ref is unique, so overlapping sweeps award once: tiers have no
 *      per-partner lock (docs/commission-slabs.md), and this needs none.
 *      The bonus is held for the program's holdback.
 *   2. Past the grace, the bounty is marked `ended`.
 *   3. Partner emails ("bounty started", "ending soon", "you earned it")
 *      are stamped on the bounty and returned for the caller to send once
 *      the transaction commits (sendBountyEmails).
 *
 * At approval the holdback auto-approve job re-checks the goal
 * (bountyStillMet): if refunds have pushed the partner back under it, the
 * commission is reversed (reason bounty_requalification) instead.
 *
 * Who is eligible: partners granted the bounty's program (PartnerProgram),
 * not revoked, and in `partnerIds` when the bounty has an allowlist. A
 * partner earns a bounty once.
 *
 * What counts (performance-metric.ts, the query tiers share): the partner's
 * attributions in the program, weighted by their share, fraud-flagged
 * clicks excluded, corrective events never counted, net of refunds:
 *   leads        signup and trial_started events
 *   conversions  events of `eventType`, or with a value above 0
 *   revenue      Σ value × share in the bounty's currency (no FX)
 *   commissions  Σ the partner's live attribution commissions in the
 *                bounty's currency; a bonus never counts, so a bounty can't
 *                feed itself
 * over [startsAt, endsAt) for scope `new`, or all history before endsAt for
 * `lifetime` (partners who already qualify are awarded on the first sweep).
 */

import type { Knex } from 'knex';
import {
  TABLES,
  formatBountyAmount,
  formatBountyValue,
  renderBountySummary,
  type BountyMetric,
  type BountyRow,
  type BountyScope,
  type BountyStatus,
  type PartnerRow,
  type TenantRow,
} from '@openpartner/db';
import { awardBonus } from './bonuses.js';
import { resolveBrandName } from './brand-name.js';
import { bountyAwardedEmail, bountyEndingSoonEmail, bountyStartedEmail } from './email-templates.js';
import { getMailer } from './mailer.js';
import { performanceByPartner, type PerformanceQuery } from './performance-metric.js';
import { getPortalBaseUrl } from './portal-url.js';
import { withTenantTransaction } from './tenancy.js';

export const BOUNTY_METRICS = ['conversions', 'revenue', 'leads', 'commissions'] as const satisfies readonly BountyMetric[];
export const BOUNTY_SCOPES = ['new', 'lifetime'] as const satisfies readonly BountyScope[];
export const BOUNTY_STATUSES = ['draft', 'active', 'ended', 'archived'] as const satisfies readonly BountyStatus[];
/** Lead events (the dashboard's definition). */
export const LEAD_EVENT_TYPES = ['signup', 'trial_started'];
/** Fields that are locked once a bounty has awarded anything. */
export const BOUNTY_GOAL_FIELDS = ['metric', 'eventType', 'threshold', 'scope', 'rewardAmount', 'currency'] as const;
export const MAX_BOUNTY_DESCRIPTION_LENGTH = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long after endsAt the sweep keeps measuring. */
export const BOUNTY_GRACE_MS = 7 * DAY_MS;
/** "Ending soon" goes out this long before endsAt. */
export const ENDING_SOON_MS = 7 * DAY_MS;
/** Partners measured per query. */
const PARTNER_CHUNK = 1000;

export function bountyExternalRef(bountyId: string, partnerId: string): string {
  return `bounty:${bountyId}:${partnerId}`;
}

type BountyGoal = Pick<
  BountyRow,
  'tenantId' | 'programId' | 'metric' | 'eventType' | 'threshold' | 'scope' | 'startsAt' | 'endsAt' | 'currency'
>;

/** The metric query that measures partners against `b`. */
export function bountyMetricQuery(b: BountyGoal, partnerIds: readonly string[] | null): PerformanceQuery {
  const base = {
    tenantId: b.tenantId,
    programId: b.programId,
    partnerIds,
    window: {
      start: b.scope === 'new' ? new Date(b.startsAt) : null,
      end: b.endsAt ? new Date(b.endsAt) : null,
    },
    netOfRefunds: true,
  };
  switch (b.metric) {
    case 'leads':
      return { ...base, events: LEAD_EVENT_TYPES, measure: 'count' };
    case 'conversions':
      return { ...base, events: b.eventType ? [b.eventType] : 'sales', measure: 'count' };
    case 'revenue':
      return { ...base, events: b.eventType ? [b.eventType] : 'sales', measure: 'value', currency: b.currency };
    case 'commissions':
      return { ...base, events: 'all', measure: 'commissions', currency: b.currency };
  }
}

/** Metric precision, as tiers: four decimals of a conversion or a unit. */
function roundMetric(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Each partner's metric against `b` (absent = 0), rounded. */
export async function bountyProgress(db: Knex, b: BountyGoal, partnerIds: readonly string[] | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const chunks: Array<readonly string[] | null> = [];
  if (partnerIds === null) chunks.push(null);
  else for (let i = 0; i < partnerIds.length; i += PARTNER_CHUNK) chunks.push(partnerIds.slice(i, i + PARTNER_CHUNK));
  for (const chunk of chunks) {
    for (const [id, v] of await performanceByPartner(db, bountyMetricQuery(b, chunk))) out.set(id, roundMetric(v));
  }
  return out;
}

export function reachesThreshold(b: Pick<BountyRow, 'threshold'>, value: number): boolean {
  return value >= Number(b.threshold);
}

export type EligiblePartner = Pick<PartnerRow, 'id' | 'name' | 'email' | 'portalAccess' | 'activatedAt'>;

/** Partners who can earn `b`: granted its program, not revoked, and on its
 *  allowlist when it has one. */
export async function eligiblePartners(db: Knex, b: Pick<BountyRow, 'tenantId' | 'programId' | 'partnerIds'>): Promise<EligiblePartner[]> {
  if (b.partnerIds && b.partnerIds.length === 0) return [];
  const q = db(`${TABLES.Partner} as p`)
    .join(`${TABLES.PartnerProgram} as pp`, 'pp.partnerId', 'p.id')
    .where('p.tenantId', b.tenantId)
    .andWhere('pp.programId', b.programId)
    .whereNull('p.revokedAt')
    .distinct('p.id', 'p.name', 'p.email', 'p.portalAccess', 'p.activatedAt')
    .orderBy('p.id');
  if (b.partnerIds) q.whereIn('p.id', b.partnerIds);
  return (await q) as EligiblePartner[];
}

/** Partner ids that already earned `bountyId`. */
export async function awardedPartnerIds(db: Knex, tenantId: string, bountyId: string): Promise<Set<string>> {
  const rows = (await db(TABLES.Bonus).where({ tenantId, bountyId }).select('partnerId')) as Array<{ partnerId: string }>;
  return new Set(rows.map((r) => r.partnerId));
}

/** An email the sweep owes, sent once its transaction commits. */
export type BountyEmail =
  | { kind: 'started'; bountyId: string; partnerIds: string[] }
  | { kind: 'ending_soon'; bountyId: string; partnerIds: string[]; progress: Record<string, number> }
  | { kind: 'awarded'; bountyId: string; partnerId: string; held: boolean };

export interface BountySweepResult {
  evaluated: number;
  awarded: number;
  ended: number;
  /** Not dispatched yet: hand to sendBountyEmails after COMMIT. */
  emails: BountyEmail[];
}

/**
 * One tenant's pass. Runs inside the caller's transaction; the bonus.*
 * webhooks go out on its commit (awardBonus), the emails when the caller
 * passes `emails` to sendBountyEmails.
 */
export async function sweepTenantBounties(db: Knex, tenantId: string, now: Date = new Date()): Promise<BountySweepResult> {
  const result: BountySweepResult = { evaluated: 0, awarded: 0, ended: 0, emails: [] };
  const bounties = (await db<BountyRow>(TABLES.Bounty)
    .where({ tenantId, status: 'active' })
    .andWhere('startsAt', '<=', now)
    .orderBy('id')
    .forUpdate()
    .skipLocked()) as BountyRow[];

  for (const b of bounties) {
    const endsAt = b.endsAt ? new Date(b.endsAt) : null;
    const eligible = await eligiblePartners(db, b);
    const awarded = await awardedPartnerIds(db, tenantId, b.id);
    const pending = eligible.filter((p) => !awarded.has(p.id));
    const progress = await bountyProgress(db, b, pending.map((p) => p.id));
    result.evaluated += 1;

    for (const p of pending) {
      if (!reachesThreshold(b, progress.get(p.id) ?? 0)) continue;
      const res = await awardBonus(db, tenantId, {
        partnerId: p.id,
        programId: b.programId,
        amount: Number(b.rewardAmount),
        currency: b.currency,
        source: 'performance_bounty',
        bountyId: b.id,
        externalRef: bountyExternalRef(b.id, p.id),
        note: b.name,
      });
      if (!res.ok || res.replayed) continue;
      result.awarded += 1;
      awarded.add(p.id);
      result.emails.push({ kind: 'awarded', bountyId: b.id, partnerId: p.id, held: res.commission.status === 'accrued' });
    }

    const stamps: Partial<BountyRow> = {};
    const mailable = eligible.filter((p) => p.activatedAt && p.portalAccess !== false);
    if (!b.startNotifiedAt && (!endsAt || endsAt > now)) {
      stamps.startNotifiedAt = now;
      const to = mailable.filter((p) => !awarded.has(p.id)).map((p) => p.id);
      if (to.length > 0) result.emails.push({ kind: 'started', bountyId: b.id, partnerIds: to });
    }
    // Ending soon, for bounties long enough that the start email didn't
    // already say so.
    if (
      endsAt &&
      !b.endingSoonNotifiedAt &&
      endsAt > now &&
      endsAt.getTime() - now.getTime() <= ENDING_SOON_MS &&
      endsAt.getTime() - new Date(b.startsAt).getTime() > ENDING_SOON_MS
    ) {
      stamps.endingSoonNotifiedAt = now;
      const to = mailable.filter((p) => !awarded.has(p.id)).map((p) => p.id);
      if (to.length > 0) {
        result.emails.push({
          kind: 'ending_soon',
          bountyId: b.id,
          partnerIds: to,
          progress: Object.fromEntries(to.map((id) => [id, progress.get(id) ?? 0])),
        });
      }
    }
    if (endsAt && now.getTime() >= endsAt.getTime() + BOUNTY_GRACE_MS) {
      Object.assign(stamps, { status: 'ended', endedAt: now });
      result.ended += 1;
    }
    if (Object.keys(stamps).length > 0) {
      await db(TABLES.Bounty).where({ id: b.id, tenantId }).update({ ...stamps, updatedAt: now });
    }
  }
  return result;
}

/**
 * Does the partner still meet the bounty that paid `bountyId`'s bonus? The
 * auto-approve job asks before approving the bonus: refunds since the award
 * may have taken them back under the goal. A bounty that no longer exists
 * can't be re-checked, so it counts as met.
 */
export async function bountyStillMet(db: Knex, tenantId: string, bountyId: string, partnerId: string): Promise<boolean> {
  const b = await db<BountyRow>(TABLES.Bounty).where({ id: bountyId, tenantId }).first();
  if (!b) return true;
  const value = (await bountyProgress(db, b, [partnerId])).get(partnerId) ?? 0;
  return reachesThreshold(b, value);
}

/**
 * Send the emails a sweep returned, in a tenant transaction of its own,
 * after the sweep's has committed. One partner's failure doesn't stop the
 * rest; nothing is retried (the stamps already moved on), as with the
 * campaign-ending emails. Partners without portal access are skipped: the
 * links point into the portal, and a headless program tells its own
 * customers (partner-portal-access.ts).
 */
export async function sendBountyEmails(tenantId: string, emails: readonly BountyEmail[]): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  if (emails.length === 0) return { sent, failed };
  await withTenantTransaction(tenantId, async (trx) => {
    const tenant = await trx<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['slug', 'customDomain']);
    const url = `${getPortalBaseUrl(tenant)}/bounties`;
    const brandName = await resolveBrandName(trx, tenantId);
    const bounties = new Map<string, BountyRow>();
    const partners = new Map<string, Pick<PartnerRow, 'id' | 'name' | 'email' | 'portalAccess'>>();
    const ids = [...new Set(emails.flatMap((e) => ('partnerIds' in e ? e.partnerIds : [e.partnerId])))];
    for (let i = 0; i < ids.length; i += PARTNER_CHUNK) {
      const rows = (await trx<PartnerRow>(TABLES.Partner)
        .where({ tenantId })
        .whereIn('id', ids.slice(i, i + PARTNER_CHUNK))
        .whereNull('revokedAt')
        .select('id', 'name', 'email', 'portalAccess')) as Array<Pick<PartnerRow, 'id' | 'name' | 'email' | 'portalAccess'>>;
      for (const p of rows) partners.set(p.id, p);
    }
    for (const b of (await trx<BountyRow>(TABLES.Bounty)
      .where({ tenantId })
      .whereIn('id', [...new Set(emails.map((e) => e.bountyId))])) as BountyRow[]) {
      bounties.set(b.id, b);
    }

    const send = async (partnerId: string, tag: string, bountyId: string, build: (p: { name: string }) => { subject: string; text: string; html: string }) => {
      const p = partners.get(partnerId);
      if (!p || p.portalAccess === false) return;
      try {
        const tmpl = build(p);
        await getMailer().send(
          { db: trx, tenantId },
          { to: p.email, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag, metadata: { bountyId, partnerId } },
        );
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error('[bounties] partner mail failed', { tenantId, bountyId, partnerId, err });
      }
    };

    for (const e of emails) {
      const b = bounties.get(e.bountyId);
      if (!b) continue;
      const goal = renderBountySummary(b);
      if (e.kind === 'started') {
        for (const id of e.partnerIds) {
          await send(id, 'bounty_started', b.id, (p) =>
            bountyStartedEmail({ partnerName: p.name, brandName, bountyName: b.name, goal, description: b.description, url }),
          );
        }
      } else if (e.kind === 'ending_soon') {
        for (const id of e.partnerIds) {
          await send(id, 'bounty_ending_soon', b.id, (p) =>
            bountyEndingSoonEmail({
              partnerName: p.name,
              brandName,
              bountyName: b.name,
              goal,
              progress: formatBountyValue(b, e.progress[id] ?? 0),
              endsAt: new Date(b.endsAt!),
              url,
            }),
          );
        }
      } else {
        await send(e.partnerId, 'bounty_awarded', b.id, (p) =>
          bountyAwardedEmail({
            partnerName: p.name,
            brandName,
            bountyName: b.name,
            amount: formatBountyAmount(b.rewardAmount, b.currency),
            held: e.held,
            url: url.replace(/\/bounties$/, '/commissions'),
          }),
        );
      }
    }
  });
  return { sent, failed };
}
