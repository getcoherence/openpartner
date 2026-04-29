/**
 * Brand admin onboarding state.
 *
 * Single GET that the Dashboard's "Getting started" card consumes.
 * We aggregate counts + a Network-connected flag here so the card
 * doesn't have to fan out four separate queries on every render.
 *
 * Response is intentionally booleans + small ints — every item the
 * UI shows is something the admin can check off without the response
 * giving them lookup IDs to chase.
 */

import { Router } from 'express';
import { TABLES, type CampaignRow, type PartnerRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { getNetworkMembership, networkProxy, NetworkProxyError } from '../network-client.js';

export const onboardingRouter = Router();

interface BrandOnboardingStatus {
  brandInfoComplete: boolean;
  campaignCount: number;
  networkConnected: boolean;
  offeringPublishedCount: number;
  partnerCount: number;
  /** True once everything actionable is done — card hides. */
  complete: boolean;
}

onboardingRouter.get('/admin/onboarding-status', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);

  // Brand info is "complete" if either program_settings.programName is
  // explicitly set OR the Tenant has a displayName from signup. We
  // accept the signup value because re-typing it in Settings just to
  // satisfy a checkbox is dumb.
  const programRow = await db(TABLES.Config).where({ key: 'program_settings' }).first();
  const programName = ((programRow?.value as { programName?: string })?.programName ?? '').trim();
  const tenant = await db('Tenant').where({ id: tenantId }).first(['displayName']);
  const displayName = ((tenant?.displayName as string | undefined) ?? '').trim();
  const brandInfoComplete = programName.length > 0 || displayName.length > 0;

  const campaignRows = await db<CampaignRow>(TABLES.Campaign).count<Array<{ count: string }>>({ count: '*' });
  const campaignCount = Number(campaignRows[0]?.count ?? 0);

  const partnerRows = await db<PartnerRow>(TABLES.Partner)
    .whereNull('revokedAt')
    .count<Array<{ count: string }>>({ count: '*' });
  const partnerCount = Number(partnerRows[0]?.count ?? 0);

  const membership = await getNetworkMembership(db, tenantId);
  const networkConnected = !!(membership?.enabled && membership.vendorTokenCiphertext);

  // Offering count: only when connected. Network would 503 otherwise
  // and we don't want a transient Network outage to block onboarding.
  let offeringPublishedCount = 0;
  if (networkConnected) {
    try {
      const r = await networkProxy.listOfferings(db, tenantId);
      offeringPublishedCount = Array.isArray(r.offerings)
        ? r.offerings.filter((o: unknown) => (o as { published?: boolean }).published).length
        : 0;
    } catch (err) {
      if (!(err instanceof NetworkProxyError)) throw err;
      // Leave as 0; surface as "not done yet" rather than failing the
      // whole probe because the Network can't be reached.
    }
  }

  const complete =
    brandInfoComplete &&
    campaignCount > 0 &&
    networkConnected &&
    offeringPublishedCount > 0 &&
    partnerCount > 0;

  const out: BrandOnboardingStatus = {
    brandInfoComplete,
    campaignCount,
    networkConnected,
    offeringPublishedCount,
    partnerCount,
    complete,
  };
  res.json(out);
});
