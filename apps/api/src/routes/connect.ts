/**
 * Stripe Connect onboarding: Standard by default, Custom payouts by opt-in.
 *
 * We use AccountLinks (the modern hosted onboarding), not legacy OAuth. The
 * partner clicks "Set up payouts" in the portal → we create the configured
 * account type or reuse their saved account → return a
 * one-time URL → partner completes on Stripe →
 * bounces back to return_url → we read stripeConnectAccountId as stored.
 *
 * Active/ready status is confirmed via the `account.updated` webhook, not at
 * the callback — the callback fires before Stripe has finalized verification.
 *
 * Multi-tenant: Connect accounts are stamped with openpartner_tenant_id so
 * the webhook handler can resolve the tenant on inbound account.* events.
 */

import { Router } from 'express';
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { z } from '../zod.js';
import { TABLES, type PartnerRow } from '@openpartner/db';
import { requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { requireStripe } from '../stripe.js';
import { tenantOf } from '../tenancy.js';
import { readConnectSettings } from '../connect-settings.js';

const startSchema = z.object({
  returnUrl: z.string().url(),
  refreshUrl: z.string().url(),
});

export const connectRouter = Router();

connectRouter.post(
  '/partners/:id/connect/start',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = startSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const stripe = requireStripe();
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });

    const settings = await readConnectSettings(db, tenantId);
    let isCustom = settings.accountMode === 'custom_payouts';
    let accountId = partner.stripeConnectAccountId;
    if (!accountId) {
      const params: Stripe.AccountCreateParams = {
        type: isCustom ? 'custom' : 'standard',
        ...(isCustom ? {
          capabilities: {
            transfers: { requested: true },
            ...(settings.requestCardPayments ? { card_payments: { requested: true } } : {}),
            ...(settings.collectTaxInformation ? { tax_reporting_us_1099_misc: { requested: true } } : {}),
            ...(settings.collect1099KTaxInformation ? { tax_reporting_us_1099_k: { requested: true } } : {}),
          },
          ...(settings.productDescription ? {
            business_profile: { product_description: settings.productDescription },
          } : {}),
        } : {}),
        email: partner.email,
        metadata: {
          openpartner_partner_id: partner.id,
          openpartner_tenant_id: tenantId,
        },
      };
      // Changing settings after a rolled-back attempt must not reuse a key
      // with different Stripe parameters. Identical retries still deduplicate.
      const fingerprint = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 24);
      const account = await stripe.accounts.create(params, {
        // If account-link creation fails, the request's DB transaction rolls
        // back. Reuse the Stripe account when the partner retries that request.
        idempotencyKey: `connect-account:${tenantId}:${partner.id}:${fingerprint}`,
      });
      accountId = account.id;
      await db<PartnerRow>(TABLES.Partner)
        .where({ id: partner.id, tenantId })
        .update({ stripeConnectAccountId: accountId, updatedAt: new Date() });
    } else {
      // The saved account's type controls its onboarding even if the admin
      // has since selected a different type for new partners.
      const account = await stripe.accounts.retrieve(accountId);
      isCustom = account.type === 'custom';
    }

    // Saved account IDs remain authoritative. Reuse both legacy Standard and
    // current Custom accounts without converting them or changing capabilities.

    const link = await stripe.accountLinks.create({
      account: accountId,
      return_url: body.data.returnUrl,
      refresh_url: body.data.refreshUrl,
      type: 'account_onboarding',
      // Collect known identity and tax requirements up front, including those
      // that would otherwise only become due after the partner receives funds.
      ...(isCustom ? {
        collection_options: {
          fields: settings.collectEventuallyDue ? 'eventually_due' as const : 'currently_due' as const,
          future_requirements: settings.collectFutureRequirements ? 'include' as const : 'omit' as const,
        },
      } : {}),
    });

    res.json({ url: link.url, expiresAt: link.expires_at });
  },
);

connectRouter.get(
  '/partners/:id/connect/status',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });

    if (!partner.stripeConnectAccountId) {
      const settings = await readConnectSettings(db, tenantId);
      return res.json({
        connected: false,
        accountMode: settings.accountMode,
        activityDescriptionPrefilled: settings.accountMode === 'custom_payouts' && !!settings.productDescription,
      });
    }

    const stripe = requireStripe();
    const account = await stripe.accounts.retrieve(partner.stripeConnectAccountId);
    res.json({
      connected: true,
      accountId: account.id,
      chargesEnabled: account.charges_enabled,
      transfersEnabled: account.capabilities?.transfers === 'active',
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    });
  },
);
