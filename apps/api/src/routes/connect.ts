/**
 * Stripe Connect onboarding: Standard by default, Custom payouts by opt-in.
 *
 * We use AccountLinks (the modern hosted onboarding), not legacy OAuth. The
 * partner clicks "Connect Stripe" ("Set up payouts" for Custom) in the
 * portal → we create the configured account type or reuse their saved
 * account → return a one-time URL → partner completes on Stripe →
 * bounces back to return_url → we read stripeConnectAccountId as stored.
 *
 * Custom accounts have no Stripe dashboard, so /connect/update hands the
 * partner an account_update link to change their bank or details later.
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
import { countryCodeSchema } from '../country-access.js';

const linkSchema = z.object({
  returnUrl: z.string().url(),
  refreshUrl: z.string().url(),
});

const startSchema = linkSchema.extend({
  // Where the partner is based. Required to create a Custom account: Stripe
  // fixes an account's country at creation. Standard accounts ask on Stripe.
  country: countryCodeSchema().optional(),
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
      let custom: Partial<Stripe.AccountCreateParams> = {};
      if (isCustom) {
        const country = body.data.country;
        if (!country) return res.status(400).json({ error: 'country_required' });
        const platform = await stripe.accounts.retrieveCurrent();
        // A partner outside the platform's country can only receive
        // transfers, under the recipient service agreement.
        const crossBorder = country !== platform.country;
        const usTax = country === 'US' && !crossBorder;
        custom = {
          country,
          capabilities: {
            transfers: { requested: true },
            ...(usTax && settings.collectTaxInformation ? { tax_reporting_us_1099_misc: { requested: true } } : {}),
            ...(usTax && settings.collect1099KTaxInformation ? { tax_reporting_us_1099_k: { requested: true } } : {}),
          },
          ...(crossBorder ? { tos_acceptance: { service_agreement: 'recipient' } } : {}),
          ...(settings.productDescription ? {
            business_profile: { product_description: settings.productDescription },
          } : {}),
        };
      }
      const params: Stripe.AccountCreateParams = {
        type: isCustom ? 'custom' : 'standard',
        ...custom,
        email: partner.email,
        metadata: {
          openpartner_partner_id: partner.id,
          openpartner_tenant_id: tenantId,
        },
      };
      // Changing settings after a rolled-back attempt must not reuse a key
      // with different Stripe parameters. Identical retries still deduplicate.
      const fingerprint = createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 24);
      let account: Stripe.Account;
      try {
        account = await stripe.accounts.create(params, {
          // If account-link creation fails, the request's DB transaction rolls
          // back. Reuse the Stripe account when the partner retries that request.
          idempotencyKey: `connect-account:${tenantId}:${partner.id}:${fingerprint}`,
        });
      } catch (err) {
        // Stripe refusing the account (a country it can't onboard, or no
        // cross-border payouts from the platform's country) is the partner's
        // or operator's to fix, not a server error.
        if ((err as { type?: string }).type === 'StripeInvalidRequestError') {
          return res.status(400).json({ error: 'stripe_account_rejected', detail: (err as Error).message });
        }
        throw err;
      }
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

connectRouter.post(
  '/partners/:id/connect/update',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const body = linkSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });
    if (!partner.stripeConnectAccountId) return res.status(409).json({ error: 'connect_not_started' });

    // Standard accounts manage their details in their own Stripe dashboard;
    // Stripe only issues account_update links for Custom accounts.
    const stripe = requireStripe();
    const account = await stripe.accounts.retrieve(partner.stripeConnectAccountId);
    if (account.type !== 'custom') return res.status(409).json({ error: 'not_a_custom_account' });

    const link = await stripe.accountLinks.create({
      account: account.id,
      return_url: body.data.returnUrl,
      refresh_url: body.data.refreshUrl,
      type: 'account_update',
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
    // Stripe doesn't contact a Custom account's holder when it needs more
    // details, so the portal asks before payouts pause. /connect/start's
    // onboarding link collects what's due.
    const requirements = account.requirements;
    const requirementsDue = !!(requirements?.currently_due?.length || requirements?.past_due?.length);
    res.json({
      connected: true,
      accountId: account.id,
      accountType: account.type,
      chargesEnabled: account.charges_enabled,
      transfersEnabled: account.capabilities?.transfers === 'active',
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirementsDue,
      requirementsDueBy: requirementsDue && requirements?.current_deadline
        ? new Date(requirements.current_deadline * 1000).toISOString()
        : null,
    });
  },
);
