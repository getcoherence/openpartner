/**
 * POST /coupons/redeem idempotency on externalEventId.
 *
 * The route used to dedupe with a read-then-write keyed on
 * (externalEventId, eventType). Concurrent duplicates both passed the read
 * and the loser 500'd on the unique constraint; the same key with another
 * eventType passed the read and 500'd too. These lock in:
 *   - a sequential retry replays the original eventId (200, replayed)
 *   - concurrent duplicates insert exactly once (the unique constraint is
 *     the arbiter) and the loser waits for the winner's commit and replays
 *   - reusing a key for a different redemption 409s, and neither the 409
 *     nor a replay leaves a stray synthetic Click / Identity behind
 *   - a key first used by /attribution/events 409s here rather than
 *     silently dropping the coupon touchpoint
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_coupon_idem_0123456789abcdef012345';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Payout,
  TABLES.Program,
  TABLES.WebhookDelivery,
  TABLES.WebhookEndpoint,
  TABLES.ApiKey,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
let verifiedAtBefore: Date | null = null;

beforeAll(async () => {
  if (skipIntegration) return;
  // A redemption stamps the tenant's couponIntegrationVerifiedAt; restored in
  // afterAll so files that gate on it see the tenant as they would have.
  const t = (await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first('couponIntegrationVerifiedAt')) as
    | { couponIntegrationVerifiedAt: Date | null }
    | undefined;
  verifiedAtBefore = t?.couponIntegrationVerifiedAt ?? null;
});

afterAll(async () => {
  if (!skipIntegration) {
    await clean();
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ couponIntegrationVerifiedAt: verifiedAtBefore });
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  await clean();
});

async function clean(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) {
    await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
  }
}

describe.skipIf(skipIntegration)('POST /coupons/redeem — externalEventId idempotency', () => {
  it('a retried redemption replays the original event without a second click or commission', async () => {
    const coupon = await seedCoupon();
    const body = redemption(coupon.code);

    const first = await redeem(body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ ok: true, eventId: expect.any(String), partnerId: coupon.partnerId });

    // Codes match case-insensitively, so this is the same redemption.
    const retry = await redeem({ ...body, code: coupon.code.toLowerCase() });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: true, replayed: true, eventId: first.body.eventId });

    await expectRowCounts(body, { events: 1, couponClicks: 1, identities: 1, attributions: 1, commissions: 1 });
  });

  it('a duplicate arriving while the first is mid-redemption waits for it and replays', async () => {
    const coupon = await seedCoupon();
    const body = redemption(coupon.code);

    // Park the first request AFTER its Event insert: the synthetic touchpoint
    // step's first read is Identity, so an ACCESS EXCLUSIVE lock there holds
    // it with its Event row inserted but uncommitted. The duplicate then has
    // to block on that row in the unique constraint — the real race, made
    // deterministic.
    const blocker = await db.transaction();
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await blocker.raw('lock table "Identity" in access exclusive mode');
      first = redeem(body).then((r) => r);
      await waitForLockWaiters(1);
      second = redeem(body).then((r) => r);
      await waitForLockWaiters(2);
    } finally {
      await blocker.rollback();
    }
    const [a, b] = await Promise.all([first!, second!]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ ok: true, replayed: true, eventId: a.body.eventId });
    await expectRowCounts(body, { events: 1, couponClicks: 1, identities: 1, attributions: 1, commissions: 1 });
  }, 20_000);

  it('a burst of concurrent duplicates inserts, stitches and commissions exactly once', async () => {
    const coupon = await seedCoupon();
    const body = redemption(coupon.code);

    const responses = await Promise.all(Array.from({ length: 5 }, () => redeem(body).then((r) => r)));

    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(responses.map((r) => r.body.eventId)).size).toBe(1);
    await expectRowCounts(body, { events: 1, couponClicks: 1, identities: 1, attributions: 1, commissions: 1 });
  }, 20_000);

  it('reusing a key for a different redemption is a 409 and leaves no synthetic click behind', async () => {
    const coupon = await seedCoupon();
    const otherPartnersCoupon = await seedCoupon();
    const body = redemption(coupon.code);
    const first = await redeem(body);
    expect(first.status).toBe(201);

    // The new-user and other-code variants would each stitch a fresh
    // synthetic Click + Identity if anything were written before the
    // conflict was detected — and a 409 commits.
    for (const changed of [
      { ...body, eventType: 'subscription_created' },
      { ...body, value: 250 },
      { ...body, currency: 'EUR' },
      { ...body, userId: `usr_${ulid()}` },
      { ...body, code: otherPartnersCoupon.code },
    ]) {
      const res = await redeem(changed);
      expect(res.status, JSON.stringify(changed)).toBe(409);
      expect(res.body).toMatchObject({ error: 'external_event_id_conflict', eventId: first.body.eventId });
    }

    // The original redemption still replays.
    const retry = await redeem(body);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);

    await expectRowCounts(body, { events: 1, couponClicks: 1, identities: 1, attributions: 1, commissions: 1 });
    expect(await db(TABLES.Click).where({ partnerId: otherPartnersCoupon.partnerId })).toHaveLength(0);
  });

  it('a key first used by /attribution/events is a 409, not a replay that drops the coupon touch', async () => {
    const coupon = await seedCoupon();
    const body = redemption(coupon.code);
    const tracked = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        userId: body.userId,
        type: body.eventType,
        value: body.value,
        currency: body.currency,
        externalEventId: body.externalEventId,
      });
    expect(tracked.status).toBe(200);

    const res = await redeem(body);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'external_event_id_conflict', eventId: tracked.body.eventId });
    expect(await db(TABLES.Click).where({ partnerId: coupon.partnerId })).toHaveLength(0);
    expect(await db(TABLES.Identity).where({ userId: body.userId })).toHaveLength(0);
  });

  // -------- helpers --------

  function redeem(body: Record<string, unknown>) {
    return request(app).post('/coupons/redeem').set('Authorization', `Bearer ${ADMIN_KEY}`).send(body);
  }

  function redemption(code: string) {
    return {
      code,
      eventType: 'invoice_paid',
      value: 200,
      currency: 'USD',
      externalEventId: `ord_${ulid()}`,
      userId: `usr_${ulid()}`,
    };
  }

  /** A live coupon on a 10%-commission program, for a fresh partner. */
  async function seedCoupon() {
    const partnerId = ulid();
    const programId = ulid();
    await db(TABLES.Partner).insert({
      id: partnerId,
      tenantId: DEFAULT_TENANT_ID,
      email: `p${partnerId.toLowerCase()}@x.test`,
      name: 'Partner',
    });
    await db(TABLES.Program).insert({
      id: programId,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Idempotency',
      commissionRule: JSON.stringify({ type: 'percent', value: 10, recurring: true }),
      destinationUrl: 'https://x.test/landing',
      attributionWindowDays: 60,
      attributionModel: 'last_click',
    });
    const code = `IDEM${ulid().slice(-8)}`;
    await db(TABLES.Coupon).insert({ id: `cpn_${ulid()}`, tenantId: DEFAULT_TENANT_ID, partnerId, programId, code });
    return { partnerId, code };
  }

  async function expectRowCounts(
    body: { externalEventId: string; userId: string; code: string },
    expected: { events: number; couponClicks: number; identities: number; attributions: number; commissions: number },
  ) {
    const eventIds = await db(TABLES.Event)
      .where({ externalEventId: body.externalEventId, tenantId: DEFAULT_TENANT_ID })
      .pluck('id');
    const couponClicks = await db(TABLES.Click).whereRaw('lower("landingUrl") = ?', [`coupon://${body.code}`.toLowerCase()]);
    const identities = await db(TABLES.Identity).where({ userId: body.userId });
    const attributionIds = await db(TABLES.Attribution).whereIn('eventId', eventIds).pluck('id');
    const commissions = await db(TABLES.Commission).whereIn('attributionId', attributionIds);
    expect({
      events: eventIds.length,
      couponClicks: couponClicks.length,
      identities: identities.length,
      attributions: attributionIds.length,
      commissions: commissions.length,
    }).toEqual(expected);
  }

  /** Backends in this database currently waiting on a heavyweight lock. */
  async function waitForLockWaiters(n: number) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await db.raw(
        `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (rows[0].n >= n) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} lock waiter(s); saw ${rows[0].n}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
});
