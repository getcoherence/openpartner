/**
 * What Admin → Tracking health is built from on the ingest side:
 *
 * POST /attribution/landing (the browser SDK's landing beacon)
 *   - records one ClickLanding per click, the first; later calls are no-ops
 *   - the page's host comes from the browser's Origin, never the path
 *   - another tenant's click, or none, is a 404 and a counted issue
 *
 * TrackingIssue counters, one row per (tenant, day, kind):
 *   - identify, conversions and coupon redemption count what they drop
 *   - a failure to count never breaks the caller's transaction
 *   - trackingIssuesSince sums days and keeps the latest sample
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type TrackingIssueKind } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { noteTrackingIssue, trackingIssuesSince } from '../tracking-issues.js';

const ADMIN_KEY = 'op_test_tracking_capture_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const OTHER_TENANT_ID = '01J000000TRACKINGCAPTUREOT';

const TABLES_TO_CLEAN = [
  TABLES.TrackingIssue,
  TABLES.ClickLanding,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.Program,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };

async function seedClick(tenantId = DEFAULT_TENANT_ID): Promise<string> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId, name: 'Partner', email: `p-${partnerId}@example.com` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId,
    name: 'Program',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    destinationUrl: 'https://brand.example/signup',
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://brand.example/signup',
    ts: new Date(),
  });
  return clickId;
}

async function issue(kind: TrackingIssueKind) {
  return db(TABLES.TrackingIssue).where({ tenantId: DEFAULT_TENANT_ID, kind }).first();
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await db(TABLES.Tenant)
    .insert({ id: OTHER_TENANT_ID, slug: 'tracking-capture-other', displayName: 'Other brand', status: 'active' })
    .onConflict('id')
    .ignore();
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) await db(t).whereIn('tenantId', [DEFAULT_TENANT_ID, OTHER_TENANT_ID]).del();
    await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).whereIn('tenantId', [DEFAULT_TENANT_ID, OTHER_TENANT_ID]).del();
});

describe.skipIf(skipIntegration)('POST /attribution/landing', () => {
  it('records the first landing of a click, with the page host from Origin', async () => {
    const clickId = await seedClick();
    const first = await request(app)
      .post('/attribution/landing')
      .set('Origin', 'https://www.brand.example')
      .set('Referer', 'https://www.brand.example/pricing?email=a%40b.c')
      .send({ cref: clickId });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, firstLanding: true });
    // Any origin may call it, without credentials.
    expect(first.headers['access-control-allow-origin']).toBe('https://www.brand.example');
    expect(first.headers['access-control-allow-credentials']).toBeUndefined();

    const again = await request(app)
      .post('/attribution/landing')
      .set('Origin', 'https://app.brand.example')
      .send({ cref: clickId });
    expect(again.body).toEqual({ ok: true, firstLanding: false });

    const rows = await db(TABLES.ClickLanding).where({ clickId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: DEFAULT_TENANT_ID, host: 'www.brand.example' });
  });

  it('falls back to the Referer host, and stores none without either', async () => {
    const viaReferer = await seedClick();
    await request(app).post('/attribution/landing').set('Referer', 'https://Shop.Brand.example/p?x=1').send({ cref: viaReferer });
    expect(await db(TABLES.ClickLanding).where({ clickId: viaReferer }).first()).toMatchObject({ host: 'shop.brand.example' });

    const bare = await seedClick();
    await request(app).post('/attribution/landing').send({ cref: bare });
    expect(await db(TABLES.ClickLanding).where({ clickId: bare }).first()).toMatchObject({ host: null });
  });

  it("404s another tenant's click or none, and counts it", async () => {
    const foreign = await seedClick(OTHER_TENANT_ID);
    const res = await request(app).post('/attribution/landing').send({ cref: foreign });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('click_not_found');
    await request(app).post('/attribution/landing').send({ cref: 'nope' });

    expect(await db(TABLES.ClickLanding).where({ clickId: foreign })).toEqual([]);
    expect(await issue('landing_unknown_click')).toMatchObject({ count: 2, sampleRef: 'nope' });
  });

  it('rejects a body without a cref', async () => {
    const res = await request(app).post('/attribution/landing').send({});
    expect(res.status).toBe(400);
  });
});

describe.skipIf(skipIntegration)('dropped input is counted', () => {
  it('identify with an unknown click', async () => {
    const res = await request(app).post('/attribution/identify').send({ cref: 'missing-click', userId: 'u1' });
    expect(res.status).toBe(404);
    expect(await issue('identify_unknown_click')).toMatchObject({ count: 1, sampleRef: 'missing-click' });
  });

  it('a conversion naming an unknown click', async () => {
    const res = await request(app)
      .post('/attribution/conversions')
      .set(admin)
      .send({ clickId: 'missing-click', type: 'loan_funded', externalEventId: `x-${ulid()}` });
    expect(res.status).toBe(404);
    expect(await issue('conversion_unknown_click')).toMatchObject({ count: 1, sampleRef: 'missing-click' });
  });

  it('a coupon code nobody holds', async () => {
    const res = await request(app)
      .post('/coupons/redeem')
      .set(admin)
      .send({ code: 'NOSUCHCODE', eventType: 'invoice_paid', value: 10, externalEventId: `r-${ulid()}`, userId: 'u1' });
    expect(res.status).toBe(404);
    expect(await issue('coupon_unknown_code')).toMatchObject({ count: 1, sampleRef: 'NOSUCHCODE' });
  });
});

describe.skipIf(skipIntegration)('noteTrackingIssue', () => {
  it('bumps one row per day and keeps the latest sample, stripped of control characters', async () => {
    await noteTrackingIssue(db, DEFAULT_TENANT_ID, 'identify_unknown_click', 'first');
    await noteTrackingIssue(db, DEFAULT_TENANT_ID, 'identify_unknown_click', 'sec\u0000ond\n');
    await noteTrackingIssue(db, DEFAULT_TENANT_ID, 'identify_unknown_click', null);
    const rows = await db(TABLES.TrackingIssue).where({ tenantId: DEFAULT_TENANT_ID });
    expect(rows).toHaveLength(1);
    // A call without a value keeps the last one seen.
    expect(rows[0]).toMatchObject({ count: 3, sampleRef: 'second' });

    await noteTrackingIssue(db, DEFAULT_TENANT_ID, 'identify_unknown_click', 'x'.repeat(300));
    expect((await issue('identify_unknown_click'))!.sampleRef).toHaveLength(64);
  });

  it("can't abort the caller's transaction when the write fails", async () => {
    await db.transaction(async (trx) => {
      // Longer than the kind column: the insert fails inside its savepoint.
      await noteTrackingIssue(trx, DEFAULT_TENANT_ID, 'x'.repeat(50) as TrackingIssueKind, 'ref');
      const [{ ok }] = (await trx.raw('select 1 as ok')).rows;
      expect(ok).toBe(1);
    });
    expect(await db(TABLES.TrackingIssue).where({ tenantId: DEFAULT_TENANT_ID })).toEqual([]);
  });

  it('trackingIssuesSince sums the days in range per kind, newest sample first', async () => {
    await db(TABLES.TrackingIssue).insert([
      { tenantId: DEFAULT_TENANT_ID, day: '2026-10-01', kind: 'stripe_foreign_reference', count: 4, sampleRef: 'old', lastSeenAt: new Date('2026-10-01T10:00:00Z') },
      { tenantId: DEFAULT_TENANT_ID, day: '2026-10-03', kind: 'stripe_foreign_reference', count: 2, sampleRef: 'new', lastSeenAt: new Date('2026-10-03T10:00:00Z') },
      { tenantId: DEFAULT_TENANT_ID, day: '2026-09-01', kind: 'stripe_foreign_reference', count: 100, sampleRef: 'too old', lastSeenAt: new Date('2026-09-01T10:00:00Z') },
      { tenantId: OTHER_TENANT_ID, day: '2026-10-02', kind: 'stripe_foreign_reference', count: 9, sampleRef: 'theirs', lastSeenAt: new Date('2026-10-02T10:00:00Z') },
    ]);
    expect(await trackingIssuesSince(db, DEFAULT_TENANT_ID, new Date('2026-09-24T00:00:00Z'))).toEqual([
      { kind: 'stripe_foreign_reference', count: 6, days: 2, sampleRef: 'new', detail: null, lastSeenAt: '2026-10-03T10:00:00.000Z' },
    ]);
  });
});
