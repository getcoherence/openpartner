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

  it('encryption round-trips', async () => {
    const { encryptKey, decryptKey } = await import('../network/crypto.js');
    const enc = encryptKey('hello-secret-key');
    expect(enc).not.toContain('hello');
    expect(decryptKey(enc)).toBe('hello-secret-key');
  });
});
