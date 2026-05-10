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
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_admin_key_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
// Force selfhost — vitest auto-loads .env, so the ?? form would let a
// developer's local .env mode bleed into the suite.
process.env.OPENPARTNER_MODE = 'selfhost';
// Force single tenancy — every direct insert below gets stamped with the
// default tenant; routes go through tenantMiddleware which sets the same.
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Program,
  TABLES.Payout,
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
  // Truncate before destroying so subsequent test files (which share
  // this DB and may not list every Partner-referencing table in their
  // own beforeEach) start from a clean slate. Without this, a Link or
  // Click left behind here cascades into FK violations when another
  // file's `delete from Partner` runs.
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) {
      await db(t).del();
    }
  }
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
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Default', commissionRule: { type: 'percent', value: 20 }, destinationUrl: 'https://example.com/signup', deepLinkAllowedDomains: 'e.com,example.com' });
    expect(campaignRes.status).toBe(201);
    const programId = campaignRes.body.id;

    // 3. Admin creates a link for the partner.
    const linkKey = `test_${Date.now()}`;
    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey, programId, destinationUrl: 'https://example.com/signup', deepLinkAllowedDomains: 'e.com,example.com' });
    expect(linkRes.status).toBe(201);

    // 4. Simulate a click (normally written by the router).
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: linkRes.body.id,
      partnerId,
      programId,
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
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'C', commissionRule: { type: 'percent', value: 10 }, destinationUrl: 'https://example.com/signup', deepLinkAllowedDomains: 'e.com,example.com' });
    const programId = campaignRes.body.id;

    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `fraud_${Date.now()}`, programId, destinationUrl: 'https://e.com' });

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: linkRes.body.id,
      partnerId,
      programId,
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
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Linear', commissionRule: { type: 'percent', value: 20 }, attributionModel: 'linear', destinationUrl: 'https://example.com/signup', deepLinkAllowedDomains: 'e.com,example.com' })).body.id;

    const link1 = (await request(app)
      .post(`/partners/${p1}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `l1_${Date.now()}`, programId: linearCampaign, destinationUrl: 'https://e.com' })).body;
    const link2 = (await request(app)
      .post(`/partners/${p2}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `l2_${Date.now()}`, programId: linearCampaign, destinationUrl: 'https://e.com' })).body;

    const click1 = ulid();
    const click2 = ulid();
    await db(TABLES.Click).insert({
      id: click1, tenantId: DEFAULT_TENANT_ID, linkId: link1.id, partnerId: p1, programId: linearCampaign,
      landingUrl: 'x', ipHash: 'x', userAgent: 'x', referer: null, fraudFlag: null,
      ts: new Date(Date.now() - 10_000),
    });
    await db(TABLES.Click).insert({
      id: click2, tenantId: DEFAULT_TENANT_ID, linkId: link2.id, partnerId: p2, programId: linearCampaign,
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

  it('partner funnel reports stages + rates correctly', async () => {
    // Setup: partner, campaign, link, two fraud-clean clicks, one
    // fraud-flagged click (must be excluded), one signup event + one
    // paid event on one of the users.
    const partner = (
      await request(app)
        .post('/partners')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ email: 'funnel@e.com', name: 'FunnelCo' })
    ).body;
    const campaign = (
      await request(app)
        .post('/programs')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ name: 'F', commissionRule: { type: 'percent', value: 10 }, destinationUrl: 'https://example.com/signup', deepLinkAllowedDomains: 'e.com,example.com' })
    ).body;
    const link = (
      await request(app)
        .post(`/partners/${partner.id}/links`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ linkKey: `fk_${Date.now()}`, programId: campaign.id, destinationUrl: 'https://e.com' })
    ).body;

    // 3 clicks, one flagged.
    const click1 = ulid();
    const click2 = ulid();
    const click3 = ulid();
    await db(TABLES.Click).insert([
      { id: click1, tenantId: DEFAULT_TENANT_ID, linkId: link.id, partnerId: partner.id, programId: campaign.id, landingUrl: 'x', ipHash: 'a', userAgent: 'x', referer: null, fraudFlag: null },
      { id: click2, tenantId: DEFAULT_TENANT_ID, linkId: link.id, partnerId: partner.id, programId: campaign.id, landingUrl: 'x', ipHash: 'b', userAgent: 'x', referer: null, fraudFlag: null },
      { id: click3, tenantId: DEFAULT_TENANT_ID, linkId: link.id, partnerId: partner.id, programId: campaign.id, landingUrl: 'x', ipHash: 'c', userAgent: 'x', referer: null, fraudFlag: 'velocity' },
    ]);

    // User 1 stitches, signs up, pays.
    const u1 = `u1_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: click1, userId: u1 });
    await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId: u1, type: 'signup' });
    await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId: u1, type: 'invoice_paid', value: 100 });

    // User 2 stitches but only signs up, no payment.
    const u2 = `u2_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: click2, userId: u2 });
    await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId: u2, type: 'signup' });

    const funnel = await request(app)
      .get(`/partners/${partner.id}/funnel`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(funnel.status).toBe(200);
    expect(funnel.body.stages.clicks).toBe(2); // fraud-flagged excluded
    expect(funnel.body.stages.identities).toBe(2);
    expect(funnel.body.stages.signups).toBe(2);
    expect(funnel.body.stages.paid).toBe(1);
    expect(funnel.body.rates.stitchRate).toBeCloseTo(1, 3);
    expect(funnel.body.rates.signupRate).toBeCloseTo(1, 3);
    expect(funnel.body.rates.paidRate).toBeCloseTo(0.5, 3);
    expect(funnel.body.rates.overall).toBeCloseTo(0.5, 3);
    expect(funnel.body.revenue).toBe(100);
  });

  it('fraud review: unflag re-attributes events that arrived while the click was skipped', async () => {
    const partner = (
      await request(app)
        .post('/partners')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ email: 'fraud@e.com', name: 'FraudCo' })
    ).body;
    const campaign = (
      await request(app)
        .post('/programs')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ name: 'Fr', commissionRule: { type: 'percent', value: 20 }, destinationUrl: 'https://example.com/signup', deepLinkAllowedDomains: 'e.com,example.com' })
    ).body;
    const link = (
      await request(app)
        .post(`/partners/${partner.id}/links`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ linkKey: `fr_${Date.now()}`, programId: campaign.id, destinationUrl: 'https://e.com' })
    ).body;

    // Click comes in flagged as velocity.
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: link.id,
      partnerId: partner.id,
      programId: campaign.id,
      landingUrl: 'x',
      ipHash: 'x',
      userAgent: 'x',
      referer: null,
      fraudFlag: 'velocity',
    });

    // User stitches, pays. Attribution should SKIP because flagged.
    const uid = `fraud_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId: uid });
    const event = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId: uid, type: 'invoice_paid', value: 250 });
    expect(event.body.attribution.status).toBe('no_click'); // fraud-flagged filters it

    // No Attribution rows for this partner yet.
    let attrs = await db(TABLES.Attribution).where({ partnerId: partner.id });
    expect(attrs).toHaveLength(0);

    // Show up in the flagged list.
    const flagged = await request(app).get('/admin/clicks/flagged').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(flagged.body.clicks.find((c: { id: string }) => c.id === clickId)).toBeDefined();

    // Un-flag. Should re-run attribution and earn the missed $50.
    const unflag = await request(app).post(`/clicks/${clickId}/unflag`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(unflag.status).toBe(200);
    expect(unflag.body.reattributedEvents).toBe(1);

    attrs = await db(TABLES.Attribution).where({ partnerId: partner.id });
    expect(attrs).toHaveLength(1);
    const commissions = await db(TABLES.Commission).where({ partnerId: partner.id });
    expect(commissions).toHaveLength(1);
    expect(Number(commissions[0]!.amount)).toBe(50); // 20% of 250
  });

  it('/auth/whoami reports role correctly', async () => {
    const adminWhoami = await request(app).get('/auth/whoami').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(adminWhoami.status).toBe(200);
    expect(adminWhoami.body.role).toBe('admin');

    const unauth = await request(app).get('/auth/whoami');
    expect(unauth.status).toBe(401);
  });
});
