/**
 * Per-referral timeline: each customer a partner referred, and how far
 * they have come.
 *
 * A referral is one brand userId with at least one event attributed to the
 * partner (an Attribution row naming them), of any type, whether or not it
 * earned anything. So a CRM stage that pays nothing (`lead_created`,
 * `demo_booked`) still shows the partner their customer moving. Like the
 * rest of attribution this is derived from the raw Click × Event ×
 * Attribution rows on every read; nothing is stored.
 *
 * What a partner may see is the brand's choice, stored in Config
 * (`partner_referrals`, Admin → Settings or POST /config/referrals):
 *
 *   stages             the event types partners see as stages, each with
 *                      a label, in the brand's order. Default: the four
 *                      types OpenPartner itself records. Every other type
 *                      stays hidden: it still makes the customer a
 *                      referral and still counts toward the commission
 *                      total, but no type, date or count of it is shown.
 *   showCustomerLabels whether partners see `metadata.customerLabel` from
 *                      the referral's events. Off by default. OpenPartner
 *                      stores only the brand's userId, never a name; a
 *                      brand that sends a label decides, as the
 *                      controller of that data, that its partners may see
 *                      it. Off, a referral reads "Referral #n".
 *
 * The referral's date (`referredAt`) is when the customer first clicked the
 * partner's link: the earliest of the partner's clicks credited on any of
 * the customer's events. That is the partner's own traffic, so it says
 * nothing about a hidden event's timing.
 *
 * A partner never sees the userId. Each referral carries a pseudonymous
 * `referralId` instead: an HMAC of (tenant, userId) under the server's
 * secret, so it is stable on this instance but can't be reversed or
 * confirmed from a guessed userId. GET /partners/:id/customers and /events
 * return the same id. The page cursor holds the userId, so it is encrypted
 * under the same secret. Admins and scoped keys also get the userId.
 *
 * Reversals: the commission total counts live (not reversed) commissions,
 * net of refund_clawback adjustments, the same measure as performance
 * bounties (performance-metric.ts). A stage is `reversed` when every one of
 * its events earned the partner a commission and none of it is left: all
 * reversed (a refund, a chargeback, an admin reversal) or clawed back.
 * Bonuses aren't tied to a customer, so they never count here.
 *
 * Every query names the tenant explicitly: RLS scopes `db`, but under it a
 * tenant index only applies to plain column equality, and a pool without
 * the app role would otherwise read every tenant.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import { CORRECTIVE_EVENT_TYPES } from './attribution.js';
import { getConfig } from './config.js';
import { decryptSecret, encryptSecret, macValue } from './crypto.js';
import { byCurrency, currencySql } from './currency.js';
import { cursorTimestamp, decodeCursor, whereAfterCursor, type KeysetCursor } from './pagination.js';

export const REFERRAL_SETTINGS_CONFIG_KEY = 'partner_referrals';

/** Most stages a brand can list. A CRM pipeline is a handful. */
export const MAX_REFERRAL_STAGES = 20;
export const MAX_STAGE_LABEL = 60;
export const MAX_STAGE_EVENT_TYPE = 100;
/** A longer customerLabel is cut to this many characters. */
export const MAX_CUSTOMER_LABEL = 80;

export interface ReferralStage {
  eventType: string;
  label: string;
}

export interface ReferralSettings {
  /** In the order partners see them. */
  stages: ReferralStage[];
  showCustomerLabels: boolean;
}

/** The types OpenPartner records itself, which the funnel already shows
 *  partners. A custom type is hidden until the brand adds it. */
export const DEFAULT_REFERRAL_STAGES: readonly ReferralStage[] = [
  { eventType: 'signup', label: 'Signed up' },
  { eventType: 'trial_started', label: 'Trial started' },
  { eventType: 'subscription_created', label: 'Subscribed' },
  { eventType: 'invoice_paid', label: 'Paid' },
];

function settingsFrom(value: Partial<ReferralSettings> | null | undefined): ReferralSettings {
  return {
    stages: Array.isArray(value?.stages) ? value.stages : DEFAULT_REFERRAL_STAGES.map((s) => ({ ...s })),
    showCustomerLabels: value?.showCustomerLabels === true,
  };
}

export async function readReferralSettings(db: Knex, tenantId: string): Promise<ReferralSettings> {
  return settingsFrom(await getConfig<Partial<ReferralSettings>>(db, tenantId, REFERRAL_SETTINGS_CONFIG_KEY));
}

export class ReferralSettingsError extends Error {
  constructor(
    readonly code: 'duplicate_stage' | 'corrective_stage',
    readonly eventType: string,
  ) {
    super(
      code === 'duplicate_stage'
        ? `${eventType} is listed more than once`
        : `${eventType} corrects an earlier conversion and is never attributed, so it can't be a stage`,
    );
  }
}

/**
 * Omitted fields keep their value; `stages` replaces the whole list. Stages
 * arrive trimmed (the route's schema trims them).
 *
 * The merge happens in one statement, under the row lock the upsert takes,
 * so two admins saving at once each change only what they sent: a stage
 * edit read before someone turned customer labels off can't write them
 * back on.
 */
export async function saveReferralSettings(
  db: Knex,
  tenantId: string,
  patch: Partial<ReferralSettings>,
): Promise<ReferralSettings> {
  const changes: Partial<ReferralSettings> = {};
  if (patch.stages) {
    const seen = new Set<string>();
    for (const stage of patch.stages) {
      if (CORRECTIVE_EVENT_TYPES.has(stage.eventType)) throw new ReferralSettingsError('corrective_stage', stage.eventType);
      if (seen.has(stage.eventType)) throw new ReferralSettingsError('duplicate_stage', stage.eventType);
      seen.add(stage.eventType);
    }
    changes.stages = patch.stages;
  }
  if (patch.showCustomerLabels !== undefined) changes.showCustomerLabels = patch.showCustomerLabels;

  const defaults = JSON.stringify(settingsFrom(null));
  const json = JSON.stringify(changes);
  const result = await db.raw(
    `insert into ?? ("tenantId", "key", "value", "updatedAt") values (?, ?, ?::jsonb || ?::jsonb, now())
     on conflict ("tenantId", "key") do update set "value" = ??."value" || ?::jsonb, "updatedAt" = now()
     returning "value"`,
    [TABLES.Config, tenantId, REFERRAL_SETTINGS_CONFIG_KEY, defaults, json, TABLES.Config, json],
  );
  return settingsFrom((result as { rows: Array<{ value: Partial<ReferralSettings> }> }).rows[0]?.value);
}

/** Event types the tenant has recorded lately, for the stage picker on
 *  Admin → Settings. Corrective types can't be stages, so they're left out. */
export async function recentEventTypes(db: Knex, tenantId: string, days = 90): Promise<string[]> {
  const rows = (await db(TABLES.Event)
    .where('tenantId', tenantId)
    .andWhere('ts', '>=', new Date(Date.now() - days * 24 * 60 * 60 * 1000))
    .whereNotIn('type', [...CORRECTIVE_EVENT_TYPES])
    .groupBy('type')
    .orderByRaw('count(*) desc, type')
    .limit(50)
    .select('type')) as Array<{ type: string }>;
  return rows.map((r) => r.type);
}

/** The pseudonymous id a partner sees for one of the brand's customers. */
export function referralIdFor(tenantId: string, userId: string): string {
  return `ref_${macValue('referral-id', `${tenantId}:${userId}`).slice(0, 12)}`;
}

/** The brand's display label from an event's metadata, or null. */
export function customerLabelOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).customerLabel;
  if (typeof raw !== 'string') return null;
  const label = raw.replace(/\s+/g, ' ').trim();
  return label ? label.slice(0, MAX_CUSTOMER_LABEL) : null;
}

/** The page cursor: (when the customer became a referral, userId),
 *  encrypted so a partner can read neither. Null when it doesn't decrypt or
 *  decode. */
function decodeReferralCursor(cursor: string): KeysetCursor | null {
  try {
    const plain = decryptSecret(Buffer.from(cursor, 'base64url').toString('utf8'));
    return decodeCursor(Buffer.from(plain, 'utf8').toString('base64url'));
  } catch {
    return null;
  }
}

function encodeReferralCursor(c: KeysetCursor): string {
  return Buffer.from(encryptSecret(`${c.ts}|${c.id}`), 'utf8').toString('base64url');
}

export interface ReferralStageReached {
  eventType: string;
  label: string;
  /** The first event of this type: when the customer reached the stage. */
  firstAt: string;
  lastAt: string;
  /** Events of this type (a monthly invoice repeats). */
  count: number;
  /** Every one of these events earned the partner a commission and none
   *  of it is left (reversed, or clawed back after payment). */
  reversed: boolean;
}

export interface Referral {
  referralId: string;
  /** 1 = the partner's first referral, in the order customers became
   *  their referrals. */
  number: number;
  /** What to call the customer: their customerLabel when the brand shows
   *  those, else "Referral #n". */
  label: string;
  /** Null unless the brand shows customer labels and sent one. */
  customerLabel: string | null;
  /** Admins and scoped keys only. */
  userId?: string;
  /** When the customer first clicked the partner's link (of the clicks
   *  credited on their events). */
  referredAt: string;
  /** Shown stages reached, in the brand's stage order. */
  stages: ReferralStageReached[];
  /** The furthest shown stage reached, in the brand's order, that isn't reversed. */
  latestStage: { eventType: string; label: string; at: string } | null;
  /** In `currency`, the brand's default. */
  commission: number;
  commissionByCurrency: Record<string, number>;
}

export interface ReferralPage {
  referrals: Referral[];
  /** All of the partner's referrals, not just this page. */
  total: number;
  nextCursor: string | null;
}

/** One page of a partner's referrals, newest referral first (the last to
 *  become one). Null when the cursor doesn't decode. */
export async function listReferrals(
  db: Knex,
  opts: {
    tenantId: string;
    partnerId: string;
    settings: ReferralSettings;
    currency: string;
    limit: number;
    cursor?: string;
    includeUserId: boolean;
  },
): Promise<ReferralPage | null> {
  const { tenantId, partnerId, settings } = opts;
  const cursor = opts.cursor ? decodeReferralCursor(opts.cursor) : undefined;
  if (cursor === null) return null;

  // One row per customer: when they became the partner's referral (the
  // first credited event's attribution, which orders and numbers them, so a
  // new referral always takes the next number) and when they first clicked
  // the partner's link (the date shown). Numbered and counted before the
  // cursor narrows the page.
  const referrals = () =>
    db
      .with('refs', (qb) =>
        qb
          .from(`${TABLES.Attribution} as a`)
          .join(`${TABLES.Event} as e`, 'e.id', 'a.eventId')
          .join(`${TABLES.Click} as cl`, 'cl.id', 'a.clickId')
          .where('a.tenantId', tenantId)
          .andWhere('a.partnerId', partnerId)
          .andWhere('e.tenantId', tenantId)
          .andWhere('cl.tenantId', tenantId)
          .groupBy('e.userId')
          .select('e.userId as userId', db.raw('min(cl.ts) as "referredAt"'), db.raw('min(a."computedAt") as "since"')),
      )
      .with('numbered', (qb) =>
        qb
          .from('refs')
          .select(
            '*',
            db.raw('row_number() over (order by "since", "userId") as "number"'),
            db.raw('count(*) over () as "total"'),
          ),
      );

  const page = referrals()
    .from('numbered')
    .select('userId', 'number', 'total', 'referredAt', cursorTimestamp(db, 'since'))
    .orderBy([
      { column: 'since', order: 'desc' },
      { column: 'userId', order: 'desc' },
    ])
    .limit(opts.limit + 1);
  if (cursor) whereAfterCursor(page, 'since', 'userId', cursor);
  const rows = (await page) as Array<{ userId: string; number: string; total: string; referredAt: Date; _cursorTs: string }>;
  const kept = rows.slice(0, opts.limit);
  const last = kept[kept.length - 1];
  const nextCursor = rows.length > opts.limit && last ? encodeReferralCursor({ ts: last._cursorTs, id: last.userId }) : null;

  // Every row carries the count; a page past the end has none to carry it.
  let total = Number(rows[0]?.total ?? 0);
  if (rows.length === 0 && cursor) {
    const counted = (await referrals().from('refs').count<{ count: string }[]>({ count: '*' }).first()) as
      | { count: string }
      | undefined;
    total = Number(counted?.count ?? 0);
  }

  const userIds = kept.map((r) => r.userId);
  const reached = userIds.length ? await stagesOf(db, tenantId, partnerId, userIds, settings.stages) : new Map();
  const labels =
    userIds.length && settings.showCustomerLabels ? await customerLabels(db, tenantId, partnerId, userIds) : new Map();
  const commissions = userIds.length ? await commissionTotals(db, tenantId, partnerId, userIds) : new Map();

  return {
    referrals: kept.map((r) => {
      const number = Number(r.number);
      const stages: ReferralStageReached[] = reached.get(r.userId) ?? [];
      const latest = [...stages].reverse().find((s) => !s.reversed) ?? null;
      const customerLabel: string | null = labels.get(r.userId) ?? null;
      const commissionByCurrency: Record<string, number> = commissions.get(r.userId) ?? {};
      return {
        referralId: referralIdFor(tenantId, r.userId),
        number,
        label: customerLabel ?? `Referral #${number}`,
        customerLabel,
        ...(opts.includeUserId ? { userId: r.userId } : {}),
        referredAt: new Date(r.referredAt).toISOString(),
        stages,
        latestStage: latest ? { eventType: latest.eventType, label: latest.label, at: latest.firstAt } : null,
        commission: commissionByCurrency[opts.currency] ?? 0,
        commissionByCurrency,
      };
    }),
    total,
    nextCursor,
  };
}

/** Refund clawbacks per commission of the partner's (negative amounts). */
function clawbacks(db: Knex, tenantId: string, partnerId: string) {
  return db(TABLES.CommissionAdjustment)
    .where('tenantId', tenantId)
    .andWhere('reason', 'refund_clawback')
    .whereIn('commissionId', db(TABLES.Commission).where({ tenantId, partnerId }).select('id'))
    .groupBy('commissionId')
    .select('commissionId', db.raw('sum(amount) as clawback'));
}

/** The shown stages each customer has reached, in the brand's order.
 *  Hidden types are never read. */
async function stagesOf(
  db: Knex,
  tenantId: string,
  partnerId: string,
  userIds: string[],
  stages: readonly ReferralStage[],
): Promise<Map<string, ReferralStageReached[]>> {
  const out = new Map<string, ReferralStageReached[]>();
  if (stages.length === 0) return out;

  // Each credited event of a shown type, with the partner's commissions on
  // it: all of them, and those with something left.
  const perEvent = db(`${TABLES.Event} as e`)
    .join(`${TABLES.Attribution} as a`, 'a.eventId', 'e.id')
    .leftJoin(`${TABLES.Commission} as c`, (j) =>
      j.on('c.attributionId', 'a.id').andOnVal('c.tenantId', tenantId).andOnVal('c.partnerId', partnerId),
    )
    .leftJoin(clawbacks(db, tenantId, partnerId).as('adj'), 'adj.commissionId', 'c.id')
    .where('e.tenantId', tenantId)
    .andWhere('a.tenantId', tenantId)
    .andWhere('a.partnerId', partnerId)
    .whereIn('e.userId', userIds)
    .whereIn('e.type', stages.map((s) => s.eventType))
    .groupBy('e.id')
    .select(
      'e.userId as userId',
      'e.type as type',
      'e.ts as ts',
      db.raw('count(c.id) as commissions'),
      db.raw(
        `count(c.id) filter (where c.status <> 'reversed' and c.amount + coalesce(adj.clawback, 0) > 0) as "liveCommissions"`,
      ),
    );
  const rows = (await db
    .from(perEvent.as('ev'))
    .groupBy('userId', 'type')
    .select(
      'userId',
      'type',
      db.raw('min(ts) as "firstAt"'),
      db.raw('max(ts) as "lastAt"'),
      db.raw('count(*) as count'),
      db.raw('bool_and(commissions > 0 and "liveCommissions" = 0) as reversed'),
    )) as Array<{ userId: string; type: string; firstAt: Date; lastAt: Date; count: string; reversed: boolean }>;

  const byUserType = new Map(rows.map((r) => [`${r.userId}\u0000${r.type}`, r]));
  for (const userId of userIds) {
    const reached: ReferralStageReached[] = [];
    for (const stage of stages) {
      const r = byUserType.get(`${userId}\u0000${stage.eventType}`);
      if (!r) continue;
      reached.push({
        eventType: stage.eventType,
        label: stage.label,
        firstAt: new Date(r.firstAt).toISOString(),
        lastAt: new Date(r.lastAt).toISOString(),
        count: Number(r.count),
        reversed: r.reversed,
      });
    }
    out.set(userId, reached);
  }
  return out;
}

/** The newest label the brand sent on any of each customer's credited
 *  events, whatever its type: the label names the customer, not a stage. */
async function customerLabels(
  db: Knex,
  tenantId: string,
  partnerId: string,
  userIds: string[],
): Promise<Map<string, string>> {
  const rows = (await db(`${TABLES.Event} as e`)
    .whereIn('e.id', (q) =>
      q.from(TABLES.Attribution).select('eventId').where({ tenantId, partnerId }),
    )
    .where('e.tenantId', tenantId)
    .whereIn('e.userId', userIds)
    .whereRaw(`jsonb_typeof("e"."metadata"->'customerLabel') = 'string'`)
    .whereRaw(`btrim("e"."metadata"->>'customerLabel') <> ''`)
    .distinctOn('e.userId')
    .orderBy([
      { column: 'e.userId' },
      { column: 'e.ts', order: 'desc' },
      { column: 'e.id', order: 'desc' },
    ])
    .select('e.userId as userId', db.raw(`"e"."metadata"->>'customerLabel' as label`))) as Array<{ userId: string; label: string }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    const label = customerLabelOf({ customerLabel: r.label });
    if (label) out.set(r.userId, label);
  }
  return out;
}

/** What each customer has earned the partner, per currency: live
 *  commissions net of refund clawbacks, every event type included. */
async function commissionTotals(
  db: Knex,
  tenantId: string,
  partnerId: string,
  userIds: string[],
): Promise<Map<string, Record<string, number>>> {
  const currency = currencySql('"c"."currency"');
  const rows = (await db(`${TABLES.Commission} as c`)
    .join(`${TABLES.Attribution} as a`, 'a.id', 'c.attributionId')
    .join(`${TABLES.Event} as e`, 'e.id', 'a.eventId')
    .leftJoin(clawbacks(db, tenantId, partnerId).as('adj'), 'adj.commissionId', 'c.id')
    .where('c.tenantId', tenantId)
    .andWhere('c.partnerId', partnerId)
    .andWhere('a.tenantId', tenantId)
    .andWhere('e.tenantId', tenantId)
    .whereIn('e.userId', userIds)
    .whereNot('c.status', 'reversed')
    .groupByRaw(`"e"."userId", ${currency}`)
    .select(
      'e.userId as userId',
      db.raw(`${currency} as currency`),
      db.raw('sum(c.amount + coalesce(adj.clawback, 0)) as amount'),
    )) as Array<{ userId: string; currency: string; amount: string }>;
  const grouped = new Map<string, Array<{ currency: string; amount: string }>>();
  for (const r of rows) {
    const list = grouped.get(r.userId);
    if (list) list.push(r);
    else grouped.set(r.userId, [r]);
  }
  return new Map([...grouped].map(([userId, list]) => [userId, byCurrency(list)]));
}
