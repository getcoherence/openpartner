/**
 * Backfill PartnerCommission rows from current Program rules.
 *
 * For every active Partner, writes one PROGRAM-SCOPED snapshot per
 * program grant (PartnerProgram) using that Program's current
 * commissionRule + holdbackDays. Marked `source = 'backfill'` so it's
 * distinguishable from snapshots stamped at approval time.
 *
 * This used to backfill only single-program partners, with a
 * partner-wide row: a partner-wide row applies to every program, so for a
 * partner in several programs there was no one rule to write — any choice
 * would price commissions on the others at the wrong program's rate.
 * Program-scoped rows remove the ambiguity: each grant freezes its own
 * program's terms. Single-program partners get a program-scoped row too,
 * so a program granted later accrues at its own rule instead of
 * inheriting the first program's.
 *
 * Skips, without writing anything:
 *   - partners with a partner-wide row (programId null). That row already
 *     prices every program they're in; a program-scoped row would shadow
 *     it and change what they're paid.
 *   - grants that already have a program-scoped row.
 *
 * Idempotent: safe to re-run.
 */

import type { Knex } from 'knex';
import { TABLES, type CommissionRule } from '@openpartner/db';
import { parseCommissionRule } from './attribution.js';
import { legacyRuleColumns, newPartnerCommissionId, partnerCommissionConflictTarget } from './partner-commission.js';

export interface BackfillResult {
  /** Active partners looked at. */
  scanned: number;
  /** Program-scoped snapshot rows written (one per grant). */
  inserted: number;
  /** Partners skipped because a partner-wide snapshot already covers
   *  every program they're in. */
  coveredByPartnerWide: number;
  /** Grants skipped because a program-scoped snapshot already exists. */
  alreadyHadSnapshot: number;
  /** Partners skipped because they have no program grants. */
  noGrants: number;
  /** Grants skipped because their Program has no parseable
   *  commissionRule (legacy or corrupted). */
  noCampaignRule: number;
}

interface PartnerSlim {
  id: string;
  tenantId: string;
}

interface GrantSlim {
  partnerId: string;
  programId: string;
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
    coveredByPartnerWide: 0,
    alreadyHadSnapshot: 0,
    noGrants: 0,
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

  const existing = (await db(TABLES.PartnerCommission)
    .whereIn('partnerId', partnerIds)
    .select('partnerId', 'programId')) as Array<{ partnerId: string; programId: string | null }>;
  const partnerWide = new Set(existing.filter((e) => e.programId === null).map((e) => e.partnerId));
  const scoped = new Set(existing.filter((e) => e.programId !== null).map((e) => `${e.partnerId}:${e.programId}`));

  const grants = (await db(TABLES.PartnerProgram)
    .whereIn('partnerId', partnerIds)
    .select('partnerId', 'programId')) as GrantSlim[];
  const programsByPartner = new Map<string, string[]>();
  for (const g of grants) {
    const list = programsByPartner.get(g.partnerId) ?? [];
    list.push(g.programId);
    programsByPartner.set(g.partnerId, list);
  }

  const programIds = [...new Set(grants.map((g) => g.programId))];
  const campaigns =
    programIds.length === 0
      ? []
      : ((await db(TABLES.Program)
          .whereIn('id', programIds)
          .select('id', 'commissionRule', 'holdbackDays')) as CampaignSlim[]);
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  // Parse each program's rule once, not once per grant.
  const rulesByProgram = new Map<string, CommissionRule | null>();
  for (const c of campaigns) {
    let rules: CommissionRule | null;
    try {
      rules = parseCommissionRule(c.commissionRule);
    } catch {
      rules = null;
    }
    rulesByProgram.set(c.id, rules && rules.length > 0 ? rules : null);
  }

  const inserts: Array<Record<string, unknown>> = [];
  const now = new Date();

  for (const partner of partners) {
    if (partnerWide.has(partner.id)) {
      result.coveredByPartnerWide += 1;
      continue;
    }
    const ids = programsByPartner.get(partner.id) ?? [];
    if (ids.length === 0) {
      result.noGrants += 1;
      continue;
    }
    for (const programId of ids) {
      if (scoped.has(`${partner.id}:${programId}`)) {
        result.alreadyHadSnapshot += 1;
        continue;
      }
      const campaign = campaignById.get(programId);
      const rules = rulesByProgram.get(programId);
      if (!campaign || !rules) {
        result.noCampaignRule += 1;
        continue;
      }
      inserts.push({
        id: newPartnerCommissionId(),
        partnerId: partner.id,
        tenantId: partner.tenantId,
        programId,
        ...legacyRuleColumns(rules),
        // Stored as a JSON-stringified value so knex routes it through the
        // jsonb column without trying to spread the array as columns.
        commissionRules: JSON.stringify(rules),
        holdbackDays: campaign.holdbackDays,
        source: 'backfill',
        snapshottedAt: now,
      });
    }
  }

  if (inserts.length > 0) {
    // Ignore on the program-scope index: a row written between the read
    // above and here (a concurrent PUT) wins.
    const written = await db(TABLES.PartnerCommission)
      .insert(inserts)
      .onConflict(partnerCommissionConflictTarget(db, true))
      .ignore()
      .returning('id');
    result.inserted = written.length;
  }
  return result;
}
