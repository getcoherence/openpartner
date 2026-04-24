/**
 * Federated earnings view.
 *
 * For each active Partnership visible to the principal, we call the vendor's
 * /partners/:id/dashboard (via stored admin key) and project the stats back
 * into the Network UI. Attribution data stays on the vendor's instance —
 * this is a read-only projection.
 *
 * Fan-out uses Promise.allSettled so a single unreachable vendor doesn't
 * black out the whole page. Each partnership ships back with a status:
 *   ok     — stats populated
 *   error  — stats zeroed, `error` message set
 *
 * We group by vendorId first so we only decrypt each vendor's key once per
 * request even if the creator has multiple partnerships with the same vendor.
 */

import { Router } from 'express';
import {
  TABLES,
  type NetworkVendorRow,
  type OfferingRow,
  type PartnershipRow,
} from '@openpartner/db';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { fetchPartnerDashboard, type PartnerDashboardStats } from '../network/federation.js';

export const networkEarningsRouter = Router();

interface PartnershipEarning {
  partnership: {
    id: string;
    vendorId: string;
    vendorName: string;
    offeringTitle: string;
    vendorLinkKey: string;
    publicShareUrl: string;
    createdAt: string;
  };
  status: 'ok' | 'error';
  error?: string;
  stats: PartnerDashboardStats | null;
}

networkEarningsRouter.get('/network/partnerships/earnings', requireAuth, async (req, res) => {
  const p = req.principal!;

  const partnershipQuery = db<PartnershipRow>(TABLES.Partnership).where({ status: 'active' });
  if (p.role === 'network_creator') partnershipQuery.andWhere({ creatorId: p.networkCreatorId });
  else if (p.role === 'network_vendor') partnershipQuery.andWhere({ vendorId: p.networkVendorId });
  else if (p.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

  const partnerships = await partnershipQuery.orderBy('createdAt', 'desc');
  if (partnerships.length === 0) {
    return res.json({ partnerships: [], totals: emptyTotals() });
  }

  const vendorIds = Array.from(new Set(partnerships.map((p) => p.vendorId)));
  const offeringIds = Array.from(new Set(partnerships.map((p) => p.offeringId)));
  const [vendors, offerings] = await Promise.all([
    db<NetworkVendorRow>(TABLES.NetworkVendor).whereIn('id', vendorIds),
    db<OfferingRow>(TABLES.Offering).whereIn('id', offeringIds),
  ]);
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const offeringById = new Map(offerings.map((o) => [o.id, o]));

  const results = await Promise.all(
    partnerships.map(async (pRow): Promise<PartnershipEarning> => {
      const vendor = vendorById.get(pRow.vendorId);
      const offering = offeringById.get(pRow.offeringId);
      const base = {
        id: pRow.id,
        vendorId: pRow.vendorId,
        vendorName: vendor?.name ?? 'Unknown vendor',
        offeringTitle: offering?.title ?? 'Unknown offering',
        vendorLinkKey: pRow.vendorLinkKey,
        publicShareUrl: pRow.publicShareUrl,
        createdAt: pRow.createdAt instanceof Date ? pRow.createdAt.toISOString() : String(pRow.createdAt),
      };

      if (!vendor) {
        return { partnership: base, status: 'error', error: 'vendor_missing', stats: null };
      }

      try {
        const stats = await fetchPartnerDashboard(vendor, pRow.vendorPartnerId);
        return { partnership: base, status: 'ok', stats };
      } catch (err: unknown) {
        return {
          partnership: base,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          stats: null,
        };
      }
    }),
  );

  res.json({
    partnerships: results,
    totals: computeTotals(results),
  });
});

function emptyTotals() {
  return {
    clicks: 0,
    attributedEvents: 0,
    attributedRevenue: 0,
    commission: { accrued: 0, approved: 0, paid: 0, reversed: 0 },
    vendorCount: 0,
    healthy: 0,
    unreachable: 0,
  };
}

function computeTotals(rows: PartnershipEarning[]) {
  const totals = emptyTotals();
  const vendors = new Set<string>();
  for (const r of rows) {
    vendors.add(r.partnership.vendorId);
    if (r.status === 'ok' && r.stats) {
      totals.clicks += r.stats.clicks;
      totals.attributedEvents += r.stats.attributedEvents;
      totals.attributedRevenue += r.stats.attributedRevenue;
      for (const [status, amount] of Object.entries(r.stats.commissionByStatus ?? {})) {
        const bucket = totals.commission as Record<string, number>;
        bucket[status] = (bucket[status] ?? 0) + Number(amount ?? 0);
      }
      totals.healthy += 1;
    } else {
      totals.unreachable += 1;
    }
  }
  totals.vendorCount = vendors.size;
  return totals;
}
