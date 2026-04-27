/**
 * Merchant billing endpoints — only meaningful in hosted modes.
 *
 *   selfhost  → /billing/status responds 'selfhost', everything else 404.
 *   flat      → Stripe Checkout + Customer Portal for the merchant's
 *               monthly subscription.
 *   revshare  → /billing/status surfaces accrued platform fees; collection is
 *               handled out-of-band against the 3% retained on payouts.
 *
 * Multi-tenant: every Stripe object created here is stamped with
 * openpartner_tenant_id in metadata so the webhook handler can resolve the
 * tenant on inbound events without hitting the path router.
 */

import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import { TABLES } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { REVSHARE_FEE_BPS, getMode, requireStripe } from '../stripe.js';
import { CONFIG_KEYS, getConfig, setConfig } from '../config.js';
import { reportUsageToStripe } from '../usage-billing.js';
import { tenantOf } from '../tenancy.js';

export const billingRouter = Router();

billingRouter.get('/billing/status', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const mode = getMode();
  if (mode === 'selfhost') {
    return res.json({ mode, billed: false });
  }

  if (mode === 'flat') {
    const subscriptionId = await getConfig<string>(db, tenantId, CONFIG_KEYS.StripeMerchantSubscriptionId);
    if (!subscriptionId) return res.json({ mode, subscribed: false });
    const stripe = requireStripe();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end
      ?? sub.items.data[0]?.current_period_end
      ?? null;
    return res.json({
      mode,
      subscribed: true,
      subscriptionId: sub.id,
      status: sub.status,
      currentPeriodEnd: periodEnd,
    });
  }

  // revshare: sum of platform fees retained on paid payouts, by currency.
  const fees = (await db(TABLES.Payout)
    .where({ status: 'paid' })
    .select('currency')
    .select(db.raw("COALESCE(SUM((metadata->>'platformFee')::numeric), 0) as fee"))
    .groupBy('currency')) as Array<{ currency: string; fee: string }>;

  res.json({
    mode,
    feeRate: `${REVSHARE_FEE_BPS / 100}%`,
    accruedPlatformFees: fees.reduce<Record<string, number>>((acc, f) => {
      acc[f.currency] = Number(f.fee);
      return acc;
    }, {}),
  });
});

const checkoutSchema = z.object({
  priceId: z.string().min(1).optional(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  customerEmail: z.string().email().optional(),
});

billingRouter.post('/billing/checkout', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const mode = getMode();
  if (mode !== 'flat' && mode !== 'revshare') {
    return res.status(400).json({ error: 'only_flat_or_revshare_mode' });
  }
  const body = checkoutSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  // Build line items per mode:
  //   flat     → $49 base + 1.5% metered
  //   revshare → 3% metered only (no monthly)
  const lineItems: Array<{ price: string; quantity?: number }> = [];
  if (mode === 'flat') {
    const basePriceId = body.data.priceId ?? process.env.STRIPE_FLAT_PRICE_ID;
    if (!basePriceId) return res.status(500).json({ error: 'no_flat_price_configured' });
    lineItems.push({ price: basePriceId, quantity: 1 });
    const usagePriceId = process.env.STRIPE_FLAT_USAGE_PRICE_ID;
    if (usagePriceId) lineItems.push({ price: usagePriceId });
  } else {
    const usagePriceId = body.data.priceId ?? process.env.STRIPE_REVSHARE_USAGE_PRICE_ID;
    if (!usagePriceId) return res.status(500).json({ error: 'no_revshare_price_configured' });
    lineItems.push({ price: usagePriceId });
  }

  const stripe = requireStripe();

  // Stripe Accounts V2 requires `customer` (not just `customer_email`) on
  // Checkout in test mode. Create or reuse a Customer for this merchant up
  // front so we can pass it to the Checkout session and so the Customer
  // Portal works on the same record after subscription completes.
  let customerId = await getConfig<string>(db, tenantId, CONFIG_KEYS.StripeMerchantCustomerId);
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: body.data.customerEmail,
      metadata: {
        openpartner_role: 'merchant_self_subscription',
        openpartner_tenant_id: tenantId,
      },
    });
    customerId = customer.id;
    await setConfig(db, tenantId, CONFIG_KEYS.StripeMerchantCustomerId, customerId);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: lineItems,
    success_url: body.data.successUrl,
    cancel_url: body.data.cancelUrl,
    metadata: { openpartner_tenant_id: tenantId },
  });
  res.json({ url: session.url });
});

billingRouter.post('/billing/report-usage', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  // Self-host has no platform billing; revshare and flat both report to the
  // shared meter (different metered prices on the merchant subscription
  // determine the rate).
  if (getMode() === 'selfhost') {
    return res.status(400).json({ error: 'no_billing_in_selfhost' });
  }
  try {
    const result = await reportUsageToStripe(db, tenantId);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: 'usage_report_failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

billingRouter.post('/billing/portal', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  if (getMode() !== 'flat') return res.status(400).json({ error: 'only_flat_mode' });
  const body = z.object({ returnUrl: z.string().url() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const customerId = await getConfig<string>(db, tenantId, CONFIG_KEYS.StripeMerchantCustomerId);
  if (!customerId) return res.status(404).json({ error: 'no_customer_on_file' });

  const stripe = requireStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: body.data.returnUrl,
  });
  res.json({ url: session.url });
});

// Exposed for the stripe webhook to call on checkout.session.completed.
// Webhook resolves tenantId from event metadata and passes its own db handle
// (a transaction with app.tenant_id pinned).
export async function persistMerchantSubscription(
  db: Knex,
  tenantId: string,
  customerId: string,
  subscriptionId: string,
): Promise<void> {
  await setConfig(db, tenantId, CONFIG_KEYS.StripeMerchantCustomerId, customerId);
  await setConfig(db, tenantId, CONFIG_KEYS.StripeMerchantSubscriptionId, subscriptionId);
}
