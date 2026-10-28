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

/** metadata.openpartner_role on the Stripe Customer a tenant pays
 *  OpenPartner through (billing.ts, invoice-billing.ts). */
export const BILLING_CUSTOMER_ROLE = 'merchant_self_subscription';

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
  /** Set while a pay-by-invoice invoice is past its due date: the oldest
   *  such invoice, and when the grace before onboarding pauses runs out. */
  invoiceOverdue: InvoiceOverdue | null;
}

export interface InvoiceOverdue {
  invoiceId: string | null;
  /** The overdue invoice's due date. */
  since: Date;
  graceEndsAt: Date;
  graceExpired: boolean;
  /** No non-zero invoice has been paid yet, so there is no grace. */
  neverPaid: boolean;
}

/** The mirror columns invoiceOverdue reads. */
export interface InvoiceDueMirror {
  oldestOpenInvoiceId: string | null;
  oldestOpenInvoiceDueAt: Date | string | null;
  invoicePaidAt: Date | string | null;
  graceDays: number | null;
}

export async function getTenantBillingState(db: Knex, tenantId: string): Promise<TenantBillingState> {
  const tenant = await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .first(['billingPlan', 'trialEndsAt', 'firstTrialActivatedAt', 'stripeCustomerId', 'stripeSubscriptionId']);
  const mirror = (await db(`${TABLES.HostedBillingState} as s`)
    .leftJoin(`${TABLES.HostedBillingProfile} as p`, 'p.tenantId', 's.tenantId')
    .where('s.tenantId', tenantId)
    .first([
      's.subscriptionStatus',
      's.collectionMethod',
      's.oldestOpenInvoiceId',
      's.oldestOpenInvoiceDueAt',
      's.invoicePaidAt',
      'p.graceDays',
    ])) as
    | (InvoiceDueMirror & {
        subscriptionStatus: MirroredSubscriptionStatus | null;
        collectionMethod: BillingCollectionMethod | null;
      })
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
 * Overdue for pay-by-invoice billing follows the invoices, not the
 * subscription status: Stripe derives the status from the LATEST invoice
 * only, so paying February's turns a subscription active again while
 * January's is still owed. The mirror keeps the oldest open invoice
 * (invoice-billing.ts refreshInvoiceDue); once its due date passes, service
 * continues through the grace counted from that date, then hasActivePlan
 * says no. A brand that has never paid a non-zero invoice gets no grace:
 * invoice terms start a plan with nothing paid, and the grace is slack for
 * a paying customer, not a free extension for a new one. Card
 * subscriptions never have a send_invoice invoice open, so this is null
 * for them and Stripe's dunning decides, as before.
 */
export function invoiceOverdue(mirror: InvoiceDueMirror | null, now: Date = new Date()): InvoiceOverdue | null {
  if (!mirror?.oldestOpenInvoiceDueAt) return null;
  const since = new Date(mirror.oldestOpenInvoiceDueAt);
  if (since > now) return null;
  const neverPaid = !mirror.invoicePaidAt;
  const graceDays = neverPaid ? 0 : (mirror.graceDays ?? INVOICE_GRACE_DAYS_DEFAULT);
  const graceEndsAt = new Date(since.getTime() + graceDays * DAY_MS);
  return { invoiceId: mirror.oldestOpenInvoiceId, since, graceEndsAt, graceExpired: graceEndsAt <= now, neverPaid };
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
  // An overdue pay-by-invoice invoice keeps service only for its grace
  // (invoiceOverdue above), whatever the subscription status says.
  if (state.invoiceOverdue?.graceExpired) return false;
  if (state.subscriptionStatus == null) return true;
  return ['active', 'trialing', 'past_due'].includes(state.subscriptionStatus);
}

/**
 * Mirror a Stripe subscription status onto HostedBillingState. Called from
 * the subscription webhooks; the mirror is what hasActivePlan and funding
 * eligibility read instead of live Stripe calls. `collectionMethod` is the
 * subscription's, when the caller has it (undefined leaves the mirrored one
 * alone).
 */
export async function mirrorHostedBillingState(
  db: Knex,
  tenantId: string,
  status: MirroredSubscriptionStatus,
  collectionMethod?: BillingCollectionMethod | null,
): Promise<void> {
  const method = collectionMethod === undefined ? {} : { collectionMethod };
  await db(TABLES.HostedBillingState)
    .insert({ tenantId, subscriptionStatus: status, delinquentFundingCount: 0, ...method, updatedAt: new Date() })
    .onConflict('tenantId')
    .merge({ subscriptionStatus: status, ...method, updatedAt: new Date() });
}

/**
 * Mirror the oldest open pay-by-invoice invoice (null: none open) and
 * whether the brand has ever paid a non-zero invoice. invoicePaidAt is
 * sticky: once set it is never cleared.
 */
export async function mirrorInvoiceDue(
  db: Knex,
  tenantId: string,
  due: { invoiceId: string | null; dueAt: Date | null; paid: boolean },
): Promise<void> {
  const paidAt = due.paid
    ? db.raw(`coalesce(??, now())`, [`${TABLES.HostedBillingState}.invoicePaidAt`])
    : db.raw('??', [`${TABLES.HostedBillingState}.invoicePaidAt`]);
  await db(TABLES.HostedBillingState)
    .insert({
      tenantId,
      delinquentFundingCount: 0,
      oldestOpenInvoiceId: due.invoiceId,
      oldestOpenInvoiceDueAt: due.dueAt,
      invoicePaidAt: due.paid ? new Date() : null,
      updatedAt: new Date(),
    })
    .onConflict('tenantId')
    .merge({
      oldestOpenInvoiceId: due.invoiceId,
      oldestOpenInvoiceDueAt: due.dueAt,
      invoicePaidAt: paidAt,
      updatedAt: new Date(),
    });
}

/** A non-zero invoice was paid (by card or by invoice): from now on an
 *  overdue invoice gets the grace. */
export async function markInvoicePaid(db: Knex, tenantId: string): Promise<void> {
  await db(TABLES.HostedBillingState)
    .insert({ tenantId, delinquentFundingCount: 0, invoicePaidAt: new Date(), updatedAt: new Date() })
    .onConflict('tenantId')
    .merge({
      invoicePaidAt: db.raw(`coalesce(??, now())`, [`${TABLES.HostedBillingState}.invoicePaidAt`]),
      updatedAt: new Date(),
    });
}
