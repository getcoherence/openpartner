/**
 * Merchant billing endpoints — only meaningful in hosted modes.
 *
 *   selfhost  → /billing/status responds 'selfhost', everything else 404.
 *   flat      → Stripe Checkout + Customer Portal for the merchant's
 *               monthly subscription.
 *   revshare  → /billing/status surfaces accrued platform fees; collection is
 *               handled out-of-band against the 3% retained on payouts.
 */

import { Router } from 'express';
import { z } from 'zod';
import { TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { REVSHARE_FEE_BPS, getMode, requireStripe } from '../stripe.js';
import { CONFIG_KEYS, getConfig, setConfig } from '../config.js';

export const billingRouter = Router();

billingRouter.get('/billing/status', requireAuth, requireAdmin, async (_req, res) => {
  const mode = getMode();
  if (mode === 'selfhost') {
    return res.json({ mode, billed: false });
  }

  if (mode === 'flat') {
    const subscriptionId = await getConfig<string>(CONFIG_KEYS.StripeMerchantSubscriptionId);
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
  if (getMode() !== 'flat') return res.status(400).json({ error: 'only_flat_mode' });
  const body = checkoutSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const priceId = body.data.priceId ?? process.env.STRIPE_FLAT_PRICE_ID;
  if (!priceId) return res.status(500).json({ error: 'no_flat_price_configured' });

  const stripe = requireStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: body.data.successUrl,
    cancel_url: body.data.cancelUrl,
    customer_email: body.data.customerEmail,
  });
  res.json({ url: session.url });
});

billingRouter.post('/billing/portal', requireAuth, requireAdmin, async (req, res) => {
  if (getMode() !== 'flat') return res.status(400).json({ error: 'only_flat_mode' });
  const body = z.object({ returnUrl: z.string().url() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const customerId = await getConfig<string>(CONFIG_KEYS.StripeMerchantCustomerId);
  if (!customerId) return res.status(404).json({ error: 'no_customer_on_file' });

  const stripe = requireStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: body.data.returnUrl,
  });
  res.json({ url: session.url });
});

// Exposed for the stripe webhook to call on checkout.session.completed.
export async function persistMerchantSubscription(customerId: string, subscriptionId: string): Promise<void> {
  await setConfig(CONFIG_KEYS.StripeMerchantCustomerId, customerId);
  await setConfig(CONFIG_KEYS.StripeMerchantSubscriptionId, subscriptionId);
}
