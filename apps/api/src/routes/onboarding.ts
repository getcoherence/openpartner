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
import { getTenantBillingState } from '../billing-plan.js';

export const onboardingRouter = Router();

interface BrandOnboardingStatus {
  brandInfoComplete: boolean;
  campaignCount: number;
  networkConnected: boolean;
  offeringPublishedCount: number;
  partnerCount: number;
  /** Pending creator applications waiting for brand approval on the
   *  Network. Drives the "X partners are waiting" subscribe-now banner
   *  on the Dashboard. 0 when Network is unreachable or not connected. */
  pendingPartnershipRequests: number;
  /** True when billing is set up OR not required (selfhost / enterprise). */
  billingReady: boolean;
  /** ISO timestamp the in-product evaluation window ends. Null when there's
   *  no trial concept (selfhost / enterprise / legacy tenants). The UI
   *  shows "Subscribe by <date>" / urgency styling off this. */
  trialEndsAt: string | null;
  /** Whole days from now until trialEndsAt. Negative when expired. Null
   *  when trialEndsAt is null. */
  trialDaysRemaining: number | null;
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
  let pendingPartnershipRequests = 0;
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
    try {
      const r = await networkProxy.listRequests(db, tenantId, 'pending');
      pendingPartnershipRequests = Array.isArray(r.requests) ? r.requests.length : 0;
    } catch (err) {
      if (!(err instanceof NetworkProxyError)) throw err;
      // Same fallback semantics — Network outage shouldn't suppress
      // the rest of the onboarding probe.
    }
  }

  // Billing readiness: selfhost has no billing, so always "ready".
  // Enterprise tenants are billed out of band — we treat as "ready"
  // since there's no Checkout flow for them. Everyone else needs an
  // active Stripe subscription.
  const billingState = await getTenantBillingState(db, tenantId);
  const billingReady =
    billingState.mode === 'selfhost' ||
    billingState.plan === 'enterprise' ||
    !!billingState.stripeSubscriptionId;

  // Surface the signup-set evaluation window so the dashboard can render
  // a "Subscribe by <date>" pressure task instead of an "activate trial"
  // task. Selfhost + enterprise + legacy tenants without a trialEndsAt
  // get null — the UI falls back to a plain "Set up billing" label.
  const trialEndsAt = billingState.trialEndsAt;
  let trialDaysRemaining: number | null = null;
  if (trialEndsAt) {
    const msPerDay = 24 * 60 * 60 * 1000;
    trialDaysRemaining = Math.ceil((trialEndsAt.getTime() - Date.now()) / msPerDay);
  }

  const complete =
    brandInfoComplete &&
    campaignCount > 0 &&
    networkConnected &&
    offeringPublishedCount > 0 &&
    partnerCount > 0 &&
    billingReady;

  const out: BrandOnboardingStatus = {
    brandInfoComplete,
    campaignCount,
    networkConnected,
    offeringPublishedCount,
    partnerCount,
    pendingPartnershipRequests,
    billingReady,
    trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
    trialDaysRemaining,
    complete,
  };
  res.json(out);
});
