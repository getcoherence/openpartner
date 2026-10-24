/**
 * Inputs OpenPartner had to drop, counted per (tenant, day, kind) in
 * TrackingIssue (migration 20261024000000_click_landing_tracking_issue).
 *
 * Each is a conversion that may have belonged to a partner and silently
 * didn't: the caller got a 404 (or, from Stripe, nothing at all), and
 * nobody watches those. Admin → Tracking health lists them so a brand sees
 * that its identify() calls name another tenant's clicks (a wrong
 * data-api-url slug), or that its Checkout Sessions carry its own ids in
 * client_reference_id, where partner clicks can't ride.
 *
 *   identify_unknown_click    POST /attribution/identify named no click of
 *                             this tenant
 *   landing_unknown_click     the same, from the SDK's landing beacon
 *   conversion_unknown_click  POST /attribution/conversions or GET /postback
 *   stripe_unknown_click      a Checkout Session's client_reference_id is
 *                             shaped like a click id but names none
 *   stripe_foreign_reference  client_reference_id is something else
 *                             entirely (the brand's own order or user id)
 *   coupon_unknown_code       POST /coupons/redeem with a code nobody holds
 *
 * Counting never fails the request that found the problem: the write runs
 * in a savepoint, so a failure can't abort the caller's transaction, and it
 * is logged and dropped.
 */

import type { Knex } from 'knex';
import { TABLES, type TrackingIssueKind } from '@openpartner/db';

export const TRACKING_ISSUE_KINDS: readonly TrackingIssueKind[] = [
  'identify_unknown_click',
  'landing_unknown_click',
  'conversion_unknown_click',
  'stripe_unknown_click',
  'stripe_foreign_reference',
  'coupon_unknown_code',
];

const SAMPLE_MAX = 64;

/** A click id: a ULID, 26 Crockford base32 characters. */
const CLICK_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function looksLikeClickId(value: string): boolean {
  return CLICK_ID_RE.test(value);
}

/** The value a brand will recognise, minus anything that isn't printable. */
function sample(ref: string | null | undefined): string | null {
  if (ref == null) return null;
  // eslint-disable-next-line no-control-regex
  const clean = ref.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? clean.slice(0, SAMPLE_MAX) : null;
}

export async function noteTrackingIssue(
  db: Knex,
  tenantId: string,
  kind: TrackingIssueKind,
  ref?: string | null,
): Promise<void> {
  try {
    // A savepoint when `db` is the request's transaction, a transaction of
    // its own otherwise: a failed statement inside the caller's
    // transaction would abort everything after it.
    await db.transaction(async (sp) => {
      await sp.raw(
        `insert into ?? ("tenantId", "day", "kind", "count", "sampleRef", "firstSeenAt", "lastSeenAt")
           values (?, (now() at time zone 'utc')::date, ?, 1, ?, now(), now())
         on conflict ("tenantId", "day", "kind") do update
           set "count" = ??."count" + 1,
               "sampleRef" = coalesce(excluded."sampleRef", ??."sampleRef"),
               "lastSeenAt" = excluded."lastSeenAt"`,
        [TABLES.TrackingIssue, tenantId, kind, sample(ref), TABLES.TrackingIssue, TABLES.TrackingIssue],
      );
    });
  } catch (err) {
    console.error('[tracking-issues] could not record', kind, err instanceof Error ? err.message : err);
  }
}

export interface TrackingIssueSummary {
  kind: TrackingIssueKind;
  count: number;
  days: number;
  sampleRef: string | null;
  lastSeenAt: string;
}

/** Every kind seen since `since` (a UTC day boundary is fine), most recent first. */
export async function trackingIssuesSince(db: Knex, tenantId: string, since: Date): Promise<TrackingIssueSummary[]> {
  const rows = (await db(TABLES.TrackingIssue)
    .where({ tenantId })
    .andWhere('day', '>=', since.toISOString().slice(0, 10))
    .orderBy('lastSeenAt', 'desc')
    .select('kind', 'count', 'sampleRef', 'lastSeenAt')) as Array<{
    kind: TrackingIssueKind;
    count: number;
    sampleRef: string | null;
    lastSeenAt: Date;
  }>;
  const byKind = new Map<TrackingIssueKind, TrackingIssueSummary>();
  for (const row of rows) {
    const seen = byKind.get(row.kind);
    if (seen) {
      seen.count += row.count;
      seen.days += 1;
      continue;
    }
    // Rows come newest first, so the first one per kind has the latest sample.
    byKind.set(row.kind, {
      kind: row.kind,
      count: row.count,
      days: 1,
      sampleRef: row.sampleRef,
      lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    });
  }
  return [...byKind.values()];
}
