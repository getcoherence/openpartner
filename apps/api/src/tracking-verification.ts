/**
 * Verified tracking: can this brand credit a partner?
 *
 * A brand's tracking is verified once one of its clicks has been linked to a
 * customer:
 *
 *   - a test click linked to a customer (Tenant.trackingTestPassedAt, from
 *     Admin → Tracking health → Send a test click, which works while the
 *     brand is still in review), by identify(), a Stripe checkout or a
 *     conversion call, or
 *   - a real partner click linked to a customer: any Identity row, written by
 *     identify(), a Stripe checkout, a conversion call or a coupon redemption.
 *
 * An event on its own, or the script seen on a page, doesn't count: neither
 * shows that a partner's click would end in a credited customer.
 *
 * Hosted multi-tenant only. From the operator's `enforceFrom`
 * (PlatformSetting trackingGate), an approved brand that isn't verified:
 *
 *   - takes no new partners: the partner-join routes in approval-gate.ts
 *     answer 403 tracking_not_verified
 *   - reads 'pending' on the Network (networkReviewStatus), which keeps its
 *     offerings out of the marketplace and its creator outreach closed until
 *     it verifies. network-review-reconcile.ts pushes the change within 15
 *     minutes either way.
 *
 * Partners it already has keep their links and earnings. Operators see the
 * state on /platform/brands, where approving an unverified brand takes an
 * explicit "Approve anyway".
 */

import type { Knex } from 'knex';
import { TABLES, type TenantRow } from '@openpartner/db';
import { getTrackingGateSettings } from './platform-settings.js';
import { getTenancyMode } from './tenancy.js';

export type ReviewStatus = TenantRow['approvalStatus'];

/** The brands among `tenantIds` whose tracking is verified. Works on the
 *  privileged pool and, for the brand's own id, on a tenant-scoped one. */
export async function trackingVerifiedFor(db: Knex, tenantIds: string[]): Promise<Set<string>> {
  if (tenantIds.length === 0) return new Set();
  const rows = (
    (await db.raw(
      `select t.id as "tenantId"
         from unnest(?::text[]) as t(id)
        where exists (select 1 from "Tenant" x where x.id = t.id and x."trackingTestPassedAt" is not null)
           or exists (select 1 from "Identity" i where i."tenantId" = t.id)`,
      [tenantIds],
    )) as { rows: Array<{ tenantId: string }> }
  ).rows;
  return new Set(rows.map((r) => r.tenantId));
}

export async function isTrackingVerified(db: Knex, tenantId: string): Promise<boolean> {
  return (await trackingVerifiedFor(db, [tenantId])).has(tenantId);
}

/** Whether the gate is in force now. `platformDb` must be the privileged
 *  pool: PlatformSetting is a platform table. */
export async function trackingGateEnforced(platformDb: Knex, now = new Date()): Promise<boolean> {
  if (getTenancyMode() !== 'multi') return false;
  const { enforceFrom } = await getTrackingGateSettings(platformDb);
  return enforceFrom != null && new Date(enforceFrom).getTime() <= now.getTime();
}

/**
 * What the Network should show for a brand. An approved brand reads
 * 'pending' while the gate holds it back, so the Network's own review fence
 * (discovery, applications, creator outreach) covers it with no Network
 * change.
 */
export function networkReviewStatus(approval: ReviewStatus, verified: boolean, enforced: boolean): ReviewStatus {
  if (approval !== 'approved') return approval;
  return enforced && !verified ? 'pending' : 'approved';
}

/**
 * networkReviewStatus for one brand, read now: what to send the Network when
 * enrolling or approving it. `db` reads the brand (privileged, or scoped to
 * it); `platformDb` must be the privileged pool, for the gate's setting.
 */
export async function networkReviewFor(
  db: Knex,
  platformDb: Knex,
  tenantId: string,
  approval: ReviewStatus,
): Promise<ReviewStatus> {
  if (approval !== 'approved') return approval;
  const enforced = await trackingGateEnforced(platformDb);
  return networkReviewStatus(approval, enforced ? await isTrackingVerified(db, tenantId) : true, enforced);
}

/**
 * Why partners can't join the brand yet, or null when they can: 'review'
 * while it awaits approval (approval-gate.ts), 'tracking' while its tracking
 * isn't verified and either the gate is in force or the portal keeps its
 * partner pages locked (no partner yet, as GET /admin/setup-lock has it).
 * Hosted multi-tenant only. The setup checks wait on it rather than tell
 * the brand to invite partners it can't. `platformDb` as for
 * trackingGateEnforced.
 */
export async function partnerJoinsWaitOn(
  db: Knex,
  platformDb: Knex,
  tenantId: string,
  now = new Date(),
): Promise<'review' | 'tracking' | null> {
  if (getTenancyMode() !== 'multi') return null;
  const tenant = (await db(TABLES.Tenant).where({ id: tenantId }).first('approvalStatus')) as
    | Pick<TenantRow, 'approvalStatus'>
    | undefined;
  if ((tenant?.approvalStatus ?? 'approved') !== 'approved') return 'review';
  if (await isTrackingVerified(db, tenantId)) return null;
  if (await trackingGateEnforced(platformDb, now)) return 'tracking';
  return (await db(TABLES.Partner).where({ tenantId }).first('id')) ? null : 'tracking';
}

/** Mark a passed test click. Set once; the first pass is kept. */
export async function markTrackingTestPassed(db: Knex, tenantId: string, at: Date): Promise<void> {
  await db(TABLES.Tenant)
    .where({ id: tenantId })
    .whereNull('trackingTestPassedAt')
    .update({ trackingTestPassedAt: at });
}

export const TRACKING_NOT_VERIFIED_DETAIL =
  'Partners can join once your tracking is verified. Install the tracking script, then send a test click from Tracking health.';
