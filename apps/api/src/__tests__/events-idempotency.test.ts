/**
 * POST /attribution/events idempotency on externalEventId.
 *
 * S2S senders (merchant backends, Zapier, CRMs) retry on timeouts and 5xx.
 * Before externalEventId was honoured here, every retry inserted a fresh
 * Event and attributeEvent commissioned it again. These lock in:
 *   - a sequential retry replays the original eventId + attribution
 *   - concurrent duplicates insert exactly once (the unique constraint is
 *     the arbiter, not a read-then-write) and the loser waits for the
 *     winner's commit, so its replay carries the winner's attribution
 *   - reusing a key for a different conversion 409s instead of replaying
 *   - no key keeps the old insert-every-time behavior
 *   - keys are scoped per tenant
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_events_idem_0123456789abcdef01234';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const OTHER_TENANT_ID = '01J000000EVENTSIDEMOTHER00';

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Program,
  TABLES.Payout,
  TABLES.WebhookDelivery,
  TABLES.WebhookEndpoint,
  TABLES.ApiKey,
  TABLES.Partner,
  TABLES.Config,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) {
    await db(TABLES.Event).where({ tenantId: OTHER_TENANT_ID }).del();
    await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) {
    await db(t).del();
  }
});

describe.skipIf(skipIntegration)('POST /attribution/events — externalEventId idempotency', () => {
  it('a retried POST replays the original event and attribution without a second commission', async () => {
    const { userId, partnerId } = await attributableUser();
    const body = { userId, type: 'invoice_paid', value: 200, currency: 'USD', externalEventId: `in_${ulid()}` };

    const first = await postEvent(body);
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBeUndefined();
    expect(first.body.attribution.status).toBe('attributed');
    expect(first.body.attribution.touches).toHaveLength(1);
    expect(first.body.attribution.touches[0].partnerId).toBe(partnerId);
    expect(first.body.attribution.touches[0].commissionId).toBeDefined();

    const retry = await postEvent(body);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.eventId).toBe(first.body.eventId);
    expect(retry.body.attribution).toEqual(first.body.attribution);

    await expectRowCounts(body.externalEventId, { events: 1, attributions: 1, commissions: 1 });
    const event = await db(TABLES.Event).where({ id: first.body.eventId }).first();
    expect(event.externalEventId).toBe(body.externalEventId);
  });

  it('a retry of an event that did not attribute replays as not_attributed', async () => {
    const body = { userId: `u-${ulid()}`, type: 'signup', externalEventId: `su_${ulid()}` };

    const first = await postEvent(body);
    expect(first.status).toBe(200);
    expect(first.body.attribution.status).toBe('no_identity');

    const retry = await postEvent(body);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, replayed: true, eventId: first.body.eventId });
    expect(retry.body.attribution).toEqual({ status: 'not_attributed' });
    await expectRowCounts(body.externalEventId, { events: 1, attributions: 0, commissions: 0 });
  });

  it('a duplicate arriving while the first is mid-attribution waits for it and replays its result', async () => {
    const { userId } = await attributableUser();
    const body = { userId, type: 'invoice_paid', value: 200, currency: 'USD', externalEventId: `in_${ulid()}` };

    // Park the first request AFTER its Event insert: attributeEvent's first
    // read is Identity, so an ACCESS EXCLUSIVE lock there holds it with its
    // Event row inserted but uncommitted. The duplicate then has to block on
    // that row in the unique constraint — the real race, made deterministic.
    const blocker = await db.transaction();
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    try {
      await blocker.raw('lock table "Identity" in access exclusive mode');
      first = postEvent(body).then((r) => r);
      await waitForLockWaiters(1);
      second = postEvent(body).then((r) => r);
      await waitForLockWaiters(2);
    } finally {
      await blocker.rollback();
    }
    const [a, b] = await Promise.all([first!, second!]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.replayed).toBeUndefined();
    expect(b.body.replayed).toBe(true);
    expect(b.body.eventId).toBe(a.body.eventId);
    expect(a.body.attribution.status).toBe('attributed');
    expect(b.body.attribution).toEqual(a.body.attribution);
    await expectRowCounts(body.externalEventId, { events: 1, attributions: 1, commissions: 1 });
  }, 20_000);

  it('a burst of concurrent duplicates inserts and commissions exactly once', async () => {
    const { userId } = await attributableUser();
    const body = { userId, type: 'invoice_paid', value: 200, currency: 'USD', externalEventId: `in_${ulid()}` };

    const responses = await Promise.all(Array.from({ length: 5 }, () => postEvent(body).then((r) => r)));

    for (const r of responses) expect(r.status).toBe(200);
    expect(new Set(responses.map((r) => r.body.eventId)).size).toBe(1);
    expect(responses.filter((r) => !r.body.replayed)).toHaveLength(1);
    await expectRowCounts(body.externalEventId, { events: 1, attributions: 1, commissions: 1 });
  }, 20_000);

  it('reusing a key for a different conversion is a 409, not a silent replay', async () => {
    const { userId } = await attributableUser();
    const externalEventId = `in_${ulid()}`;
    const first = await postEvent({ userId, type: 'invoice_paid', value: 200, externalEventId });
    expect(first.status).toBe(200);

    for (const changed of [
      { userId, type: 'invoice_paid', value: 250, externalEventId },
      { userId, type: 'subscription_created', value: 200, externalEventId },
      { userId: `u-${ulid()}`, type: 'invoice_paid', value: 200, externalEventId },
      { userId, type: 'invoice_paid', value: 200, currency: 'EUR', externalEventId },
    ]) {
      const res = await postEvent(changed);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'external_event_id_conflict', eventId: first.body.eventId });
    }

    // Same conversion with a different ts / metadata is still a retry.
    const retry = await postEvent({
      userId,
      type: 'invoice_paid',
      value: 200,
      currency: 'USD',
      externalEventId,
      metadata: { attempt: 2 },
      ts: new Date().toISOString(),
    });
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    await expectRowCounts(externalEventId, { events: 1, attributions: 1, commissions: 1 });
  });

  it('without a key every POST still inserts (unchanged behavior)', async () => {
    const userId = `u-${ulid()}`;
    const a = await postEvent({ userId, type: 'signup' });
    const b = await postEvent({ userId, type: 'signup' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.eventId).not.toBe(a.body.eventId);
    expect(b.body.replayed).toBeUndefined();
    const rows = await db(TABLES.Event).where({ userId });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.externalEventId === null)).toBe(true);
  });

  it('an unmapped no-code field ("" or null) means no key, and a numeric id is its string', async () => {
    const userId = `u-${ulid()}`;
    const blank = await postEvent({ userId, type: 'signup', externalEventId: '' });
    const nulled = await postEvent({ userId, type: 'signup', externalEventId: null });
    expect(blank.status).toBe(200);
    expect(nulled.status).toBe(200);
    expect(nulled.body.eventId).not.toBe(blank.body.eventId);

    const numeric = await postEvent({ userId, type: 'trial_started', externalEventId: 1001 });
    const asString = await postEvent({ userId, type: 'trial_started', externalEventId: '1001' });
    expect(numeric.status).toBe(200);
    expect(asString.body).toMatchObject({ replayed: true, eventId: numeric.body.eventId });

    const rows = await db(TABLES.Event).where({ userId }).orderBy('id');
    expect(rows.map((r) => r.externalEventId)).toEqual([null, null, '1001']);
  });

  it('the same key in another tenant neither replays nor blocks this tenant', async () => {
    await db(TABLES.Tenant)
      .insert({ id: OTHER_TENANT_ID, slug: 'events-idem-other', displayName: 'Other brand', status: 'active' })
      .onConflict('id')
      .ignore();
    const externalEventId = `order_${ulid()}`;
    const otherEventId = ulid();
    await db(TABLES.Event).insert({
      id: otherEventId,
      tenantId: OTHER_TENANT_ID,
      userId: 'someone-else',
      type: 'invoice_paid',
      value: '99.00',
      currency: 'USD',
      externalEventId,
      metadata: {},
      ts: new Date(),
    });

    const res = await postEvent({ userId: `u-${ulid()}`, type: 'invoice_paid', value: 200, externalEventId });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBeUndefined();
    expect(res.body.eventId).not.toBe(otherEventId);
    const rows = await db(TABLES.Event).where({ externalEventId }).orderBy('tenantId');
    expect(rows.map((r) => r.tenantId).sort()).toEqual([DEFAULT_TENANT_ID, OTHER_TENANT_ID].sort());
  });

  // -------- helpers --------

  function postEvent(body: Record<string, unknown>) {
    return request(app).post('/attribution/events').set('Authorization', `Bearer ${ADMIN_KEY}`).send(body);
  }

  async function expectRowCounts(
    externalEventId: string,
    expected: { events: number; attributions: number; commissions: number },
  ) {
    const eventIds = await db(TABLES.Event).where({ externalEventId, tenantId: DEFAULT_TENANT_ID }).pluck('id');
    const attributionIds = await db(TABLES.Attribution).whereIn('eventId', eventIds).pluck('id');
    const commissions = await db(TABLES.Commission).whereIn('attributionId', attributionIds);
    expect({ events: eventIds.length, attributions: attributionIds.length, commissions: commissions.length }).toEqual(
      expected,
    );
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

  /** A user stitched to a fresh click on a 10%-commission program. */
  async function attributableUser() {
    const partner = await adminPost('/partners', { email: `p+${ulid()}@example.com`, name: 'Test' });
    const program = await adminPost('/programs', {
      name: 'Idempotency',
      commissionRule: { type: 'percent', value: 10, recurring: true },
      destinationUrl: 'https://example.com/signup',
      deepLinkAllowedDomains: 'example.com',
    });
    const link = await adminPost(`/partners/${partner.id}/links`, {
      linkKey: `idem-${ulid().toLowerCase()}`,
      programId: program.id,
      destinationUrl: 'https://example.com/',
    });
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: link.id,
      partnerId: partner.id,
      programId: program.id,
      landingUrl: 'https://example.com/',
      ts: new Date(Date.now() - 60_000),
    });
    const userId = `u-${ulid()}`;
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });
    return { userId, partnerId: partner.id as string };
  }

  async function adminPost(path: string, body: Record<string, unknown>) {
    const res = await request(app).post(path).set('Authorization', `Bearer ${ADMIN_KEY}`).send(body);
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }
});
