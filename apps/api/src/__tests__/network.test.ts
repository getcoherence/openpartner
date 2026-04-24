/**
 * End-to-end Network flow, with a real running Express server standing in
 * as the "vendor's OpenPartner instance" that the Network federates to.
 *
 * Walkthrough:
 *   1. Admin registers a NetworkVendor with the local instance URL + admin key.
 *   2. Vendor uses the issued vendor API key to publish an Offering tied to
 *      a real Campaign on their instance.
 *   3. Admin creates a NetworkCreator and activates it.
 *   4. Creator applies to the Offering.
 *   5. Vendor approves → federation POSTs to the same server to create a
 *      Partner + Link. Partnership row is written with the public share URL.
 *   6. We assert the Partner + Link actually exist on the vendor's side.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_network_admin_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.NETWORK_ENCRYPTION_KEY = 'a'.repeat(64); // 32 hex bytes

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
// ApiKey has FKs to NetworkVendor, NetworkCreator, and Partner, so it must
// be cleared BEFORE those parent tables. Similarly Partnership/Request have
// FKs to Offering/NetworkVendor/NetworkCreator.
const TABLES_TO_CLEAN = [
  TABLES.Partnership,
  TABLES.PartnershipRequest,
  TABLES.Offering,
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.DevMessage,
  TABLES.ApiKey,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Campaign,
  TABLES.Payout,
  TABLES.NetworkVendor,
  TABLES.NetworkCreator,
  TABLES.Partner,
  TABLES.Config,
];

const app = createApp({ enableLogger: false });
let server: ReturnType<typeof app.listen>;
let instanceUrl: string;

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      instanceUrl = `http://127.0.0.1:${port}`;
      // Pin the router URL so federation doesn't try to swap ports.
      process.env.NETWORK_ROUTER_URL = instanceUrl;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) {
    await db(t).del();
  }
});

describe.skipIf(skipIntegration)('openpartner network', () => {
  it('vendor → offering → creator → request → approve federates a partner + link', async () => {
    // Create a campaign on the "vendor's instance" (same server in tests).
    const campaignRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Referral', commissionRule: { type: 'percent', value: 30, recurring: true } });
    expect(campaignRes.status).toBe(201);
    const vendorCampaignId = campaignRes.body.id;

    // Register vendor on the Network (admin-gated).
    const vendorRegRes = await request(app)
      .post('/network/vendors')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'Acme',
        slug: 'acme',
        websiteUrl: 'https://acme.example',
        instanceUrl,
        instanceKey: ADMIN_KEY,
      });
    expect(vendorRegRes.status).toBe(201);
    const vendorId = vendorRegRes.body.vendor.id;
    const vendorApiKey = vendorRegRes.body.apiKey;

    // Admin activates the vendor.
    await request(app)
      .post(`/network/vendors/${vendorId}/activate`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);

    // Vendor publishes an offering.
    const offeringRes = await request(app)
      .post('/network/offerings')
      .set('Authorization', `Bearer ${vendorApiKey}`)
      .send({
        title: 'Acme Pro — 30% for 6 months',
        productUrl: 'https://acme.example/pro',
        description: 'Sell our flagship to your audience.',
        vendorCampaignId,
        terms: {
          payout: { type: 'recurring_percent', percent: 30, durationMonths: 6 },
          bonuses: [{ description: '$500 at $10k MRR', triggerRevenueUsd: 10000, bonusUsd: 500 }],
          cookieWindowDays: 60,
        },
        published: true,
      });
    expect(offeringRes.status).toBe(201);
    const offeringId = offeringRes.body.offering.id;

    // Admin onboards a creator.
    const creatorRes = await request(app)
      .post('/network/creators')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'Grace Hopper',
        handle: 'gracie',
        email: 'grace@example.com',
        platforms: [{ platform: 'youtube', url: 'https://youtube.com/@gracie', followers: 120000 }],
      });
    expect(creatorRes.status).toBe(201);
    const creatorId = creatorRes.body.creator.id;
    const creatorKey = creatorRes.body.apiKey;
    await request(app).post(`/network/creators/${creatorId}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    // Creator sees the directory.
    const dirRes = await request(app).get('/network/directory/offerings');
    expect(dirRes.status).toBe(200);
    expect(dirRes.body.offerings).toHaveLength(1);
    expect(dirRes.body.offerings[0].title).toContain('Acme');

    // Creator applies.
    const applyRes = await request(app)
      .post('/network/requests')
      .set('Authorization', `Bearer ${creatorKey}`)
      .send({ offeringId, message: 'I have 120k subs interested in this.' });
    expect(applyRes.status).toBe(201);
    const requestId = applyRes.body.request.id;

    // Vendor approves (this federates).
    const approveRes = await request(app)
      .post(`/network/requests/${requestId}/approve`)
      .set('Authorization', `Bearer ${vendorApiKey}`)
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.partnership.status).toBe('active');
    expect(approveRes.body.federated.partnerId).toBeTruthy();
    expect(approveRes.body.federated.linkKey).toBe('gracie');
    expect(approveRes.body.federated.publicShareUrl).toBe(`${instanceUrl}/r/gracie`);

    // The vendor's instance actually has the partner + link now.
    const partnerOnVendor = await db(TABLES.Partner).where({ id: approveRes.body.federated.partnerId }).first();
    expect(partnerOnVendor).toBeDefined();
    expect(partnerOnVendor!.email).toBe('grace@example.com');
    expect(partnerOnVendor!.metadata).toMatchObject({ source: 'openpartner_network' });

    const linkOnVendor = await db(TABLES.Link).where({ linkKey: 'gracie' }).first();
    expect(linkOnVendor).toBeDefined();
    expect(linkOnVendor!.campaignId).toBe(vendorCampaignId);
  });

  it('creator cannot double-apply to the same offering', async () => {
    const campaignRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'C', commissionRule: { type: 'percent', value: 10 } });
    const vendorCampaignId = campaignRes.body.id;

    const vendorRes = await request(app)
      .post('/network/vendors')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Vendo', slug: `vendo-${Date.now()}`, instanceUrl, instanceKey: ADMIN_KEY });
    const vendorApiKey = vendorRes.body.apiKey;
    await request(app).post(`/network/vendors/${vendorRes.body.vendor.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const offeringRes = await request(app)
      .post('/network/offerings')
      .set('Authorization', `Bearer ${vendorApiKey}`)
      .send({
        title: 'Offer',
        productUrl: 'https://v.example',
        vendorCampaignId,
        terms: { payout: { type: 'one_time_fee', amount: 50 }, cookieWindowDays: 30 },
        published: true,
      });
    const offeringId = offeringRes.body.offering.id;

    const creatorRes = await request(app)
      .post('/network/creators')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Eva', handle: `eva_${Date.now()}`, email: `eva${Date.now()}@e.com` });
    const creatorKey = creatorRes.body.apiKey;
    await request(app).post(`/network/creators/${creatorRes.body.creator.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const first = await request(app)
      .post('/network/requests')
      .set('Authorization', `Bearer ${creatorKey}`)
      .send({ offeringId });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/network/requests')
      .set('Authorization', `Bearer ${creatorKey}`)
      .send({ offeringId });
    expect(second.status).toBe(409);
  });

  it('creator-chosen promo code becomes the share-link slug', async () => {
    const campaign = (await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Promo test', commissionRule: { type: 'percent', value: 20 } })).body;

    const vendorRouter = `${instanceUrl}`; // point router at same server for the test
    const vendorRes = await request(app)
      .post('/network/vendors')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'Coherence',
        slug: `coherence-${Date.now()}`,
        instanceUrl,
        instanceKey: ADMIN_KEY,
        routerUrl: vendorRouter,
      });
    const vendorKey = vendorRes.body.apiKey;
    await request(app).post(`/network/vendors/${vendorRes.body.vendor.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const offeringRes = await request(app)
      .post('/network/offerings')
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({
        title: 'Coherence Pro',
        productUrl: 'https://getcoherence.io/pro',
        vendorCampaignId: campaign.id,
        terms: { payout: { type: 'recurring_percent', percent: 20, durationMonths: null }, cookieWindowDays: 60 },
        published: true,
      });
    const offeringId = offeringRes.body.offering.id;

    const creatorRes = await request(app)
      .post('/network/creators')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Grace', handle: `g_${Date.now()}`, email: `g${Date.now()}@e.com` });
    const creatorKey = creatorRes.body.apiKey;
    await request(app).post(`/network/creators/${creatorRes.body.creator.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const applyRes = await request(app)
      .post('/network/requests')
      .set('Authorization', `Bearer ${creatorKey}`)
      .send({ offeringId, promoCode: 'graciefindsdeals' });
    expect(applyRes.status).toBe(201);
    expect(applyRes.body.request.promoCode).toBe('graciefindsdeals');

    const approveRes = await request(app)
      .post(`/network/requests/${applyRes.body.request.id}/approve`)
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.federated.linkKey).toBe('graciefindsdeals');
    expect(approveRes.body.federated.publicShareUrl).toBe(`${vendorRouter}/r/graciefindsdeals`);

    const linkOnVendor = await db(TABLES.Link).where({ linkKey: 'graciefindsdeals' }).first();
    expect(linkOnVendor).toBeDefined();
  });

  it('defaults to creator default promo code, falls back to handle', async () => {
    const campaign = (await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Defaults', commissionRule: { type: 'percent', value: 10 } })).body;

    const vendorRes = await request(app)
      .post('/network/vendors')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'DefaultCo', slug: `default-${Date.now()}`, instanceUrl, instanceKey: ADMIN_KEY });
    const vendorKey = vendorRes.body.apiKey;
    await request(app).post(`/network/vendors/${vendorRes.body.vendor.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const offering = (await request(app)
      .post('/network/offerings')
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({
        title: 'Offering One',
        productUrl: 'https://example.com',
        vendorCampaignId: campaign.id,
        terms: { payout: { type: 'one_time_fee', amount: 1 }, cookieWindowDays: 30 },
        published: true,
      })).body.offering;

    // Creator WITH a default
    const handle = `ada_${Date.now()}`;
    const creatorRes = await request(app)
      .post('/network/creators')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Ada', handle, email: `ada${Date.now()}@e.com`, defaultPromoCode: 'ada-picks' });
    const creatorKey = creatorRes.body.apiKey;
    await request(app).post(`/network/creators/${creatorRes.body.creator.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    // No promoCode on the request — should use the creator's default.
    const req1 = await request(app)
      .post('/network/requests')
      .set('Authorization', `Bearer ${creatorKey}`)
      .send({ offeringId: offering.id });
    expect(req1.body.request.promoCode).toBe('ada-picks');

    // Creator WITHOUT a default → handle
    const handle2 = `rose_${Date.now()}`;
    const c2 = await request(app)
      .post('/network/creators')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Rose', handle: handle2, email: `rose${Date.now()}@e.com` });
    const c2key = c2.body.apiKey;
    await request(app).post(`/network/creators/${c2.body.creator.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const o2 = (await request(app)
      .post('/network/offerings')
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({
        title: 'Offering Two',
        productUrl: 'https://example.com',
        vendorCampaignId: campaign.id,
        terms: { payout: { type: 'one_time_fee', amount: 2 }, cookieWindowDays: 30 },
        published: true,
      })).body.offering;

    const req2 = await request(app)
      .post('/network/requests')
      .set('Authorization', `Bearer ${c2key}`)
      .send({ offeringId: o2.id });
    expect(req2.body.request.promoCode).toBe(handle2);
  });

  it('earnings endpoint federates a read and surfaces per-partnership stats', async () => {
    // Campaign with a 20% recurring rule on the vendor's instance
    const campaign = (await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Earn test', commissionRule: { type: 'percent', value: 20 } })).body;

    const vendorRes = await request(app)
      .post('/network/vendors')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'EarnVendor', slug: `earn-${Date.now()}`, instanceUrl, instanceKey: ADMIN_KEY, routerUrl: instanceUrl });
    const vendorKey = vendorRes.body.apiKey;
    await request(app).post(`/network/vendors/${vendorRes.body.vendor.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const offeringId = (await request(app)
      .post('/network/offerings')
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({
        title: 'Earning offering',
        productUrl: 'https://example.com/pro',
        vendorCampaignId: campaign.id,
        terms: { payout: { type: 'recurring_percent', percent: 20, durationMonths: 6 }, cookieWindowDays: 60 },
        published: true,
      })).body.offering.id;

    const creatorRes = await request(app)
      .post('/network/creators')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Earner', handle: `earner_${Date.now()}`, email: `earner${Date.now()}@e.com` });
    const creatorKey = creatorRes.body.apiKey;
    await request(app).post(`/network/creators/${creatorRes.body.creator.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const reqRes = await request(app)
      .post('/network/requests')
      .set('Authorization', `Bearer ${creatorKey}`)
      .send({ offeringId, promoCode: 'earntest' });
    await request(app)
      .post(`/network/requests/${reqRes.body.request.id}/approve`)
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({});

    // Simulate traffic on the vendor's side: click → identify → event.
    // (We write Click directly because the router is a separate server in
    // prod; the dashboard endpoint doesn't care how Clicks got there.)
    const link = await db(TABLES.Link).where({ linkKey: 'earntest' }).first();
    expect(link).toBeDefined();
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      linkId: link!.id,
      partnerId: link!.partnerId,
      campaignId: link!.campaignId,
      landingUrl: 'https://example.com/pro',
      ipHash: 'x',
      userAgent: 'x',
      referer: null,
      fraudFlag: null,
    });

    const userId = `viewer_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });
    await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 250 });

    // Creator pulls their earnings via the Network's federated read.
    const earnings = await request(app)
      .get('/network/partnerships/earnings')
      .set('Authorization', `Bearer ${creatorKey}`);
    expect(earnings.status).toBe(200);
    expect(earnings.body.partnerships).toHaveLength(1);
    const row = earnings.body.partnerships[0];
    expect(row.status).toBe('ok');
    expect(row.stats.clicks).toBe(1);
    expect(row.stats.attributedEvents).toBe(1);
    expect(row.stats.attributedRevenue).toBe(250);
    expect(row.stats.commissionByStatus.accrued).toBe(50); // 20% of 250

    expect(earnings.body.totals.clicks).toBe(1);
    expect(earnings.body.totals.attributedRevenue).toBe(250);
    expect(earnings.body.totals.commission.accrued).toBe(50);
    expect(earnings.body.totals.unreachable).toBe(0);
    expect(earnings.body.totals.healthy).toBe(1);
  });

  it('earnings endpoint surfaces unreachable vendors without blacking out', async () => {
    const campaign = (await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Unreach', commissionRule: { type: 'percent', value: 10 } })).body;

    // Register the vendor against a dead URL so federation will fail.
    const vendorRes = await request(app)
      .post('/network/vendors')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'DeadVendor',
        slug: `dead-${Date.now()}`,
        instanceUrl: 'http://127.0.0.1:1', // port 1 — nothing listens here
        instanceKey: ADMIN_KEY,
      });
    const vendorKey = vendorRes.body.apiKey;
    await request(app).post(`/network/vendors/${vendorRes.body.vendor.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    // Insert a Partnership directly so we don't have to federate-create
    // one against the dead instance.
    const creatorRes = await request(app)
      .post('/network/creators')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Drift', handle: `drift_${Date.now()}`, email: `drift${Date.now()}@e.com` });
    const creatorKey = creatorRes.body.apiKey;
    await request(app).post(`/network/creators/${creatorRes.body.creator.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const offeringId = (await request(app)
      .post('/network/offerings')
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({
        title: 'Offline offering',
        productUrl: 'https://example.com',
        vendorCampaignId: campaign.id,
        terms: { payout: { type: 'one_time_fee', amount: 10 }, cookieWindowDays: 30 },
        published: true,
      })).body.offering.id;

    await db(TABLES.PartnershipRequest).insert({
      id: ulid(),
      offeringId,
      vendorId: vendorRes.body.vendor.id,
      creatorId: creatorRes.body.creator.id,
      direction: 'creator_to_vendor',
      status: 'approved',
      promoCode: 'drift',
      decidedAt: new Date(),
    });
    const partnershipId = ulid();
    const lastReq = await db(TABLES.PartnershipRequest).where({ creatorId: creatorRes.body.creator.id }).first();
    await db(TABLES.Partnership).insert({
      id: partnershipId,
      requestId: lastReq!.id,
      offeringId,
      vendorId: vendorRes.body.vendor.id,
      creatorId: creatorRes.body.creator.id,
      vendorPartnerId: 'phantom',
      vendorLinkKey: 'drift',
      publicShareUrl: 'http://127.0.0.1:1/r/drift',
      status: 'active',
    });

    const earnings = await request(app)
      .get('/network/partnerships/earnings')
      .set('Authorization', `Bearer ${creatorKey}`);
    expect(earnings.status).toBe(200);
    expect(earnings.body.partnerships).toHaveLength(1);
    expect(earnings.body.partnerships[0].status).toBe('error');
    expect(earnings.body.totals.unreachable).toBe(1);
    expect(earnings.body.totals.clicks).toBe(0);
  });

  it('full network federation works with a scoped key (not admin)', async () => {
    // Mint a scoped key on the "vendor instance" with exactly the
    // federation permission set. Register the vendor with THAT key.
    const scopedMint = await request(app)
      .post('/api-keys/scoped')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ scopes: ['partners:write', 'partners:read', 'links:write', 'commissions:read'] });
    const scopedKey = scopedMint.body.plaintext as string;

    const campaign = (await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Scoped test', commissionRule: { type: 'percent', value: 15 } })).body;

    const vendorRes = await request(app)
      .post('/network/vendors')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'ScopedCo',
        slug: `scoped-${Date.now()}`,
        instanceUrl,
        instanceKey: scopedKey, // <-- scoped, not ADMIN_KEY
        routerUrl: instanceUrl,
      });
    const vendorKey = vendorRes.body.apiKey;
    await request(app).post(`/network/vendors/${vendorRes.body.vendor.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const offeringId = (await request(app)
      .post('/network/offerings')
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({
        title: 'Scoped offering',
        productUrl: 'https://example.com',
        vendorCampaignId: campaign.id,
        terms: { payout: { type: 'recurring_percent', percent: 15, durationMonths: null }, cookieWindowDays: 45 },
        published: true,
      })).body.offering.id;

    const creatorRes = await request(app)
      .post('/network/creators')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Scopy', handle: `scopy_${Date.now()}`, email: `scopy${Date.now()}@e.com` });
    const creatorKey = creatorRes.body.apiKey;
    await request(app).post(`/network/creators/${creatorRes.body.creator.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const applyRes = await request(app)
      .post('/network/requests')
      .set('Authorization', `Bearer ${creatorKey}`)
      .send({ offeringId, promoCode: 'scopyshares' });

    const approveRes = await request(app)
      .post(`/network/requests/${applyRes.body.request.id}/approve`)
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.federated.linkKey).toBe('scopyshares');

    // Federated read (commissions:read) works too.
    const earnings = await request(app)
      .get('/network/partnerships/earnings')
      .set('Authorization', `Bearer ${creatorKey}`);
    expect(earnings.status).toBe(200);
    expect(earnings.body.partnerships[0].status).toBe('ok');
  });

  it('verify-key endpoint flags unrestricted admin keys and accepts proper scoped keys', async () => {
    // Unrestricted admin → warn.
    const adminCheck = await request(app)
      .post('/network/vendors/verify-key')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ instanceUrl, instanceKey: ADMIN_KEY });
    expect(adminCheck.status).toBe(200);
    expect(adminCheck.body.unrestricted).toBe(true);
    expect(adminCheck.body.acceptable).toBe(true);

    // Scoped with all required → acceptable, missing=[].
    const fullyScoped = await request(app)
      .post('/api-keys/scoped')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ scopes: ['partners:write', 'partners:read', 'links:write', 'commissions:read'] });
    const okCheck = await request(app)
      .post('/network/vendors/verify-key')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ instanceUrl, instanceKey: fullyScoped.body.plaintext });
    expect(okCheck.status).toBe(200);
    expect(okCheck.body.unrestricted).toBe(false);
    expect(okCheck.body.missing).toEqual([]);
    expect(okCheck.body.acceptable).toBe(true);

    // Scoped with only some → missing listed.
    const partial = await request(app)
      .post('/api-keys/scoped')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ scopes: ['partners:write'] });
    const missCheck = await request(app)
      .post('/network/vendors/verify-key')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ instanceUrl, instanceKey: partial.body.plaintext });
    expect(missCheck.status).toBe(200);
    expect(missCheck.body.missing).toEqual(
      expect.arrayContaining(['partners:read', 'links:write', 'commissions:read']),
    );
    expect(missCheck.body.acceptable).toBe(false);
  });

  it('creator profile patch + directory visibility', async () => {
    const creatorRes = await request(app)
      .post('/network/creators')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Start', handle: `start_${Date.now()}`, email: `start${Date.now()}@e.com` });
    const creatorKey = creatorRes.body.apiKey;
    const creatorId = creatorRes.body.creator.id;

    // Inactive creators don't appear in the public directory.
    let dir = await request(app).get('/network/directory/creators');
    expect(dir.body.creators.find((c: { id: string }) => c.id === creatorId)).toBeUndefined();

    await request(app).post(`/network/creators/${creatorId}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    dir = await request(app).get('/network/directory/creators');
    expect(dir.body.creators.find((c: { id: string }) => c.id === creatorId)).toBeDefined();

    // Self-edit persists.
    const patch = await request(app)
      .patch('/network/creators/me')
      .set('Authorization', `Bearer ${creatorKey}`)
      .send({
        name: 'Patched',
        bio: 'I publish on YouTube.',
        defaultPromoCode: 'patchedcode',
        platforms: [{ platform: 'youtube', url: 'https://youtube.com/@patched', followers: 50000 }],
      });
    expect(patch.status).toBe(200);
    expect(patch.body.creator.name).toBe('Patched');
    expect(patch.body.creator.bio).toBe('I publish on YouTube.');
    expect(patch.body.creator.defaultPromoCode).toBe('patchedcode');
    expect(patch.body.creator.platforms).toHaveLength(1);

    // Handle is not in the PATCH schema — it stays pinned.
    const handleAttempt = await request(app)
      .patch('/network/creators/me')
      .set('Authorization', `Bearer ${creatorKey}`)
      .send({ handle: 'renamed' });
    expect(handleAttempt.status).toBe(200);
    expect(handleAttempt.body.creator.handle).not.toBe('renamed');
  });

  it('vendor invite via /network/invites creates a pending request', async () => {
    const campaign = (await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Inv', commissionRule: { type: 'percent', value: 10 } })).body;

    const vendorRes = await request(app)
      .post('/network/vendors')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'InviteVendor', slug: `inv-${Date.now()}`, instanceUrl, instanceKey: ADMIN_KEY });
    const vendorKey = vendorRes.body.apiKey;
    await request(app).post(`/network/vendors/${vendorRes.body.vendor.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const offering = (await request(app)
      .post('/network/offerings')
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({
        title: 'Invite offering',
        productUrl: 'https://example.com',
        vendorCampaignId: campaign.id,
        terms: { payout: { type: 'one_time_fee', amount: 1 }, cookieWindowDays: 30 },
        published: true,
      })).body.offering;

    const creator = (await request(app)
      .post('/network/creators')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Targ', handle: `targ_${Date.now()}`, email: `targ${Date.now()}@e.com` })).body;
    await request(app).post(`/network/creators/${creator.creator.id}/activate`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const invite = await request(app)
      .post('/network/invites')
      .set('Authorization', `Bearer ${vendorKey}`)
      .send({
        offeringId: offering.id,
        creatorId: creator.creator.id,
        message: 'Want to be part of this?',
        promoCode: 'targshare',
      });
    expect(invite.status).toBe(201);
    expect(invite.body.request.direction).toBe('vendor_to_creator');
    expect(invite.body.request.promoCode).toBe('targshare');
  });

  it('encryption round-trips', async () => {
    const { encryptKey, decryptKey } = await import('../network/crypto.js');
    const enc = encryptKey('hello-secret-key');
    expect(enc).not.toContain('hello');
    expect(decryptKey(enc)).toBe('hello-secret-key');
  });
});
