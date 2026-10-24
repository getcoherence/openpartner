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
 * Flex and Revshare are charged to a card by default (Checkout). A tenant
 * on pay-by-invoice terms (invoice-billing.ts) subscribes through
 * POST /billing/invoice-subscription instead and pays each invoice from
 * Stripe's hosted invoice page.
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
import { z } from '../zod.js';
import type Stripe from 'stripe';
import { TABLES, type AdminRow, type BillingPlan, type TenantRow } from '@openpartner/db';
import { requireAdmin, requireAuth, type ApiKeyPrincipal } from '../auth.js';
import { REVSHARE_FEE_BPS, requireStripe } from '../stripe.js';
import { describeTenantFee } from '../fee-terms.js';
import { getTenantBillingState, priceIdsForPlan, type TenantBillingState } from '../billing-plan.js';
import {
  applyCustomerTaxDetails,
  InvoiceSubscribeError,
  normalizeGstin,
  resolveCollectionTerms,
  setGstin,
  startInvoiceSubscription,
  type CollectionTerms,
} from '../invoice-billing.js';
import { reportUsageToStripe } from '../usage-billing.js';
import { tenantOf } from '../tenancy.js';
import { getWhiteLabelState } from '../white-label.js';
import { getNetworkMembership } from '../network-client.js';
import { applyWhiteLabelFromSubscription, whiteLabelPriceId } from '../white-label-billing.js';

export const billingRouter = Router();

/** How the tenant pays, for the Billing page: the terms a new subscription
 *  gets, how the live one is collected, and an overdue invoice's grace. */
function collectionView(terms: CollectionTerms, state: TenantBillingState) {
  return {
    collection: {
      method: terms.method,
      source: terms.source,
      daysUntilDue: terms.daysUntilDue,
      country: terms.country,
      gstin: terms.gstin,
      gstinRequired: terms.gstinRequired,
    },
    // The live subscription's own method. It differs from
    // collection.method until ops moves an existing subscription across.
    subscriptionCollectionMethod: state.stripeSubscriptionId ? state.collectionMethod : null,
    invoiceOverdue: state.invoiceOverdue
      ? {
          since: state.invoiceOverdue.since.toISOString(),
          graceEndsAt: state.invoiceOverdue.graceEndsAt.toISOString(),
          graceExpired: state.invoiceOverdue.graceExpired,
          neverPaid: state.invoiceOverdue.neverPaid,
        }
      : null,
  };
}

billingRouter.get('/billing/status', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);
  const mode = state.mode;

  if (mode === 'selfhost') {
    return res.json({ mode, plan: null, billed: false });
  }

  // How the platform fee is worked out for this tenant (docs/platform-fee.md).
  const fee = await describeTenantFee(db, tenantId, state);
  const collection = state.plan === 'enterprise' ? null : collectionView(await resolveCollectionTerms(db, tenantId), state);

  if (state.plan === 'enterprise') {
    return res.json({
      mode,
      plan: state.plan,
      enterprise: true,
      message: 'Billed out of band — contact your account manager.',
      // Only contract terms describe an Enterprise fee; plan rates don't apply.
      fee: fee?.contract ? fee : null,
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
        fee,
        ...collection,
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
      fee,
      ...collection,
      subscriptionCollectionMethod: sub.collection_method,
    });
  }

  // revshare: sum of platform fees retained on paid payouts, by currency.
  const fees = (await db(TABLES.Payout)
    .where({ tenantId, status: 'paid' })
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
    status: state.stripeSubscriptionId ? state.subscriptionStatus : null,
    trialEndsAt: state.trialEndsAt,
    inTrial: state.inTrial,
    fee,
    ...collection,
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
  // Enterprise is sales-led and billed out of band: it counts as "active"
  // with no Stripe subscription and can enable white-label directly. It must
  // never be self-assignable through this authenticated setter (signup
  // already excludes it) — only flex/revshare go through self-serve.
  plan: z.enum(['flex', 'revshare']),
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

// ---------- White-label add-on (spec §8.2) ----------

/**
 * Add-on status for the admin wizard. `effective` is the runtime
 * entitlement (provisioned AND entitling billing state) — the same truth
 * /config/program reports.
 */
billingRouter.get('/billing/white-label', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);
  const wl = await getWhiteLabelState(db, tenantId);
  // Self-host Network access is billed separately by the Network, and
  // white-label hides its pages (billing included) without cancelling it —
  // the wizard warns before enabling. Hosted bundles Network access.
  const networkConnected =
    state.mode === 'selfhost' ? !!(await getNetworkMembership(db, tenantId))?.enabled : false;
  res.json({
    provisioned: wl.provisioned,
    effective: wl.effective,
    plan: state.plan,
    mode: state.mode,
    subscribed: !!state.stripeSubscriptionId,
    // An invoice-billed subscription invoices the add-on instead of
    // charging a card; the wizard words its confirmation to match.
    collectionMethod: state.stripeSubscriptionId ? state.collectionMethod : null,
    priceConfigured: !!whiteLabelPriceId(),
    networkConnected,
  });
});

/**
 * Enable the add-on. Hosted flex/revshare: attaches the add-on price to
 * the tenant's ACTIVE subscription and charges the prorated rest of the
 * current period immediately (a declined charge → 402, nothing attached),
 * then mirrors the flag locally (the webhook re-confirms). Enterprise:
 * flag only — sales-led, no Stripe item. Self-host: flag only and free — entitled
 * without billing, but still the admin's choice rather than a default,
 * because white-label isolates the tenant from the Network and a self-host
 * install on the Network plan must be able to stay connected. No
 * subscription → 409; the wizard sends the admin through plan checkout
 * first (checkout accepts whiteLabel:true to bundle the add-on from the
 * start).
 */
billingRouter.post('/billing/white-label', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);

  if (state.mode === 'selfhost' || state.plan === 'enterprise') {
    // Shares the transition path with the webhook so enabling also
    // withdraws the brand from the shared marketplace.
    await applyWhiteLabelFromSubscription(db, tenantId, true);
    return res.json({
      ok: true,
      provisioned: true,
      billedVia: state.mode === 'selfhost' ? 'selfhost' : 'enterprise_contract',
    });
  }
  if (!state.stripeSubscriptionId) {
    return res.status(409).json({
      error: 'subscription_required',
      detail: 'Activate your plan first — the white-label add-on attaches to your subscription.',
    });
  }
  const price = whiteLabelPriceId();
  if (!price) {
    return res.status(500).json({ error: 'stripe_price_not_configured', detail: 'STRIPE_WHITELABEL_ADD_ON_PRICE_ID is not set.' });
  }

  const stripe = requireStripe();
  const sub = await stripe.subscriptions.retrieve(state.stripeSubscriptionId);
  const already = sub.items.data.find((it) => it.price.id === price);
  if (!already) {
    try {
      // always_invoice: bill the rest of this period now. create_prorations
      // parked it on the next renewal invoice, so the first partial month
      // was charged a month late alongside the next month in advance, and
      // never at all if the subscription ended first. error_if_incomplete:
      // a declined charge leaves the subscription untouched instead of
      // attaching the item and pushing the whole plan into dunning.
      await stripe.subscriptionItems.create({
        subscription: sub.id,
        price,
        quantity: 1,
        proration_behavior: 'always_invoice',
        payment_behavior: 'error_if_incomplete',
      });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 402) throw err;
      return res.status(402).json({
        error: 'payment_failed',
        detail: `The add-on charge didn't go through, so white-label wasn't enabled. ${
          err instanceof Error ? err.message : ''
        }`.trim(),
      });
    }
  }
  // Optimistic local mirror — the subscription.updated webhook is the
  // authoritative confirmation and is idempotent with this.
  await applyWhiteLabelFromSubscription(db, tenantId, true);
  res.json({ ok: true, provisioned: true, billedVia: already ? 'already_on_subscription' : 'subscription_item_added' });
});

/**
 * Disable the add-on: remove the subscription item and mirror locally —
 * which also revokes custom-domain routing + the DO edge. The prorated
 * credit stays pending and comes off a later invoice rather than being
 * refunded to the card.
 */
billingRouter.delete('/billing/white-label', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);

  if (state.mode === 'selfhost' || state.plan === 'enterprise') {
    // Flip the flag only: self-host has no subscription item to remove,
    // and enterprise contract changes happen out of band.
    await applyWhiteLabelFromSubscription(db, tenantId, false);
    return res.json({ ok: true, provisioned: false });
  }
  const price = whiteLabelPriceId();
  if (state.stripeSubscriptionId && price) {
    const stripe = requireStripe();
    const sub = await stripe.subscriptions.retrieve(state.stripeSubscriptionId);
    const item = sub.items.data.find((it) => it.price.id === price);
    if (item) {
      await stripe.subscriptionItems.del(item.id, { proration_behavior: 'create_prorations' });
    }
  }
  await applyWhiteLabelFromSubscription(db, tenantId, false);
  res.json({ ok: true, provisioned: false });
});

const checkoutSchema = z.object({
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  customerEmail: z.string().email().optional(),
  /** Bundle the white-label add-on into the plan checkout (new brands
   *  that picked white-label before subscribing). */
  whiteLabel: z.boolean().optional(),
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

  // Card Checkout would put a pay-by-invoice tenant straight back on the
  // auto-charge it can't use.
  const terms = await resolveCollectionTerms(db, tenantId);
  if (terms.method === 'send_invoice') {
    return res.status(409).json({
      error: 'invoice_billing',
      detail: 'This account pays by invoice. Start your plan from the Billing page.',
    });
  }
  // An Indian brand needs a GSTIN by card too (invoice-billing.ts).
  if (terms.gstinRequired && !terms.gstin) {
    return res.status(409).json({
      error: 'gstin_required',
      detail: 'Add your GSTIN on the Billing page first. OpenPartner bills businesses in India only when they are registered for GST.',
    });
  }

  let lineItems: ReturnType<typeof priceIdsForPlan>;
  try {
    lineItems = priceIdsForPlan(state.plan, { whiteLabel: body.data.whiteLabel });
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
  // The GSTIN and reverse-charge footer must be on the customer before
  // Checkout's first invoice is finalized.
  await applyCustomerTaxDetails(stripe, customerId, { country: terms.country, gstin: terms.gstin });

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
    // Show the promo-code field so sales-issued codes (e.g. first-month
    // white-label discounts) are self-serve at checkout.
    allow_promotion_codes: true,
    success_url: body.data.successUrl,
    cancel_url: body.data.cancelUrl,
    metadata: {
      openpartner_tenant_id: tenantId,
      openpartner_plan: state.plan,
    },
  });
  res.json({ url: session.url });
});

const invoiceSubscriptionSchema = z.object({
  /** Where Stripe emails the invoices. Defaults to the signed-in admin. */
  billingEmail: z.string().trim().email().max(254).optional(),
  /** The registered business name printed on invoices. Defaults to the
   *  brand name. */
  legalName: z.string().trim().min(1).max(200).optional(),
  /** Indian GSTIN: required for a brand that declared India, unless one
   *  is already on file. */
  gstin: z.string().trim().max(32).optional(),
  /** A sales-issued promotion code, as Checkout accepts. */
  promotionCode: z.string().trim().min(1).max(100).optional(),
  whiteLabel: z.boolean().optional(),
});

/**
 * Start the plan on pay-by-invoice terms (docs/invoice-billing.md): a
 * subscription with collection_method=send_invoice on the same prices and
 * meter as Checkout's, created here because Checkout only makes
 * auto-charged subscriptions. invoice-billing.ts startInvoiceSubscription
 * makes sure the app never loses track of one: it runs in transactions of
 * its own, not the request's. The first invoice (Flex's first month; a $0
 * one for metered-only Revshare) is finalized right away, so Stripe emails
 * it and its pay link comes back in the response.
 */
billingRouter.post('/billing/invoice-subscription', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);
  if (state.mode === 'selfhost') return res.status(400).json({ error: 'no_billing_in_selfhost' });
  if (state.plan === 'enterprise') {
    return res.status(400).json({ error: 'enterprise_plan_no_checkout', detail: 'Enterprise tenants are billed out of band.' });
  }
  if (!state.plan) return res.status(400).json({ error: 'no_plan_chosen', detail: 'Pick a plan first via /admin/billing.' });
  if (state.stripeSubscriptionId) {
    return res.status(409).json({ error: 'already_subscribed', detail: 'Use the Customer Portal to change plans.' });
  }

  const body = invoiceSubscriptionSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const terms = await resolveCollectionTerms(db, tenantId);
  if (terms.method !== 'send_invoice') {
    return res.status(409).json({ error: 'card_billing', detail: 'This account pays by card. Use Checkout to subscribe.' });
  }
  let gstin = terms.gstin;
  if (body.data.gstin !== undefined) {
    gstin = normalizeGstin(body.data.gstin);
    if (!gstin) {
      return res.status(400).json({
        error: 'invalid_gstin',
        detail: 'That isn’t a valid GSTIN. Check it against your GST registration certificate.',
      });
    }
  }
  if (terms.gstinRequired && !gstin) {
    return res.status(400).json({
      error: 'gstin_required',
      detail: 'Enter your GSTIN. OpenPartner bills businesses in India only when they are registered for GST.',
    });
  }

  let lineItems: NonNullable<ReturnType<typeof priceIdsForPlan>>;
  try {
    lineItems = priceIdsForPlan(state.plan, { whiteLabel: body.data.whiteLabel })!;
  } catch (err) {
    return res.status(500).json({ error: 'stripe_price_not_configured', detail: err instanceof Error ? err.message : String(err) });
  }

  const stripe = requireStripe();
  let promotionCodeId: string | undefined;
  if (body.data.promotionCode) {
    const found = await stripe.promotionCodes.list({ code: body.data.promotionCode, active: true, limit: 1 });
    promotionCodeId = found.data[0]?.id;
    if (!promotionCodeId) {
      return res.status(400).json({ error: 'invalid_promotion_code', detail: 'That promotion code isn’t valid.' });
    }
  }

  let started: Awaited<ReturnType<typeof startInvoiceSubscription>>;
  try {
    started = await startInvoiceSubscription(stripe, {
      tenantId,
      plan: state.plan,
      lineItems,
      terms,
      gstin,
      billingEmail: body.data.billingEmail,
      legalName: body.data.legalName,
      adminEmail: await adminEmail(db, tenantId, req.principal),
      promotionCodeId,
    });
  } catch (err) {
    if (err instanceof InvoiceSubscribeError) return res.status(409).json({ error: err.code, detail: err.message });
    // Stripe refusing the code itself (first-time-only, a minimum amount,
    // a customer restriction) is the brand's to fix, not a server error.
    const param = (err as { param?: string }).param ?? '';
    if (promotionCodeId && (err as { type?: string }).type === 'StripeInvalidRequestError' && /discount|promotion|coupon/.test(param)) {
      return res.status(400).json({ error: 'promotion_code_not_applicable', detail: (err as Error).message });
    }
    throw err;
  }

  res.json({
    ok: true,
    subscriptionId: started.subscription.id,
    status: started.subscription.status,
    adopted: started.adopted,
    invoice: started.invoice ? invoiceView(started.invoice) : null,
  });
});

const taxDetailsSchema = z.object({ gstin: z.string().trim().min(1).max(32) });

/**
 * Record or correct an Indian brand's GSTIN: on the billing profile and,
 * once the brand has a Stripe customer, on that too, so invoices finalized
 * from now on print it. Every Indian brand needs one, by card or invoice.
 */
billingRouter.put('/billing/tax-details', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);
  if (state.mode === 'selfhost') return res.status(400).json({ error: 'no_billing_in_selfhost' });
  const body = taxDetailsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const terms = await resolveCollectionTerms(db, tenantId);
  if (terms.country !== 'IN') {
    return res.status(400).json({ error: 'gstin_not_applicable', detail: 'A GSTIN applies only to businesses in India.' });
  }
  const gstin = normalizeGstin(body.data.gstin);
  if (!gstin) {
    return res.status(400).json({
      error: 'invalid_gstin',
      detail: 'That isn’t a valid GSTIN. Check it against your GST registration certificate.',
    });
  }
  await setGstin(db, tenantId, gstin, await adminEmail(db, tenantId, req.principal));
  if (state.stripeCustomerId) {
    await applyCustomerTaxDetails(requireStripe(), state.stripeCustomerId, { country: terms.country, gstin });
  }
  res.json({ ok: true, gstin });
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
  res.json({ invoices: list.data.map(invoiceView) });
});

function invoiceView(inv: Stripe.Invoice) {
  return {
    id: inv.id,
    number: inv.number,
    status: inv.status,
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    amountRemaining: inv.amount_remaining,
    currency: inv.currency,
    created: inv.created,
    // Set on pay-by-invoice invoices; null on auto-charged ones.
    dueDate: inv.due_date,
    collectionMethod: inv.collection_method,
    periodStart: inv.period_start,
    periodEnd: inv.period_end,
    hostedInvoiceUrl: inv.hosted_invoice_url,
    invoicePdf: inv.invoice_pdf,
  };
}

/** Where Stripe emails a tenant's invoices: the signed-in admin, else the
 *  brand's first admin. */
async function adminEmail(db: Knex, tenantId: string, principal: ApiKeyPrincipal | undefined): Promise<string | null> {
  if (principal?.role === 'admin' && principal.source === 'session') {
    const me = await db<AdminRow>(TABLES.Admin).where({ id: principal.adminId, tenantId }).first(['email']);
    if (me) return me.email;
  }
  const first = await db<AdminRow>(TABLES.Admin)
    .where({ tenantId })
    .whereNull('revokedAt')
    .orderBy('createdAt', 'asc')
    .first(['email']);
  return first?.email ?? null;
}

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
