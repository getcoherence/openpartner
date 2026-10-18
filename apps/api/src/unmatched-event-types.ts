/**
 * Event types that reached a partner but match no commission rule.
 *
 * A sender that reports `funded` when the program pays on `loan_funded`
 * gets a 200 (the conversion is recorded and attributed) and the partner
 * earns nothing. The conversion and postback responses say
 * `no_matching_rule` at the time; this is the list the brand sees later on
 * Admin → Integrations, so a stage-name typo gets noticed.
 *
 * Derived from the raw tables on every read, not stored: attributed events
 * of a custom type, grouped by (type, program, partner), checked against the
 * rules that partner earns on now. Fixing the rule clears the warning, and
 * export carries nothing extra. OpenPartner's own event types (signup,
 * invoice_paid, refund, …) are left out: a program that pays only on
 * payments is supposed to pay nothing on its signups.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import { ruleTakesEventType, rulesFor, type CommissionSnapshotRules } from './attribution.js';

/** Types OpenPartner records itself (the SDK, the Stripe webhook). */
export const BUILT_IN_EVENT_TYPES = [
  'signup',
  'trial_started',
  'subscription_created',
  'invoice_paid',
  'refund',
  'dispute_created',
  'invoice_payment_failed',
] as const;

export const UNMATCHED_WINDOW_DAYS = 30;

// (type, program, partner) groups read per call. A tenant with more distinct
// combinations than this in the window has bigger problems than this list.
const MAX_GROUPS = 2000;

export interface UnmatchedEventType {
  type: string;
  /** Attributed events of this type in the window that matched no rule. */
  events: number;
  lastSeenAt: string;
  programs: Array<{ id: string; name: string }>;
}

export async function unmatchedEventTypes(db: Knex, tenantId: string, since: Date): Promise<UnmatchedEventType[]> {
  // tenantId named on both tables: under RLS alone, the policy's OR keeps
  // the planner off the tenant indexes.
  const groups = (await db(`${TABLES.Event} as e`)
    .join(`${TABLES.Attribution} as a`, 'a.eventId', 'e.id')
    .where('e.tenantId', tenantId)
    .andWhere('a.tenantId', tenantId)
    .andWhere('e.ts', '>=', since)
    .whereNotIn('e.type', BUILT_IN_EVENT_TYPES)
    .groupBy('e.type', 'a.programId', 'a.partnerId')
    .select(
      'e.type as type',
      'a.programId as programId',
      'a.partnerId as partnerId',
      db.raw('count(distinct e.id)::int as events'),
      db.raw('max(e.ts) as "lastSeenAt"'),
    )
    .limit(MAX_GROUPS)) as Array<{ type: string; programId: string; partnerId: string; events: number; lastSeenAt: Date }>;
  if (groups.length === 0) return [];

  const programIds = [...new Set(groups.map((g) => g.programId))];
  const partnerIds = [...new Set(groups.map((g) => g.partnerId))];
  const programs = (await db(TABLES.Program)
    .where({ tenantId })
    .whereIn('id', programIds)
    .select('id', 'name', 'commissionRule')) as Array<{ id: string; name: string; commissionRule: unknown }>;
  const snapshots = (await db(TABLES.PartnerCommission)
    .where({ tenantId })
    .whereIn('partnerId', partnerIds)
    .select('partnerId', 'programId', 'commissionType', 'commissionValue', 'recurring', 'commissionRules')) as Array<
    CommissionSnapshotRules & { partnerId: string; programId: string | null }
  >;
  const programById = new Map(programs.map((p) => [p.id, p]));
  const snapshotFor = (partnerId: string, programId: string) =>
    snapshots.find((s) => s.partnerId === partnerId && s.programId === programId) ??
    snapshots.find((s) => s.partnerId === partnerId && s.programId === null);

  const byType = new Map<string, { events: number; lastSeenAt: Date; programs: Map<string, string> }>();
  for (const g of groups) {
    const program = programById.get(g.programId);
    if (!program) continue;
    let rules;
    try {
      rules = rulesFor(snapshotFor(g.partnerId, g.programId), program.commissionRule);
    } catch {
      continue; // an unreadable rule pays nothing on anything; not this list's concern
    }
    if (rules.some((r) => ruleTakesEventType(r, g.type))) continue;

    const entry = byType.get(g.type) ?? { events: 0, lastSeenAt: new Date(0), programs: new Map<string, string>() };
    entry.events += g.events;
    const seen = new Date(g.lastSeenAt);
    if (seen > entry.lastSeenAt) entry.lastSeenAt = seen;
    entry.programs.set(program.id, program.name);
    byType.set(g.type, entry);
  }

  return [...byType.entries()]
    .map(([type, e]) => ({
      type,
      events: e.events,
      lastSeenAt: e.lastSeenAt.toISOString(),
      programs: [...e.programs.entries()].map(([id, name]) => ({ id, name })),
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}
