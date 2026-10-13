/**
 * Keep the Network's Vendor.reviewStatus in step with Tenant.approvalStatus.
 *
 * The Network decides marketplace visibility and only lists vendors whose
 * reviewStatus is 'approved'. openpartner pushes the decision directly on
 * approve/reject (brand-review.ts) and at enrollment (signup / add-brand /
 * auto-enroll), but those pushes are best-effort. This job is the backstop:
 *
 *   - retries any push that failed (Network outage, deploy window)
 *   - is the backfill: the Network migration defaults every existing vendor
 *     to 'approved', so the first run after deploy hides every brand that is
 *     still pending (or was rejected) in openpartner
 *   - covers memberships created by paths that don't push (complete-connect)
 *
 * One admin list call per run, then a push per drifted vendor only.
 *
 * Hosted multi-tenant only. Single-tenant / self-host deployments have no
 * operator review (their tenants backfill to 'approved') and usually no
 * Network admin key, so the job is a no-op there.
 */

import { TABLES, type TenantRow } from '@openpartner/db';
import { db } from './db.js';
import { getTenancyMode } from './tenancy.js';
import {
  adminListVendors,
  adminSetVendorReview,
  platformNetworkUrl,
  type NetworkMembership,
  type NetworkVendorSummary,
} from './network-client.js';

export interface ReviewReconcileResult {
  skipped?: string;
  checked: number;
  pushed: number;
  unmatched: number;
  failed: number;
}

const norm = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase();

export async function reconcileNetworkReview(): Promise<ReviewReconcileResult> {
  const empty = { checked: 0, pushed: 0, unmatched: 0, failed: 0 };
  if (getTenancyMode() !== 'multi') return { skipped: 'single_tenant', ...empty };
  const networkUrl = platformNetworkUrl();
  if (!networkUrl || !process.env.NETWORK_ADMIN_API_KEY) {
    return { skipped: 'network_admin_not_configured', ...empty };
  }

  const vendors = await adminListVendors(networkUrl);
  // A Network that predates the review gate doesn't return the field —
  // pushing would just 404 every vendor.
  if (vendors.length > 0 && vendors.every((v) => v.reviewStatus === undefined)) {
    return { skipped: 'network_predates_review_gate', ...empty };
  }
  const byId = new Map<string, NetworkVendorSummary>(vendors.map((v) => [v.id, v]));
  const byInstanceUrl = new Map<string, NetworkVendorSummary>(vendors.map((v) => [norm(v.instanceUrl), v]));
  const portalBase = norm(process.env.PORTAL_URL ?? '');

  // Privileged, cross-tenant read: every tenant (suspended included — a
  // rejected brand is suspended, and its vendor must read 'rejected').
  const rows = (await db(TABLES.Config)
    .join(TABLES.Tenant, `${TABLES.Tenant}.id`, `${TABLES.Config}.tenantId`)
    .where(`${TABLES.Config}.key`, 'network_membership')
    .select(
      `${TABLES.Tenant}.id as tenantId`,
      `${TABLES.Tenant}.slug as slug`,
      `${TABLES.Tenant}.approvalStatus as approvalStatus`,
      `${TABLES.Config}.value as membership`,
    )) as Array<{
    tenantId: string;
    slug: string;
    approvalStatus: TenantRow['approvalStatus'];
    membership: NetworkMembership | null;
  }>;

  const out = { ...empty };
  for (const r of rows) {
    const m = r.membership;
    // Only memberships on the platform Network — a brand pointed at some
    // other Network instance isn't ours to moderate.
    if (!m?.networkUrl || norm(m.networkUrl) !== norm(networkUrl)) continue;
    out.checked += 1;
    // Rows written before vendorId was persisted: fall back to the
    // instanceUrl hosted enrollment registers.
    const vendor = m.vendorId
      ? byId.get(m.vendorId)
      : portalBase
        ? byInstanceUrl.get(`${portalBase}/api/t/${r.slug.toLowerCase()}`)
        : undefined;
    if (!vendor) {
      out.unmatched += 1;
      continue;
    }
    if (vendor.reviewStatus === r.approvalStatus) continue;
    try {
      await adminSetVendorReview(
        networkUrl,
        vendor.id,
        r.approvalStatus,
        `reconciled from openpartner approval state (${r.approvalStatus})`,
      );
      out.pushed += 1;
    } catch (err) {
      out.failed += 1;
      console.error('[network-review-reconcile] push failed', { tenantId: r.tenantId, vendorId: vendor.id, err });
    }
  }
  return out;
}
