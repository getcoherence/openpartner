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
import { TABLES, type BillingCollectionMethod, type BillingPlan, type TenantRow } from '@openpartner/db';
import { getMode, type OpenPartnerMode } from './stripe.js';

export const TRIAL_DAYS = 14;

/** Days a pay-by-invoice subscription may stay past due before partner
 *  onboarding pauses, when ops set nothing else for the tenant
 *  (HostedBillingProfile.graceDays). */
export const INVOICE_GRACE_DAYS_DEFAULT = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

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
  /** How the live subscription is collected (webhook mirror). Null when
   *  no mirror row records it — treated as a card subscription. */
  collectionMethod: BillingCollectionMethod | null;
  /** Set while a pay-by-invoice subscription is past due: when that
   *  started, and when the grace before onboarding pauses runs out. */
  invoiceOverdue: InvoiceOverdue | null;
}

export interface InvoiceOverdue {
  since: Date;
  graceEndsAt: Date;
  graceExpired: boolean;
}

export async function getTenantBillingState(db: Knex, tenantId: string): Promise<TenantBillingState> {
  const tenant = await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .first(['billingPlan', 'trialEndsAt', 'firstTrialActivatedAt', 'stripeCustomerId', 'stripeSubscriptionId']);
  const mirror = (await db(`${TABLES.HostedBillingState} as s`)
    .leftJoin(`${TABLES.HostedBillingProfile} as p`, 'p.tenantId', 's.tenantId')
    .where('s.tenantId', tenantId)
    .first(['s.subscriptionStatus', 's.collectionMethod', 's.pastDueSince', 'p.graceDays'])) as
    | {
        subscriptionStatus: MirroredSubscriptionStatus | null;
        collectionMethod: BillingCollectionMethod | null;
        pastDueSince: Date | string | null;
        graceDays: number | null;
      }
    | undefined;
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
    collectionMethod: mirror?.collectionMethod ?? null,
    invoiceOverdue: invoiceOverdue(mirror ?? null),
  };
}

/**
 * A pay-by-invoice subscription goes past_due the day its invoice passes
 * the due date, and Stripe can leave it there indefinitely (the account's
 * "Manage invoices sent to customers" setting). Service continues through
 * a grace counted from the start of the past_due stretch; only after it
 * does hasActivePlan say no. Card subscriptions are left to Stripe's
 * dunning, as before.
 */
export function invoiceOverdue(
  mirror: {
    subscriptionStatus: MirroredSubscriptionStatus | null;
    collectionMethod: BillingCollectionMethod | null;
    pastDueSince: Date | string | null;
    graceDays: number | null;
  } | null,
  now: Date = new Date(),
): InvoiceOverdue | null {
  if (mirror?.subscriptionStatus !== 'past_due' || mirror.collectionMethod !== 'send_invoice') return null;
  // A stretch the mirror didn't time (a row from before pastDueSince
  // existed) starts now rather than counting as already expired.
  const since = mirror.pastDueSince ? new Date(mirror.pastDueSince) : now;
  const graceEndsAt = new Date(since.getTime() + (mirror.graceDays ?? INVOICE_GRACE_DAYS_DEFAULT) * DAY_MS);
  return { since, graceEndsAt, graceExpired: graceEndsAt <= now };
}

/** Map a billing plan to the legacy mode enum.
 *  - flex → 'flat' (Stripe sub with monthly + metered)
 *  - enterprise → 'flat' too, but it has no Stripe sub; callers that
 *    bill check `plan === 'enterprise'` first (reportUsageToStripe
 *    skips it)
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
  // A pay-by-invoice subscription keeps service while past due only for
  // its grace (invoiceOverdue above).
  if (state.invoiceOverdue?.graceExpired) return false;
  return ['active', 'trialing', 'past_due'].includes(state.subscriptionStatus);
}

/**
 * Mirror a Stripe subscription status onto HostedBillingState. Called from
 * the subscription webhooks; the mirror is what hasActivePlan and funding
 * eligibility read instead of live Stripe calls.
 *
 * `collectionMethod` is the subscription's, when the caller has it
 * (undefined leaves the mirrored one alone). pastDueSince keeps the start
 * of a continuous past_due stretch and clears on any other status; it is
 * returned so callers can tell one overdue stretch from the next.
 */
export async function mirrorHostedBillingState(
  db: Knex,
  tenantId: string,
  status: MirroredSubscriptionStatus,
  collectionMethod?: BillingCollectionMethod | null,
): Promise<{ pastDueSince: Date | null }> {
  const method = collectionMethod === undefined ? {} : { collectionMethod };
  const rows = (await db(TABLES.HostedBillingState)
    .insert({
      tenantId,
      subscriptionStatus: status,
      delinquentFundingCount: 0,
      pastDueSince: status === 'past_due' ? db.fn.now() : null,
      ...method,
      updatedAt: new Date(),
    })
    .onConflict('tenantId')
    .merge({
      subscriptionStatus: status,
      pastDueSince:
        status === 'past_due' ? db.raw(`coalesce(??, now())`, [`${TABLES.HostedBillingState}.pastDueSince`]) : null,
      ...method,
      updatedAt: new Date(),
    })
    .returning(['pastDueSince'])) as Array<{ pastDueSince: Date | string | null }>;
  const since = rows[0]?.pastDueSince;
  return { pastDueSince: since ? new Date(since) : null };
}
