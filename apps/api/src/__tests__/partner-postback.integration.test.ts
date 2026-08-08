/**
 * Partner postback end-to-end integration test.
 *
 * Spins up a local capturing HTTP server to act as the partner's
 * tracker, wires a PartnerPostback row pointing at it with macro
 * placeholders in the URL, runs the full click → identify → event
 * pipeline, and asserts:
 *   - the tracker received a GET with the substituted macros
 *   - the PartnerPostback row's audit counters bumped
 *
 * Skipped when DATABASE_URL isn't set (matches the rest of the
 * integration suite).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type PartnerPostbackRow } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_postback_admin_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';
process.env.OPENPARTNER_MODE = 'selfhost';
// The capturing receiver binds 127.0.0.1; the SSRF guard blocks private IPs
// by default. Self-host-only escape hatch (mode=selfhost + tenancy=single).
process.env.OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS = '127.0.0.1/32,::1/128';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

interface CapturedCall {
  url: string;
  method: string;
}

let receiver: Server;
let receiverUrl: string;
const calls: CapturedCall[] = [];

const TABLES_TO_CLEAN = [
  TABLES.PartnerPostback,
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
  TABLES.ApiKey,
  TABLES.Partner,
  TABLES.Config,
];

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    receiver = createServer((req, res) => {
      calls.push({ method: req.method ?? '', url: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }).listen(0, '127.0.0.1', () => {
      const addr = receiver.address() as AddressInfo;
      receiverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (receiver) await new Promise<void>((r) => receiver.close(() => r()));
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) await db(t).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
  calls.length = 0;
});

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timeout');
}

describe.skipIf(skipIntegration)('partner postback', () => {
  it('fires a substituted GET when commission.accrued lands', async () => {
    // 1. Set up a brand-side partner + campaign + link via the API so
    //    Campaign / PartnerCampaign / Link rows are realistic.
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'pb-test@example.com', name: 'Postback Test' });
    expect(partnerRes.status).toBe(201);
    const partnerId = partnerRes.body.id;

    const campaignRes = await request(app)
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'PB',
        commissionRule: { type: 'percent', value: 20 },
        destinationUrl: 'https://example.com/signup',
      });
    expect(campaignRes.status).toBe(201);
    const programId = campaignRes.body.id;

    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `pb_${Date.now()}`, programId });
    expect(linkRes.status).toBe(201);

    // 2. Register a partner postback against the local capturing server.
    await db<PartnerPostbackRow>(TABLES.PartnerPostback).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      url: `${receiverUrl}/cb?cid={click_id}&amt={commission_amount}&cur={currency}&tx={transaction_id}`,
      events: JSON.stringify(['commission.accrued']) as never,
      enabled: true,
    });

    // 3. Drive the full pipeline. Insert a click directly (the router
    //    would normally do this), stitch identity, fire a server-side
    //    revenue event.
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: linkRes.body.id,
      partnerId,
      programId,
      landingUrl: 'https://example.com/signup',
      ipHash: 'test-hash',
      userAgent: 'test',
      referer: null,
      fraudFlag: null,
    });

    const userId = `u_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });
    const eventRes = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 100, currency: 'USD' });
    expect(eventRes.status).toBe(200);

    // 4. Postback fires asynchronously via dispatchEvent — wait for it.
    await waitFor(async () => (calls.length > 0 ? calls[0] : null));

    expect(calls).toHaveLength(1);
    const captured = calls[0]!;
    expect(captured.method).toBe('GET');
    // URL-encoded substitution: macros replaced, structure preserved.
    expect(captured.url).toMatch(/^\/cb\?/);
    expect(captured.url).toContain(`cid=${clickId}`);
    expect(captured.url).toContain('amt=20.00');
    expect(captured.url).toContain('cur=USD');
    // transaction_id is the alias for event_id — verify the alias path
    // resolves to a non-empty string (the actual event id is generated
    // server-side so we just check it's there).
    expect(captured.url).toMatch(/tx=[A-Z0-9]/);

    // 5. Audit counters bumped on the row.
    const row = await waitFor(async () =>
      db<PartnerPostbackRow>(TABLES.PartnerPostback)
        .where({ partnerId })
        .first()
        .then((r) => (r && r.successCount > 0 ? r : null)),
    );
    expect(row.successCount).toBe(1);
    expect(row.failureCount).toBe(0);
    expect(row.lastStatus).toBe(200);
    expect(row.lastFiredAt).not.toBeNull();
  });

  it('skips disabled postbacks and postbacks subscribed to other events', async () => {
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'pb-skip@example.com', name: 'Skip' });
    const partnerId = partnerRes.body.id;

    const campaignRes = await request(app)
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'Skip',
        commissionRule: { type: 'percent', value: 10 },
        destinationUrl: 'https://example.com/',
      });
    const programId = campaignRes.body.id;
    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `skip_${Date.now()}`, programId });

    // Disabled postback — should be ignored.
    await db<PartnerPostbackRow>(TABLES.PartnerPostback).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      url: `${receiverUrl}/disabled`,
      events: JSON.stringify(['commission.accrued']) as never,
      enabled: false,
    });
    // Wrong-event postback — should be ignored on commission.accrued.
    await db<PartnerPostbackRow>(TABLES.PartnerPostback).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      url: `${receiverUrl}/paid-only`,
      events: JSON.stringify(['commission.paid']) as never,
      enabled: true,
    });

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: linkRes.body.id,
      partnerId,
      programId,
      landingUrl: 'https://example.com/',
      ipHash: 'h',
      userAgent: 't',
      referer: null,
      fraudFlag: null,
    });
    const userId = `u_${Date.now()}_skip`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });
    await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 50, currency: 'USD' });

    // Give the dispatcher a chance to run; nothing should land.
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(0);
  });
});
