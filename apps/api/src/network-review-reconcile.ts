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
 * It also alerts the ops inbox once per vendor when a SELF-SERVE vendor (a
 * self-hosted instance, not one of our hosted brands) lands in the Network's
 * review queue — those are decided on /platform → Vendors, and nothing else
 * would tell an operator they're waiting.
 *
 * One admin list call per run, then a push per drifted vendor only.
 *
 * Hosted multi-tenant only. Single-tenant / self-host deployments have no
 * operator review (their tenants backfill to 'approved') and usually no
 * Network admin key, so the job is a no-op there.
 */

import { TABLES, type PlatformSettingRow, type TenantRow } from '@openpartner/db';
import { db } from './db.js';
import { getTenancyMode } from './tenancy.js';
import {
  adminListVendors,
  adminSetVendorReview,
  platformNetworkUrl,
  type NetworkMembership,
  type NetworkVendorSummary,
} from './network-client.js';
import { opsNetworkVendorsPendingEmail } from './email-templates.js';
import { sendOpsEmail } from './platform-ops-mail.js';
import { getPortalBaseUrl } from './portal-url.js';

export interface ReviewReconcileResult {
  skipped?: string;
  checked: number;
  pushed: number;
  unmatched: number;
  failed: number;
  /** Self-serve vendors newly reported to the ops inbox this run. */
  alerted?: number;
}

/** The hosted brand (tenant) a Network vendor belongs to. */
export interface VendorTenantLink {
  tenantId: string;
  slug: string;
  displayName: string;
  approvalStatus: TenantRow['approvalStatus'];
}

const norm = (u: string): string => u.trim().replace(/\/+$/, '').toLowerCase();

/**
 * Which Network vendors are our hosted brands. Matches each tenant's
 * network_membership (on THIS platform Network) to a vendor by vendorId,
 * falling back to the instanceUrl hosted enrollment registers for rows
 * written before vendorId was persisted. Vendors with no link are self-serve
 * (self-hosted instances) — the operator review queue's business, not brand
 * approval's.
 */
export async function linkVendorsToTenants(
  networkUrl: string,
  vendors: NetworkVendorSummary[],
): Promise<{ links: Map<string, VendorTenantLink>; checked: number; unmatched: number }> {
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
      `${TABLES.Tenant}.displayName as displayName`,
      `${TABLES.Tenant}.approvalStatus as approvalStatus`,
      `${TABLES.Config}.value as membership`,
    )) as Array<{
    tenantId: string;
    slug: string;
    displayName: string;
    approvalStatus: TenantRow['approvalStatus'];
    membership: NetworkMembership | null;
  }>;

  const links = new Map<string, VendorTenantLink>();
  let checked = 0;
  let unmatched = 0;
  for (const r of rows) {
    const m = r.membership;
    // Only memberships on the platform Network — a brand pointed at some
    // other Network instance isn't ours to moderate.
    if (!m?.networkUrl || norm(m.networkUrl) !== norm(networkUrl)) continue;
    checked += 1;
    const vendor = m.vendorId
      ? byId.get(m.vendorId)
      : portalBase
        ? byInstanceUrl.get(`${portalBase}/api/t/${r.slug.toLowerCase()}`)
        : undefined;
    if (!vendor) {
      unmatched += 1;
      continue;
    }
    links.set(vendor.id, {
      tenantId: r.tenantId,
      slug: r.slug,
      displayName: r.displayName,
      approvalStatus: r.approvalStatus,
    });
  }
  return { links, checked, unmatched };
}

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
  const { links, checked, unmatched } = await linkVendorsToTenants(networkUrl, vendors);

  const out: ReviewReconcileResult = { ...empty, checked, unmatched };
  for (const vendor of vendors) {
    const link = links.get(vendor.id);
    if (!link || vendor.reviewStatus === link.approvalStatus) continue;
    try {
      await adminSetVendorReview(
        networkUrl,
        vendor.id,
        link.approvalStatus,
        `reconciled from openpartner approval state (${link.approvalStatus})`,
      );
      out.pushed += 1;
    } catch (err) {
      out.failed += 1;
      console.error('[network-review-reconcile] push failed', { tenantId: link.tenantId, vendorId: vendor.id, err });
    }
  }

  try {
    out.alerted = await alertOpsToPendingVendors(vendors.filter((v) => !links.has(v.id) && v.reviewStatus === 'pending'));
  } catch (err) {
    // The alert is a courtesy; never fail the reconcile over it.
    console.error('[network-review-reconcile] pending-vendor alert failed', err);
  }
  return out;
}

const ALERTED_KEY = 'network_vendor_review_alerted';
/** Remember at most this many alerted vendor ids (oldest dropped first). */
const ALERTED_MEMORY = 1000;

/**
 * One ops email per batch of self-serve vendors that newly entered the review
 * queue. Remembers which ids were reported (PlatformSetting) so a vendor
 * waiting several runs isn't re-announced every 15 minutes. If the send fails
 * nothing is recorded, so the next run retries.
 */
async function alertOpsToPendingVendors(pending: NetworkVendorSummary[]): Promise<number> {
  if (pending.length === 0) return 0;
  const row = await db<PlatformSettingRow>(TABLES.PlatformSetting).where({ key: ALERTED_KEY }).first();
  const seen = new Set(((row?.value as { vendorIds?: string[] } | undefined)?.vendorIds ?? []).filter(Boolean));
  const fresh = pending.filter((v) => !seen.has(v.id));
  if (fresh.length === 0) return 0;

  const tmpl = opsNetworkVendorsPendingEmail(
    fresh.map((v) => ({ name: v.displayName ?? v.id, instanceUrl: v.instanceUrl })),
    `${getPortalBaseUrl()}/platform/vendors`,
  );
  const sent = await sendOpsEmail(db, tmpl, 'ops_network_vendors_pending');
  if (!sent) return 0;

  const vendorIds = [...seen, ...fresh.map((v) => v.id)].slice(-ALERTED_MEMORY);
  await db(TABLES.PlatformSetting)
    .insert({ key: ALERTED_KEY, value: { vendorIds } as unknown as never, updatedByEmail: null, updatedAt: new Date() })
    .onConflict('key')
    .merge({ value: { vendorIds } as unknown as never, updatedAt: new Date() });
  return fresh.length;
}
