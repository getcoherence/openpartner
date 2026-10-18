/**
 * Performance bounties (docs/bounties.md §7): the metric each bounty is
 * measured on, its window, the hourly sweep that pays it as a bonus, the
 * re-check at approval, the partner emails, and the admin and partner
 * routes.
 *
 * dispatchEvent is mocked so the assertions read the exact payloads, and a
 * capturing mailer stands in for SMTP.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';

const ADMIN_KEY = 'op_test_bounties_admin_0123456789abcdef012';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { dispatchEvent } = await import('../webhook-dispatcher.js');
const { awardBonus } = await import('../bonuses.js');
const { __setMailerForTests } = await import('../mailer.js');
const { bountyMetricQuery, bountyProgress, sendBountyEmails, sweepTenantBounties } = await import('../performance-bounties.js');
const { performanceByPartner } = await import('../performance-metric.js');
const { runCommissionAutoApproveJob, runPerformanceBountiesJob } = await import('../scheduler.js');
import type { Mailer, Message } from '../mailer.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const T = DEFAULT_TENANT_ID;
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

class CapturingMailer implements Mailer {
  readonly sent: Message[] = [];
  async send(_ctx: unknown, msg: Message): Promise<void> {
    this.sent.push(msg);
  }
}
let mailer: CapturingMailer;

const TABLES_TO_CLEAN = [
  TABLES.CommissionAdjustment,
  TABLES.Commission,
  TABLES.Bonus,
  TABLES.Bounty,
  TABLES.Payout,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.ApiKey,
  TABLES.Session,
  TABLES.Program,
  TABLES.Partner,
];

async function clean(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).del();
}

// ---------- seeding ----------

async function seedProgram(opts: { holdbackDays?: number | null } = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: T,
    name: 'Holiday program',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 10 }]),
    destinationUrl: 'https://x.test',
    holdbackDays: opts.holdbackDays ?? null,
  });
  return id;
}

interface Partner {
  id: string;
  linkId: string;
}

async function seedPartner(programId: string | null, opts: { name?: string; revoked?: boolean; portalAccess?: boolean } = {}): Promise<Partner> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: T,
    name: opts.name ?? `Partner ${id.slice(-4)}`,
    email: `p-${id}@x.test`,
    activatedAt: new Date(),
    portalAccess: opts.portalAccess ?? true,
    ...(opts.revoked ? { revokedAt: new Date() } : {}),
  });
  const linkId = ulid();
  if (programId) {
    await db(TABLES.PartnerProgram).insert({ id: `pc_${ulid()}`, tenantId: T, partnerId: id, programId, source: 'admin' });
    await db(TABLES.Link).insert({ id: linkId, tenantId: T, partnerId: id, programId, linkKey: `lk-${linkId}`, destinationUrl: 'https://x.test' });
  }
  return { id, linkId };
}

/** One attributed conversion for `p`, with its commission. */
async function convert(
  p: Partner,
  programId: string,
  opts: {
    type?: string;
    value?: number | null;
    currency?: string;
    ts?: Date;
    weight?: number;
    /** Another partner's touch on the same event, for a split. */
    splitWith?: Partner;
    fraud?: boolean;
    commission?: number | null;
    commissionStatus?: 'accrued' | 'approved' | 'paid' | 'reversed';
    metadata?: Record<string, unknown>;
  } = {},
): Promise<{ eventId: string; commissionId: string | null }> {
  const clickId = ulid();
  const eventId = ulid();
  const ts = opts.ts ?? ago(1);
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: T,
    linkId: p.linkId,
    partnerId: p.id,
    programId,
    landingUrl: 'https://x.test',
    ipHash: 'h',
    ts: new Date(ts.getTime() - 60_000),
    fraudFlag: opts.fraud ? 'velocity' : null,
  });
  await db(TABLES.Event).insert({
    id: eventId,
    tenantId: T,
    userId: `u-${eventId}`,
    type: opts.type ?? 'invoice_paid',
    value: opts.value === null ? null : (opts.value ?? 100).toFixed(2),
    currency: opts.currency ?? 'USD',
    metadata: opts.metadata ?? {},
    ts,
  });
  const attributionId = ulid();
  await db(TABLES.Attribution).insert({
    id: attributionId,
    tenantId: T,
    eventId,
    partnerId: p.id,
    programId,
    clickId,
    model: 'last_click',
    weight: (opts.weight ?? 1).toFixed(4),
    computedAt: ts,
  });
  if (opts.splitWith) {
    const otherClick = ulid();
    await db(TABLES.Click).insert({
      id: otherClick, tenantId: T, linkId: opts.splitWith.linkId, partnerId: opts.splitWith.id, programId,
      landingUrl: 'https://x.test', ipHash: 'h', ts: new Date(ts.getTime() - 120_000),
    });
    await db(TABLES.Attribution).insert({
      id: ulid(), tenantId: T, eventId, partnerId: opts.splitWith.id, programId, clickId: otherClick,
      model: 'last_click', weight: (1 - (opts.weight ?? 1)).toFixed(4), computedAt: ts,
    });
  }
  let commissionId: string | null = null;
  if (opts.commission !== null) {
    commissionId = ulid();
    await db(TABLES.Commission).insert({
      id: commissionId,
      tenantId: T,
      attributionId,
      partnerId: p.id,
      amount: (opts.commission ?? 10).toFixed(2),
      currency: opts.currency ?? 'USD',
      status: opts.commissionStatus ?? 'approved',
      accruedAt: ts,
      metadata: { rateType: 'percent' },
    });
  }
  return { eventId, commissionId };
}

/** A refund naming its conversion, as POST /attribution/refunds records it. */
async function refund(eventId: string, amount: number | null, type: 'refund' | 'chargeback' = 'refund'): Promise<void> {
  await db(TABLES.Event).insert({
    id: ulid(),
    tenantId: T,
    userId: `u-${eventId}`,
    type,
    value: amount === null ? null : (-amount).toFixed(2),
    currency: 'USD',
    metadata: { conversionEventId: eventId },
    ts: new Date(),
  });
}

/** A refund of a Stripe charge, as the self-host webhook records
 *  charge.refunded: matched by the invoice or PaymentIntent, no
 *  conversionEventId, the charge's CUMULATIVE amounts in minor units. */
async function stripeRefund(
  match: { stripeInvoiceId?: string; stripePaymentIntentId?: string },
  amountRefunded: number,
  chargeCollected: number,
): Promise<void> {
  await db(TABLES.Event).insert({
    id: ulid(),
    tenantId: T,
    userId: 'u-stripe',
    type: 'refund',
    value: (-amountRefunded / 100).toFixed(2),
    currency: 'USD',
    metadata: {
      stripeChargeId: `ch_${ulid()}`,
      ...match,
      amountRefunded,
      chargeCollected,
      fullRefund: amountRefunded >= chargeCollected,
    },
    ts: new Date(),
  });
}

async function seedBounty(programId: string, opts: Record<string, unknown> = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Bounty).insert({
    id,
    tenantId: T,
    programId,
    name: 'Holiday push',
    description: 'Ten sales before New Year',
    metric: 'conversions',
    eventType: null,
    threshold: 3,
    scope: 'new',
    startsAt: ago(10),
    endsAt: ahead(30),
    rewardAmount: '500.00',
    currency: 'USD',
    partnerIds: null,
    status: 'active',
    ...opts,
    ...(Array.isArray(opts.partnerIds) ? { partnerIds: JSON.stringify(opts.partnerIds) } : {}),
  });
  return id;
}

/** What the sweep measures `p` at against the bounty. */
async function progress(bountyId: string, partnerId: string): Promise<number> {
  const b = await db(TABLES.Bounty).where({ id: bountyId }).first();
  return (await bountyProgress(db, b, [partnerId])).get(partnerId) ?? 0;
}

async function sweep(now?: Date) {
  return db.transaction((trx) => sweepTenantBounties(trx, T, now));
}

async function bonusesFor(bountyId: string) {
  return db(TABLES.Bonus).where({ bountyId }).orderBy('partnerId');
}

function dispatched(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.filter((c) => c[1] === event)
    .map((c) => c[2] as Record<string, unknown>);
}

function admin(method: 'get' | 'post' | 'patch', path: string, body?: object) {
  const r = request(app)[method](path).set('Authorization', `Bearer ${ADMIN_KEY}`);
  return body ? r.send(body) : r;
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  __setMailerForTests(null);
  if (!skipIntegration) await clean();
  await db.destroy();
});

beforeEach(async () => {
  vi.mocked(dispatchEvent).mockClear();
  mailer = new CapturingMailer();
  __setMailerForTests(mailer);
  if (skipIntegration) return;
  await clean();
});

// ---------- metrics and windows ----------

describe.skipIf(skipIntegration)('what a bounty counts', () => {
  it('conversions: sales by default, weighted by the share, refunded ones out, fraud out', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    const rival = await seedPartner(programId);
    await convert(p, programId); // 1
    await convert(p, programId, { weight: 0.5, splitWith: rival }); // 0.5
    await convert(p, programId, { type: 'signup', value: null }); // not a sale
    await convert(p, programId, { fraud: true }); // flagged click
    const refunded = await convert(p, programId);
    await refund(refunded.eventId, 100); // refunded in full: out
    const partial = await convert(p, programId);
    await refund(partial.eventId, 40); // partial: still a sale
    const bountyId = await seedBounty(programId, { threshold: 3 });

    await sweep();
    expect(await bonusesFor(bountyId)).toHaveLength(0); // 2.5 < 3

    await convert(p, programId, { weight: 0.5, splitWith: rival }); // 3
    await sweep();
    expect(await bonusesFor(bountyId)).toHaveLength(1);
  });

  it('conversions of one eventType count only that type, value or not', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    await convert(p, programId, { type: 'demo_booked', value: null });
    await convert(p, programId, { type: 'demo_booked', value: null });
    await convert(p, programId, { type: 'invoice_paid' });
    const bountyId = await seedBounty(programId, { eventType: 'demo_booked', threshold: 2 });
    await sweep();
    expect(await bonusesFor(bountyId)).toHaveLength(1);
  });

  it('leads: signups and trial starts', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    await convert(p, programId, { type: 'signup', value: null });
    await convert(p, programId, { type: 'trial_started', value: null });
    await convert(p, programId, { type: 'invoice_paid' });
    const two = await seedBounty(programId, { metric: 'leads', threshold: 2 });
    const three = await seedBounty(programId, { metric: 'leads', threshold: 3 });
    await sweep();
    expect(await bonusesFor(two)).toHaveLength(1);
    expect(await bonusesFor(three)).toHaveLength(0);
  });

  it('revenue: value × share in the bounty currency, net of refunds', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    const rival = await seedPartner(programId);
    await convert(p, programId, { value: 600 });
    await convert(p, programId, { value: 400, weight: 0.5, splitWith: rival }); // 200
    await convert(p, programId, { value: 5000, currency: 'EUR' }); // other currency
    const r = await convert(p, programId, { value: 300 });
    await refund(r.eventId, 100); // 200 kept
    const at1000 = await seedBounty(programId, { metric: 'revenue', threshold: 1000 });
    const at1001 = await seedBounty(programId, { metric: 'revenue', threshold: 1001 });
    await sweep();
    expect(await bonusesFor(at1000)).toHaveLength(1);
    expect(await bonusesFor(at1001)).toHaveLength(0);
  });

  it('a Stripe refund of the invoice or PaymentIntent: in full, out; in part, still a sale, net', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    await convert(p, programId, { metadata: { stripeInvoiceId: 'in_full' } });
    // amountRefunded is cumulative: $40, then the rest.
    await stripeRefund({ stripeInvoiceId: 'in_full' }, 4000, 10000);
    await stripeRefund({ stripeInvoiceId: 'in_full' }, 10000, 10000);
    await convert(p, programId, { metadata: { stripePaymentIntentId: 'pi_part' } });
    await stripeRefund({ stripePaymentIntentId: 'pi_part' }, 2500, 10000); // 75 kept
    await convert(p, programId); // untouched
    const conversions = await seedBounty(programId, { threshold: 2 });
    const at175 = await seedBounty(programId, { metric: 'revenue', threshold: 175 });
    const at176 = await seedBounty(programId, { metric: 'revenue', threshold: 176 });

    expect(await progress(conversions, p.id)).toBe(2);
    expect(await progress(at175, p.id)).toBe(175);
    await sweep();
    expect(await bonusesFor(conversions)).toHaveLength(1);
    expect(await bonusesFor(at175)).toHaveLength(1);
    expect(await bonusesFor(at176)).toHaveLength(0);
  });

  it('when the API and Stripe both refund a conversion, the larger share wins', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    const a = await convert(p, programId, { value: 200, metadata: { stripeInvoiceId: 'in_a' } });
    await refund(a.eventId, 20); // 180 left
    await stripeRefund({ stripeInvoiceId: 'in_a' }, 5000, 10000); // half: 100 left
    const b = await convert(p, programId, { value: 200, metadata: { stripeInvoiceId: 'in_b' } });
    await refund(b.eventId, 150); // 50 left
    await stripeRefund({ stripeInvoiceId: 'in_b' }, 2500, 10000); // a quarter: 150 left
    const c = await convert(p, programId, { value: 200, metadata: { stripeInvoiceId: 'in_c' } });
    await refund(c.eventId, 50);
    await stripeRefund({ stripeInvoiceId: 'in_c' }, 10000, 10000); // in full: out
    const revenue = await seedBounty(programId, { metric: 'revenue', threshold: 1 });
    const conversions = await seedBounty(programId, { threshold: 1 });

    expect(await progress(revenue, p.id)).toBe(150);
    expect(await progress(conversions, p.id)).toBe(2);
  });

  it('only an invoice_paid conversion takes a Stripe refund, and tiers never net one', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    await convert(p, programId, { type: 'subscription_created', metadata: { stripeInvoiceId: 'in_sub' } });
    await convert(p, programId, { metadata: { stripeInvoiceId: 'in_paid' } });
    await stripeRefund({ stripeInvoiceId: 'in_sub' }, 10000, 10000);
    await stripeRefund({ stripeInvoiceId: 'in_paid' }, 10000, 10000);
    const bountyId = await seedBounty(programId, { threshold: 1 });

    expect(await progress(bountyId, p.id)).toBe(1); // the subscription_created
    // Tiers call the same query without netOfRefunds.
    const b = await db(TABLES.Bounty).where({ id: bountyId }).first();
    const tierShaped = { ...bountyMetricQuery(b, [p.id]), netOfRefunds: false };
    expect((await performanceByPartner(db, tierShaped)).get(p.id)).toBe(2);
  });

  it('commissions: live attribution commissions, net of clawbacks; a bonus never counts', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    await convert(p, programId, { commission: 40 });
    await convert(p, programId, { commission: 30, commissionStatus: 'reversed' }); // out
    const paid = await convert(p, programId, { commission: 50, commissionStatus: 'paid' });
    await db(TABLES.CommissionAdjustment).insert({
      id: ulid(),
      tenantId: T,
      commissionId: paid.commissionId,
      amount: '-20.00',
      currency: 'USD',
      reason: 'refund_clawback',
      metadata: {},
    });
    // 40 + 50 − 20 = 70. A big manual bonus in the same program changes nothing.
    await awardBonus(db, T, { partnerId: p.id, programId, amount: 1000, currency: 'USD', source: 'manual' });
    const at70 = await seedBounty(programId, { metric: 'commissions', threshold: 70 });
    const at71 = await seedBounty(programId, { metric: 'commissions', threshold: 71 });
    await sweep();
    expect(await bonusesFor(at70)).toHaveLength(1);
    expect(await bonusesFor(at71)).toHaveLength(0);
  });

  it('new counts [startsAt, endsAt): the first instant in, the last instant out', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    const startsAt = ago(10);
    const endsAt = ago(1);
    await convert(p, programId, { ts: new Date(startsAt.getTime() - 1) }); // before
    await convert(p, programId, { ts: startsAt }); // in
    await convert(p, programId, { ts: new Date(endsAt.getTime() - 1) }); // in
    await convert(p, programId, { ts: endsAt }); // out
    const two = await seedBounty(programId, { threshold: 2, startsAt, endsAt });
    const three = await seedBounty(programId, { threshold: 3, startsAt, endsAt });
    await sweep();
    expect(await bonusesFor(two)).toHaveLength(1);
    expect(await bonusesFor(three)).toHaveLength(0);
  });

  it('lifetime counts history from before the bounty, so partners already there are paid at once', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    for (let i = 0; i < 3; i += 1) await convert(p, programId, { ts: ago(200) });
    const fresh = await seedBounty(programId, { threshold: 3, scope: 'new', startsAt: ago(1) });
    const lifetime = await seedBounty(programId, { threshold: 3, scope: 'lifetime', startsAt: ago(1) });
    await sweep();
    expect(await bonusesFor(fresh)).toHaveLength(0);
    expect(await bonusesFor(lifetime)).toHaveLength(1);
  });

  it('another program, another partner and the bounty’s allowlist are each respected', async () => {
    const programId = await seedProgram();
    const otherProgram = await seedProgram();
    const listed = await seedPartner(programId);
    const unlisted = await seedPartner(programId);
    const outsider = await seedPartner(otherProgram);
    const revoked = await seedPartner(programId, { revoked: true });
    for (const p of [listed, unlisted, revoked]) for (let i = 0; i < 3; i += 1) await convert(p, programId);
    for (let i = 0; i < 3; i += 1) await convert(outsider, otherProgram);
    const open = await seedBounty(programId);
    const allowlist = await seedBounty(programId, { partnerIds: [listed.id, outsider.id] });
    await sweep();
    expect((await bonusesFor(open)).map((b: { partnerId: string }) => b.partnerId).sort()).toEqual([listed.id, unlisted.id].sort());
    expect((await bonusesFor(allowlist)).map((b: { partnerId: string }) => b.partnerId)).toEqual([listed.id]);
  });
});

// ---------- the sweep ----------

describe.skipIf(skipIntegration)('the sweep', () => {
  it('pays a held bonus once, however often or concurrently it runs', async () => {
    const programId = await seedProgram({ holdbackDays: 14 });
    const p = await seedPartner(programId);
    for (let i = 0; i < 3; i += 1) await convert(p, programId);
    const bountyId = await seedBounty(programId, { rewardAmount: '250.00', currency: 'USD' });

    const runs = await Promise.all([sweep(), sweep(), sweep()]);
    await sweep();
    const bonuses = await bonusesFor(bountyId);
    expect(bonuses).toHaveLength(1);
    expect(bonuses[0]).toMatchObject({
      partnerId: p.id,
      programId,
      amount: '250.00',
      source: 'performance_bounty',
      externalRef: `bounty:${bountyId}:${p.id}`,
      note: 'Holiday push',
      createdBy: null,
    });
    expect(runs.reduce((n, r) => n + r.awarded, 0)).toBe(1);
    const commission = await db(TABLES.Commission).where({ bonusId: bonuses[0].id }).first();
    expect(commission.status).toBe('accrued'); // held for the holdback
    await vi.waitFor(() => expect(dispatched('bonus.awarded')).toHaveLength(1));
    expect(dispatched('bonus.awarded')[0]).toMatchObject({ bountyId, source: 'performance_bounty', status: 'accrued' });
    expect(dispatched('bonus.approved')).toHaveLength(0);
  });

  it('keeps measuring for 7 days after the end, then marks the bounty ended', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    const endsAt = ago(3);
    const bountyId = await seedBounty(programId, { endsAt, threshold: 1 });
    // A conversion inside the window, recorded late (a backlog replay).
    await convert(p, programId, { ts: new Date(endsAt.getTime() - DAY) });
    const late = await sweep();
    expect(late).toMatchObject({ awarded: 1, ended: 0 });
    expect((await db(TABLES.Bounty).where({ id: bountyId }).first()).status).toBe('active');

    const after = await sweep(new Date(endsAt.getTime() + 7 * DAY));
    expect(after.ended).toBe(1);
    const ended = await db(TABLES.Bounty).where({ id: bountyId }).first();
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).not.toBeNull();
    // Ended bounties aren't swept.
    expect((await sweep(new Date(endsAt.getTime() + 8 * DAY))).evaluated).toBe(0);
  });

  it('leaves drafts, archived and not-yet-started bounties alone', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    for (let i = 0; i < 3; i += 1) await convert(p, programId);
    await seedBounty(programId, { status: 'draft' });
    await seedBounty(programId, { status: 'archived' });
    await seedBounty(programId, { startsAt: ahead(1), endsAt: ahead(30), scope: 'lifetime' });
    expect((await sweep()).awarded).toBe(0);
    expect(await db(TABLES.Bonus)).toHaveLength(0);
  });

  it('emails partners: started once, ending soon once, and the award', async () => {
    const programId = await seedProgram();
    const winner = await seedPartner(programId, { name: 'Ada Winner' });
    const close = await seedPartner(programId, { name: 'Grace Close' });
    const headless = await seedPartner(programId, { name: 'Headless', portalAccess: false });
    for (let i = 0; i < 3; i += 1) await convert(winner, programId);
    await convert(close, programId);
    const endsAt = ahead(5);
    await seedBounty(programId, { startsAt: ago(20), endsAt, threshold: 3 });

    const first = await sweep();
    await sendBountyEmails(T, first.emails);
    const subjects = (to: string) => mailer.sent.filter((m) => m.to.startsWith(`p-${to}`)).map((m) => m.tag);
    expect(subjects(winner.id).sort()).toEqual(['bounty_awarded']);
    expect(subjects(close.id).sort()).toEqual(['bounty_ending_soon', 'bounty_started']);
    expect(subjects(headless.id)).toEqual([]);
    const ending = mailer.sent.find((m) => m.tag === 'bounty_ending_soon')!;
    expect(ending.text).toContain("You're at 1 so far.");
    expect(ending.text).toContain('Reach 3 new sales between');
    const awarded = mailer.sent.find((m) => m.tag === 'bounty_awarded')!;
    expect(awarded.subject).toBe('You earned $500: "Holiday push"');

    mailer.sent.length = 0;
    const again = await sweep();
    await sendBountyEmails(T, again.emails);
    expect(mailer.sent).toHaveLength(0);
  });

  it('runs as a scheduled job, emails after commit, and reports counts only', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    for (let i = 0; i < 3; i += 1) await convert(p, programId);
    await seedBounty(programId);
    const result = await runPerformanceBountiesJob();
    expect(result.find((r) => r.tenantId === T)).toMatchObject({ ok: true, evaluated: 1, awarded: 1, ended: 0 });
    expect(result.find((r) => r.tenantId === T)).not.toHaveProperty('result');
    await vi.waitFor(() => expect(mailer.sent.some((m) => m.tag === 'bounty_awarded')).toBe(true));
  });
});

// ---------- re-qualification at approval ----------

describe.skipIf(skipIntegration)('the re-check at approval', () => {
  async function awardedBounty() {
    const programId = await seedProgram({ holdbackDays: 7 });
    const p = await seedPartner(programId);
    const conversions = [];
    // Stripe invoices in_0..in_2, for the charge.refunded re-check.
    for (let i = 0; i < 3; i += 1) conversions.push(await convert(p, programId, { metadata: { stripeInvoiceId: `in_${i}` } }));
    const bountyId = await seedBounty(programId, { threshold: 3 });
    await sweep();
    const [bonus] = await bonusesFor(bountyId);
    const commission = await db(TABLES.Commission).where({ bonusId: bonus.id }).first();
    // Mature the holdback.
    await db(TABLES.Commission).where({ id: commission.id }).update({ accruedAt: ago(8) });
    vi.mocked(dispatchEvent).mockClear();
    return { programId, p, conversions, bountyId, bonus, commissionId: commission.id as string };
  }

  it('approves the bonus when the partner still meets the goal', async () => {
    const { commissionId, bonus } = await awardedBounty();
    const result = await runCommissionAutoApproveJob();
    expect(result.find((r) => r.tenantId === T)).toMatchObject({ approvedCount: 1, requalifiedCount: 0 });
    expect((await db(TABLES.Commission).where({ id: commissionId }).first()).status).toBe('approved');
    await vi.waitFor(() => expect(dispatched('bonus.approved')).toHaveLength(1));
    expect(dispatched('bonus.approved')[0]).toMatchObject({ bonusId: bonus.id });
  });

  it('reverses it, with bonus.reversed reason bounty_requalification, when refunds took them under', async () => {
    const { commissionId, conversions, bonus, bountyId, p, programId } = await awardedBounty();
    await refund(conversions[0]!.eventId, null, 'chargeback');

    const result = await runCommissionAutoApproveJob();
    expect(result.find((r) => r.tenantId === T)).toMatchObject({ approvedCount: 0, requalifiedCount: 1 });
    expect((await db(TABLES.Commission).where({ id: commissionId }).first()).status).toBe('reversed');
    await vi.waitFor(() => expect(dispatched('bonus.reversed')).toHaveLength(1));
    expect(dispatched('bonus.reversed')[0]).toMatchObject({
      bonusId: bonus.id,
      commissionId,
      bountyId,
      reason: 'bounty_requalification',
    });
    expect(dispatched('bonus.approved')).toHaveLength(0);
    expect(dispatched('commission.reversed')).toHaveLength(0);

    // Earned once: back over the goal, a later sweep doesn't pay it again.
    await convert(p, programId);
    await sweep();
    expect(await bonusesFor(bountyId)).toHaveLength(1);
  });

  it("reverses it when Stripe's charge.refunded refunds an invoice in full, not in part", async () => {
    const { commissionId, bountyId, p } = await awardedBounty();
    await stripeRefund({ stripeInvoiceId: 'in_1' }, 9900, 10000);
    expect(await progress(bountyId, p.id)).toBe(3); // still a sale

    await stripeRefund({ stripeInvoiceId: 'in_2' }, 10000, 10000);
    const result = await runCommissionAutoApproveJob();
    expect(result.find((r) => r.tenantId === T)).toMatchObject({ approvedCount: 0, requalifiedCount: 1 });
    expect((await db(TABLES.Commission).where({ id: commissionId }).first()).status).toBe('reversed');
    await vi.waitFor(() => expect(dispatched('bonus.reversed')).toHaveLength(1));
    expect(dispatched('bonus.reversed')[0]).toMatchObject({ commissionId, bountyId, reason: 'bounty_requalification' });
  });
});

// ---------- routes ----------

describe.skipIf(skipIntegration)('admin routes', () => {
  const body = (programId: string, extra: Record<string, unknown> = {}) => ({
    programId,
    name: 'Holiday push',
    description: 'Ten sales before New Year',
    metric: 'conversions',
    threshold: 10,
    scope: 'new',
    startsAt: '2026-11-01T00:00:00Z',
    endsAt: '2026-12-31T00:00:00Z',
    rewardAmount: 500,
    currency: 'usd',
    ...extra,
  });

  it('creates a bounty, with its goal in words, and lists it per program', async () => {
    const programId = await seedProgram();
    const res = await admin('post', '/bounties', body(programId));
    expect(res.status).toBe(201);
    expect(res.body.bounty).toMatchObject({
      programId,
      metric: 'conversions',
      threshold: 10,
      currency: 'USD',
      rewardAmount: '500.00',
      status: 'active',
      partnerIds: null,
      awardedCount: 0,
      summary: 'Reach 10 new sales between Nov 1, 2026 and Dec 31, 2026 to earn $500.',
    });
    const list = await admin('get', `/bounties?programId=${programId}`);
    expect(list.body.bounties.map((b: { id: string }) => b.id)).toEqual([res.body.bounty.id]);
    expect((await admin('get', `/bounties?programId=${ulid()}`)).body.bounties).toEqual([]);
  });

  it('refuses goals that make no sense', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ metric: 'leads', eventType: 'signup' }, 'invalid_bounty'],
      [{ eventType: 'refund' }, 'invalid_bounty'],
      [{ threshold: 2.5 }, 'invalid_bounty'],
      [{ metric: 'revenue', threshold: 10.005 }, 'invalid_bounty'],
      [{ endsAt: '2026-10-01T00:00:00Z' }, 'invalid_bounty'],
      [{ rewardAmount: 0 }, 'invalid_body'],
      [{ description: 'x'.repeat(5001) }, 'invalid_body'],
      [{ partnerIds: [p.id, ulid()] }, 'unknown_partner_ids'],
    ];
    for (const [extra, error] of bad) {
      const res = await admin('post', '/bounties', body(programId, extra));
      expect(res.body.error, JSON.stringify(extra)).toBe(error);
    }
    expect((await admin('post', '/bounties', body(ulid()))).status).toBe(404);
    expect(await db(TABLES.Bounty)).toHaveLength(0);
  });

  it('locks the goal once it has paid anyone; the end may only move later', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    const created = await admin('post', '/bounties', body(programId, { threshold: 1, startsAt: ago(5).toISOString(), endsAt: ahead(10).toISOString() }));
    const id = created.body.bounty.id as string;
    // Before any award, anything goes.
    expect((await admin('patch', `/bounties/${id}`, { threshold: 2 })).status).toBe(200);
    await convert(p, programId);
    await convert(p, programId);
    await sweep();

    const locked = await admin('patch', `/bounties/${id}`, { threshold: 5 });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toBe('bounty_locked');
    expect((await admin('patch', `/bounties/${id}`, { endsAt: ahead(5).toISOString() })).status).toBe(409);
    // Re-sending the same goal is not a change.
    expect((await admin('patch', `/bounties/${id}`, { threshold: 2, name: 'Renamed' })).status).toBe(200);
    const later = await admin('patch', `/bounties/${id}`, { endsAt: ahead(20).toISOString(), description: 'More time!' });
    expect(later.status).toBe(200);
    expect(later.body.bounty).toMatchObject({ name: 'Renamed', description: 'More time!', awardedCount: 1, endingSoonNotifiedAt: null });
  });

  it('moves status only along the allowed paths', async () => {
    const programId = await seedProgram();
    const created = await admin('post', '/bounties', body(programId, { status: 'draft', startsAt: ago(5).toISOString(), endsAt: ahead(10).toISOString() }));
    const id = created.body.bounty.id as string;
    expect((await admin('patch', `/bounties/${id}`, { status: 'ended' })).body.error).toBe('invalid_transition');
    expect((await admin('patch', `/bounties/${id}`, { status: 'active' })).status).toBe(200);
    const ended = await admin('patch', `/bounties/${id}`, { status: 'ended' });
    expect(ended.body.bounty.endedAt).not.toBeNull();
    expect((await admin('patch', `/bounties/${id}`, { status: 'active' })).status).toBe(200);
    expect((await admin('patch', `/bounties/${id}`, { status: 'archived' })).status).toBe(200);
    expect((await admin('patch', `/bounties/${id}`, { status: 'active' })).body.error).toBe('invalid_transition');
  });

  it("shows each partner's progress against the threshold", async () => {
    const programId = await seedProgram();
    const a = await seedPartner(programId, { name: 'Ada' });
    const b = await seedPartner(programId, { name: 'Bea' });
    for (let i = 0; i < 3; i += 1) await convert(a, programId);
    await convert(b, programId);
    const bountyId = await seedBounty(programId, { threshold: 3 });
    await sweep();
    const res = await admin('get', `/bounties/${bountyId}/progress`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ eligible: 2, reached: 1, awarded: 1 });
    expect(res.body.partners.map((r: { name: string; value: number; reached: boolean }) => [r.name, r.value, r.reached])).toEqual([
      ['Ada', 3, true],
      ['Bea', 1, false],
    ]);
    expect(res.body.partners[0].award).toMatchObject({ status: 'accrued' });
    expect(res.body.partners[1].award).toBeNull();
  });

  it('is for admins: scoped and partner keys are refused', async () => {
    const programId = await seedProgram();
    const p = await seedPartner(programId);
    const scoped = await createApiKeyRow(db, { tenantId: T, scopes: ['bonuses:write'], label: 's' });
    const partnerKey = await createApiKeyRow(db, { tenantId: T, partnerId: p.id, label: 'p' });
    for (const key of [scoped.plaintext, partnerKey.plaintext]) {
      expect((await request(app).get('/bounties').set('Authorization', `Bearer ${key}`)).status).toBe(403);
      expect((await request(app).post('/bounties').set('Authorization', `Bearer ${key}`).send(body(programId))).status).toBe(403);
    }
  });
});

describe.skipIf(skipIntegration)('GET /me/bounties', () => {
  it("lists the partner's own bounties with progress, and nobody else's", async () => {
    const programId = await seedProgram();
    const otherProgram = await seedProgram();
    const p = await seedPartner(programId);
    const other = await seedPartner(programId);
    for (let i = 0; i < 2; i += 1) await convert(p, programId);
    const open = await seedBounty(programId, { threshold: 3 });
    const earned = await seedBounty(programId, { threshold: 1, name: 'First sale' });
    await seedBounty(programId, { partnerIds: [other.id] }); // not for p
    await seedBounty(otherProgram); // not p's program
    await seedBounty(programId, { status: 'draft' });
    await sweep();

    const key = await createApiKeyRow(db, { tenantId: T, partnerId: p.id, label: 'p' });
    const res = await request(app).get('/me/bounties').set('Authorization', `Bearer ${key.plaintext}`);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.bounties.map((b: { id: string }) => [b.id, b]));
    expect([...byId.keys()].sort()).toEqual([open, earned].sort());
    expect(byId.get(open)).toMatchObject({ progress: 2, threshold: 3, reached: false, award: null, programName: 'Holiday program' });
    expect(byId.get(earned)).toMatchObject({ progress: 2, reached: true, award: { status: 'accrued' } });
    expect((byId.get(open) as { summary: string }).summary).toContain('Reach 3 new sales');

    expect((await request(app).get('/me/bounties').set('Authorization', `Bearer ${ADMIN_KEY}`)).status).toBe(403);
  });
});

describe('the goal in words (renderBountySummary)', () => {
  const base = {
    metric: 'conversions' as const,
    threshold: 10,
    scope: 'new' as const,
    startsAt: '2026-11-01T00:00:00Z',
    endsAt: '2026-12-31T00:00:00Z',
    rewardAmount: '500.00',
    currency: 'USD',
  };

  it('reads the structured fields, never free text', async () => {
    const { renderBountySummary } = await import('@openpartner/db');
    expect(renderBountySummary(base)).toBe('Reach 10 new sales between Nov 1, 2026 and Dec 31, 2026 to earn $500.');
    expect(renderBountySummary({ ...base, threshold: 1, eventType: 'demo_booked', endsAt: null })).toBe(
      'Reach 1 new demo booked from Nov 1, 2026 on to earn $500.',
    );
    expect(renderBountySummary({ ...base, metric: 'leads', scope: 'lifetime', threshold: 25 })).toBe(
      'Reach 25 leads by Dec 31, 2026 to earn $500.',
    );
    expect(
      renderBountySummary({ ...base, metric: 'revenue', eventType: 'invoice_paid', threshold: 2500.5, currency: 'EUR', rewardAmount: 250, scope: 'lifetime', endsAt: null }),
    ).toBe('Reach €2,500.50 in invoice revenue to earn €250.');
    expect(renderBountySummary({ ...base, metric: 'commissions', threshold: 1000 })).toContain('$1,000 in new commissions');
  });
});
