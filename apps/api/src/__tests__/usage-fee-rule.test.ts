/**
 * The commission-floor platform fee (docs/platform-fee.md).
 *
 * Per attributed conversion, on the new rule:
 *   fee   = max(revenueRate × revenue, commissionRate × commissions)
 *   basis = fee / meterRate  (what the one meter is sent)
 * Revenue counts for invoice_paid / subscription_created, a type the program
 * declares, or a conversion that paid a PERCENT commission. Revshare
 * defaults 3% / 10%, Flex 1.5% / 5%: both meter multipliers are 10/3.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.STRIPE_SECRET_KEY = 'sk_test_usage_fee_rule';
process.env.PORTAL_URL = 'http://localhost:5673';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ identifier: string; value: string }>,
  /** subscriptions.retrieve → this, or throws when null. */
  subscription: null as null | { start_date: number; billing_cycle_anchor: number },
}));

vi.mock('../stripe.js', async () => {
  const actual = await vi.importActual<typeof import('../stripe.js')>('../stripe.js');
  return {
    ...actual,
    requireStripe: () => ({
      billing: {
        meterEvents: {
          create: async (args: { identifier: string; payload: { value: string } }) => {
            h.calls.push({ identifier: args.identifier, value: args.payload.value });
            return { id: 'mbe_' + ulid() };
          },
        },
      },
      subscriptions: {
        retrieve: async (id: string) => {
          if (!h.subscription) throw new Error(`no such subscription ${id}`);
          return { id, ...h.subscription, items: { data: [{ price: { recurring: { interval: 'month', interval_count: 1 } } }] } };
        },
      },
    }),
  };
});

const { db } = await import('../db.js');
const { reportUsageToStripe } = await import('../usage-billing.js');
const { setFeeRuleSettings } = await import('../platform-settings.js');
const { FROM_THE_START, effectiveAfterNotice, nextPeriodStart } = await import('../fee-terms.js');
const { previewPricingNotices, sendPricingNotices } = await import('../fee-notice.js');
const { contractStatement, setContractTerms, ContractTermsError, estimateFeeImpact, reviewSignals } = await import('../fee-review.js');
const { getFeeRuleSettings } = await import('../platform-settings.js');
const { __setMailerForTests } = await import('../mailer.js');
import type { Mailer, Message } from '../mailer.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const T = DEFAULT_TENANT_ID;
const CUSTOMER = 'cus_fee_rule';
const DAY = 86_400_000;
const OPERATOR = 'ops@openpartner.test';

class CapturingMailer implements Mailer {
  readonly sent: Message[] = [];
  failFor = new Set<string>();
  async send(_ctx: unknown, msg: Message): Promise<void> {
    if (this.failFor.has(msg.to)) throw new Error('mailbox unavailable');
    this.sent.push(msg);
  }
}
let mailer: CapturingMailer;

interface SeedCommission {
  amount: number;
  rateType?: 'percent' | 'fixed' | null;
  status?: 'accrued' | 'approved' | 'paid' | 'reversed';
}

interface Seeded {
  eventId: string;
  programId: string;
  commissionIds: string[];
}

/**
 * One attributed conversion. Each entry of `touches` is one partner's
 * Attribution with its commissions (multi-touch = several entries).
 */
async function seed(opts: {
  type?: string;
  value?: number | null;
  currency?: string;
  touches?: SeedCommission[][];
  commissions?: SeedCommission[];
  revenueEventTypes?: string[];
  attributedAt?: Date;
  tenantId?: string;
  programId?: string;
}): Promise<Seeded> {
  const tenantId = opts.tenantId ?? T;
  const programId = opts.programId ?? ulid();
  if (!opts.programId) {
    await db(TABLES.Program).insert({
      id: programId, tenantId, name: 'Prog', attributionModel: 'linear', attributionWindowDays: 60,
      commissionRule: JSON.stringify([{ trigger: 'every', type: 'fixed', value: 1 }]), destinationUrl: 'https://x/',
      revenueEventTypes: opts.revenueEventTypes ?? [],
    });
  }
  const eventId = ulid();
  const userId = `u-${eventId}`;
  const at = opts.attributedAt ?? new Date(Date.now() - 1000);
  await db(TABLES.Event).insert({
    id: eventId, tenantId, userId, type: opts.type ?? 'invoice_paid',
    value: opts.value == null ? null : opts.value.toFixed(2), currency: opts.currency ?? 'USD', metadata: {}, ts: at,
  });
  const touches = opts.touches ?? [opts.commissions ?? []];
  const commissionIds: string[] = [];
  for (const commissions of touches) {
    const partnerId = ulid();
    const linkId = ulid();
    const clickId = ulid();
    const attributionId = ulid();
    await db(TABLES.Partner).insert({ id: partnerId, tenantId, name: 'P', email: `p-${partnerId}@x.com` });
    await db(TABLES.Link).insert({ id: linkId, tenantId, partnerId, programId, linkKey: `lk-${linkId}`, destinationUrl: 'https://x/' });
    await db(TABLES.Click).insert({ id: clickId, tenantId, linkId, partnerId, programId, landingUrl: 'https://x/', ipHash: 'h', ts: new Date(at.getTime() - 60_000) });
    await db(TABLES.Attribution).insert({
      id: attributionId, tenantId, eventId, partnerId, programId, clickId, model: 'linear',
      weight: (1 / touches.length).toFixed(4), computedAt: at,
    });
    for (const c of commissions) {
      const id = ulid();
      commissionIds.push(id);
      await db(TABLES.Commission).insert({
        id, tenantId, attributionId, partnerId, amount: c.amount.toFixed(2), currency: opts.currency ?? 'USD',
        status: c.status ?? 'accrued', accruedAt: at,
        metadata: c.rateType === null ? {} : { rateType: c.rateType ?? 'fixed' },
      });
    }
  }
  return { eventId, programId, commissionIds };
}

const pct = (amount: number): SeedCommission => ({ amount, rateType: 'percent' });
const fixed = (amount: number): SeedCommission => ({ amount, rateType: 'fixed' });

async function newRule(tenantId = T, effectiveAt: Date = FROM_THE_START): Promise<void> {
  await db(TABLES.HostedFeeTerms)
    .insert({ tenantId, effectiveAt, effectiveSource: 'contract', updatedAt: new Date() })
    .onConflict('tenantId')
    .merge(['effectiveAt', 'effectiveSource']);
}

const report = (tenantId = T) => reportUsageToStripe(db, tenantId);
const metered = () => h.calls.map((c) => c.value);

const CLEAN = [
  TABLES.UsageFeeShadow, TABLES.UsageLedger, TABLES.HostedFeeTerms, TABLES.CommissionAdjustment, TABLES.Commission,
  TABLES.Attribution, TABLES.Event, TABLES.Identity, TABLES.Click, TABLES.Link, TABLES.Program, TABLES.Partner,
  TABLES.Config,
];
const createdTenants: string[] = [];

async function cleanAll(): Promise<void> {
  for (const t of CLEAN) await db(t).del();
  await db(TABLES.PlatformSetting).where({ key: 'feeRule' }).del();
  if (createdTenants.length) {
    await db(TABLES.Admin).whereIn('tenantId', createdTenants).del();
    await db(TABLES.Tenant).whereIn('id', createdTenants).del();
    createdTenants.length = 0;
  }
}

async function plan(billingPlan: 'revshare' | 'flex' | 'enterprise', tenantId = T): Promise<void> {
  await db(TABLES.Tenant).where({ id: tenantId }).update({
    billingPlan,
    stripeCustomerId: billingPlan === 'enterprise' ? null : CUSTOMER,
    stripeSubscriptionId: billingPlan === 'enterprise' ? null : 'sub_fee_rule',
  });
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  __setMailerForTests(null);
  if (!skipIntegration) {
    await cleanAll();
    await db(TABLES.Tenant).where({ id: T }).update({ billingPlan: null, stripeCustomerId: null, stripeSubscriptionId: null });
  }
  await db.destroy();
});

beforeEach(async () => {
  mailer = new CapturingMailer();
  __setMailerForTests(mailer);
  h.calls.length = 0;
  h.subscription = null;
  if (skipIntegration) return;
  await cleanAll();
  await plan('revshare');
});

afterEach(() => {
  __setMailerForTests(null);
});

describe('billing-period arithmetic', () => {
  it('renews an anchor on the 31st on the last day of shorter months', () => {
    const anchor = new Date('2026-01-31T09:00:00Z');
    expect(nextPeriodStart(anchor, 'month', 1, new Date('2026-02-01T00:00:00Z')).toISOString()).toBe('2026-02-28T09:00:00.000Z');
    expect(nextPeriodStart(anchor, 'month', 1, new Date('2026-03-01T00:00:00Z')).toISOString()).toBe('2026-03-31T09:00:00.000Z');
    expect(nextPeriodStart(anchor, 'year', 1, new Date('2026-02-01T00:00:00Z')).toISOString()).toBe('2027-01-31T09:00:00.000Z');
  });

  it('applies a notice 30 days on, at the start of the next billing period', () => {
    const billing = { anchor: new Date('2025-03-05T00:00:00Z'), interval: 'month' as const, count: 1 };
    // Noticed Oct 17 → Nov 16 at the earliest → next renewal Dec 5.
    expect(effectiveAfterNotice(new Date('2026-10-17T12:00:00Z'), billing).toISOString()).toBe('2026-12-05T00:00:00.000Z');
    // A renewal exactly 30 days on counts.
    expect(effectiveAfterNotice(new Date('2026-10-06T00:00:00Z'), billing).toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });
});

describe.skipIf(skipIntegration)('what the new rule bills (Revshare 3% / 10%)', () => {
  beforeEach(async () => {
    await newRule();
  });

  it('bills a renamed sale that paid a percent commission on its revenue', async () => {
    await seed({ type: 'order_paid', value: 100, commissions: [pct(20)] });
    const res = await report();
    // max(3% × 100, 10% × 20) = 3 → 3 / 0.03 = 100 of basis.
    expect(metered()).toEqual(['100.00']);
    expect(res.feeRule).toMatchObject({ revenueRate: 0.03, commissionRate: 0.1, meterRate: 0.03, newRuleUsd: 100 });
  });

  it('a percent commission accrued before the rate type was stamped still counts, by its program rule', async () => {
    const s = await seed({ type: 'order_paid', value: 100, commissions: [{ amount: 20, rateType: null }] });
    await db(TABLES.Program).where({ id: s.programId }).update({
      commissionRule: JSON.stringify([{ trigger: 'every', eventType: 'order_paid', type: 'percent', value: 20 }]),
    });
    await report();
    expect(metered()).toEqual(['100.00']);
  });

  it('floors a zero-value conversion paid a fixed bounty at 10% of the bounty', async () => {
    await seed({ type: 'signup', value: null, commissions: [fixed(50)] });
    await report();
    // 10% × 50 = 5 → 5 / 0.03.
    expect(metered()).toEqual(['166.67']);
  });

  it('floors an understated value paid a fixed bounty, declared revenue or not', async () => {
    await seed({ type: 'order_paid', value: 10, commissions: [fixed(50)], revenueEventTypes: ['order_paid'] });
    await seed({ type: 'loan_funded', value: 1, commissions: [fixed(100)] });
    await report();
    // max(0.30, 5) + max(0, 10) = 15 → 500 of basis.
    expect(metered()).toEqual(['500.00']);
  });

  it('bills a declared revenue type paid fixed bounties on its revenue when that is higher', async () => {
    await seed({ type: 'order_paid', value: 1000, commissions: [fixed(50)], revenueEventTypes: ['order_paid'] });
    await report();
    expect(metered()).toEqual(['1000.00']);
  });

  it('charges honest percent programs at 10%, 20% and 30% exactly the revenue rate', async () => {
    for (const rate of [10, 20, 30]) await seed({ value: 1000, commissions: [pct(rate * 10)] });
    await report();
    expect(metered()).toEqual(['3000.00']);
  });

  it('only a program paying over 30% reaches the floor', async () => {
    await seed({ value: 1000, commissions: [pct(350)] });
    await report();
    // 10% × 350 = 35 > 3% × 1000 = 30.
    expect(metered()).toEqual(['1166.67']);
  });

  it('keeps billing revenue whose commission rule did not fire, and nothing for a conversion with neither', async () => {
    await seed({ value: 100 });
    await seed({ type: 'signup', value: null });
    await seed({ type: 'pageview', value: 50 });
    await report();
    expect(metered()).toEqual(['100.00']);
  });

  it('counts revenue once per conversion and commissions over every touch', async () => {
    // Linear 50/50: revenue 100 once; commissions 10 + 10.
    await seed({ value: 100, touches: [[pct(10)], [pct(10)]] });
    // Two partners' fixed bounties on one signup: 25 + 25 → floor 5.
    await seed({ type: 'signup', value: null, touches: [[fixed(25)], [fixed(25)]] });
    await report();
    expect(metered()).toEqual(['266.67']); // 100 + 166.67
  });

  it('leaves reversed commissions out, and credits a reversal after billing', async () => {
    await seed({ type: 'signup', value: null, commissions: [{ amount: 50, rateType: 'fixed', status: 'reversed' }] });
    const partial = await seed({ type: 'signup', value: null, touches: [[fixed(30)], [{ amount: 30, rateType: 'fixed', status: 'reversed' }]] });
    await report();
    expect(metered()).toEqual(['100.00']); // 10% × 30 / 0.03

    await db(TABLES.Commission).where({ id: partial.commissionIds[0]! }).update({ status: 'reversed' });
    await seed({ type: 'signup', value: null, commissions: [fixed(60)] });
    const res = await report();
    expect(res.creditsByCurrency).toEqual({ USD: -100 });
    expect(metered()).toEqual(['100.00', '100.00']); // 200 new − 100 credit
  });

  it('keeps the floor while the partner keeps the bounty, however the value is refunded', async () => {
    const s = await seed({ type: 'order_paid', value: 200, commissions: [fixed(100)], revenueEventTypes: ['order_paid'] });
    await report();
    expect(metered()).toEqual(['333.33']); // max(6, 10) / 0.03
    await db(TABLES.Event).insert({
      id: ulid(), tenantId: T, userId: 'u', type: 'refund', value: '-200.00', currency: 'USD',
      metadata: { conversionEventId: s.eventId }, ts: new Date(),
    });
    const res = await report();
    expect(res.creditsByCurrency).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('refunds only cut the fee with the commission (both rules)', () => {
  async function refund(eventId: string, amount: number) {
    await db(TABLES.Event).insert({
      id: ulid(), tenantId: T, userId: 'u', type: 'refund', value: (-amount).toFixed(2), currency: 'USD',
      metadata: { conversionEventId: eventId }, ts: new Date(),
    });
  }

  it('old rule: a refund the partner keeps the commission on credits nothing, until it is reversed', async () => {
    const s = await seed({ value: 100, commissions: [pct(20)] });
    await report();
    await refund(s.eventId, 100);
    const kept = await report();
    expect(kept.creditsByCurrency).toBeUndefined();

    await db(TABLES.Commission).where({ id: s.commissionIds[0]! }).update({ status: 'reversed' });
    const reversed = await report();
    expect(reversed.creditsByCurrency).toEqual({ USD: -100 });
  });

  it('old rule: a paid commission with no clawback keeps its revenue billed', async () => {
    const s = await seed({ value: 100, commissions: [{ amount: 20, rateType: 'percent', status: 'paid' }] });
    await refund(s.eventId, 40);
    await report();
    expect(metered()).toEqual(['100.00']);
  });

  it('new rule: a partial refund with a prorated replacement bills the kept share', async () => {
    await newRule();
    const s = await seed({ value: 100, commissions: [pct(20)] });
    await refund(s.eventId, 33.33);
    // refunds.ts: reverse the root, accrue the kept share (rounded).
    await db(TABLES.Commission).where({ id: s.commissionIds[0]! }).update({ status: 'reversed' });
    const attribution = await db(TABLES.Attribution).where({ eventId: s.eventId }).first();
    await db(TABLES.Commission).insert({
      id: ulid(), tenantId: T, attributionId: attribution.id, partnerId: attribution.partnerId, amount: '13.33',
      currency: 'USD', status: 'accrued', accruedAt: new Date(),
      metadata: { refund: { rootCommissionId: s.commissionIds[0], replacesCommissionId: s.commissionIds[0], refundEventId: 'x' } },
    });
    await report();
    expect(metered()).toEqual(['66.67']);
  });
});

describe.skipIf(skipIntegration)('Flex vs Revshare', () => {
  it('Flex bills 1.5% / 5% through the same multiplier, so the same basis reaches its meter', async () => {
    await plan('flex');
    await newRule();
    await seed({ type: 'order_paid', value: 100, commissions: [pct(20)] });
    await seed({ type: 'signup', value: null, commissions: [fixed(50)] });
    const res = await report();
    // max(1.5, 1) / 0.015 = 100; 5% × 50 / 0.015 = 166.67.
    expect(metered()).toEqual(['266.67']);
    expect(res.feeRule).toMatchObject({ revenueRate: 0.015, commissionRate: 0.05, meterRate: 0.015 });
  });

  it('the old rule bills only revenue types, on both plans', async () => {
    await plan('flex');
    await seed({ type: 'order_paid', value: 100, commissions: [pct(20)] });
    await seed({ type: 'signup', value: null, commissions: [fixed(50)] });
    await seed({ value: 70, commissions: [pct(14)] });
    await report();
    expect(metered()).toEqual(['70.00']);
  });
});

describe.skipIf(skipIntegration)('settings changes never re-bill history', () => {
  beforeEach(async () => {
    await newRule();
  });

  it('a rate change applies to new conversions only', async () => {
    await seed({ type: 'signup', value: null, commissions: [fixed(30)] });
    await report();
    expect(metered()).toEqual(['100.00']);

    await setFeeRuleSettings(db, { rates: { revshare: { commissionRate: 0.15 } } }, OPERATOR);
    await seed({ type: 'signup', value: null, commissions: [fixed(30)] });
    const res = await report();
    // Only the new one, at 15%: 4.5 / 0.03.
    expect(metered()).toEqual(['100.00', '150.00']);
    expect(res.creditsByCurrency).toBeUndefined();
  });

  it('declaring a revenue type later does not bill conversions already seen', async () => {
    const s = await seed({ type: 'order_paid', value: 1000, commissions: [fixed(30)] });
    await report();
    expect(metered()).toEqual(['100.00']); // floor only: not declared, not percent
    await db(TABLES.Program).where({ id: s.programId }).update({ revenueEventTypes: ['order_paid'] });
    await seed({ type: 'order_paid', value: 1000, commissions: [fixed(30)], programId: s.programId });
    await report();
    expect(metered()).toEqual(['100.00', '1000.00']);
  });
});

describe.skipIf(skipIntegration)('shadow mode', () => {
  it('off by default: nothing recorded', async () => {
    await seed({ type: 'signup', value: null, commissions: [fixed(30)] });
    await report();
    expect(await db(TABLES.UsageFeeShadow)).toHaveLength(0);
  });

  it('on: records old vs new for a tenant on the old rule, billing the old rule', async () => {
    await setFeeRuleSettings(db, { shadow: true }, OPERATOR);
    await seed({ value: 100, commissions: [pct(20)] });
    await seed({ type: 'order_paid', value: 100, commissions: [pct(20)] });
    await seed({ type: 'signup', value: null, commissions: [fixed(30)] });
    const res = await report();
    expect(metered()).toEqual(['100.00']);
    expect(res.feeRule?.newRuleUsd).toBe(0);
    const [row] = await db(TABLES.UsageFeeShadow);
    expect(row).toMatchObject({ conversions: 3, floorConversions: 1, renamedSaleConversions: 1, mode: 'revshare' });
    expect(Number(row.oldBasisUsd)).toBe(100);
    expect(Number(row.oldFeeUsd)).toBe(3);
    expect(Number(row.newFeeUsd)).toBe(9); // 3 + 3 + 3
    expect(Number(row.newBasisUsd)).toBe(300);
  });

  it('on: nothing recorded once the tenant is on the new rule', async () => {
    await setFeeRuleSettings(db, { shadow: true }, OPERATOR);
    await newRule();
    await seed({ type: 'signup', value: null, commissions: [fixed(30)] });
    await report();
    expect(await db(TABLES.UsageFeeShadow)).toHaveLength(0);
  });

  it('the live estimate compares the trailing window per hosted tenant', async () => {
    const hosted = await hostedTenant('revshare');
    await seed({ type: 'signup', value: null, commissions: [fixed(30)], tenantId: hosted.id });
    await seed({ value: 200, commissions: [pct(40)], tenantId: hosted.id });
    await seed({ value: 999, commissions: [pct(100)], tenantId: hosted.id, attributedAt: new Date(Date.now() - 30 * DAY) });
    const [estimate] = (await estimateFeeImpact(db, await getFeeRuleSettings(db), { days: 7 })).filter((e) => e.tenantId === hosted.id);
    // old: 200 × 3% = 6; new: 3 (floor on the signup) + max(6, 4) = 9.
    expect(estimate).toMatchObject({ conversions: 2, oldBasisUsd: 200, oldFeeUsd: 6, newFeeUsd: 9, floorConversions: 1 });
  });
});

async function hostedTenant(
  billingPlan: 'revshare' | 'flex' | 'enterprise',
  opts: { admins?: string[] } = {},
): Promise<{ id: string; slug: string }> {
  const id = ulid().slice(0, 26);
  const slug = `fee${id.slice(-8).toLowerCase()}`;
  await db(TABLES.Tenant).insert({
    id, slug, displayName: `Brand ${slug}`, status: 'active', approvalStatus: 'approved', billingPlan,
    stripeCustomerId: billingPlan === 'enterprise' ? null : `cus_${slug}`,
    stripeSubscriptionId: billingPlan === 'enterprise' ? null : `sub_${slug}`,
  });
  createdTenants.push(id);
  for (const email of opts.admins ?? []) {
    await db(TABLES.Admin).insert({ id: ulid(), tenantId: id, email, name: 'Owner', activatedAt: new Date() });
  }
  return { id, slug };
}

describe.skipIf(skipIntegration)('cutover: new plans start on the new rule', () => {
  it('a tenant whose plan starts after the cutover is billed on the new rule from its first conversion', async () => {
    const cutover = new Date(Date.now() - 2 * DAY);
    await setFeeRuleSettings(db, { cutoverAt: cutover.toISOString() }, OPERATOR);
    h.subscription = { start_date: Math.floor((Date.now() - DAY) / 1000), billing_cycle_anchor: Math.floor((Date.now() - DAY) / 1000) };
    // Attributed before the plan started (e.g. in the trial): still the new rule.
    await seed({ type: 'signup', value: null, commissions: [fixed(30)], attributedAt: new Date(Date.now() - 3 * DAY) });
    const res = await report();
    expect(metered()).toEqual(['100.00']);
    expect(res.feeRule?.effectiveAt).toBe(FROM_THE_START.toISOString());
    const terms = await db(TABLES.HostedFeeTerms).where({ tenantId: T }).first();
    expect(terms).toMatchObject({ effectiveSource: 'new_plan', planSubscriptionId: 'sub_fee_rule' });
  });

  it('a tenant whose plan started before the cutover stays on the old rule', async () => {
    await setFeeRuleSettings(db, { cutoverAt: new Date(Date.now() - DAY).toISOString() }, OPERATOR);
    h.subscription = { start_date: Math.floor((Date.now() - 90 * DAY) / 1000), billing_cycle_anchor: Math.floor((Date.now() - 90 * DAY) / 1000) };
    await seed({ type: 'signup', value: null, commissions: [fixed(30)] });
    await report();
    expect(h.calls).toHaveLength(0);
    expect((await db(TABLES.HostedFeeTerms).where({ tenantId: T }).first()).effectiveAt).toBeNull();
  });

  it('with no cutover, nobody moves and Stripe is not asked', async () => {
    h.subscription = { start_date: Math.floor(Date.now() / 1000), billing_cycle_anchor: Math.floor(Date.now() / 1000) };
    await seed({ type: 'signup', value: null, commissions: [fixed(30)] });
    await report();
    expect(h.calls).toHaveLength(0);
    expect(await db(TABLES.HostedFeeTerms).where({ tenantId: T }).first()).toBeUndefined();
  });
});

describe.skipIf(skipIntegration)('an existing tenant across its effective date', () => {
  it('bills each conversion under the rule of its own time, in one report spanning the date', async () => {
    const effectiveAt = new Date(Date.now() - 2 * DAY);
    await newRule(T, effectiveAt);
    await db(TABLES.HostedFeeTerms).where({ tenantId: T }).update({ effectiveSource: 'notice' });
    // Before the date: old rule (signup bills nothing, invoice bills revenue).
    await seed({ type: 'signup', value: null, commissions: [fixed(30)], attributedAt: new Date(effectiveAt.getTime() - DAY) });
    await seed({ value: 50, commissions: [pct(10)], attributedAt: new Date(effectiveAt.getTime() - DAY) });
    // After: new rule.
    await seed({ type: 'signup', value: null, commissions: [fixed(30)], attributedAt: new Date(effectiveAt.getTime() + DAY) });
    const res = await report();
    expect(metered()).toEqual(['150.00']); // 50 + 100
    expect(res.feeRule?.newRuleUsd).toBe(100);
    const terms = (await db(TABLES.UsageLedger).orderBy('amount')).map((r: { terms: { v: number } }) => r.terms.v);
    expect(terms).toEqual([1, 2]);
  });

  it('before the date, the tenant is on the old rule and the shadow shows the new one', async () => {
    await setFeeRuleSettings(db, { shadow: true }, OPERATOR);
    await newRule(T, new Date(Date.now() + 20 * DAY));
    await seed({ type: 'signup', value: null, commissions: [fixed(30)] });
    await report();
    expect(h.calls).toHaveLength(0);
    const [row] = await db(TABLES.UsageFeeShadow);
    expect(Number(row.newFeeUsd)).toBe(3);
  });
});

describe.skipIf(skipIntegration)('pricing-change notice', () => {
  const READ = async () => ({
    startDate: new Date('2025-03-05T00:00:00Z'),
    anchor: new Date('2025-03-05T00:00:00Z'),
    interval: 'month' as const,
    count: 1,
  });
  const NOW = new Date('2026-10-17T12:00:00Z');

  it('previews nothing until there is a cutover', async () => {
    await hostedTenant('revshare', { admins: ['a@brand.test'] });
    const preview = await previewPricingNotices(db, { now: NOW, readSubscription: READ });
    expect(preview.candidates).toEqual([]);
  });

  it('previews recipients, the effective date and the email, then sends once', async () => {
    await setFeeRuleSettings(db, { cutoverAt: NOW.toISOString() }, OPERATOR);
    const a = await hostedTenant('revshare', { admins: ['owner@a.test', 'cfo@a.test'] });
    const b = await hostedTenant('flex', { admins: ['owner@b.test'] });
    await hostedTenant('enterprise', { admins: ['owner@e.test'] });

    const preview = await previewPricingNotices(db, { now: NOW, readSubscription: READ });
    const ids = preview.candidates.map((c) => c.tenantId);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).toHaveLength(2); // Enterprise moves by contract
    const ca = preview.candidates.find((c) => c.tenantId === a.id)!;
    expect(ca.recipients.map((r) => r.email).sort()).toEqual(['cfo@a.test', 'owner@a.test']);
    expect(ca.effectiveAt).toBe('2026-12-05T00:00:00.000Z');
    expect(preview.sample?.text).toContain('3% of partner-attributed revenue, with a minimum of 10%');
    expect(preview.sample?.text).toContain('up to 30%');
    expect(preview.sample?.text).toContain('December 5, 2026');
    expect(mailer.sent).toHaveLength(0);

    const sent = await sendPricingNotices(db, { operatorEmail: OPERATOR, now: NOW, readSubscription: READ });
    expect(sent.sent.map((s) => s.tenantId).sort()).toEqual([a.id, b.id].sort());
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(['cfo@a.test', 'owner@a.test', 'owner@b.test']);
    const flexMail = mailer.sent.find((m) => m.to === 'owner@b.test')!;
    expect(flexMail.text).toContain('1.5% of partner-attributed revenue, with a minimum of 5%');
    expect(flexMail.platform).toBe(true);
    const terms = await db(TABLES.HostedFeeTerms).where({ tenantId: a.id }).first();
    expect(terms).toMatchObject({ effectiveSource: 'notice', noticeSentByEmail: OPERATOR });
    expect(new Date(terms.effectiveAt).toISOString()).toBe('2026-12-05T00:00:00.000Z');

    // Idempotent: a second send (double click, second operator) sends nothing.
    const again = await sendPricingNotices(db, { operatorEmail: OPERATOR, now: NOW, readSubscription: READ });
    expect(again.sent).toEqual([]);
    expect(mailer.sent).toHaveLength(3);
    expect((await previewPricingNotices(db, { now: NOW, readSubscription: READ })).candidates).toEqual([]);
  });

  it('releases the claim when no recipient could be reached', async () => {
    await setFeeRuleSettings(db, { cutoverAt: NOW.toISOString() }, OPERATOR);
    const a = await hostedTenant('revshare', { admins: ['down@a.test'] });
    mailer.failFor.add('down@a.test');
    const res = await sendPricingNotices(db, { operatorEmail: OPERATOR, now: NOW, readSubscription: READ });
    expect(res.failed.map((f) => f.tenantId)).toEqual([a.id]);
    const terms = await db(TABLES.HostedFeeTerms).where({ tenantId: a.id }).first();
    expect(terms.noticeSentAt).toBeNull();
    expect(terms.effectiveAt).toBeNull();
    mailer.failFor.clear();
    const retry = await sendPricingNotices(db, { operatorEmail: OPERATOR, now: NOW, readSubscription: READ });
    expect(retry.sent.map((s) => s.tenantId)).toEqual([a.id]);
  });

  it('skips a tenant whose plan started after the cutover', async () => {
    await setFeeRuleSettings(db, { cutoverAt: new Date('2025-01-01T00:00:00Z').toISOString() }, OPERATOR);
    await hostedTenant('revshare', { admins: ['owner@new.test'] });
    expect((await previewPricingNotices(db, { now: NOW, readSubscription: READ })).candidates).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('contract terms', () => {
  it('Enterprise commission-only with a monthly minimum: the statement owes the minimum', async () => {
    const e = await hostedTenant('enterprise');
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await setContractTerms(
      db,
      e.id,
      { revenueRate: 0, commissionRate: 0.05, monthlyMinimumUsd: 299, effectiveAt: monthStart.toISOString(), note: 'network operator' },
      OPERATOR,
    );
    // A loan: its principal is no revenue to bill, only the commission.
    await seed({ tenantId: e.id, type: 'loan_funded', value: 250_000, commissions: [fixed(1500)] });
    await seed({ tenantId: e.id, value: 10_000, commissions: [pct(500)] });
    const month = monthStart.toISOString().slice(0, 7);
    const st = await contractStatement(db, await getFeeRuleSettings(db), e.id, month);
    expect(st).toMatchObject({ revenueRate: 0, commissionRate: 0.05, conversions: 2, feeUsd: 100, minimumTopUpUsd: 199, amountOwedUsd: 299 });

    // Above the minimum, the fee is what's owed.
    await seed({ tenantId: e.id, type: 'loan_funded', value: 900_000, commissions: [fixed(6000)] });
    const higher = await contractStatement(db, await getFeeRuleSettings(db), e.id, month);
    expect(higher).toMatchObject({ feeUsd: 400, minimumTopUpUsd: 0, amountOwedUsd: 400 });
  });

  it('a metered tenant with overridden rates is metered at them', async () => {
    await setContractTerms(
      db,
      T,
      { revenueRate: 0.02, commissionRate: 0.08, monthlyMinimumUsd: null, effectiveAt: FROM_THE_START.toISOString(), note: null },
      OPERATOR,
    );
    await seed({ value: 1000, commissions: [pct(100)] }); // max(20, 8) = 20
    await seed({ type: 'signup', value: null, commissions: [fixed(30)] }); // 2.4
    const res = await report();
    // 22.4 / 0.03 (the Revshare price) = 746.67
    expect(metered()).toEqual(['746.67']);
    expect(res.feeRule).toMatchObject({ contract: true, revenueRate: 0.02, commissionRate: 0.08 });
  });

  it('refuses a monthly minimum outside Enterprise', async () => {
    await expect(
      setContractTerms(db, T, { revenueRate: null, commissionRate: 0.05, monthlyMinimumUsd: 299, effectiveAt: null, note: null }, OPERATOR),
    ).rejects.toBeInstanceOf(ContractTermsError);
  });
});

describe.skipIf(skipIntegration)('review signals', () => {
  it('flags clicks without commission and commission above value', async () => {
    const quiet = await hostedTenant('revshare');
    const programId = ulid();
    await db(TABLES.Program).insert({
      id: programId, tenantId: quiet.id, name: 'Q', attributionModel: 'last_click', attributionWindowDays: 60,
      commissionRule: JSON.stringify([{ trigger: 'every', type: 'fixed', value: 1 }]), destinationUrl: 'https://x/',
    });
    const partnerId = ulid();
    await db(TABLES.Partner).insert({ id: partnerId, tenantId: quiet.id, name: 'P', email: `p-${partnerId}@x.com` });
    const clickId = ulid();
    await db(TABLES.Click).insert({ id: clickId, tenantId: quiet.id, partnerId, programId, landingUrl: 'https://x/', ipHash: 'h', ts: new Date() });
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: quiet.id, clickId, userId: 'u1', stitchedAt: new Date() });

    const lowball = await hostedTenant('revshare');
    const s = await seed({ tenantId: lowball.id, type: 'order_paid', value: 5, commissions: [fixed(50)], revenueEventTypes: ['order_paid'] });

    const signals = await reviewSignals(db, { days: 60 });
    expect(signals.noCommissionActivity.map((r) => r.tenantId)).toContain(quiet.id);
    expect(signals.noCommissionActivity.map((r) => r.tenantId)).not.toContain(lowball.id);
    const above = signals.commissionAboveValue.find((r) => r.tenantId === lowball.id);
    expect(above).toMatchObject({ events: 1, sampleEventIds: [s.eventId] });
  });
});
