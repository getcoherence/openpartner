/**
 * Per-tenant billing plan resolver + helpers.
 *
 * The hosted multi-tenant deployment now lets each tenant pick a tier
 * (Flex / Revshare / Enterprise) at signup. Selfhost deployments keep
 * the global OPENPARTNER_MODE env behavior — a single mode for the
 * single installation.
 *
 * Resolution rules:
 *
 *   selfhost mode:        always returns the global mode (no Tenant
 *                         lookup; selfhost has one tenant by definition).
 *   hosted mode + plan:   returns the tenant's billingPlan column.
 *   hosted mode + null:   legacy tenant predating per-tenant billing —
 *                         fall back to OPENPARTNER_MODE so reportUsage
 *                         and friends keep working until the operator
 *                         backfills.
 *
 * `effectiveMode()` returns the same shape as the legacy `getMode()` so
 * downstream code (reportUsageToStripe, billing route) can switch on
 * one variable.
 */

import type { Knex } from 'knex';
import { TABLES, type BillingPlan, type TenantRow } from '@openpartner/db';
import { getMode, type OpenPartnerMode } from './stripe.js';

export const TRIAL_DAYS = 14;

export interface TenantBillingState {
  /** The plan column on Tenant. Null for legacy or selfhost. */
  plan: BillingPlan | null;
  /** Mode the rest of the billing layer should switch on. Same shape
   *  as the legacy getMode() return so existing callers can swap in
   *  with no changes. */
  mode: OpenPartnerMode;
  trialEndsAt: Date | null;
  inTrial: boolean;
  /** True iff the tenant has previously activated a trial. Used to
   *  refuse second-and-later trials. */
  hasUsedTrial: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** True for tenants that picked a paid plan, used a trial, and are
   *  now without an active subscription. The soft trial-gate uses
   *  this to 402 expensive write endpoints. */
  trialExpiredWithoutSubscription: boolean;
}

export async function getTenantBillingState(db: Knex, tenantId: string): Promise<TenantBillingState> {
  const tenant = await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .first(['billingPlan', 'trialEndsAt', 'firstTrialActivatedAt', 'stripeCustomerId', 'stripeSubscriptionId']);
  const plan = (tenant?.billingPlan as BillingPlan | null) ?? null;
  const hasUsedTrial = !!tenant?.firstTrialActivatedAt;
  const stripeSubscriptionId = tenant?.stripeSubscriptionId ?? null;
  // "Trial expired without sub" = paid plan picked, trial has been
  // used at some point, no current subscription. Enterprise tenants
  // are never gated (they don't go through the Checkout flow).
  const trialExpiredWithoutSubscription =
    plan !== null &&
    plan !== 'enterprise' &&
    hasUsedTrial &&
    !stripeSubscriptionId;
  return {
    plan,
    mode: planToMode(plan),
    trialEndsAt: tenant?.trialEndsAt ? new Date(tenant.trialEndsAt) : null,
    inTrial: tenant?.trialEndsAt ? new Date(tenant.trialEndsAt) > new Date() : false,
    hasUsedTrial,
    stripeCustomerId: tenant?.stripeCustomerId ?? null,
    stripeSubscriptionId,
    trialExpiredWithoutSubscription,
  };
}

/** Map a billing plan to the legacy mode enum.
 *  - flex/enterprise → 'flat' (Stripe sub with monthly + metered)
 *  - revshare → 'revshare' (metered-only)
 *  - null → fall through to OPENPARTNER_MODE env (selfhost or
 *    legacy hosted tenants from before this column existed) */
export function planToMode(plan: BillingPlan | null): OpenPartnerMode {
  if (plan === 'flex' || plan === 'enterprise') return 'flat';
  if (plan === 'revshare') return 'revshare';
  return getMode();
}

/** Stripe price IDs for a given plan. Returns the line items to pass
 *  to Stripe Checkout. Enterprise returns null — those tenants don't
 *  get a Stripe subscription (sales-led billing). */
export function priceIdsForPlan(plan: BillingPlan): Array<{ price: string; quantity?: number }> | null {
  if (plan === 'enterprise') return null;
  if (plan === 'flex') {
    const base = process.env.STRIPE_FLAT_PRICE_ID;
    const usage = process.env.STRIPE_FLAT_USAGE_PRICE_ID;
    if (!base) throw new Error('STRIPE_FLAT_PRICE_ID not configured');
    const items: Array<{ price: string; quantity?: number }> = [{ price: base, quantity: 1 }];
    if (usage) items.push({ price: usage });
    return items;
  }
  // revshare: metered only.
  const usage = process.env.STRIPE_REVSHARE_USAGE_PRICE_ID;
  if (!usage) throw new Error('STRIPE_REVSHARE_USAGE_PRICE_ID not configured');
  return [{ price: usage }];
}

/** Trial end timestamp `TRIAL_DAYS` days from now, normalized to the
 *  start of the day so renewal dates align cleanly across timezones. */
export function newTrialEnd(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + TRIAL_DAYS);
  return d;
}
