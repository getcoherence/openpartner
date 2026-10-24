/**
 * Two-tier (recruiter) commissions (docs/two-tier-commissions.md). These
 * lock in:
 *
 *   - a recruit's commission pays their recruiter the program's share, as a
 *     commission on the same attribution naming its source
 *   - off by default, two levels only, never retroactive, capped by
 *     recruiterCommissionMonths, nothing for a revoked recruiter
 *   - the share is approved with its source (admin or holdback sweep) and
 *     never before it; an admin reversal of the source reverses it, or
 *     claws it back once paid; a refund cuts both by the same share
 *   - the platform fee counts it on the commission side; the conversions
 *     API and a partner's own metrics don't count it as the recruit's
 *   - webhooks name the source and recruit; the recruiter's postback gets
 *     no click or sub-ID
 *   - recruiting: PATCH /partners/:id, POST /partners, the join page's ref,
 *     GET /partners/:id/recruits
 *   - export v11 carries the columns; the self-references are deferred
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';

const ADMIN_KEY = 'op_test_two_tier_0123456789abcdef01234567';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';
process.env.PORTAL_URL = 'http://localhost:5673';

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn(actual.dispatchEvent) };
});
vi.mock('../partner-postback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../partner-postback.js')>();
  return { ...actual, dispatchPartnerPostbacks: vi.fn() };
});

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { dispatchEvent } = await import('../webhook-dispatcher.js');
const { dispatchPartnerPostbacks } = await import('../partner-postback.js');
const { autoApproveMatureCommissions } = await import('../commission-auto-approve.js');
const { conversionSql } = await import('../usage-ledger.js');
const { performanceByPartner } = await import('../performance-metric.js');
const { withTenantTransaction } = await import('../tenancy.js');
const { __setMailerForTests } = await import('../mailer.js');
const { SCHEMA_VERSION } = await import('../export.js');
import type { Mailer, Message } from '../mailer.js';

const T = DEFAULT_TENANT_ID;
const TABLES_TO_CLEAN = [
  TABLES.CommissionAdjustment,
  TABLES.Commission,
  TABLES.Payout,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Coupon,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Program,
  TABLES.ApiKey,
  TABLES.Session,
  TABLES.Partner,
  TABLES.Config,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

class CapturingMailer implements Mailer {
  readonly sent: Message[] = [];
  async send(_ctx: unknown, msg: Message): Promise<void> {
    this.sent.push(msg);
  }
}

async function wipe(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) {
    // Announcements are fire-and-forget; let the last ones land first.
    await new Promise((r) => setTimeout(r, 50));
    await wipe();
  }
  __setMailerForTests(null);
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  await wipe();
  __setMailerForTests(new CapturingMailer());
  vi.mocked(dispatchEvent).mockClear();
  vi.mocked(dispatchPartnerPostbacks).mockClear();
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function partner(opts: { name?: string; recruitedBy?: string; recruitedAt?: Date; revokedAt?: Date } = {}) {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: T,
    name: opts.name ?? `Partner ${id.slice(-4)}`,
    email: `p-${id}@example.com`,
    activatedAt: new Date(),
    revokedAt: opts.revokedAt ?? null,
    ...(opts.recruitedBy ? { recruitedByPartnerId: opts.recruitedBy, recruitedAt: opts.recruitedAt ?? new Date(Date.now() - 2 * HOUR) } : {}),
  });
  return id;
}

async function program(opts: { percent?: number | null; months?: number | null; holdbackDays?: number; rule?: unknown } = {}) {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: T,
    name: `Program ${id.slice(-4)}`,
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify(opts.rule ?? [{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl: 'https://example.com/',
    holdbackDays: opts.holdbackDays ?? null,
    recruiterCommissionPercent: opts.percent === undefined ? '10.00' : opts.percent === null ? null : opts.percent.toFixed(2),
    recruiterCommissionMonths: opts.months ?? null,
  });
  return id;
}

async function grant(partnerId: string, programId: string): Promise<void> {
  await db(TABLES.PartnerProgram).insert({ id: `pc_${ulid()}`, tenantId: T, partnerId, programId, source: 'admin' });
}

/** A click for the partner on the program, an hour ago. */
async function click(partnerId: string, programId: string, subId: string | null = 'pub-sub-1'): Promise<string> {
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Link).insert({ id: linkId, tenantId: T, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: T,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://example.com/',
    ipHash: 'h',
    subId,
    ts: new Date(Date.now() - HOUR),
  });
  return clickId;
}

async function convert(clickId: string, body: { value?: number; externalEventId: string; ts?: string }) {
  const res = await request(app)
    .post('/attribution/conversions')
    .set(admin)
    .send({ clickId, type: 'invoice_paid', currency: 'USD', value: 100, ...body });
  expect(res.status).toBe(200);
  expect(res.body.attribution.status).toBe('attributed');
  return res.body as { eventId: string; attribution: { touches: Array<{ commissionId?: string; partnerId: string }> } };
}

async function commissionsOf(eventId: string) {
  const attributionIds = await db(TABLES.Attribution).where({ eventId }).pluck('id');
  return db(TABLES.Commission).whereIn('attributionId', attributionIds).orderBy('id');
}

/** The recruit's own commission and the recruiter's share on a conversion. */
async function pair(eventId: string, recruitId: string) {
  const all = await commissionsOf(eventId);
  const own = all.filter((c) => c.partnerId === recruitId && !c.sourceCommissionId);
  const shares = all.filter((c) => c.sourceCommissionId);
  return { all, own, shares };
}

/** A recruiter A, a recruit B, a program paying A 10% of B's commissions,
 *  and a click of B's. */
async function setup(opts: Parameters<typeof program>[0] = {}) {
  const recruiterId = await partner({ name: 'Ada Recruiter' });
  const recruitId = await partner({ name: 'Ben Recruit', recruitedBy: recruiterId });
  const programId = await program(opts);
  await grant(recruiterId, programId);
  await grant(recruitId, programId);
  const clickId = await click(recruitId, programId);
  return { recruiterId, recruitId, programId, clickId };
}

async function partnerKey(partnerId: string): Promise<string> {
  const res = await request(app).post(`/partners/${partnerId}/api-keys`).set(admin).send({});
  expect(res.status).toBe(201);
  return res.body.plaintext as string;
}

function dispatched(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.filter((c) => c[1] === event)
    .map((c) => c[2] as Record<string, unknown>);
}

function postbacks(event: string): Array<{ partnerId: string; ctx: Record<string, unknown> }> {
  return vi
    .mocked(dispatchPartnerPostbacks)
    .mock.calls.filter((c) => c[2] === event)
    .map((c) => ({ partnerId: c[1] as string, ctx: c[3] as unknown as Record<string, unknown> }));
}

async function markPaid(partnerId: string, commissionIds: string[]): Promise<void> {
  const payoutId = ulid();
  await db(TABLES.Payout).insert({
    id: payoutId,
    tenantId: T,
    partnerId,
    amount: '0.00',
    currency: 'USD',
    method: 'manual',
    status: 'paid',
    metadata: {},
  });
  await db(TABLES.Commission).whereIn('id', commissionIds).update({ status: 'paid', paidAt: new Date(), payoutId });
}

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('two-tier: accrual', () => {
  it("pays the recruiter the program's share of the recruit's commission, on the same attribution", async () => {
    const { recruiterId, recruitId, programId, clickId } = await setup();
    const res = await convert(clickId, { value: 250, externalEventId: 'order-1' });

    const { all, own, shares } = await pair(res.eventId, recruitId);
    expect(all).toHaveLength(2);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ amount: '50.00', currency: 'USD', status: 'accrued', sourceCommissionId: null });
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      partnerId: recruiterId,
      attributionId: own[0].attributionId,
      sourceCommissionId: own[0].id,
      amount: '5.00',
      currency: 'USD',
      status: 'accrued',
      metadata: { rateType: 'recruiter', recruiter: { percent: 10, recruitedPartnerId: recruitId } },
    });
    // The conversions API reports the recruit's own commission per touch.
    expect(res.attribution.touches).toEqual([expect.objectContaining({ partnerId: recruitId, commissionId: own[0].id })]);

    // The brand hears about both; the share names its source and recruit.
    await vi.waitFor(() => expect(dispatched('commission.accrued')).toHaveLength(2));
    const shareEvent = dispatched('commission.accrued').find((p) => p.partnerId === recruiterId);
    expect(shareEvent).toMatchObject({
      commissionId: shares[0].id,
      amount: '5.00',
      sourceCommissionId: own[0].id,
      recruitedPartnerId: recruitId,
      clickId,
      programId,
      eventId: res.eventId,
    });
    expect(dispatched('commission.accrued').find((p) => p.partnerId === recruitId)).not.toHaveProperty('sourceCommissionId');

    // The recruiter's postback gets nothing of the recruit's sale: their
    // click, sub-ID, event or its value.
    await vi.waitFor(() => expect(postbacks('commission.accrued')).toHaveLength(2));
    const recruiterPostback = postbacks('commission.accrued').find((p) => p.partnerId === recruiterId)!;
    expect(recruiterPostback.ctx).toMatchObject({
      commission_id: shares[0].id,
      commission_amount: '5.00',
      status: 'pending',
      event_type: 'invoice_paid',
      program_id: programId,
    });
    for (const macro of ['click_id', 'sub_id', 'event_id', 'transaction_id', 'sale_amount']) {
      expect(recruiterPostback.ctx[macro]).toBeUndefined();
    }
    const recruitPostback = postbacks('commission.accrued').find((p) => p.partnerId === recruitId)!;
    expect(recruitPostback.ctx).toMatchObject({ click_id: clickId, sub_id: 'pub-sub-1', event_id: res.eventId, sale_amount: '250.00' });
  });

  it('pays nothing in a program without a recruiter share (the default)', async () => {
    const { recruitId, clickId } = await setup({ percent: null });
    const res = await convert(clickId, { externalEventId: 'order-off' });
    const { all, shares } = await pair(res.eventId, recruitId);
    expect(all).toHaveLength(1);
    expect(shares).toHaveLength(0);
  });

  it("stops at two levels: the recruiter's recruiter earns nothing", async () => {
    const top = await partner({ name: 'Top' });
    const middle = await partner({ name: 'Middle', recruitedBy: top });
    const bottom = await partner({ name: 'Bottom', recruitedBy: middle });
    const programId = await program();
    const res = await convert(await click(bottom, programId), { externalEventId: 'order-levels' });

    const { all, shares } = await pair(res.eventId, bottom);
    expect(all).toHaveLength(2);
    expect(shares.map((c) => c.partnerId)).toEqual([middle]);
    expect(all.some((c) => c.partnerId === top)).toBe(false);
  });

  it('never pays on events from before the recruitment, nor past recruiterCommissionMonths', async () => {
    const recruiter = await partner();
    // Recruited ten minutes ago: the hour-old click converts now, so the
    // event is after the recruitment...
    const recent = await partner({ recruitedBy: recruiter, recruitedAt: new Date(Date.now() - 10 * 60 * 1000) });
    const programId = await program({ months: 2 });
    const clickId = await click(recent, programId);
    // ...but a backdated event from before it pays no share.
    const before = await convert(clickId, { externalEventId: 'order-before', ts: new Date(Date.now() - 30 * 60 * 1000).toISOString() });
    expect((await pair(before.eventId, recent)).shares).toHaveLength(0);
    const after = await convert(clickId, { externalEventId: 'order-after' });
    expect((await pair(after.eventId, recent)).shares).toHaveLength(1);

    // Recruited a year ago with a two-month cap: past it.
    const old = await partner({ recruitedBy: recruiter, recruitedAt: new Date(Date.now() - 365 * DAY) });
    const lapsed = await convert(await click(old, programId), { externalEventId: 'order-lapsed' });
    expect((await pair(lapsed.eventId, old)).shares).toHaveLength(0);
  });

  it('pays a revoked recruiter nothing', async () => {
    const recruiter = await partner({ revokedAt: new Date() });
    const recruit = await partner({ recruitedBy: recruiter });
    const res = await convert(await click(recruit, await program()), { externalEventId: 'order-revoked' });
    expect((await pair(res.eventId, recruit)).shares).toHaveLength(0);
  });

  it('pays one share per commission when two sub-rules fire', async () => {
    const { recruiterId, recruitId, clickId } = await setup({
      rule: [
        { trigger: 'every', type: 'percent', value: 20 },
        { trigger: 'every', type: 'fixed', value: 30 },
      ],
    });
    const res = await convert(clickId, { value: 100, externalEventId: 'order-two-rules' });
    const { own, shares } = await pair(res.eventId, recruitId);
    expect(own.map((c) => c.amount).sort()).toEqual(['20.00', '30.00']);
    expect(shares.map((c) => [c.amount, c.partnerId]).sort()).toEqual([
      ['2.00', recruiterId],
      ['3.00', recruiterId],
    ]);
    for (const s of shares) expect(own.map((c) => c.id)).toContain(s.sourceCommissionId);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('two-tier: lifecycle follows the source', () => {
  it('is approved with its source, and not on its own before it', async () => {
    const { recruiterId, recruitId, clickId } = await setup();
    const res = await convert(clickId, { externalEventId: 'order-approve' });
    const { own, shares } = await pair(res.eventId, recruitId);

    const early = await request(app).post(`/commissions/${shares[0].id}/approve`).set(admin);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ error: 'source_not_approved', sourceCommissionId: own[0].id });
    expect((await db(TABLES.Commission).where({ id: shares[0].id }).first()).status).toBe('accrued');

    vi.mocked(dispatchEvent).mockClear();
    const approved = await request(app).post(`/commissions/${own[0].id}/approve`).set(admin);
    expect(approved.status).toBe(200);
    expect(approved.body.recruiterCommissions).toEqual([expect.objectContaining({ id: shares[0].id, status: 'approved' })]);
    expect((await db(TABLES.Commission).where({ id: shares[0].id }).first()).status).toBe('approved');
    await vi.waitFor(() => expect(dispatched('commission.approved')).toHaveLength(2));
    expect(dispatched('commission.approved').find((p) => p.partnerId === recruiterId)).toMatchObject({
      commissionId: shares[0].id,
      sourceCommissionId: own[0].id,
      recruitedPartnerId: recruitId,
    });
  });

  it("lists the share with its recruit, no holdback of its own and the recruit's sale", async () => {
    const { recruiterId, recruitId, clickId } = await setup({ holdbackDays: 30 });
    await convert(clickId, { externalEventId: 'order-list' });
    const res = await request(app).get(`/partners/${recruiterId}/commissions`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body.commissions).toEqual([
      expect.objectContaining({
        partnerId: recruiterId,
        source: 'attribution',
        eventType: 'invoice_paid',
        matureAt: null,
        recruiter: expect.objectContaining({ recruitedPartnerId: recruitId, recruitedPartnerName: 'Ben Recruit', percent: 10 }),
      }),
    ]);
  });

  it('is approved by the holdback sweep in the same pass as its source, never alone', async () => {
    const { recruitId, clickId } = await setup({ holdbackDays: 7 });
    const res = await convert(clickId, { externalEventId: 'order-sweep' });
    const { own, shares } = await pair(res.eventId, recruitId);

    // Only the share is past the holdback: nothing is approved.
    await db(TABLES.Commission).where({ id: shares[0].id }).update({ accruedAt: new Date(Date.now() - 8 * DAY) });
    let swept = await withTenantTransaction(T, (trx) => autoApproveMatureCommissions(trx, T));
    expect(swept.approvedCount).toBe(0);

    // The source matures: both go.
    await db(TABLES.Commission).where({ id: own[0].id }).update({ accruedAt: new Date(Date.now() - 8 * DAY) });
    swept = await withTenantTransaction(T, (trx) => autoApproveMatureCommissions(trx, T));
    expect(swept.approved.map((c) => c.id).sort()).toEqual([own[0].id, shares[0].id].sort());
  });

  it('is reversed with its source by an admin', async () => {
    const { recruitId, clickId } = await setup();
    const res = await convert(clickId, { externalEventId: 'order-reverse' });
    const { own, shares } = await pair(res.eventId, recruitId);

    const reversed = await request(app).post(`/commissions/${own[0].id}/reverse`).set(admin);
    expect(reversed.status).toBe(200);
    expect(reversed.body.recruiterCommissions).toMatchObject({
      reversed: [expect.objectContaining({ id: shares[0].id, status: 'reversed' })],
      clawbacks: [],
      heldInTransfer: [],
    });
    expect((await db(TABLES.Commission).where({ id: shares[0].id }).first()).status).toBe('reversed');
  });

  it("claws back a paid share when an admin reverses the recruit's commission", async () => {
    const { recruiterId, recruitId, clickId } = await setup();
    const res = await convert(clickId, { value: 300, externalEventId: 'order-clawback' });
    const { own, shares } = await pair(res.eventId, recruitId);
    expect((await request(app).post(`/commissions/${own[0].id}/approve`).set(admin)).status).toBe(200);
    await markPaid(recruiterId, [shares[0].id]);

    const reversed = await request(app).post(`/commissions/${own[0].id}/reverse`).set(admin);
    expect(reversed.status).toBe(200);
    expect(reversed.body.recruiterCommissions.clawbacks).toEqual([
      { commissionId: shares[0].id, partnerId: recruiterId, amount: '-6.00', currency: 'USD' },
    ]);
    // Paid stays paid; the clawback nets off the next payout.
    expect((await db(TABLES.Commission).where({ id: shares[0].id }).first()).status).toBe('paid');
    const adj = await db(TABLES.CommissionAdjustment).where({ commissionId: shares[0].id });
    expect(adj).toEqual([
      expect.objectContaining({
        amount: '-6.00',
        reason: 'refund_clawback',
        appliedPayoutId: null,
        metadata: { cause: 'recruit_commission_reversed', sourceCommissionId: own[0].id },
      }),
    ]);
  });

  it('finishes a share a payout was moving when the source is reversed again after it settles', async () => {
    const { recruiterId, recruitId, clickId } = await setup();
    const res = await convert(clickId, { value: 100, externalEventId: 'order-held' });
    const { own, shares } = await pair(res.eventId, recruitId);
    expect((await request(app).post(`/commissions/${own[0].id}/approve`).set(admin)).status).toBe(200);

    // A direct-Connect payout intent has claimed the approved share.
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: T,
      partnerId: recruiterId,
      amount: '2.00',
      currency: 'USD',
      method: 'stripe_connect',
      status: 'pending',
      metadata: { transferState: 'posted' },
    });
    await db(TABLES.Commission).where({ id: shares[0].id }).update({ payoutId });

    const first = await request(app).post(`/commissions/${own[0].id}/reverse`).set(admin);
    expect(first.status).toBe(200);
    expect(first.body.recruiterCommissions).toMatchObject({ reversed: [], clawbacks: [], heldInTransfer: [shares[0].id] });
    expect((await db(TABLES.Commission).where({ id: shares[0].id }).first()).status).toBe('approved');

    // The transfer lands: the share is paid. Reversing the source again
    // records what the recruiter now holds.
    await db(TABLES.Payout).where({ id: payoutId }).update({ status: 'paid', metadata: { transferState: 'confirmed' } });
    await db(TABLES.Commission).where({ id: shares[0].id }).update({ status: 'paid', paidAt: new Date() });
    const again = await request(app).post(`/commissions/${own[0].id}/reverse`).set(admin);
    expect(again.status).toBe(200);
    expect(again.body.recruiterCommissions.clawbacks).toEqual([
      { commissionId: shares[0].id, partnerId: recruiterId, amount: '-2.00', currency: 'USD' },
    ]);

    // Nothing left to finish: it answers as for any reversed commission.
    const third = await request(app).post(`/commissions/${own[0].id}/reverse`).set(admin);
    expect(third.status).toBe(409);
    expect(third.body.error).toBe('not_reversible');
    expect(await db(TABLES.CommissionAdjustment).where({ commissionId: shares[0].id })).toHaveLength(1);
  });

  it('lets fraud review re-derive a sale with its share, and leaves one whose share was reversed alone', async () => {
    const { recruitId, programId, clickId } = await setup();
    const res = await convert(clickId, { value: 100, externalEventId: 'order-fraud' });
    const event = await db(TABLES.Event).where({ id: res.eventId }).first();
    // A newer click of the recruit's, flagged, stitched to the same customer.
    const flagged = await click(recruitId, programId);
    await db(TABLES.Click).where({ id: flagged }).update({ fraudFlag: 'manual', ts: new Date(Date.now() - 30 * 60 * 1000) });
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: T, clickId: flagged, userId: event.userId });

    // Everything still accrued: dropped and re-derived on the newer click,
    // share included.
    const unflagged = await request(app).post(`/clicks/${flagged}/unflag`).set(admin);
    expect(unflagged.status).toBe(200);
    expect(unflagged.body.reattributedEvents).toBe(1);
    const after = await pair(res.eventId, recruitId);
    expect(after.own).toHaveLength(1);
    expect(after.shares).toEqual([expect.objectContaining({ sourceCommissionId: after.own[0].id, amount: '2.00' })]);
    expect((await db(TABLES.Attribution).where({ eventId: res.eventId }).first()).clickId).toBe(flagged);

    // Reverse just the share, then go round again: the event keeps its rows.
    expect((await request(app).post(`/commissions/${after.shares[0].id}/reverse`).set(admin)).status).toBe(200);
    await db(TABLES.Click).where({ id: flagged }).update({ fraudFlag: 'manual' });
    const second = await request(app).post(`/clicks/${flagged}/unflag`).set(admin);
    expect(second.status).toBe(200);
    expect(second.body.reattributedEvents).toBe(0);
    const kept = await pair(res.eventId, recruitId);
    expect(kept.all.map((c) => `${c.id}:${c.status}`).sort()).toEqual(
      [`${after.own[0].id}:accrued`, `${after.shares[0].id}:reversed`].sort(),
    );
  });

  it('is cut by the same share on a partial refund, and its replacement keeps the source', async () => {
    const { recruitId, clickId } = await setup();
    const res = await convert(clickId, { value: 200, externalEventId: 'order-partial' });
    const before = await pair(res.eventId, recruitId);

    const refund = await request(app)
      .post('/attribution/refunds')
      .set(admin)
      .send({ conversionEventId: res.eventId, amount: 50, externalEventId: 'rf-partial' });
    expect(refund.status).toBe(200);

    const live = (await commissionsOf(res.eventId)).filter((c) => c.status !== 'reversed');
    const ownLive = live.find((c) => !c.sourceCommissionId)!;
    const shareLive = live.find((c) => c.sourceCommissionId)!;
    expect(ownLive.amount).toBe('30.00'); // 20% of the 150 kept
    expect(shareLive).toMatchObject({ amount: '3.00', sourceCommissionId: before.own[0].id });
    expect(shareLive.metadata).toMatchObject({ rateType: 'recruiter', refund: { rootCommissionId: before.shares[0].id } });

    // A share replaced by a refund is still approved with its source.
    const approved = await request(app).post(`/commissions/${ownLive.id}/approve`).set(admin);
    expect(approved.body.recruiterCommissions).toEqual([expect.objectContaining({ id: shareLive.id, status: 'approved' })]);

    // A full refund takes both.
    const full = await request(app)
      .post('/attribution/refunds')
      .set(admin)
      .send({ conversionEventId: res.eventId, externalEventId: 'rf-rest' });
    expect(full.status).toBe(200);
    expect((await commissionsOf(res.eventId)).every((c) => c.status === 'reversed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fee and metrics
// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('two-tier: fee meter and metrics', () => {
  it('counts the share on the commission side of the platform fee', async () => {
    const { clickId } = await setup();
    const res = await convert(clickId, { value: 100, externalEventId: 'order-fee' });
    const { sql, bindings } = conversionSql({ tenantId: T, until: new Date(Date.now() + 60_000) });
    const rows = (await db.raw(`select * from (${sql}) v where v."eventId" = ?`, [...bindings, res.eventId])) as {
      rows: Array<{ commissions: string; percent: boolean; revenue: string }>;
    };
    expect(Number(rows.rows[0]!.commissions)).toBe(22); // 20 + the recruiter's 2
    expect(rows.rows[0]!.percent).toBe(true);
    expect(Number(rows.rows[0]!.revenue)).toBe(100);
  });

  it("keeps the share out of the recruit's own commissions metric", async () => {
    const { recruiterId, recruitId, programId, clickId } = await setup();
    await convert(clickId, { value: 100, externalEventId: 'order-metric' });
    const totals = await performanceByPartner(db, {
      tenantId: T,
      programId,
      partnerIds: [recruitId, recruiterId],
      events: 'all',
      measure: 'commissions',
      currency: 'USD',
      window: { start: null, end: null },
    });
    expect(totals.get(recruitId)).toBe(20);
    expect(totals.has(recruiterId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recruiting
// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('two-tier: recruiting', () => {
  it('sets, changes and clears a recruiter with PATCH /partners/:id, refusing bad ones', async () => {
    const a = await partner({ name: 'A' });
    const b = await partner({ name: 'B' });
    const revoked = await partner({ revokedAt: new Date() });

    const set = await request(app).patch(`/partners/${b}`).set(admin).send({ recruitedByPartnerId: a });
    expect(set.status).toBe(200);
    expect(set.body.recruitedByPartnerId).toBe(a);
    expect(Date.parse(set.body.recruitedAt)).toBeGreaterThan(Date.now() - 60_000);

    for (const [body, error] of [
      [{ recruitedByPartnerId: b }, 'recruiter_is_partner'],
      [{ recruitedByPartnerId: revoked }, 'recruiter_revoked'],
      [{ recruitedByPartnerId: 'nobody' }, 'recruiter_not_found'],
    ] as const) {
      const res = await request(app).patch(`/partners/${b}`).set(admin).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(error);
    }
    // A recruited B, so B can't recruit A.
    const cycle = await request(app).patch(`/partners/${a}`).set(admin).send({ recruitedByPartnerId: b });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error).toBe('recruiter_cycle');
    // A refused change writes nothing, portal access included.
    const refusedWithAccess = await request(app).patch(`/partners/${b}`).set(admin).send({ portalAccess: false, recruitedByPartnerId: revoked });
    expect(refusedWithAccess.status).toBe(400);
    expect((await db(TABLES.Partner).where({ id: b }).first()).portalAccess).toBe(true);

    const cleared = await request(app).patch(`/partners/${b}`).set(admin).send({ recruitedByPartnerId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ recruitedByPartnerId: null, recruitedAt: null });
  });

  it('refuses one of two requests making partners recruit each other at once', async () => {
    const a = await partner({ name: 'A' });
    const b = await partner({ name: 'B' });
    const [one, two] = await Promise.all([
      request(app).patch(`/partners/${a}`).set(admin).send({ recruitedByPartnerId: b }),
      request(app).patch(`/partners/${b}`).set(admin).send({ recruitedByPartnerId: a }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 400]);
    expect([one.body.error, two.body.error]).toContain('recruiter_cycle');
    const rows = await db(TABLES.Partner).whereIn('id', [a, b]).select('id', 'recruitedByPartnerId');
    expect(rows.filter((r) => r.recruitedByPartnerId)).toHaveLength(1);
  });

  it('names a recruiter on POST /partners, but not with a partners:create key', async () => {
    const a = await partner();
    const created = await request(app)
      .post('/partners')
      .set(admin)
      .send({ email: `new-${ulid()}@example.com`, name: 'New', sendInvite: false, programIds: [], recruitedByPartnerId: a });
    expect(created.status).toBe(201);
    expect(created.body.recruitedByPartnerId).toBe(a);
    await vi.waitFor(() =>
      expect(dispatched('partner.created')).toContainEqual(expect.objectContaining({ partnerId: created.body.id, recruitedByPartnerId: a })),
    );

    const keyRes = await request(app).post('/api-keys/scoped').set(admin).send({ scopes: ['partners:create'] });
    expect(keyRes.status).toBe(201);
    const scoped = await request(app)
      .post('/partners')
      .set({ Authorization: `Bearer ${keyRes.body.plaintext}` })
      .send({ email: `scoped-${ulid()}@example.com`, name: 'Scoped', sendInvite: false, programIds: [], recruitedByPartnerId: a });
    expect(scoped.status).toBe(403);
    expect(scoped.body).toMatchObject({ error: 'forbidden_scope', required: 'partners:write' });
  });

  it("gives a partner their recruit link, and the join page's ref makes them the applicant's recruiter", async () => {
    const a = await partner({ name: 'Ada' });
    const shared = await program({ percent: 12.5, months: 6 });
    const privateProgram = await program({ percent: 5 });
    const unpaid = await program({ percent: null });
    await grant(a, shared);
    await grant(a, unpaid);
    const key = await partnerKey(a);

    const mine = await request(app).get(`/partners/${a}/recruits`).set({ Authorization: `Bearer ${key}` });
    expect(mine.status).toBe(200);
    expect(mine.body.recruitCode).toMatch(/^[a-z2-9]{10}$/);
    expect(mine.body.recruitUrl).toBe(`http://localhost:5673/join?ref=${mine.body.recruitCode}`);
    expect(mine.body.signupOpen).toBe(true);
    // Only programs they're granted that pay a share; the private one stays private.
    expect(mine.body.programs).toEqual([
      { id: shared, name: expect.any(String), recruiterCommissionPercent: 12.5, recruiterCommissionMonths: 6 },
    ]);
    expect(mine.body.programs.map((p: { id: string }) => p.id)).not.toContain(privateProgram);
    // Minted once.
    const again = await request(app).get(`/partners/${a}/recruits`).set(admin);
    expect(again.body.recruitCode).toBe(mine.body.recruitCode);
    expect(again.body.programs).toHaveLength(2); // an admin sees every program that pays

    // Another partner can't read it.
    const other = await partner();
    const denied = await request(app).get(`/partners/${a}/recruits`).set({ Authorization: `Bearer ${await partnerKey(other)}` });
    expect(denied.status).toBe(403);

    // The join page names the recruiter, and the signup records them.
    const status = await request(app).get(`/partner-signup/status?ref=${mine.body.recruitCode}`);
    expect(status.body.recruiter).toEqual({ name: 'Ada' });
    const email = `joiner-${ulid()}@example.com`.toLowerCase();
    const joined = await request(app)
      .post('/partner-signup')
      .send({ email, name: 'Joiner', application: APPLICATION, ref: mine.body.recruitCode.toUpperCase() });
    expect(joined.status).toBe(201);
    const recruit = await db(TABLES.Partner).where({ tenantId: T, email }).first();
    expect(recruit).toMatchObject({ recruitedByPartnerId: a });
    expect(recruit.recruitedAt).toBeInstanceOf(Date);

    const listed = await request(app).get(`/partners/${a}/recruits`).set({ Authorization: `Bearer ${key}` });
    expect(listed.body).toMatchObject({
      total: 1,
      recruits: [{ id: recruit.id, name: 'Joiner', status: 'active', earned: {} }],
    });
  });

  it('ignores an unknown or revoked ref instead of failing the signup', async () => {
    const status = await request(app).get('/partner-signup/status?ref=nosuchcode');
    expect(status.body.recruiter).toBeNull();
    const email = `stale-${ulid()}@example.com`.toLowerCase();
    const joined = await request(app).post('/partner-signup').send({ email, name: 'Stale', application: APPLICATION, ref: 'nosuchcode' });
    expect(joined.status).toBe(201);
    expect((await db(TABLES.Partner).where({ tenantId: T, email }).first()).recruitedByPartnerId).toBeNull();
  });

  it("shows what each recruit has earned the recruiter, net of clawbacks", async () => {
    const { recruiterId, recruitId, clickId } = await setup();
    await convert(clickId, { value: 100, externalEventId: 'order-earned-1' });
    await convert(clickId, { value: 300, externalEventId: 'order-earned-2' });
    const res = await request(app).get(`/partners/${recruiterId}/recruits`).set(admin);
    expect(res.body.recruits).toEqual([expect.objectContaining({ id: recruitId, name: 'Ben Recruit', earned: { USD: '8.00' } })]);
    const recruitView = await request(app).get(`/partners/${recruitId}/recruits`).set(admin);
    expect(recruitView.body.recruitedBy).toMatchObject({ id: recruiterId, name: 'Ada Recruiter' });
  });

  it('reads no link and mints no code while no program pays a share', async () => {
    const a = await partner();
    const p = await program({ percent: null });
    await grant(a, p);
    const res = await request(app).get(`/partners/${a}/recruits`).set(admin);
    expect(res.body).toMatchObject({ recruitCode: null, recruitUrl: null, programs: [] });
    expect((await db(TABLES.Partner).where({ id: a }).first()).recruitCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Programs, export, constraints
// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('two-tier: program settings, export and constraints', () => {
  it('sets and clears the share on a program, refusing out-of-range values', async () => {
    const id = await program({ percent: null });
    const set = await request(app).patch(`/programs/${id}`).set(admin).send({ recruiterCommissionPercent: 7.5, recruiterCommissionMonths: 12 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ recruiterCommissionPercent: '7.50', recruiterCommissionMonths: 12 });
    for (const bad of [{ recruiterCommissionPercent: 0 }, { recruiterCommissionPercent: 51 }, { recruiterCommissionPercent: 1.234 }, { recruiterCommissionMonths: 0 }]) {
      expect((await request(app).patch(`/programs/${id}`).set(admin).send(bad)).status).toBe(400);
    }
    const cleared = await request(app).patch(`/programs/${id}`).set(admin).send({ recruiterCommissionPercent: null, recruiterCommissionMonths: null });
    expect(cleared.body).toMatchObject({ recruiterCommissionPercent: null, recruiterCommissionMonths: null });
  });

  it('exports the new columns (added at schemaVersion 11)', async () => {
    const { recruiterId, recruitId, clickId } = await setup();
    await convert(clickId, { externalEventId: 'order-export' });
    const res = await request(app).get('/export.json').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(SCHEMA_VERSION);
    // Later versions keep the columns.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
    const partners = res.body.tables.Partner as Array<Record<string, unknown>>;
    expect(partners.find((p) => p.id === recruitId)).toMatchObject({ recruitedByPartnerId: recruiterId });
    const programs = res.body.tables.Program as Array<Record<string, unknown>>;
    expect(programs[0]).toHaveProperty('recruiterCommissionPercent', '10.00');
    const commissions = res.body.tables.Commission as Array<Record<string, unknown>>;
    expect(commissions.filter((c) => c.sourceCommissionId)).toHaveLength(1);
  });

  it('checks the self-references at commit, so a restore can write a recruit before their recruiter', async () => {
    const recruiter = ulid();
    const recruit = ulid();
    await db.transaction(async (trx) => {
      await trx(TABLES.Partner).insert({
        id: recruit,
        tenantId: T,
        name: 'Recruit',
        email: `r-${recruit}@example.com`,
        recruitedByPartnerId: recruiter,
        recruitedAt: new Date(),
      });
      await trx(TABLES.Partner).insert({ id: recruiter, tenantId: T, name: 'Recruiter', email: `r-${recruiter}@example.com` });
    });
    expect((await db(TABLES.Partner).where({ id: recruit }).first()).recruitedByPartnerId).toBe(recruiter);

    // A dangling recruiter still fails, at commit.
    await expect(
      db.transaction(async (trx) => {
        await trx(TABLES.Partner).insert({
          id: ulid(),
          tenantId: T,
          name: 'Orphan',
          email: `orphan-${ulid()}@example.com`,
          recruitedByPartnerId: 'missing',
          recruitedAt: new Date(),
        });
      }),
    ).rejects.toThrow(/Partner_recruitedByPartnerId_foreign/);

    // A purge deletes a recruiter and their recruit in one statement: fine.
    // Deleting the recruiter alone is refused at commit.
    await expect(db.transaction((trx) => trx(TABLES.Partner).where({ id: recruiter }).del())).rejects.toThrow(
      /Partner_recruitedByPartnerId_foreign/,
    );
    await db(TABLES.Partner).whereIn('id', [recruiter, recruit]).del();
    expect(await db(TABLES.Partner).whereIn('id', [recruiter, recruit])).toHaveLength(0);
  });
});

const APPLICATION = {
  websiteUrl: 'https://creator.example',
  socialUrls: ['https://instagram.com/creator'],
  audienceSize: '1k_10k',
  pitch: 'I run a weekly newsletter for designers and would feature the product in a deep-dive issue.',
};
