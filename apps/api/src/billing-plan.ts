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

export type MirroredSubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'unpaid'
  | 'paused'
  | 'canceled';

export interface TenantBillingState {
  /** The plan column on Tenant. Null for legacy or selfhost. */
  plan: BillingPlan | null;
  /** Webhook-mirrored Stripe subscription status (HostedBillingState,
   *  spec §4 finding 13). Null when no mirror row exists yet — tenants
   *  predating the mirror are grandfathered by hasActivePlan. */
  subscriptionStatus: MirroredSubscriptionStatus | null;
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
  const mirror = (await db(TABLES.HostedBillingState)
    .where({ tenantId })
    .first(['subscriptionStatus'])) as { subscriptionStatus: MirroredSubscriptionStatus | null } | undefined;
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
    subscriptionStatus: mirror?.subscriptionStatus ?? null,
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
 *  get a Stripe subscription (sales-led billing; the white-label add-on
 *  is encoded in the negotiated contract, not a Checkout line item). */
export function priceIdsForPlan(
  plan: BillingPlan,
  opts: { whiteLabel?: boolean } = {},
): Array<{ price: string; quantity?: number }> | null {
  if (plan === 'enterprise') return null;
  let items: Array<{ price: string; quantity?: number }>;
  if (plan === 'flex') {
    const base = process.env.STRIPE_FLAT_PRICE_ID;
    const usage = process.env.STRIPE_FLAT_USAGE_PRICE_ID;
    if (!base) throw new Error('STRIPE_FLAT_PRICE_ID not configured');
    items = [{ price: base, quantity: 1 }];
    if (usage) items.push({ price: usage });
  } else {
    // revshare: metered only.
    const usage = process.env.STRIPE_REVSHARE_USAGE_PRICE_ID;
    if (!usage) throw new Error('STRIPE_REVSHARE_USAGE_PRICE_ID not configured');
    items = [{ price: usage }];
  }
  if (opts.whiteLabel) {
    const addOn = process.env.STRIPE_WHITELABEL_ADD_ON_PRICE_ID;
    if (!addOn) throw new Error('STRIPE_WHITELABEL_ADD_ON_PRICE_ID not configured');
    items.push({ price: addOn, quantity: 1 });
  }
  return items;
}

/** Trial end timestamp `TRIAL_DAYS` days from now, normalized to the
 *  start of the day so renewal dates align cleanly across timezones. */
export function newTrialEnd(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + TRIAL_DAYS);
  return d;
}

/** Hard gate: refuse value-creating writes (partner approvals, etc.)
 *  when the brand's evaluation window has closed and they haven't
 *  subscribed. Conservative — only fires when trialEndsAt is set and
 *  already past, so legacy tenants without a trialEndsAt are
 *  grandfathered. Selfhost + enterprise + active sub are always allowed. */
export function isTrialGateActive(state: TenantBillingState): boolean {
  if (state.mode === 'selfhost') return false;
  if (state.plan === 'enterprise') return false;
  if (state.stripeSubscriptionId) return false;
  return state.trialEndsAt != null && state.trialEndsAt <= new Date();
}

/**
 * True when the tenant has a billing arrangement that permits onboarding
 * partners: an active Stripe subscription (Flex, or RevShare's metered
 * $0-recurring subscription), an enterprise plan (billed out of band), or
 * self-host (no billing relationship).
 *
 * "RevShare selected but never checked out" (a plan column set, but no
 * `stripeSubscriptionId`) does NOT count — that's exactly the loophole the
 * per-brand billing policy closes: a brand must actually activate a plan
 * before it can bring in partners, not merely pick one on a free trial.
 */
export function hasActivePlan(state: TenantBillingState): boolean {
  if (state.mode === 'selfhost') return true;
  if (state.plan === 'enterprise') return true;
  if (state.stripeSubscriptionId == null) return false;
  // Upgrade (spec §4 finding 13): "subscription id non-null" alone let a
  // deeply-delinquent subscription keep full service. The webhook-mirrored
  // status refines it — past_due keeps service (Stripe is still dunning);
  // unpaid/paused/canceled do not. No mirror row = legacy tenant,
  // grandfathered on the id check until the next subscription webhook.
  if (state.subscriptionStatus == null) return true;
  return ['active', 'trialing', 'past_due'].includes(state.subscriptionStatus);
}

/**
 * Mirror a Stripe subscription status onto HostedBillingState. Called from
 * the subscription webhooks; the mirror is what hasActivePlan and funding
 * eligibility read instead of live Stripe calls.
 */
export async function mirrorHostedBillingState(
  db: Knex,
  tenantId: string,
  status: MirroredSubscriptionStatus,
): Promise<void> {
  await db(TABLES.HostedBillingState)
    .insert({ tenantId, subscriptionStatus: status, delinquentFundingCount: 0, updatedAt: new Date() })
    .onConflict('tenantId')
    .merge({ subscriptionStatus: status, updatedAt: new Date() });
}
