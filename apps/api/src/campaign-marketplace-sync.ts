/**
 * Campaign → Network Offering sync.
 *
 * The brand admin only manages campaigns. When a campaign has
 * `shareOnNetwork=true` and the tenant is connected to the Network, every
 * save triggers an auto-upsert of the corresponding Network Offering. The
 * Offering becomes a back-end mirror — never user-edited directly.
 *
 * Sync semantics:
 *   shareOnNetwork=true && no networkOfferingId  → create offering, store id
 *   shareOnNetwork=true && have networkOfferingId → patch existing offering
 *   shareOnNetwork=false && have networkOfferingId → patch published=false
 *
 * Failures are non-fatal: if the Network is down or rejects the call, we
 * log + continue (the campaign save itself succeeds). The brand can re-save
 * the campaign to retry, or unflip + reflip the toggle.
 *
 * The terms payload mirrors what the previous offering admin form built —
 * compound rules + customer reward + attribution snapshot — so creator-side
 * filters and the discover card render identically.
 */

import type { Knex } from 'knex';
import {
  TABLES,
  type CampaignRow,
  type CommissionRule,
  type CommissionSubRule,
} from '@openpartner/db';
import { parseCommissionRule } from './attribution.js';
import { getNetworkMembership } from './network-client.js';
import { networkProxy, NetworkProxyError } from './network-client.js';

interface OfferingTerms {
  commissionDescription?: string;
  cookieWindowDays?: number;
  payoutHoldbackDays?: number;
  attributionWindowDays?: number;
  attributionModel?: string;
  /** Legacy single-rule mirror for older Network clients. */
  commissionType?: 'percent' | 'fixed';
  commissionValue?: number;
  recurring?: boolean;
  /** Compound rule snapshot — preferred. */
  commissionRules?: CommissionSubRule[];
  customerReward?: unknown;
  campaignEndsAt?: string | null;
}

/**
 * Upsert (or unpublish) the Network offering tied to this campaign.
 * Returns the offering id when one exists post-sync — caller persists it
 * back to Campaign.networkOfferingId so subsequent edits hit the same row.
 *
 * Returns null when no sync happened (Network not configured for tenant,
 * or campaign was never on the Network and shareOnNetwork is false).
 *
 * Throws never. Errors are logged.
 */
export async function syncCampaignToMarketplace(
  db: Knex,
  tenantId: string,
  campaign: CampaignRow,
  derivedSummary: string,
): Promise<string | null> {
  const membership = await getNetworkMembership(db, tenantId);
  if (!membership?.enabled) {
    // Brand not on the Network — nothing to do. Even a campaign with
    // shareOnNetwork=true is effectively a no-op until they connect.
    return campaign.networkOfferingId;
  }

  const terms = buildTermsPayload(campaign, derivedSummary);

  // Path A: campaign opted out of the marketplace. If we have a
  // networkOfferingId on file, flip its published flag to false. We
  // don't DELETE — preserves history + the path back if they re-enable.
  if (!campaign.shareOnNetwork) {
    if (!campaign.networkOfferingId) return null;
    try {
      await networkProxy.updateOffering(db, tenantId, campaign.networkOfferingId, {
        published: false,
      });
    } catch (err) {
      logSyncError('unpublish', campaign.id, err);
    }
    return campaign.networkOfferingId;
  }

  // Path B: shareOnNetwork=true. Update if we know about an existing
  // offering, otherwise create a new one and capture the id back.
  if (campaign.networkOfferingId) {
    try {
      await networkProxy.updateOffering(db, tenantId, campaign.networkOfferingId, {
        title: campaign.name,
        description: campaign.marketplaceDescription ?? null,
        productUrl: campaign.destinationUrl,
        terms,
        published: true,
      });
    } catch (err) {
      logSyncError('update', campaign.id, err);
    }
    return campaign.networkOfferingId;
  }

  try {
    const created = (await networkProxy.createOffering(db, tenantId, {
      title: campaign.name,
      description: campaign.marketplaceDescription ?? undefined,
      productUrl: campaign.destinationUrl,
      vendorCampaignId: campaign.id,
      terms,
      published: true,
    })) as { id?: string } | null;
    return created?.id ?? null;
  } catch (err) {
    logSyncError('create', campaign.id, err);
    return null;
  }
}

function buildTermsPayload(campaign: CampaignRow, derivedSummary: string): OfferingTerms {
  let rules: CommissionRule;
  try {
    rules = parseCommissionRule(campaign.commissionRule);
  } catch {
    rules = [];
  }
  // Best-effort legacy single-rule mirror so older Network consumers still
  // render something. Same logic as backfill-commission-snapshots.ts.
  const legacy = rules.find((r) => r.trigger === 'every') ?? rules[0];
  return {
    commissionDescription: derivedSummary,
    payoutHoldbackDays: campaign.holdbackDays ?? undefined,
    attributionWindowDays: campaign.attributionWindowDays,
    attributionModel: campaign.attributionModel,
    commissionType: legacy?.type,
    commissionValue: legacy?.value,
    recurring: legacy?.recurring ?? false,
    commissionRules: rules,
    customerReward: campaign.customerReward ?? null,
    campaignEndsAt: campaign.endsAt ? campaign.endsAt.toISOString() : null,
  };
}

function logSyncError(op: 'create' | 'update' | 'unpublish', campaignId: string, err: unknown): void {
  const detail =
    err instanceof NetworkProxyError
      ? `${err.status} ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  console.error(`[campaign-marketplace-sync] ${op} failed`, { campaignId, detail });
}

/** Default for new-campaign shareOnNetwork when the caller didn't specify.
 *  True when the brand is on the Network so the common case is one-click
 *  publish; false otherwise. */
export async function defaultShareOnNetwork(db: Knex, tenantId: string): Promise<boolean> {
  const membership = await getNetworkMembership(db, tenantId);
  return Boolean(membership?.enabled);
}

/** Re-load the campaign after a sync and persist any newly-discovered
 *  networkOfferingId. Idempotent — skips the UPDATE when the value is
 *  already correct, so writing this on every save is fine. */
export async function persistNetworkOfferingId(
  db: Knex,
  campaignId: string,
  networkOfferingId: string | null,
): Promise<void> {
  await db<CampaignRow>(TABLES.Campaign)
    .where({ id: campaignId })
    .andWhere((qb) => {
      if (networkOfferingId == null) qb.whereNotNull('networkOfferingId');
      else qb.where('networkOfferingId', '!=', networkOfferingId).orWhereNull('networkOfferingId');
    })
    .update({ networkOfferingId });
}
