/**
 * End-to-end integration tests against a real Postgres.
 *
 * Requires `DATABASE_URL` pointing at a migrated, writable database. The
 * suite truncates all product tables in beforeEach so each test is hermetic.
 *
 * If DATABASE_URL isn't set or postgres isn't reachable, the whole suite is
 * skipped — keeps `pnpm test` green on dev machines without docker running.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_admin_key_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Campaign,
  TABLES.Payout,
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.DevMessage,
  TABLES.ApiKey,
  TABLES.Partner,
  TABLES.Config,
];

// Skip the whole suite if no DB configured — keeps `pnpm test` green on dev
// machines where docker isn't running. Set INTEGRATION=skip to force-skip.
const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1'); // fail loudly if DB isn't reachable
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) {
    await db(t).del();
  }
});

describe.skipIf(skipIntegration)('api integration', () => {
  it('full funnel: partner → link → click → identify → event → attribution → payout', async () => {
    // 1. Admin creates a partner.
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'ada@example.com', name: 'Ada' });
    expect(partnerRes.status).toBe(201);
    const partnerId = partnerRes.body.id;

    // 2. Admin creates a campaign (20% commission).
    const campaignRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Default', commissionRule: { type: 'percent', value: 20 } });
    expect(campaignRes.status).toBe(201);
    const campaignId = campaignRes.body.id;

    // 3. Admin creates a link for the partner.
    const linkKey = `test_${Date.now()}`;
    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey, campaignId, destinationUrl: 'https://example.com/signup' });
    expect(linkRes.status).toBe(201);

    // 4. Simulate a click (normally written by the router).
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      linkId: linkRes.body.id,
      partnerId,
      campaignId,
      landingUrl: 'https://example.com/signup?cref=' + clickId,
      ipHash: 'test-hash',
      userAgent: 'test',
      referer: null,
      fraudFlag: null,
    });

    // 5. Browser stitches the click to an authenticated user (SDK's identify()).
    const userId = `user_${Date.now()}`;
    const stitchRes = await request(app)
      .post('/attribution/identify')
      .send({ cref: clickId, userId });
    expect(stitchRes.status).toBe(200);
    expect(stitchRes.body.firstStitch).toBe(true);

    // 6. Server-to-server revenue event.
    const eventRes = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 200, currency: 'USD' });
    expect(eventRes.status).toBe(200);
    expect(eventRes.body.attribution.status).toBe('attributed');

    // 7. Attribution + Commission rows exist.
    const attributions = await db(TABLES.Attribution).where({ partnerId });
    expect(attributions).toHaveLength(1);

    const commissions = await db(TABLES.Commission).where({ partnerId });
    expect(commissions).toHaveLength(1);
    expect(Number(commissions[0]!.amount)).toBe(40); // 20% of 200
    expect(commissions[0]!.status).toBe('accrued');

    // 8. Admin approves.
    const approveRes = await request(app)
      .post(`/commissions/${commissions[0]!.id}/approve`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.commission.status).toBe('approved');

    // 9. Run payouts — no stripe connect on partner, so method=manual, status=pending.
    const payoutRes = await request(app)
      .post('/payouts/run')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(payoutRes.status).toBe(200);
    expect(payoutRes.body.payouts).toHaveLength(1);
    expect(payoutRes.body.payouts[0].method).toBe('manual');
    expect(payoutRes.body.payouts[0].status).toBe('pending');
    expect(payoutRes.body.payouts[0].amount).toBe(40);

    // Commission now marked paid and linked to the payout.
    const paidCommission = await db(TABLES.Commission).where({ partnerId }).first();
    expect(paidCommission!.status).toBe('paid');
    expect(paidCommission!.payoutId).toBe(payoutRes.body.payouts[0].payoutId);

    // 10. Dashboard reflects the attributed revenue.
    const dashRes = await request(app)
      .get(`/partners/${partnerId}/dashboard`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.clicks).toBe(1);
    expect(dashRes.body.attributedEvents).toBe(1);
    expect(dashRes.body.attributedRevenue).toBe(200);
    expect(dashRes.body.commissionByStatus.paid).toBe(40);
  });

  it('attribution is skipped for fraud-flagged clicks', async () => {
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'eve@example.com', name: 'Eve' });
    const partnerId = partnerRes.body.id;

    const campaignRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'C', commissionRule: { type: 'percent', value: 10 } });
    const campaignId = campaignRes.body.id;

    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `fraud_${Date.now()}`, campaignId, destinationUrl: 'https://e.com' });

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      linkId: linkRes.body.id,
      partnerId,
      campaignId,
      landingUrl: 'https://e.com',
      ipHash: 'x',
      userAgent: 'x',
      referer: null,
      fraudFlag: 'velocity',
    });

    const userId = `user_f_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });

    const eventRes = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 100 });

    expect(eventRes.body.attribution.status).toBe('no_click');
    const attributions = await db(TABLES.Attribution).where({ partnerId });
    expect(attributions).toHaveLength(0);
  });

  it('partner key can read own dashboard but not another partner', async () => {
    // Create two partners, issue a key for the first, try to read both.
    const p1 = (await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: 'a@x.com', name: 'A' })).body.id;
    const p2 = (await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: 'b@x.com', name: 'B' })).body.id;

    const keyRes = await request(app)
      .post(`/partners/${p1}/api-keys`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ label: 'test' });
    const partnerKey = keyRes.body.plaintext;

    const ownRes = await request(app)
      .get(`/partners/${p1}/dashboard`)
      .set('Authorization', `Bearer ${partnerKey}`);
    expect(ownRes.status).toBe(200);

    const otherRes = await request(app)
      .get(`/partners/${p2}/dashboard`)
      .set('Authorization', `Bearer ${partnerKey}`);
    expect(otherRes.status).toBe(403);
  });

  it('export/import round-trips on selfhost', async () => {
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'export@example.com', name: 'Export' });

    const exportRes = await request(app)
      .get('/export.json')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.body.schemaVersion).toBe(1);
    expect(exportRes.body.tables.Partner).toHaveLength(1);

    // Wipe, re-import.
    await db(TABLES.Partner).del();
    const importRes = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: 1, tables: exportRes.body.tables });
    expect(importRes.status).toBe(200);
    expect(importRes.body.report.inserted.Partner).toBe(1);

    const restored = await db(TABLES.Partner).where({ id: partnerRes.body.id }).first();
    expect(restored).toBeDefined();
    expect(restored!.email).toBe('export@example.com');
  });

  it('multi-touch linear model splits commission across partners', async () => {
    // Two partners, their own campaigns (20% each, linear model), one user
    // clicks both, buys once → both should earn half the commission.
    const p1 = (await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: 'p1@x.com', name: 'P1' })).body.id;
    const p2 = (await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: 'p2@x.com', name: 'P2' })).body.id;

    const linearCampaign = (await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Linear', commissionRule: { type: 'percent', value: 20 }, attributionModel: 'linear' })).body.id;

    const link1 = (await request(app)
      .post(`/partners/${p1}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `l1_${Date.now()}`, campaignId: linearCampaign, destinationUrl: 'https://e.com' })).body;
    const link2 = (await request(app)
      .post(`/partners/${p2}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `l2_${Date.now()}`, campaignId: linearCampaign, destinationUrl: 'https://e.com' })).body;

    const click1 = ulid();
    const click2 = ulid();
    await db(TABLES.Click).insert({
      id: click1, linkId: link1.id, partnerId: p1, campaignId: linearCampaign,
      landingUrl: 'x', ipHash: 'x', userAgent: 'x', referer: null, fraudFlag: null,
      ts: new Date(Date.now() - 10_000),
    });
    await db(TABLES.Click).insert({
      id: click2, linkId: link2.id, partnerId: p2, campaignId: linearCampaign,
      landingUrl: 'x', ipHash: 'x', userAgent: 'x', referer: null, fraudFlag: null,
      ts: new Date(Date.now() - 5_000),
    });

    const userId = `mt_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: click1, userId });
    await request(app).post('/attribution/identify').send({ cref: click2, userId });

    const evt = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 100 });
    expect(evt.body.attribution.status).toBe('attributed');
    expect(evt.body.attribution.touches).toHaveLength(2);

    const c1 = await db(TABLES.Commission).where({ partnerId: p1 }).first();
    const c2 = await db(TABLES.Commission).where({ partnerId: p2 }).first();
    expect(Number(c1!.amount)).toBeCloseTo(10, 2); // half of 20% of 100
    expect(Number(c2!.amount)).toBeCloseTo(10, 2);
  });

  it('scoped key: partners:write allows POST /partners; missing scope denies', async () => {
    // Issue a scoped key with ONLY partners:write.
    const mintRes = await request(app)
      .post('/api-keys/scoped')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ scopes: ['partners:write'], label: 'integration-test' });
    expect(mintRes.status).toBe(201);
    const scopedKey = mintRes.body.plaintext as string;

    // Allowed: POST /partners (requires partners:write)
    const createRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${scopedKey}`)
      .send({ email: 'scoped@e.com', name: 'Scoped' });
    expect(createRes.status).toBe(201);
    const partnerId = createRes.body.id;

    // Denied: GET /partners/:id/commissions (requires commissions:read)
    const deniedRes = await request(app)
      .get(`/partners/${partnerId}/commissions`)
      .set('Authorization', `Bearer ${scopedKey}`);
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body.error).toBe('forbidden_scope');
  });

  it('/auth/introspect surfaces scopes; admin reports unrestricted', async () => {
    const adminIntro = await request(app)
      .get('/auth/introspect')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(adminIntro.status).toBe(200);
    expect(adminIntro.body).toEqual({ role: 'admin', unrestricted: true });

    const scopedMint = await request(app)
      .post('/api-keys/scoped')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ scopes: ['partners:write', 'links:write'] });
    const scopedIntro = await request(app)
      .get('/auth/introspect')
      .set('Authorization', `Bearer ${scopedMint.body.plaintext}`);
    expect(scopedIntro.status).toBe(200);
    expect(scopedIntro.body.role).toBe('scoped');
    expect(scopedIntro.body.scopes).toEqual(['partners:write', 'links:write']);
  });

  it('/auth/whoami reports role correctly', async () => {
    const adminWhoami = await request(app).get('/auth/whoami').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(adminWhoami.status).toBe(200);
    expect(adminWhoami.body.role).toBe('admin');

    const unauth = await request(app).get('/auth/whoami');
    expect(unauth.status).toBe(401);
  });
});
