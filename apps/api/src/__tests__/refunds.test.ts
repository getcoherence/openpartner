/**
 * Refunds and chargebacks reported over the API (POST /attribution/refunds),
 * and the shared implementation behind it and the Stripe webhook
 * (refunds.ts). These lock in:
 *
 *   - the refund is a raw corrective Event that is never attributed, by the
 *     route or by a later backlog replay, and never billable GMV
 *   - full refund: accrued + approved commissions are reversed, announced
 *     as commission.reversed (reason refund / chargeback) with the partner
 *     postback
 *   - partial refund: each commission is reversed and replaced by one for
 *     the kept share, same status and accrual time; refunds add up
 *   - paid commission: stays paid; a negative refund_clawback adjustment
 *     records what the partner holds
 *   - in a payout right now: left alone, and a retry finishes it later
 *   - idempotent on externalEventId, including concurrent duplicates
 *   - events:write keys are enough
 *   - the manual payout rail can't turn a commission reversed under it back
 *     into 'paid'
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';

const ADMIN_KEY = 'op_test_refunds_0123456789abcdef0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

// Real dispatch, observed; partner postbacks captured instead of fired.
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
const { aggregateAttributedGmv } = await import('../usage-billing.js');
const { runPayouts } = await import('../payouts.js');
const { withTenantTransaction } = await import('../tenancy.js');

const TABLES_TO_CLEAN = [
  TABLES.CommissionAdjustment,
  TABLES.Commission,
  TABLES.Payout,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.ApiKey,
  TABLES.Partner,
  TABLES.Config,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) {
    // Announcements are fire-and-forget; let the last ones land first.
    await new Promise((r) => setTimeout(r, 50));
    for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
  vi.mocked(dispatchEvent).mockClear();
  vi.mocked(dispatchPartnerPostbacks).mockClear();
});

describe.skipIf(skipIntegration)('POST /attribution/refunds — full refunds', () => {
  it('reverses accrued and approved commissions and announces each, with the partner postback', async () => {
    // Two sub-rules: two commissions on the one attribution.
    const { clickId, partnerId } = await seed([
      { trigger: 'every', type: 'percent', value: 10 },
      { trigger: 'every', type: 'fixed', value: 5 },
    ]);
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-1' });
    const [percent, fixed] = await commissionsOf(eventId);
    expect([percent!.amount, fixed!.amount]).toEqual(['10.00', '5.00']);
    await db(TABLES.Commission).where({ id: fixed!.id }).update({ status: 'approved' });
    vi.mocked(dispatchEvent).mockClear();

    const res = await refund({ conversionExternalEventId: 'order-1', reason: 'customer request', externalEventId: 'rf-1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      conversionEventId: eventId,
      kind: 'refund',
      amount: '100.00',
      refundedAmount: '100.00',
      conversionValue: '100.00',
      currency: 'USD',
      fullRefund: true,
      actionRequired: false,
    });
    expect(res.body.replayed).toBeUndefined();
    expect(res.body.commissions.map((c: Record<string, unknown>) => [c.commissionId, c.status, c.keptAmount, c.currentCommissionId])).toEqual([
      [percent!.id, 'reversed', '0.00', null],
      [fixed!.id, 'reversed', '0.00', null],
    ]);
    expect((await commissionsOf(eventId)).map((c) => c.status)).toEqual(['reversed', 'reversed']);

    // The raw corrective event: negative, linked to its conversion, never attributed.
    const refundEvent = await db(TABLES.Event).where({ id: res.body.refundEventId }).first();
    expect(refundEvent).toMatchObject({
      type: 'refund',
      value: '-100.00',
      currency: 'USD',
      externalEventId: 'rf-1',
      metadata: { conversionEventId: eventId, conversionExternalEventId: 'order-1', reason: 'customer request', requestedAmount: null },
    });
    expect(await db(TABLES.Attribution).where({ eventId: refundEvent!.id })).toHaveLength(0);

    await vi.waitFor(() => expect(dispatched('commission.reversed')).toHaveLength(2));
    for (const c of [percent!, fixed!]) {
      expect(dispatched('commission.reversed')).toContainEqual(
        expect.objectContaining({
          commissionId: c.id,
          partnerId,
          clickId,
          eventId,
          eventType: 'invoice_paid',
          reason: 'refund',
          refundEventId: refundEvent!.id,
        }),
      );
    }
    expect(dispatched('commission.reversed')[0]).not.toHaveProperty('replacementCommissionId');
    // Each reversal reaches the partner's postback, with the click it traces to.
    await vi.waitFor(() =>
      expect(postbacks('commission.reversed').map((p) => p.commission_id).sort()).toEqual([percent!.id, fixed!.id].sort()),
    );
    expect(postbacks('commission.reversed')[0]).toMatchObject({ click_id: clickId, partner_id: partnerId, event_id: eventId });
  });

  it('records a chargeback as its own corrective type and reverses with reason chargeback', async () => {
    const { clickId } = await seed();
    const eventId = await convert(clickId, { value: 50, externalEventId: 'order-cb' });
    vi.mocked(dispatchEvent).mockClear();

    const res = await refund({ conversionEventId: eventId, kind: 'chargeback', externalEventId: 'cb-1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'chargeback', fullRefund: true });
    expect(await db(TABLES.Event).where({ id: res.body.refundEventId }).first()).toMatchObject({ type: 'chargeback', value: '-50.00' });
    await vi.waitFor(() => expect(dispatched('commission.reversed')).toEqual([expect.objectContaining({ reason: 'chargeback' })]));
  });

  it('records a refund of a conversion no partner was credited for, with no commissions', async () => {
    const posted = await request(app)
      .post('/attribution/events')
      .set(admin)
      .send({ userId: 'nobody', type: 'invoice_paid', value: 30, externalEventId: 'order-unreferred' });
    expect(posted.body.attribution.status).toBe('no_identity');

    const res = await refund({ conversionExternalEventId: 'order-unreferred', externalEventId: 'rf-unreferred' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fullRefund: true, commissions: [], actionRequired: false });
    expect(await db(TABLES.Event).where({ type: 'refund' })).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('POST /attribution/refunds — partial refunds', () => {
  it('replaces each commission with one for the kept share, and the refunds add up', async () => {
    const { clickId } = await seed([
      { trigger: 'every', type: 'percent', value: 20 },
      { trigger: 'every', type: 'fixed', value: 5 },
    ]);
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-2' });
    const [percent] = await commissionsOf(eventId);
    await db(TABLES.Commission).where({ id: percent!.id }).update({ status: 'approved' });
    vi.mocked(dispatchEvent).mockClear();

    // 30 of 100: each commission keeps 70%, the fixed bounty included.
    const first = await refund({ conversionExternalEventId: 'order-2', amount: 30, externalEventId: 'rf-2a' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ amount: '30.00', refundedAmount: '30.00', fullRefund: false, actionRequired: false });
    const [p1, f1] = first.body.commissions as Array<Record<string, string>>;
    expect([p1!.status, p1!.originalAmount, p1!.keptAmount, p1!.currentStatus]).toEqual(['reduced', '20.00', '14.00', 'approved']);
    expect([f1!.status, f1!.originalAmount, f1!.keptAmount, f1!.currentStatus]).toEqual(['reduced', '5.00', '3.50', 'accrued']);

    const rows = await commissionsOf(eventId);
    expect(rows.map((c) => [c.status, c.amount])).toEqual([
      ['reversed', '20.00'],
      ['reversed', '5.00'],
      ['approved', '14.00'],
      ['accrued', '3.50'],
    ]);
    const replacement = rows.find((c) => c.id === p1!.currentCommissionId)!;
    // The holdback clock doesn't restart, and the row says where it came from.
    expect(new Date(replacement.accruedAt).getTime()).toBe(new Date(percent!.accruedAt).getTime());
    expect((replacement.metadata as { refund?: unknown }).refund).toEqual({
      rootCommissionId: percent!.id,
      replacesCommissionId: percent!.id,
      refundEventId: first.body.refundEventId,
    });

    // reversed → accrued (+ approved for the approved one), each naming the other.
    await vi.waitFor(() => expect(dispatched('commission.approved')).toHaveLength(1));
    expect(dispatched('commission.reversed')).toContainEqual(
      expect.objectContaining({ commissionId: percent!.id, reason: 'refund', replacementCommissionId: replacement.id }),
    );
    expect(dispatched('commission.accrued')).toContainEqual(
      expect.objectContaining({ commissionId: replacement.id, amount: '14.00', eventId, clickId, replacesCommissionId: percent!.id }),
    );
    expect(dispatched('commission.approved')[0]).toMatchObject({ commissionId: replacement.id, eventId, clickId });
    const order = vi.mocked(dispatchEvent).mock.calls.map((c) => `${c[1]}:${(c[2] as { commissionId: string }).commissionId}`);
    expect(order.indexOf(`commission.reversed:${percent!.id}`)).toBeLessThan(order.indexOf(`commission.accrued:${replacement.id}`));

    // 20 more: 50 refunded in all keeps 50% of the ORIGINAL amounts.
    const second = await refund({ conversionEventId: eventId, amount: 20, externalEventId: 'rf-2b' });
    expect(second.body.refundedAmount).toBe('50.00');
    expect(second.body.commissions.map((c: Record<string, string>) => c.keptAmount)).toEqual(['10.00', '2.50']);
    expect(await liveAmounts(eventId)).toEqual(['10.00', '2.50']);

    // More than is left is refused; the rest (no amount) is a full refund.
    const tooMuch = await refund({ conversionEventId: eventId, amount: 50.01, externalEventId: 'rf-2c' });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body).toMatchObject({ error: 'refund_exceeds_remaining', remaining: '50.00' });
    const rest = await refund({ conversionEventId: eventId, externalEventId: 'rf-2d' });
    expect(rest.body).toMatchObject({ amount: '50.00', refundedAmount: '100.00', fullRefund: true });
    expect(await liveAmounts(eventId)).toEqual([]);
    const nothing = await refund({ conversionEventId: eventId, externalEventId: 'rf-2e' });
    expect(nothing.status).toBe(422);
    expect(nothing.body.error).toBe('nothing_to_refund');
    expect(await db(TABLES.Event).whereIn('type', ['refund', 'chargeback'])).toHaveLength(3);
  });

  it('refunds a conversion with no value only in full', async () => {
    const { clickId } = await seed({ type: 'fixed', value: 25 });
    const eventId = await convert(clickId, { type: 'signup', externalEventId: 'signup-1' });
    expect((await commissionsOf(eventId)).map((c) => c.amount)).toEqual(['25.00']);

    const partial = await refund({ conversionEventId: eventId, amount: 5, externalEventId: 'rf-3a' });
    expect(partial.status).toBe(422);
    expect(partial.body.error).toBe('partial_refund_needs_value');

    const full = await refund({ conversionEventId: eventId, externalEventId: 'rf-3b' });
    expect(full.body).toMatchObject({ amount: null, refundedAmount: null, conversionValue: null, fullRefund: true });
    expect(await db(TABLES.Event).where({ id: full.body.refundEventId }).first('value')).toEqual({ value: null });
    expect(await liveAmounts(eventId)).toEqual([]);
    expect((await refund({ conversionEventId: eventId, externalEventId: 'rf-3c' })).body.error).toBe('nothing_to_refund');
  });
});

describe.skipIf(skipIntegration)('POST /attribution/refunds — already-paid commissions', () => {
  it('leaves the commission paid and records a negative refund_clawback adjustment for what the partner holds', async () => {
    const { clickId, partnerId } = await seed();
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-4' });
    const [commission] = await commissionsOf(eventId);
    const payoutId = await markPaid(partnerId, [commission!.id]);
    vi.mocked(dispatchEvent).mockClear();

    const part = { conversionExternalEventId: 'order-4', amount: 25, externalEventId: 'rf-4a' };
    const res = await refund(part);
    expect(res.status).toBe(200);
    expect(res.body.actionRequired).toBe(true);
    expect(res.body.commissions).toEqual([
      {
        commissionId: commission!.id,
        partnerId,
        currency: 'USD',
        originalAmount: '20.00',
        keptAmount: '15.00',
        status: 'clawback_recorded',
        currentCommissionId: commission!.id,
        currentStatus: 'paid',
        clawbackAmount: '-5.00',
      },
    ]);
    const stored = await db(TABLES.Commission).where({ id: commission!.id }).first();
    expect(stored).toMatchObject({ status: 'paid', amount: '20.00', payoutId });
    expect(await adjustments()).toEqual([[commission!.id, '-5.00', 'refund_clawback', res.body.refundEventId]]);

    // A retry records nothing more.
    const replay = await refund(part);
    expect(replay.body).toMatchObject({ replayed: true, refundEventId: res.body.refundEventId });
    expect(replay.body.commissions[0].clawbackAmount).toBe('-5.00');
    expect(await adjustments()).toHaveLength(1);

    // The rest of it: the clawback grows to the whole commission.
    const rest = await refund({ conversionEventId: eventId, externalEventId: 'rf-4b' });
    expect(rest.body.commissions[0]).toMatchObject({ status: 'clawback_recorded', keptAmount: '0.00', clawbackAmount: '-20.00' });
    expect((await adjustments()).map((a) => a[1])).toEqual(['-5.00', '-15.00']);
    expect((await db(TABLES.Commission).where({ id: commission!.id }).first())!.status).toBe('paid');

    // Paid commissions aren't reversed, so nothing announces a reversal.
    await new Promise((r) => setTimeout(r, 30));
    expect(dispatched('commission.reversed')).toHaveLength(0);
  });

  it('claws back nothing the partner already returned (a reversed transfer)', async () => {
    const { clickId, partnerId } = await seed();
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-5' });
    const [commission] = await commissionsOf(eventId);
    await markPaid(partnerId, [commission!.id]);
    await db(TABLES.CommissionAdjustment).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      commissionId: commission!.id,
      amount: '-20.00',
      currency: 'USD',
      reason: 'transfer_reversed',
      metadata: {},
    });

    const res = await refund({ conversionEventId: eventId, externalEventId: 'rf-5' });
    expect(res.body.commissions[0]).toMatchObject({ status: 'unchanged', keptAmount: '0.00', clawbackAmount: null });
    expect(res.body.actionRequired).toBe(false);
    expect(await db(TABLES.CommissionAdjustment).where({ reason: 'refund_clawback' })).toHaveLength(0);
  });

  it('a replacement paid after a partial refund carries the next clawback', async () => {
    const { clickId, partnerId } = await seed();
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-6' });
    const first = await refund({ conversionEventId: eventId, amount: 30, externalEventId: 'rf-6a' });
    const replacementId = first.body.commissions[0].currentCommissionId as string;
    await db(TABLES.Commission).where({ id: replacementId }).update({ status: 'approved' });
    await markPaid(partnerId, [replacementId]);

    const rest = await refund({ conversionEventId: eventId, externalEventId: 'rf-6b' });
    expect(rest.body.commissions[0]).toMatchObject({
      currentCommissionId: replacementId,
      status: 'clawback_recorded',
      clawbackAmount: '-14.00',
    });
    const [adjustment] = await db(TABLES.CommissionAdjustment);
    expect(adjustment).toMatchObject({ commissionId: replacementId, amount: '-14.00' });
    expect((adjustment!.metadata as { rootCommissionId?: string }).rootCommissionId).toBe(first.body.commissions[0].commissionId);
  });
});

describe.skipIf(skipIntegration)('POST /attribution/refunds — commissions in a payout right now', () => {
  it('leaves a commission an open payout intent claimed, and a retry of the same refund finishes it', async () => {
    const { clickId, partnerId } = await seed();
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-7' });
    const [commission] = await commissionsOf(eventId);
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      amount: '20.00',
      currency: 'USD',
      method: 'stripe_connect',
      status: 'pending',
      metadata: { transferState: 'posted', amountMinor: 2000 },
    });
    await db(TABLES.Commission).where({ id: commission!.id }).update({ status: 'approved', payoutId });

    const body = { conversionEventId: eventId, externalEventId: 'rf-7' };
    const held = await refund(body);
    expect(held.status).toBe(200);
    expect(held.body.actionRequired).toBe(true);
    expect(held.body.commissions[0]).toMatchObject({ status: 'held_in_transfer', keptAmount: '20.00', currentStatus: 'approved' });
    expect((await db(TABLES.Commission).where({ id: commission!.id }).first())!.status).toBe('approved');

    // The intent is abandoned and its claim released; the same refund, retried, completes.
    await db(TABLES.Payout).where({ id: payoutId }).update({ metadata: { transferState: 'canceled', amountMinor: 2000 } });
    await db(TABLES.Commission).where({ id: commission!.id }).update({ payoutId: null });
    const retried = await refund(body);
    expect(retried.body).toMatchObject({ replayed: true, refundEventId: held.body.refundEventId, actionRequired: false });
    expect(retried.body.commissions[0]).toMatchObject({ status: 'reversed', keptAmount: '0.00' });
    expect((await db(TABLES.Commission).where({ id: commission!.id }).first())!.status).toBe('reversed');
  });
});

describe.skipIf(skipIntegration)('POST /attribution/refunds — idempotency', () => {
  it('a retry with the same externalEventId replays: nothing new recorded, reversed and announced once', async () => {
    const { clickId } = await seed();
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-8' });
    vi.mocked(dispatchEvent).mockClear();

    const body = { conversionExternalEventId: 'order-8', amount: 40, externalEventId: 'rf-8' };
    const first = await refund(body);
    await vi.waitFor(() => expect(dispatched('commission.accrued')).toHaveLength(1));
    const replay = await refund(body);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const { replayed: _replayed, ...rest } = replay.body;
    expect(rest).toEqual(first.body);

    await new Promise((r) => setTimeout(r, 30));
    expect(dispatched('commission.reversed')).toHaveLength(1);
    expect(dispatched('commission.accrued')).toHaveLength(1);
    expect(await db(TABLES.Event).where({ type: 'refund' })).toHaveLength(1);
    expect(await liveAmounts(eventId)).toEqual(['12.00']);
  });

  it('a key reused for a different amount, kind or conversion — or a conversion\'s own key — is a 409', async () => {
    const { clickId } = await seed();
    await convert(clickId, { value: 100, externalEventId: 'order-9' });
    await convert(clickId, { value: 100, externalEventId: 'order-10' });
    const body = { conversionExternalEventId: 'order-9', amount: 10, externalEventId: 'rf-9' };
    expect((await refund(body)).status).toBe(200);

    for (const reused of [
      { ...body, amount: 11 },
      { ...body, amount: undefined },
      { ...body, kind: 'chargeback' },
      { ...body, conversionExternalEventId: 'order-10' },
      { ...body, externalEventId: 'order-10' },
    ]) {
      const res = await refund(reused);
      expect(res.status, JSON.stringify(reused)).toBe(409);
      expect(res.body.error).toBe('external_event_id_conflict');
    }
    expect(await db(TABLES.Event).where({ type: 'refund' })).toHaveLength(1);
  });

  it('concurrent duplicates record one refund and reverse once', async () => {
    const { clickId } = await seed();
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-11' });
    vi.mocked(dispatchEvent).mockClear();

    const body = { conversionEventId: eventId, externalEventId: 'rf-11' };
    const results = await Promise.all(Array.from({ length: 6 }, () => refund(body)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.refundEventId)).size).toBe(1);

    expect(await db(TABLES.Event).where({ type: 'refund' })).toHaveLength(1);
    expect((await commissionsOf(eventId)).map((c) => c.status)).toEqual(['reversed']);
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatched('commission.reversed')).toHaveLength(1);
  });

  it('concurrent partial refunds of one conversion serialise and add up', async () => {
    const { clickId } = await seed();
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-12' });

    const results = await Promise.all([
      refund({ conversionEventId: eventId, amount: 30, externalEventId: 'rf-12a' }),
      refund({ conversionEventId: eventId, amount: 20, externalEventId: 'rf-12b' }),
      refund({ conversionEventId: eventId, amount: 10, externalEventId: 'rf-12c' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    // 60 of 100 refunded: one live commission at 40% of 20.00.
    expect(await liveAmounts(eventId)).toEqual(['8.00']);
    expect((await commissionsOf(eventId)).filter((c) => c.status === 'reversed')).toHaveLength(3);
  });
});

describe.skipIf(skipIntegration)('POST /attribution/refunds — validation and access', () => {
  it('rejects what it cannot apply, before recording anything', async () => {
    const { clickId } = await seed();
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-13' });
    const refunded = await refund({ conversionEventId: eventId, amount: 1, externalEventId: 'rf-13' });

    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ conversionExternalEventId: 'nope', externalEventId: 'x1' }, 404, 'conversion_not_found'],
      [{ conversionEventId: refunded.body.refundEventId, externalEventId: 'x2' }, 422, 'not_a_conversion'],
      [{ conversionEventId: eventId, currency: 'EUR', externalEventId: 'x3' }, 422, 'currency_mismatch'],
      [{ conversionEventId: eventId, conversionExternalEventId: 'order-13', externalEventId: 'x4' }, 400, 'invalid_body'],
      [{ externalEventId: 'x5' }, 400, 'invalid_body'],
      [{ conversionEventId: eventId }, 400, 'invalid_body'],
      [{ conversionEventId: eventId, amount: 0, externalEventId: 'x6' }, 400, 'invalid_body'],
      [{ conversionEventId: eventId, amount: 0.001, externalEventId: 'x7' }, 400, 'invalid_body'],
      [{ conversionEventId: eventId, kind: 'dispute', externalEventId: 'x8' }, 400, 'invalid_body'],
    ];
    for (const [body, status, error] of cases) {
      const res = await refund(body);
      expect([res.status, res.body.error], JSON.stringify(body)).toEqual([status, error]);
    }
    expect(await db(TABLES.Event).whereIn('type', ['refund', 'chargeback'])).toHaveLength(1);
    // The currency check is case-insensitive.
    expect((await refund({ conversionEventId: eventId, amount: 1, currency: 'usd', externalEventId: 'x9' })).status).toBe(200);
  });

  it('accepts an events:write scoped key; refuses a key without it and a partner key', async () => {
    const { clickId, partnerId } = await seed();
    await convert(clickId, { value: 100, externalEventId: 'order-14' });
    const body = { conversionExternalEventId: 'order-14', amount: 1 };

    const scoped = await mintScopedKey(['events:write']);
    expect((await refund({ ...body, externalEventId: 'rf-14a' }, { Authorization: `Bearer ${scoped}` })).status).toBe(200);
    const wrongScope = await mintScopedKey(['partners:read']);
    expect((await refund({ ...body, externalEventId: 'rf-14b' }, { Authorization: `Bearer ${wrongScope}` })).status).toBe(403);
    const partnerKey = await request(app).post(`/partners/${partnerId}/api-keys`).set(admin).send({});
    expect((await refund({ ...body, externalEventId: 'rf-14c' }, { Authorization: `Bearer ${partnerKey.body.plaintext}` })).status).toBe(403);
    expect((await refund({ ...body, externalEventId: 'rf-14d' }, {})).status).toBe(401);
  });
});

describe.skipIf(skipIntegration)('corrective events are never attributed or billed', () => {
  it('an event refunded before its user was stitched attributes later with the refund already applied', async () => {
    const { clickId } = await seed();
    // Recorded with no identity yet, then refunded in part.
    await request(app)
      .post('/attribution/events')
      .set(admin)
      .send({ userId: 'late-user', type: 'invoice_paid', value: 100, externalEventId: 'order-15' });
    const partial = await refund({ conversionExternalEventId: 'order-15', amount: 40, externalEventId: 'rf-15' });
    expect(partial.body.commissions).toEqual([]);

    // The stitch replays the backlog: the conversion attributes, the refund doesn't.
    const stitched = await request(app).post('/attribution/identify').send({ cref: clickId, userId: 'late-user' });
    expect(stitched.body.backfilledAttributions).toBe(1);
    const conversion = await db(TABLES.Event).where({ externalEventId: 'order-15' }).first();
    expect(await db(TABLES.Attribution).where({ eventId: partial.body.refundEventId })).toHaveLength(0);
    // 20% of 100 accrued, then cut to the 60% the customer kept.
    expect(await liveAmounts(conversion!.id)).toEqual(['12.00']);
  });

  it('refund and chargeback events never count as billable GMV, even when configured as revenue types', async () => {
    const since = new Date(Date.now() - 1000);
    const { clickId } = await seed();
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-16' });
    await refund({ conversionEventId: eventId, amount: 30, externalEventId: 'rf-16a' });
    await refund({ conversionEventId: eventId, kind: 'chargeback', externalEventId: 'rf-16b' });
    // A refund sent to /attribution/events is recorded too, and still not revenue.
    const asEvent = await request(app)
      .post('/attribution/events')
      .set(admin)
      .send({ userId: (await db(TABLES.Event).where({ id: eventId }).first())!.userId, type: 'refund', value: 5, externalEventId: 'ev-refund' });
    expect(asEvent.body.attribution.status).toBe('corrective');

    // The refund events themselves add nothing (their negative values never
    // enter the sum), even when the program declares them as revenue types.
    // (Revenue types are per program since the commission-floor fee rule,
    // so the declaration goes on the Program, not an argument.)
    const until = new Date(Date.now() + 1000);
    const gmv = await aggregateAttributedGmv(db, DEFAULT_TENANT_ID, since, until);
    expect(gmv.USD ?? 0).toBeLessThanOrEqual(100);
    expect(Object.values(gmv).every((v) => v >= 0)).toBe(true);
    await db(TABLES.Program)
      .where({ tenantId: DEFAULT_TENANT_ID })
      .update({ revenueEventTypes: db.raw('?::text[]', [['invoice_paid', 'refund', 'chargeback']]) });
    expect(await aggregateAttributedGmv(db, DEFAULT_TENANT_ID, since, until)).toEqual(gmv);
  });
});

describe.skipIf(skipIntegration)('manual payout vs a concurrent reversal', () => {
  it("can't turn a commission reversed under it back into paid — the run aborts", async () => {
    const { clickId } = await seed();
    const eventId = await convert(clickId, { value: 100, externalEventId: 'order-17' });
    const [commission] = await commissionsOf(eventId);
    await db(TABLES.Commission).where({ id: commission!.id }).update({ status: 'approved' });

    // A reversal holds the row, uncommitted, while the planner reads it as
    // approved and blocks on its UPDATE.
    const reversal = await db.transaction();
    await reversal(TABLES.Commission).where({ id: commission!.id }).update({ status: 'reversed' });
    const run = withTenantTransaction(DEFAULT_TENANT_ID, (trx) => runPayouts(trx, DEFAULT_TENANT_ID));
    run.catch(() => {});
    await vi.waitFor(
      async () => {
        const waiting = await db.raw(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        );
        expect(waiting.rows[0].n).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 25 },
    );
    await reversal.commit();

    await expect(run).rejects.toThrow(/reversed or claimed concurrently/);
    expect((await db(TABLES.Commission).where({ id: commission!.id }).first())!).toMatchObject({ status: 'reversed', payoutId: null });
    expect(await db(TABLES.Payout)).toHaveLength(0);
  });
});

// -------- helpers --------

async function seed(commissionRule: unknown = { type: 'percent', value: 20 }) {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, name: 'Partner', email: `p-${partnerId}@example.com` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Refunds',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify(commissionRule),
    destinationUrl: 'https://example.com/',
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId: DEFAULT_TENANT_ID, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: DEFAULT_TENANT_ID,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://example.com/',
    ipHash: 'h',
    ts: new Date(Date.now() - 60 * 60 * 1000),
  });
  return { partnerId, programId, clickId };
}

/** A conversion against the click, by the one-call conversions route. */
async function convert(clickId: string, body: { value?: number; type?: string; externalEventId: string }): Promise<string> {
  const res = await request(app)
    .post('/attribution/conversions')
    .set(admin)
    .send({ clickId, type: body.type ?? 'invoice_paid', currency: 'USD', ...body });
  expect(res.status).toBe(200);
  expect(res.body.attribution.status).toBe('attributed');
  return res.body.eventId as string;
}

function refund(body: Record<string, unknown>, auth: Record<string, string> = admin) {
  return request(app).post('/attribution/refunds').set(auth).send(body);
}

async function commissionsOf(eventId: string) {
  const attributionIds = await db(TABLES.Attribution).where({ eventId }).pluck('id');
  return db(TABLES.Commission).whereIn('attributionId', attributionIds).orderBy('id');
}

async function liveAmounts(eventId: string): Promise<string[]> {
  return (await commissionsOf(eventId)).filter((c) => c.status !== 'reversed').map((c) => c.amount);
}

/** Put commissions in a manual payout, as the planner does. */
async function markPaid(partnerId: string, commissionIds: string[]): Promise<string> {
  const payoutId = ulid();
  await db(TABLES.Payout).insert({
    id: payoutId,
    tenantId: DEFAULT_TENANT_ID,
    partnerId,
    amount: '0.00',
    currency: 'USD',
    method: 'manual',
    status: 'paid',
    metadata: {},
  });
  await db(TABLES.Commission).whereIn('id', commissionIds).update({ status: 'paid', paidAt: new Date(), payoutId });
  return payoutId;
}

async function adjustments(): Promise<Array<[string, string, string, unknown]>> {
  const rows = await db(TABLES.CommissionAdjustment).orderBy('id');
  return rows.map((a) => [a.commissionId, a.amount, a.reason, (a.metadata as { refundEventId?: unknown }).refundEventId]);
}

async function mintScopedKey(scopes: string[]): Promise<string> {
  const res = await request(app).post('/api-keys/scoped').set(admin).send({ scopes });
  expect(res.status).toBe(201);
  return res.body.plaintext as string;
}

function dispatched(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.filter((c) => c[1] === event)
    .map((c) => c[2] as Record<string, unknown>);
}

function postbacks(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(dispatchPartnerPostbacks)
    .mock.calls.filter((c) => c[2] === event)
    .map((c) => c[3] as unknown as Record<string, unknown>);
}
