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
  it('local partner sessions manage only their own granted customizable coupon codes', async () => {
    const { createSession } = await import('../auth-sessions.js');
    const createPartner = async (email: string) => {
      const response = await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email, name: email, programIds: [] });
      expect(response.status).toBe(201);
      return response.body.id as string;
    };
    const owner = await createPartner('coupon-owner@example.com');
    const other = await createPartner('coupon-other@example.com');
    const program = await request(app).post('/programs').set('Authorization', `Bearer ${ADMIN_KEY}`).send({
      name: 'Coupons', destinationUrl: 'https://example.com', commissionRule: { type: 'percent', value: 10 }, partnersMayCustomizeCode: true,
    });
    expect(program.status).toBe(201);
    const programId = program.body.id as string;
    const session = await createSession(db, { tenantId: DEFAULT_TENANT_ID, principalKind: 'partner', principalId: owner });
    const cookie = `op_session=${session.plaintext}`;
    const oldTenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first('couponIntegrationVerifiedAt');
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ couponIntegrationVerifiedAt: new Date() });
    try {
      const post = (partnerId: string, code: string) => request(app).post(`/partners/${partnerId}/coupons`).set('Cookie', cookie).send({ programId, code });
      expect((await post(other, 'OTHER')).status).toBe(403);
      const ungranted = await post(owner, 'UNGRANTED');
      expect(ungranted.status).toBe(403);
      expect(ungranted.body.error).toBe('campaign_not_granted');
      await db(TABLES.PartnerProgram).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, partnerId: owner, programId, source: 'admin' });
      const reward = { type: 'percent_off', value: 15, duration: 'repeating', durationInMonths: 3 };
      await db(TABLES.Program).where({ id: programId }).update({ customerReward: JSON.stringify(reward) });
      const programs = await request(app).get('/me/programs').set('Cookie', cookie);
      expect(programs.body.programs).toHaveLength(1);
      expect(programs.body.programs[0].customerReward).toEqual(reward);
      expect(programs.body.programs[0].commissionRule).toBeUndefined();
      const adminPrograms = await request(app).get('/me/programs').set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(adminPrograms.body.programs[0].customerReward).toEqual(reward);
      await db(TABLES.Program).where({ id: programId }).update({ customerReward: null });
      expect(programs.body.programs[0].partnersMayCustomizeCode).toBe(true);
      await db(TABLES.Program).where({ id: programId }).update({ partnersMayCustomizeCode: false });
      expect((await post(owner, 'DISABLED')).body.error).toBe('partner_customization_disabled');
      await db(TABLES.Program).where({ id: programId }).update({ partnersMayCustomizeCode: true, endsAt: new Date(Date.now() - 1000) });
      expect((await post(owner, 'ENDED')).body.error).toBe('campaign_not_active');
      await db(TABLES.Program).where({ id: programId }).update({ endsAt: null });
      const created = await post(owner, 'MYCODE');
      expect(created.status).toBe(201);
      const couponId = created.body.id as string;
      const otherCoupon = await request(app).post(`/partners/${other}/coupons`).set('Authorization', `Bearer ${ADMIN_KEY}`).send({ programId, code: 'OTHERCODE' });
      expect(otherCoupon.status).toBe(201);
      expect((await request(app).delete(`/partners/${other}/coupons/${otherCoupon.body.id}`).set('Cookie', cookie)).status).toBe(403);
      expect((await request(app).delete(`/partners/${owner}/coupons/${otherCoupon.body.id}`).set('Cookie', cookie)).status).toBe(404);
      for (let index = 0; index < 4; index++) expect((await post(owner, `CODE${index}`)).status).toBe(201);
      expect((await post(owner, 'LIMIT')).body.error).toBe('active_codes_cap_reached');
      await db(TABLES.Program).where({ id: programId }).update({ partnersMayCustomizeCode: false });
      expect((await request(app).delete(`/partners/${owner}/coupons/${couponId}`).set('Cookie', cookie)).body.error).toBe('partner_customization_disabled');
      await db(TABLES.Program).where({ id: programId }).update({ partnersMayCustomizeCode: true });
      expect((await request(app).delete(`/partners/${owner}/coupons/${couponId}`).set('Cookie', cookie)).status).toBe(200);
      const replacement = await post(owner, 'REPLACEMENT');
      expect(replacement.status).toBe(201);
      expect((await request(app).post('/coupons/redeem').set('Cookie', cookie).send({})).status).toBe(403);

      // Create/deactivate churn is capped per 24h (each mint can create
      // Stripe objects on self-host). Six created so far; four more cycles
      // reach the cap of ten, then the next create is refused.
      let latest = replacement.body.id as string;
      for (let index = 0; index < 4; index++) {
        expect((await request(app).delete(`/partners/${owner}/coupons/${latest}`).set('Cookie', cookie)).status).toBe(200);
        const churn = await post(owner, `CHURN${index}`);
        expect(churn.status).toBe(201);
        latest = churn.body.id as string;
      }
      expect((await request(app).delete(`/partners/${owner}/coupons/${latest}`).set('Cookie', cookie)).status).toBe(200);
      const capped = await post(owner, 'ONEMORE');
      expect(capped.status).toBe(429);
      expect(capped.body.error).toBe('daily_code_limit_reached');

      // The brand-wide verification gate runs after the access checks and
      // gives partners a partner-facing message, not the brand's coupon
      // count or integration instructions.
      await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ couponIntegrationVerifiedAt: null });
      expect((await post(other, 'NOTMINE')).status).toBe(403);
      await db(TABLES.Coupon).where({ partnerId: owner }).update({ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
      const gated = await post(owner, 'GATED');
      expect(gated.status).toBe(409);
      expect(gated.body.error).toBe('verification_required');
      expect(gated.body.existing).toBeUndefined();
      expect(gated.body.detail).not.toMatch(/coupons\/redeem|webhook/);
    } finally {
      await db(TABLES.Session).where({ id: session.id }).del();
      await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ couponIntegrationVerifiedAt: oldTenant?.couponIntegrationVerifiedAt ?? null });
    }
  });
  it('persists partner Network visibility across unrelated settings saves', async () => {
    const initial = await request(app).get('/config/program').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(initial.body.partnerNetworkVisible).toBe(true);
    const saved = await request(app).post('/config/program').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ partnerNetworkVisible: false });
    expect(saved.status).toBe(200);
    expect(saved.body.partnerNetworkVisible).toBe(false);
    const other = await request(app).post('/config/program').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ programName: 'Brand' });
    expect(other.body.partnerNetworkVisible).toBe(false);
    const invalid = await request(app).post('/config/program').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ partnerNetworkVisible: 'false' });
    expect(invalid.status).toBe(400);
    expect(other.body.partnerNetworkToggleAvailable).toBe(true);
  });
  it('the hosted (multi-tenant) platform ignores the partner Network toggle', async () => {
    // The stored value from a self-host era (or a direct API call) must not
    // hide Network discovery from a hosted brand's partners.
    const tenantId = ulid();
    const slug = `hosted${tenantId.slice(-8).toLowerCase()}`;
    await db(TABLES.Tenant).insert({ id: tenantId, slug, displayName: 'Hosted Brand', status: 'active', approvalStatus: 'approved' });
    await db(TABLES.Config).insert({ tenantId, key: 'program_settings', value: { partnerNetworkVisible: false } as never, updatedAt: new Date() });
    process.env.OPENPARTNER_TENANCY = 'multi';
    try {
      const read = await request(app).get(`/t/${slug}/config/program`).set('Authorization', `Bearer ${ADMIN_KEY}`);
      expect(read.status).toBe(200);
      expect(read.body.partnerNetworkVisible).toBe(true);
      expect(read.body.partnerNetworkToggleAvailable).toBe(false);
      const save = await request(app).post(`/t/${slug}/config/program`).set('Authorization', `Bearer ${ADMIN_KEY}`).send({ partnerNetworkVisible: false });
      expect(save.status).toBe(200);
      expect(save.body.partnerNetworkVisible).toBe(true);
    } finally {
      process.env.OPENPARTNER_TENANCY = 'single';
      await db(TABLES.Config).where({ tenantId }).del();
      await db(TABLES.Tenant).where({ id: tenantId }).del();
    }
  });
  it('validates and persists the public router origin across settings saves', async () => {
    for (const routerUrl of ['javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/r', 'https://example.com?x=1', 'https://example.com/#x']) {
      const rejected = await request(app).post('/config/program').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ routerUrl });
      expect(rejected.status).toBe(400);
    }
    const saved = await request(app).post('/config/program').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ routerUrl: 'https://links.example.com/' });
    expect(saved.status).toBe(200);
    expect(saved.body.routerUrl).toBe('https://links.example.com');
    const other = await request(app).post('/config/program').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ programName: 'Brand' });
    expect(other.body.routerUrl).toBe('https://links.example.com');
    const cleared = await request(app).post('/config/program').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ routerUrl: '' });
    expect(cleared.body.routerUrl).toBeNull();
  });
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
    expect(exportRes.body.schemaVersion).toBe(4);
    expect(exportRes.body.tables.Partner).toHaveLength(1);

    // Wipe, re-import.
    await db(TABLES.Partner).del();
    const importRes = await request(app)
      .post('/import')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ schemaVersion: exportRes.body.schemaVersion, tables: exportRes.body.tables });
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

describe.skipIf(skipIntegration)('audit safe-fixes', () => {
  it('POST /billing/plan rejects enterprise (sales-led), accepts flex', async () => {
    // enterprise counts as active + white-label with no Stripe sub, so it
    // must not be self-assignable through this authenticated setter.
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ billingPlan: null });
    try {
      const bad = await request(app)
        .post('/billing/plan')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ plan: 'enterprise' });
      expect(bad.status).toBe(400);

      const ok = await request(app)
        .post('/billing/plan')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ plan: 'flex' });
      expect(ok.status).toBe(200);
    } finally {
      await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ billingPlan: null });
    }
  });

  it('a click that happened AFTER the event does not attribute it (negative age)', async () => {
    const partnerId = (
      await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: `fut-${ulid()}@x.com`, name: 'Fut' })
    ).body.id;
    const programId = (
      await request(app).post('/programs').set('Authorization', `Bearer ${ADMIN_KEY}`).send({
        name: 'Fut',
        commissionRule: { type: 'percent', value: 20 },
        destinationUrl: 'https://example.com/signup',
      })
    ).body.id;
    const linkId = (
      await request(app).post(`/partners/${partnerId}/links`).set('Authorization', `Bearer ${ADMIN_KEY}`).send({ linkKey: `fut_${ulid()}`, programId })
    ).body.id;

    // Click NOW; the conversion event is backdated to before it.
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId, tenantId: DEFAULT_TENANT_ID, linkId, partnerId, programId,
      landingUrl: 'https://example.com/signup', ipHash: 'h', userAgent: 't', referer: null, ts: new Date(),
    });
    const userId = `u_${ulid()}`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });
    const eventRes = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 100, currency: 'USD', ts: new Date(Date.now() - 3600_000).toISOString() });

    expect(eventRes.status).toBe(200);
    expect(eventRes.body.attribution.status).toBe('outside_window');
    const attributions = await db(TABLES.Attribution).where({ partnerId });
    expect(attributions).toHaveLength(0);
  });

  it('an event a few seconds before its click still attributes (skew grace)', async () => {
    // The companion to the test above, and the reason the negative-age check
    // is not a strict `< 0`. Stripe stamps `created` in whole SECONDS, so a
    // conversion in the same second as the click truncates to BEFORE it, and
    // the click clock is not the event clock. A strict check dropped these
    // silently. Revert the grace in attribution.ts and this test fails.
    const partnerId = (
      await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: `skew-${ulid()}@x.com`, name: 'Skew' })
    ).body.id;
    const programId = (
      await request(app).post('/programs').set('Authorization', `Bearer ${ADMIN_KEY}`).send({
        name: 'Skew',
        commissionRule: { type: 'percent', value: 20 },
        destinationUrl: 'https://example.com/signup',
      })
    ).body.id;
    const linkId = (
      await request(app).post(`/partners/${partnerId}/links`).set('Authorization', `Bearer ${ADMIN_KEY}`).send({ linkKey: `skew_${ulid()}`, programId })
    ).body.id;

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId, tenantId: DEFAULT_TENANT_ID, linkId, partnerId, programId,
      landingUrl: 'https://example.com/signup', ipHash: 'h', userAgent: 't', referer: null, ts: new Date(),
    });
    const userId = `u_${ulid()}`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });
    const eventRes = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 100, currency: 'USD', ts: new Date(Date.now() - 2_000).toISOString() });

    expect(eventRes.status).toBe(200);
    expect(eventRes.body.attribution.status).toBe('attributed');
    const attributions = await db(TABLES.Attribution).where({ partnerId });
    expect(attributions).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('backlog replay never double-attributes an event', () => {
  // Regression: a new stitch (identify) or an unflag replays the user's
  // backlog through attributeEvent. Attribution is unique on
  // (eventId, model, clickId), so an event that was ALREADY attributed
  // gained a second last_click row at weight 1 — plus a full commission —
  // whenever the replay picked a different winning click. One conversion
  // paid two partners 100% each.
  const DAY = 24 * 60 * 60 * 1000;

  async function setup(clickBFlag: string | null = null) {
    const mkPartner = async (name: string) =>
      (await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: `${name}-${ulid()}@x.com`, name })).body.id as string;
    const partnerA = await mkPartner('Desktop');
    const partnerB = await mkPartner('Phone');
    const programId = (
      await request(app).post('/programs').set('Authorization', `Bearer ${ADMIN_KEY}`).send({
        name: 'Backlog', commissionRule: { type: 'percent', value: 20 }, destinationUrl: 'https://example.com/signup',
      })
    ).body.id as string;
    const mkClick = async (partnerId: string, ts: Date, fraudFlag: string | null) => {
      const linkId = (
        await request(app).post(`/partners/${partnerId}/links`).set('Authorization', `Bearer ${ADMIN_KEY}`).send({ linkKey: `bl_${ulid()}`, programId })
      ).body.id as string;
      const id = ulid();
      await db(TABLES.Click).insert({
        id, tenantId: DEFAULT_TENANT_ID, linkId, partnerId, programId,
        landingUrl: 'https://example.com/signup', ipHash: 'h', userAgent: 't', referer: null, fraudFlag, ts,
      });
      return id;
    };
    // Desktop click (A) three days ago; phone click (B) two days ago — B is
    // the true last click before a conversion one day ago.
    const clickA = await mkClick(partnerA, new Date(Date.now() - 3 * DAY), null);
    const clickB = await mkClick(partnerB, new Date(Date.now() - 2 * DAY), clickBFlag);
    return { partnerA, partnerB, clickA, clickB };
  }

  async function convert(userId: string) {
    const res = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 100, currency: 'USD', ts: new Date(Date.now() - DAY).toISOString() });
    expect(res.status).toBe(200);
    return res.body as { eventId: string; attribution: { status: string } };
  }

  it('identify: a cross-device click stitched after the conversion does not add a second 100% attribution', async () => {
    const { partnerA, partnerB, clickA, clickB } = await setup();
    const userId = `xdev_${ulid()}`;

    // Desktop session: stitch A, convert → A earns 20% of 100.
    await request(app).post('/attribution/identify').send({ cref: clickA, userId });
    const event = await convert(userId);
    expect(event.attribution.status).toBe('attributed');

    // The paid ledger must survive the replay untouched.
    await db(TABLES.Commission).where({ partnerId: partnerA }).update({ status: 'paid', paidAt: new Date() });

    // Later the user logs in on the phone: B is a NEW stitch, and its click
    // sits inside the window, before the conversion.
    const stitch = await request(app).post('/attribution/identify').send({ cref: clickB, userId });
    expect(stitch.status).toBe(200);
    expect(stitch.body.firstStitch).toBe(true);
    expect(stitch.body.backfilledAttributions).toBe(0);

    const attributions = await db(TABLES.Attribution).where({ eventId: event.eventId });
    expect(attributions).toHaveLength(1);
    expect(attributions[0]!.partnerId).toBe(partnerA);
    expect(await db(TABLES.Commission).where({ partnerId: partnerB })).toHaveLength(0);
    const paid = await db(TABLES.Commission).where({ partnerId: partnerA });
    expect(paid).toHaveLength(1);
    expect(paid[0]!.status).toBe('paid');
    expect(Number(paid[0]!.amount)).toBe(20);
  });

  it('identify: an event that arrived before any stitch is still backfilled', async () => {
    // The replay exists for this case — the guard must not block it.
    const { partnerB, clickB } = await setup();
    const userId = `late_${ulid()}`;
    const event = await convert(userId);
    expect(event.attribution.status).toBe('no_identity');

    const stitch = await request(app).post('/attribution/identify').send({ cref: clickB, userId });
    expect(stitch.body.backfilledAttributions).toBe(1);
    const attributions = await db(TABLES.Attribution).where({ eventId: event.eventId });
    expect(attributions).toHaveLength(1);
    expect(attributions[0]!.partnerId).toBe(partnerB);
  });

  it('unflag: an event whose commission is already paid is not re-attributed to the unflagged click', async () => {
    // fraud-review drops only ACCRUED attributions before replaying, so a
    // paid one stays — and the replay used to add the unflagged click
    // beside it at weight 1.
    const { partnerA, partnerB, clickA, clickB } = await setup('velocity');
    const userId = `unflag_${ulid()}`;
    await request(app).post('/attribution/identify').send({ cref: clickA, userId });
    await request(app).post('/attribution/identify').send({ cref: clickB, userId });
    const event = await convert(userId);
    expect(event.attribution.status).toBe('attributed'); // B is flagged → A wins
    await db(TABLES.Commission).where({ partnerId: partnerA }).update({ status: 'paid', paidAt: new Date() });

    const unflag = await request(app).post(`/clicks/${clickB}/unflag`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(unflag.status).toBe(200);
    expect(unflag.body.reattributedEvents).toBe(0);

    const attributions = await db(TABLES.Attribution).where({ eventId: event.eventId });
    expect(attributions).toHaveLength(1);
    expect(attributions[0]!.partnerId).toBe(partnerA);
    expect(await db(TABLES.Commission).where({ partnerId: partnerB })).toHaveLength(0);
  });

  it('two concurrent stitches for one user attribute an unattributed event once', async () => {
    // Two devices log in at once. Each replay runs in its own request
    // transaction and, unserialised, sees the event unattributed (the other's
    // Identity and Attribution are uncommitted) and inserts its own winner.
    const { attributeBacklogForUser } = await import('../attribution.js');
    const { clickA, clickB } = await setup();
    const userId = `race_${ulid()}`;
    const event = await convert(userId);
    expect(event.attribution.status).toBe('no_identity');

    const first = await db.transaction();
    const second = await db.transaction();
    try {
      await first(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId: clickA, userId });
      await second(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId: clickB, userId });
      expect(await attributeBacklogForUser(first, userId)).toBe(1);

      let settled = false;
      const inFlight = attributeBacklogForUser(second, userId).then((n) => {
        settled = true;
        return n;
      });
      // Room to either block on the event lock (fixed) or race past it.
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);

      await first.commit();
      expect(await inFlight).toBe(0);
      await second.commit();
    } finally {
      if (!first.isCompleted()) await first.rollback();
      if (!second.isCompleted()) await second.rollback();
    }

    expect(await db(TABLES.Attribution).where({ eventId: event.eventId })).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('corrective events are never attributed', () => {
  // Regression: the Stripe webhook records refunds / disputes / failed
  // payments with a NEGATIVE value and deliberately never attributes them,
  // so they have no Attribution row — which is exactly what the backlog
  // replay selects. A later stitch (identify) or unflag then ran them
  // through attributeEvent: a percent rule accrued a negative commission (a
  // second clawback on top of the refund's reversal) and a fixed rule paid a
  // full bounty on a refund.
  const DAY = 24 * 60 * 60 * 1000;
  const RULES = [
    { label: 'percent', rule: { type: 'percent', value: 20 }, invoiceCommission: 20 },
    { label: 'fixed', rule: { type: 'fixed', value: 50 }, invoiceCommission: 50 },
  ] as const;

  async function setup(commissionRule: (typeof RULES)[number]['rule'], clickBFlag: string | null = null) {
    const mkPartner = async (name: string) =>
      (await request(app).post('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: `${name}-${ulid()}@x.com`, name })).body.id as string;
    const partnerA = await mkPartner('Original');
    const partnerB = await mkPartner('Later');
    const programId = (
      await request(app).post('/programs').set('Authorization', `Bearer ${ADMIN_KEY}`).send({
        name: 'Corrective', commissionRule, destinationUrl: 'https://example.com/signup',
      })
    ).body.id as string;
    const mkClick = async (partnerId: string, ts: Date, fraudFlag: string | null) => {
      const linkId = (
        await request(app).post(`/partners/${partnerId}/links`).set('Authorization', `Bearer ${ADMIN_KEY}`).send({ linkKey: `ce_${ulid()}`, programId })
      ).body.id as string;
      const id = ulid();
      await db(TABLES.Click).insert({
        id, tenantId: DEFAULT_TENANT_ID, linkId, partnerId, programId,
        landingUrl: 'https://example.com/signup', ipHash: 'h', userAgent: 't', referer: null, fraudFlag, ts,
      });
      return id;
    };
    const clickA = await mkClick(partnerA, new Date(Date.now() - 4 * DAY), null);
    const clickB = await mkClick(partnerB, new Date(Date.now() - 3 * DAY), clickBFlag);
    return { partnerA, partnerB, clickA, clickB };
  }

  // Written the way the webhook writes it: a raw Event row, no attributeEvent.
  async function insertEvent(userId: string, type: string, value: number, ts: Date) {
    const id = ulid();
    await db(TABLES.Event).insert({
      id, tenantId: DEFAULT_TENANT_ID, userId, type, value: value.toFixed(2), currency: 'USD',
      externalEventId: null, metadata: {}, ts,
    });
    return id;
  }

  it.each(RULES)('identify: a refund recorded before the stitch is not backfilled ($label rule)', async ({ rule, invoiceCommission }) => {
    const { partnerA, clickA } = await setup(rule);
    const userId = `refund_${ulid()}`;
    const invoiceId = await insertEvent(userId, 'invoice_paid', 100, new Date(Date.now() - 2 * DAY));
    const refundId = await insertEvent(userId, 'refund', -100, new Date(Date.now() - DAY));

    const stitch = await request(app).post('/attribution/identify').send({ cref: clickA, userId });
    expect(stitch.status).toBe(200);
    expect(stitch.body.firstStitch).toBe(true);
    // The real conversion still backfills — the guard only skips corrective types.
    expect(stitch.body.backfilledAttributions).toBe(1);
    expect(await db(TABLES.Attribution).where({ eventId: invoiceId })).toHaveLength(1);

    expect(await db(TABLES.Attribution).where({ eventId: refundId })).toHaveLength(0);
    const commissions = await db(TABLES.Commission).where({ partnerId: partnerA });
    expect(commissions).toHaveLength(1);
    expect(Number(commissions[0]!.amount)).toBe(invoiceCommission);
  });

  it.each(RULES)('identify: a new device stitched after a refund does not claw back or pay again ($label rule)', async ({ rule, invoiceCommission }) => {
    const { partnerA, partnerB, clickA, clickB } = await setup(rule);
    const userId = `xdev_refund_${ulid()}`;

    // Desktop: stitch A, convert (attributed live), then a full refund
    // reverses that commission and records the refund Event unattributed.
    await request(app).post('/attribution/identify').send({ cref: clickA, userId });
    const convert = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 100, currency: 'USD', ts: new Date(Date.now() - 2 * DAY).toISOString() });
    expect(convert.body.attribution.status).toBe('attributed');
    await db(TABLES.Commission).where({ partnerId: partnerA }).update({ status: 'reversed' });
    const refundId = await insertEvent(userId, 'refund', -100, new Date(Date.now() - DAY));

    // Phone login stitches B — the first stitch for that click replays the backlog.
    const stitch = await request(app).post('/attribution/identify').send({ cref: clickB, userId });
    expect(stitch.body.firstStitch).toBe(true);
    expect(stitch.body.backfilledAttributions).toBe(0);

    expect(await db(TABLES.Attribution).where({ eventId: refundId })).toHaveLength(0);
    expect(await db(TABLES.Commission).where({ partnerId: partnerB })).toHaveLength(0);
    const original = await db(TABLES.Commission).where({ partnerId: partnerA });
    expect(original).toHaveLength(1);
    expect(original[0]!.status).toBe('reversed');
    expect(Number(original[0]!.amount)).toBe(invoiceCommission);
  });

  it('identify: disputes and failed payments are skipped as well', async () => {
    const { clickA } = await setup(RULES[1].rule);
    const userId = `corrective_${ulid()}`;
    const ids = [
      await insertEvent(userId, 'refund', -100, new Date(Date.now() - DAY)),
      await insertEvent(userId, 'dispute_created', -100, new Date(Date.now() - DAY)),
      await insertEvent(userId, 'invoice_payment_failed', -100, new Date(Date.now() - DAY)),
    ];

    const stitch = await request(app).post('/attribution/identify').send({ cref: clickA, userId });
    expect(stitch.body.backfilledAttributions).toBe(0);
    expect(await db(TABLES.Attribution).whereIn('eventId', ids)).toHaveLength(0);
    expect(await db(TABLES.Commission)).toHaveLength(0);
  });

  it('unflag: replaying the backlog skips a refund', async () => {
    const { partnerB, clickB } = await setup(RULES[0].rule, 'velocity');
    const userId = `unflag_refund_${ulid()}`;
    await request(app).post('/attribution/identify').send({ cref: clickB, userId });
    const refundId = await insertEvent(userId, 'refund', -100, new Date(Date.now() - DAY));

    const unflag = await request(app).post(`/clicks/${clickB}/unflag`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(unflag.status).toBe(200);
    expect(unflag.body.reattributedEvents).toBe(0);
    expect(await db(TABLES.Attribution).where({ eventId: refundId })).toHaveLength(0);
    expect(await db(TABLES.Commission).where({ partnerId: partnerB })).toHaveLength(0);
  });

  it('POST /attribution/events records a merchant-sent refund without attributing it', async () => {
    const { partnerA, clickA } = await setup(RULES[1].rule);
    const userId = `api_refund_${ulid()}`;
    await request(app).post('/attribution/identify').send({ cref: clickA, userId });

    const res = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'refund', value: 100, currency: 'USD', ts: new Date(Date.now() - DAY).toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.attribution.status).toBe('corrective');
    expect(await db(TABLES.Event).where({ id: res.body.eventId })).toHaveLength(1);
    expect(await db(TABLES.Attribution).where({ eventId: res.body.eventId })).toHaveLength(0);
    expect(await db(TABLES.Commission).where({ partnerId: partnerA })).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('server-to-server ingest routes reject partner principals', () => {
  // Regression: /coupons/redeem and /clicks are admin-or-scoped-key ingest
  // routes (grantScope + requireAdmin, same as /attribution/events). A
  // partner principal must NOT reach them — /coupons/redeem mints
  // commissions, so a partner without the gate could forge conversions
  // crediting themselves.
  async function mintPartnerKey(): Promise<string> {
    const p = (
      await request(app)
        .post('/partners')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ email: `s2s-${ulid()}@x.com`, name: 'S2S' })
    ).body.id;
    const keyRes = await request(app)
      .post(`/partners/${p}/api-keys`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ label: 'test' });
    return keyRes.body.plaintext as string;
  }

  it('POST /coupons/redeem: partner key → 403; admin passes auth (404 unknown coupon)', async () => {
    const partnerKey = await mintPartnerKey();
    const body = { code: 'NOPE', eventType: 'sale', userId: 'u1', externalEventId: ulid(), value: 100 };

    const asPartner = await request(app)
      .post('/coupons/redeem')
      .set('Authorization', `Bearer ${partnerKey}`)
      .send(body);
    expect(asPartner.status).toBe(403);

    const asAdmin = await request(app)
      .post('/coupons/redeem')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send(body);
    expect(asAdmin.status).not.toBe(403);
    expect(asAdmin.status).toBe(404); // coupon_not_found — reached the handler
  });

  it('POST /clicks: partner key → 403; admin passes auth (404 unknown link)', async () => {
    const partnerKey = await mintPartnerKey();
    const body = { id: ulid(), linkKey: 'nope', landingUrl: 'https://x/', ts: new Date().toISOString() };

    const asPartner = await request(app)
      .post('/clicks')
      .set('Authorization', `Bearer ${partnerKey}`)
      .send(body);
    expect(asPartner.status).toBe(403);

    const asAdmin = await request(app)
      .post('/clicks')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send(body);
    expect(asAdmin.status).not.toBe(403);
    expect(asAdmin.status).toBe(404); // link_not_found — reached the handler
  });
});
