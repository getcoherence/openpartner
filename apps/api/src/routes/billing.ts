/**
 * Per-tenant billing endpoints.
 *
 * Each tenant on a hosted multi-tenant deployment picks one of:
 *
 *   flex        $49/mo + 1.5% metered. Stripe subscription with two
 *               line items (base + usage), 14-day trial.
 *   revshare    3% metered, no monthly. Stripe subscription with the
 *               metered line item only, 14-day trial.
 *   enterprise  Custom — no Stripe sub, billed out of band.
 *
 * Selfhost installs run as one tenant under the global OPENPARTNER_MODE
 * env (selfhost / flat / revshare). The per-tenant resolver in
 * billing-plan.ts unifies both paths so this route stays mode-agnostic.
 *
 * Stripe Customer + Subscription IDs live on the Tenant row
 * (stripeCustomerId, stripeSubscriptionId). The legacy Config-keyed
 * store (stripe.merchant.{customerId,subscriptionId}) is back-filled
 * by the tenant_billing_plan migration; this file only reads/writes
 * Tenant.
 */

import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import { TABLES, BILLING_PLANS, type BillingPlan, type TenantRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { REVSHARE_FEE_BPS, requireStripe } from '../stripe.js';
import { getTenantBillingState, priceIdsForPlan } from '../billing-plan.js';
import { reportUsageToStripe } from '../usage-billing.js';
import { tenantOf } from '../tenancy.js';

export const billingRouter = Router();

billingRouter.get('/billing/status', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);
  const mode = state.mode;

  if (mode === 'selfhost') {
    return res.json({ mode, plan: null, billed: false });
  }

  if (state.plan === 'enterprise') {
    return res.json({
      mode,
      plan: state.plan,
      enterprise: true,
      message: 'Billed out of band — contact your account manager.',
    });
  }

  if (mode === 'flat') {
    if (!state.stripeSubscriptionId) {
      return res.json({
        mode,
        plan: state.plan,
        subscribed: false,
        trialEndsAt: state.trialEndsAt,
        inTrial: state.inTrial,
        hasUsedTrial: state.hasUsedTrial,
        trialExpiredWithoutSubscription: state.trialExpiredWithoutSubscription,
      });
    }
    const stripe = requireStripe();
    const sub = await stripe.subscriptions.retrieve(state.stripeSubscriptionId);
    const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end
      ?? sub.items.data[0]?.current_period_end
      ?? null;
    return res.json({
      mode,
      plan: state.plan,
      subscribed: true,
      subscriptionId: sub.id,
      status: sub.status,
      currentPeriodEnd: periodEnd,
      trialEnd: sub.trial_end,
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
    plan: state.plan,
    feeRate: `${REVSHARE_FEE_BPS / 100}%`,
    accruedPlatformFees: fees.reduce<Record<string, number>>((acc, f) => {
      acc[f.currency] = Number(f.fee);
      return acc;
    }, {}),
    subscribed: !!state.stripeSubscriptionId,
    trialEndsAt: state.trialEndsAt,
    inTrial: state.inTrial,
  });
});

/**
 * Set the tenant's plan in-place when none was picked at signup
 * (legacy tenants + anyone who signed up before the marketing
 * pricing CTAs). Refuses to overwrite an existing plan — those go
 * through the Stripe Customer Portal so the subscription's price
 * IDs change in lockstep with our local mirror.
 */
const setPlanSchema = z.object({
  plan: z.enum(BILLING_PLANS as readonly [string, ...string[]]),
});
billingRouter.post('/billing/plan', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = setPlanSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const state = await getTenantBillingState(db, tenantId);
  if (state.plan) {
    return res.status(409).json({
      error: 'plan_already_set',
      detail: 'Use the Stripe Customer Portal to switch plans on an active subscription.',
      currentPlan: state.plan,
    });
  }

  await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .update({ billingPlan: body.data.plan as BillingPlan, updatedAt: new Date() });

  res.json({ ok: true, plan: body.data.plan });
});

const checkoutSchema = z.object({
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  customerEmail: z.string().email().optional(),
});

billingRouter.post('/billing/checkout', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);

  if (state.plan === 'enterprise') {
    return res.status(400).json({ error: 'enterprise_plan_no_checkout', detail: 'Enterprise tenants are billed out of band.' });
  }
  if (state.mode === 'selfhost') {
    return res.status(400).json({ error: 'no_billing_in_selfhost' });
  }
  if (state.stripeSubscriptionId) {
    return res.status(409).json({ error: 'already_subscribed', detail: 'Use the Customer Portal to change plans.' });
  }
  if (!state.plan) {
    return res.status(400).json({ error: 'no_plan_chosen', detail: 'Pick a plan first via /admin/billing.' });
  }

  const body = checkoutSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  let lineItems: ReturnType<typeof priceIdsForPlan>;
  try {
    lineItems = priceIdsForPlan(state.plan);
  } catch (err) {
    return res.status(500).json({ error: 'stripe_price_not_configured', detail: err instanceof Error ? err.message : String(err) });
  }
  if (!lineItems) {
    return res.status(400).json({ error: 'enterprise_plan_no_checkout' });
  }

  const stripe = requireStripe();

  // Reuse Stripe Customer if one exists from a prior aborted Checkout
  // attempt; otherwise create + persist on Tenant.stripeCustomerId so
  // the Customer Portal works on the same record after subscription
  // completion.
  let customerId = state.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: body.data.customerEmail,
      metadata: {
        openpartner_role: 'merchant_self_subscription',
        openpartner_tenant_id: tenantId,
      },
    });
    customerId = customer.id;
    await db<TenantRow>(TABLES.Tenant)
      .where({ id: tenantId })
      .update({ stripeCustomerId: customerId, updatedAt: new Date() });
  }

  // The 14-day trial runs from signup, not from Stripe Checkout — by
  // the time a brand reaches Checkout the evaluation window is the
  // pressure to subscribe. Always require a payment method up front;
  // never set trial_period_days (Stripe would otherwise add a *second*
  // trial on top of the one they just spent in-product).
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: lineItems,
    payment_method_collection: 'always',
    success_url: body.data.successUrl,
    cancel_url: body.data.cancelUrl,
    metadata: {
      openpartner_tenant_id: tenantId,
      openpartner_plan: state.plan,
    },
  });
  res.json({ url: session.url });
});

billingRouter.post('/billing/report-usage', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);
  if (state.mode === 'selfhost') {
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
  const state = await getTenantBillingState(db, tenantId);
  // Both flat and revshare have a Stripe Customer + subscription, both
  // benefit from the Portal (payment method updates, invoice history,
  // plan switching). Selfhost + enterprise: nothing to manage here.
  if (state.mode === 'selfhost' || state.plan === 'enterprise') {
    return res.status(400).json({ error: 'no_portal_for_this_plan' });
  }
  const body = z.object({ returnUrl: z.string().url() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  if (!state.stripeCustomerId) return res.status(404).json({ error: 'no_customer_on_file' });

  const stripe = requireStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: state.stripeCustomerId,
    return_url: body.data.returnUrl,
  });
  res.json({ url: session.url });
});

/**
 * Recent invoices for the tenant. Used by the Admin → Billing page.
 * Returns a thin slice — full detail lives in the Stripe Customer Portal.
 */
billingRouter.get('/billing/invoices', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);
  if (!state.stripeCustomerId) return res.json({ invoices: [] });

  const stripe = requireStripe();
  const list = await stripe.invoices.list({ customer: state.stripeCustomerId, limit: 12 });
  res.json({
    invoices: list.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amountDue: inv.amount_due,
      amountPaid: inv.amount_paid,
      currency: inv.currency,
      created: inv.created,
      periodStart: inv.period_start,
      periodEnd: inv.period_end,
      hostedInvoiceUrl: inv.hosted_invoice_url,
      invoicePdf: inv.invoice_pdf,
    })),
  });
});

/**
 * Webhook helper — stamps Stripe state on the Tenant row. Used from
 * checkout.session.completed (subscribe), customer.subscription.updated
 * (plan switch / trial conversion), and customer.subscription.deleted
 * (cancel).
 *
 * Patch semantics: undefined = "leave field alone", null = "explicitly
 * clear" (used on subscription.deleted to drop stripeSubscriptionId).
 */
export interface MerchantSubscriptionPatch {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  trialEndsAt?: Date | null;
  /** Stamp the trial-used marker on this update. Webhook sets it to
   *  `new Date()` only on the first checkout-with-trial completion;
   *  never cleared afterward. */
  firstTrialActivatedAt?: Date | null;
}

export async function persistMerchantSubscription(
  db: Knex,
  tenantId: string,
  patch: MerchantSubscriptionPatch,
): Promise<void> {
  const dbPatch: Partial<TenantRow> = { updatedAt: new Date() };
  if (patch.stripeCustomerId !== undefined) dbPatch.stripeCustomerId = patch.stripeCustomerId;
  if (patch.stripeSubscriptionId !== undefined) dbPatch.stripeSubscriptionId = patch.stripeSubscriptionId;
  if (patch.trialEndsAt !== undefined) dbPatch.trialEndsAt = patch.trialEndsAt;
  if (patch.firstTrialActivatedAt !== undefined) dbPatch.firstTrialActivatedAt = patch.firstTrialActivatedAt;
  await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).update(dbPatch);
}

/** Update a tenant's plan after a Stripe Customer Portal plan switch.
 *  Called from the customer.subscription.updated webhook handler when
 *  the subscription's price IDs change. */
export async function updateTenantPlanFromStripeSub(
  db: Knex,
  tenantId: string,
  newPlan: 'flex' | 'revshare',
): Promise<void> {
  await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .update({ billingPlan: newPlan as TenantRow['billingPlan'], updatedAt: new Date() });
}

/** Detect the openpartner plan from a Stripe subscription's line-item
 *  price IDs. Returns null when the IDs don't match known prices —
 *  caller treats that as "don't reclassify the tenant". */
export function inferPlanFromPriceIds(priceIds: string[]): 'flex' | 'revshare' | null {
  const flatBase = process.env.STRIPE_FLAT_PRICE_ID;
  const flatUsage = process.env.STRIPE_FLAT_USAGE_PRICE_ID;
  const rev = process.env.STRIPE_REVSHARE_USAGE_PRICE_ID;
  for (const id of priceIds) {
    if (flatBase && id === flatBase) return 'flex';
    if (flatUsage && id === flatUsage) return 'flex';
    if (rev && id === rev) return 'revshare';
  }
  return null;
}
