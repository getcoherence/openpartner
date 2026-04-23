/**
 * Stripe Connect Standard onboarding for partners.
 *
 * We use AccountLinks (the modern hosted onboarding), not legacy OAuth. The
 * partner clicks "Connect payouts" in the portal → we create or reuse a
 * Standard account → return a one-time URL → partner completes on Stripe →
 * bounces back to return_url → we read stripeConnectAccountId as stored.
 *
 * Active/ready status is confirmed via the `account.updated` webhook, not at
 * the callback — the callback fires before Stripe has finalized verification.
 */

import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type PartnerRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { requireStripe } from '../stripe.js';

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
    const body = startSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

    const stripe = requireStripe();
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });

    let accountId = partner.stripeConnectAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'standard',
        email: partner.email,
        metadata: { openpartner_partner_id: partner.id },
      });
      accountId = account.id;
      await db<PartnerRow>(TABLES.Partner)
        .where({ id: partner.id })
        .update({ stripeConnectAccountId: accountId, updatedAt: new Date() });
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      return_url: body.data.returnUrl,
      refresh_url: body.data.refreshUrl,
      type: 'account_onboarding',
    });

    res.json({ url: link.url, expiresAt: link.expires_at });
  },
);

connectRouter.get(
  '/partners/:id/connect/status',
  requireAuth,
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });

    if (!partner.stripeConnectAccountId) {
      return res.json({ connected: false });
    }

    const stripe = requireStripe();
    const account = await stripe.accounts.retrieve(partner.stripeConnectAccountId);
    res.json({
      connected: true,
      accountId: account.id,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    });
  },
);
