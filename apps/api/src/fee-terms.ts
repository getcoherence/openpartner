/**
 * Which platform-fee rule a tenant is on, and at what rates
 * (docs/platform-fee.md; the rule itself is in usage-ledger.ts).
 *
 * Every tenant starts on the old rule (a share of attributed revenue). It
 * moves to the commission-floor rule at its `effectiveAt`, which is set
 * one of three ways, recorded in HostedFeeTerms (a hosted billing sidecar,
 * never on Tenant — CLAUDE.md principle 2):
 *
 *   new_plan  Its paid Stripe plan started at or after the platform cutover
 *             (PlatformSetting feeRule.cutoverAt). New customers agree to
 *             the new pricing when they subscribe, so it applies from day
 *             one: to every conversion, when the tenant has never been
 *             billed, else from the plan's start.
 *   notice    It had a paid plan before the cutover and was sent the
 *             pricing-change notice (fee-notice.ts): notice + 30 days, then
 *             the start of its next Stripe billing period, as the Terms
 *             require.
 *   contract  An operator set it with contract terms (rate overrides and a
 *             monthly minimum), e.g. for an Enterprise agreement.
 *
 * Conversions first attributed before `effectiveAt` stay on the old rule
 * for good (their terms are frozen on the ledger), so a report spanning the
 * date bills each conversion under the rule of its own time.
 */

import type { Knex } from 'knex';
import { TABLES, type HostedFeeTermsRow } from '@openpartner/db';
import { CONFIG_KEYS, getConfig } from './config.js';
import { db as platformDb } from './db.js';
import { getFeeRuleSettings, type FeeRates, type FeeRuleSettings } from './platform-settings.js';
import { requireStripe } from './stripe.js';
import type { TenantBillingState } from './billing-plan.js';
import type { FeeContext } from './usage-ledger.js';

/**
 * USD the metered price charges per unit of basis: the prices
 * scripts/setup-stripe.mjs creates on the openpartner_attributed_gmv meter
 * (meteredCentsPerUnit / 100). The fee is divided by this before it's
 * metered, so if a price there changes, change it here in the same deploy.
 */
export const METER_RATES = { flat: 0.015, revshare: 0.03 } as const;

export type MeteredMode = keyof typeof METER_RATES;

/** The Terms: "We may change pricing with at least 30 days' notice." */
export const NOTICE_DAYS = 30;

/** effectiveAt for a tenant on the new rule from its very first conversion. */
export const FROM_THE_START = new Date(0);

export interface TenantFee extends FeeContext {
  mode: MeteredMode;
  source: HostedFeeTermsRow['effectiveSource'];
  /** Rates come from contract overrides, not the plan. */
  contract: boolean;
  monthlyMinimumUsd: number | null;
  planStartedAt: Date | null;
}

export function isMeteredMode(mode: string): mode is MeteredMode {
  return mode === 'flat' || mode === 'revshare';
}

export async function getFeeTermsRow(db: Knex, tenantId: string): Promise<HostedFeeTermsRow | null> {
  return ((await db<HostedFeeTermsRow>(TABLES.HostedFeeTerms).where({ tenantId }).first()) as HostedFeeTermsRow | undefined) ?? null;
}

/** The plan's platform rates, unless contract overrides replace them. */
export function ratesFor(mode: MeteredMode, settings: FeeRuleSettings, row: HostedFeeTermsRow | null): FeeRates & { contract: boolean } {
  const plan = settings.rates[mode];
  const rr = row?.revenueRate == null ? null : Number(row.revenueRate);
  const cr = row?.commissionRate == null ? null : Number(row.commissionRate);
  return {
    revenueRate: rr ?? plan.revenueRate,
    commissionRate: cr ?? plan.commissionRate,
    contract: rr !== null || cr !== null,
  };
}

async function upsertTerms(db: Knex, tenantId: string, patch: Partial<HostedFeeTermsRow>): Promise<void> {
  const row = { ...patch, updatedAt: new Date() };
  await db(TABLES.HostedFeeTerms)
    .insert({ tenantId, ...row })
    .onConflict('tenantId')
    .merge(Object.keys(row));
}

/** The paid plan's start, from Stripe. Null when it can't be read. */
async function readPlanStart(subscriptionId: string): Promise<Date | null> {
  try {
    const sub = await requireStripe().subscriptions.retrieve(subscriptionId);
    return typeof sub.start_date === 'number' ? new Date(sub.start_date * 1000) : null;
  } catch (err) {
    console.warn(`[fee-terms] could not read plan start of ${subscriptionId}: ${(err as Error).message}`);
    return null;
  }
}

async function hasUsageHistory(db: Knex, tenantId: string): Promise<boolean> {
  if (await db(TABLES.UsageLedger).where({ tenantId }).first('id')) return true;
  return !!(await getConfig<string>(db, tenantId, CONFIG_KEYS.LastUsageReportedAt));
}

/**
 * The fee context for a tenant's usage report. Null for a deployment that
 * meters nothing (self-host). Moves a tenant whose plan started after the
 * cutover onto the new rule the first time it's asked, and records it.
 *
 * `db` is the caller's tenant-scoped handle; platform settings are read on
 * the privileged pool (PlatformSetting is not granted to the app role).
 */
export async function resolveTenantFee(
  db: Knex,
  tenantId: string,
  state: TenantBillingState,
  opts: { settings?: FeeRuleSettings; planStart?: (subscriptionId: string) => Promise<Date | null> } = {},
): Promise<TenantFee | null> {
  if (!isMeteredMode(state.mode)) return null;
  const mode = state.mode;
  const settings = opts.settings ?? (await getFeeRuleSettings(platformDb));
  const row = await getFeeTermsRow(db, tenantId);
  const rates = ratesFor(mode, settings, row);

  let effectiveAt = row?.effectiveAt ? new Date(row.effectiveAt) : null;
  let source = row?.effectiveSource ?? null;
  let planStartedAt =
    row?.planStartedAt && row.planSubscriptionId === state.stripeSubscriptionId ? new Date(row.planStartedAt) : null;

  const cutover = settings.cutoverAt ? new Date(settings.cutoverAt) : null;
  // Enterprise is sales-led: it moves by contract, never by the cutover.
  if (cutover && state.plan !== 'enterprise' && state.stripeSubscriptionId) {
    if (!planStartedAt) {
      planStartedAt = await (opts.planStart ?? readPlanStart)(state.stripeSubscriptionId);
      if (planStartedAt) {
        await upsertTerms(db, tenantId, { planSubscriptionId: state.stripeSubscriptionId, planStartedAt });
      }
    }
    // A plan started after the cutover (a new customer, or an old one who
    // cancelled and subscribed again) is on the new rule from its start,
    // even when a notice had set a later date.
    if (planStartedAt && planStartedAt >= cutover && (!effectiveAt || planStartedAt < effectiveAt)) {
      effectiveAt = (await hasUsageHistory(db, tenantId)) ? planStartedAt : FROM_THE_START;
      source = 'new_plan';
      await upsertTerms(db, tenantId, { effectiveAt, effectiveSource: source });
    }
  }

  return {
    mode,
    revenueRate: rates.revenueRate,
    commissionRate: rates.commissionRate,
    meterRate: METER_RATES[mode],
    effectiveAt,
    source,
    contract: rates.contract,
    monthlyMinimumUsd: row?.monthlyMinimumUsd == null ? null : Number(row.monthlyMinimumUsd),
    planStartedAt,
  };
}

/** What the brand's billing page shows: read-only, no Stripe call, no move. */
export interface FeeDescription {
  revenueRate: number;
  commissionRate: number;
  /** old: the old rule; scheduled: moving at effectiveAt; new: on it now. */
  rule: 'old' | 'scheduled' | 'new';
  effectiveAt: string | null;
  contract: boolean;
  monthlyMinimumUsd: number | null;
}

export async function describeTenantFee(db: Knex, tenantId: string, state: TenantBillingState, now = new Date()): Promise<FeeDescription | null> {
  if (!isMeteredMode(state.mode)) return null;
  const settings = await getFeeRuleSettings(platformDb);
  const row = await getFeeTermsRow(db, tenantId);
  const rates = ratesFor(state.mode, settings, row);
  const effectiveAt = row?.effectiveAt ? new Date(row.effectiveAt) : null;
  return {
    revenueRate: rates.revenueRate,
    commissionRate: rates.commissionRate,
    rule: effectiveAt ? (effectiveAt <= now ? 'new' : 'scheduled') : 'old',
    // The epoch marks "from the first conversion": nothing to show as a date.
    effectiveAt: effectiveAt && effectiveAt > FROM_THE_START ? effectiveAt.toISOString() : null,
    contract: rates.contract,
    monthlyMinimumUsd: row?.monthlyMinimumUsd == null ? null : Number(row.monthlyMinimumUsd),
  };
}

/** The first billing-period boundary at or after `notBefore`, for a
 *  subscription anchored at `anchor` renewing every `count` `interval`s.
 *  Month arithmetic follows Stripe: an anchor on the 31st renews on the
 *  last day of shorter months. */
export function nextPeriodStart(
  anchor: Date,
  interval: 'day' | 'week' | 'month' | 'year',
  count: number,
  notBefore: Date,
): Date {
  const step = Math.max(1, Math.floor(count));
  const at = (k: number): Date => {
    if (interval === 'day' || interval === 'week') {
      const days = (interval === 'week' ? 7 : 1) * step * k;
      return new Date(anchor.getTime() + days * 86_400_000);
    }
    const months = (interval === 'year' ? 12 : 1) * step * k;
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth() + months;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(
      Date.UTC(
        y,
        m,
        Math.min(anchor.getUTCDate(), lastDay),
        anchor.getUTCHours(),
        anchor.getUTCMinutes(),
        anchor.getUTCSeconds(),
        anchor.getUTCMilliseconds(),
      ),
    );
  };
  // Jump close, then walk: anchors can be years back.
  let k = 0;
  if (notBefore > anchor) {
    const approxDays = { day: 1, week: 7, month: 30.4, year: 365.2 }[interval] * step;
    k = Math.max(0, Math.floor((notBefore.getTime() - anchor.getTime()) / 86_400_000 / approxDays) - 2);
  }
  while (at(k) < notBefore) k += 1;
  return at(k);
}

/** When the new rule applies to a tenant noticed at `noticeAt`: 30 days
 *  on, then the start of its next billing period. */
export function effectiveAfterNotice(
  noticeAt: Date,
  billing: { anchor: Date; interval: 'day' | 'week' | 'month' | 'year'; count: number },
): Date {
  const earliest = new Date(noticeAt.getTime() + NOTICE_DAYS * 86_400_000);
  return nextPeriodStart(billing.anchor, billing.interval, billing.count, earliest);
}
