/**
 * Backfill PartnerCommission rows from current Campaign rules.
 *
 * For every Partner that has a single bound Campaign (via PartnerCampaign)
 * and no existing PartnerCommission row, write a snapshot using that
 * Campaign's current commissionRule + holdbackDays. Marked
 * `source = 'backfill'` so it's distinguishable from snapshots stamped
 * at approval time.
 *
 * Why we only backfill single-campaign partners: a partner granted
 * access to multiple campaigns has no obvious "the rate they were
 * approved under" — different campaigns may have different rules.
 * Snapshotting from one would silently apply that rule to commissions
 * accruing under another. Multi-campaign partners stay on the live-
 * Campaign-rule fallback (status quo) until an admin amendment flow
 * lets them snapshot per-grant.
 *
 * Idempotent: skips partners that already have a row. Safe to re-run.
 */

import type { Knex } from 'knex';
import { TABLES, type CommissionType } from '@openpartner/db';

export interface BackfillResult {
  scanned: number;
  /** Single-campaign partners with no snapshot — backfilled. */
  inserted: number;
  /** Partners skipped because they're granted to multiple campaigns
   *  (no unambiguous rule to snapshot). */
  ambiguous: number;
  /** Partners skipped because a snapshot already exists. */
  alreadyHadSnapshot: number;
  /** Partners skipped because their Campaign has no parseable
   *  commissionRule (legacy or corrupted). */
  noCampaignRule: number;
}

interface PartnerSlim {
  id: string;
  tenantId: string;
}

interface GrantSlim {
  partnerId: string;
  campaignId: string;
}

interface CampaignSlim {
  id: string;
  commissionRule: unknown;
  holdbackDays: number | null;
}

export async function backfillCommissionSnapshots(db: Knex, tenantId: string): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    inserted: 0,
    ambiguous: 0,
    alreadyHadSnapshot: 0,
    noCampaignRule: 0,
  };

  // Scope to active partners (revokedAt null). No point snapshotting
  // someone whose partnership is over.
  const partners = (await db(TABLES.Partner)
    .where({ tenantId })
    .whereNull('revokedAt')
    .select('id', 'tenantId')) as PartnerSlim[];

  if (partners.length === 0) return result;
  result.scanned = partners.length;

  const partnerIds = partners.map((p) => p.id);

  // Existing snapshots — skip these.
  const existing = (await db(TABLES.PartnerCommission)
    .whereIn('partnerId', partnerIds)
    .select('partnerId')) as Array<{ partnerId: string }>;
  const haveSnapshot = new Set(existing.map((e) => e.partnerId));

  // Grants per partner.
  const grants = (await db(TABLES.PartnerCampaign)
    .whereIn('partnerId', partnerIds)
    .select('partnerId', 'campaignId')) as GrantSlim[];

  const campaignsByPartner = new Map<string, string[]>();
  for (const g of grants) {
    const list = campaignsByPartner.get(g.partnerId) ?? [];
    list.push(g.campaignId);
    campaignsByPartner.set(g.partnerId, list);
  }

  // Bulk-load campaigns for everyone with exactly one grant — these
  // are the only ones we'll backfill.
  const singleCampaignIds = new Set<string>();
  for (const [, ids] of campaignsByPartner) {
    if (ids.length === 1) singleCampaignIds.add(ids[0]!);
  }
  const campaigns =
    singleCampaignIds.size === 0
      ? []
      : ((await db(TABLES.Campaign)
          .whereIn('id', [...singleCampaignIds])
          .select('id', 'commissionRule', 'holdbackDays')) as CampaignSlim[]);
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));

  const inserts: Array<{
    partnerId: string;
    tenantId: string;
    commissionType: CommissionType;
    commissionValue: string;
    recurring: boolean;
    holdbackDays: number | null;
    source: 'backfill';
    snapshottedAt: Date;
  }> = [];
  const now = new Date();

  for (const partner of partners) {
    if (haveSnapshot.has(partner.id)) {
      result.alreadyHadSnapshot += 1;
      continue;
    }
    const ids = campaignsByPartner.get(partner.id) ?? [];
    if (ids.length !== 1) {
      result.ambiguous += 1;
      continue;
    }
    const campaign = campaignById.get(ids[0]!);
    if (!campaign) {
      result.ambiguous += 1;
      continue;
    }
    const rule = parseRule(campaign.commissionRule);
    if (!rule) {
      result.noCampaignRule += 1;
      continue;
    }
    inserts.push({
      partnerId: partner.id,
      tenantId: partner.tenantId,
      commissionType: rule.type,
      commissionValue: rule.value.toFixed(4),
      recurring: rule.recurring ?? false,
      holdbackDays: campaign.holdbackDays,
      source: 'backfill',
      snapshottedAt: now,
    });
  }

  if (inserts.length > 0) {
    await db(TABLES.PartnerCommission).insert(inserts).onConflict('partnerId').ignore();
    result.inserted = inserts.length;
  }
  return result;
}

interface ParsedRule {
  type: CommissionType;
  value: number;
  recurring?: boolean;
}

function parseRule(raw: unknown): ParsedRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== 'percent' && r.type !== 'fixed') return null;
  if (typeof r.value !== 'number') return null;
  return {
    type: r.type,
    value: r.value,
    recurring: typeof r.recurring === 'boolean' ? r.recurring : false,
  };
}
