/**
 * Outbound webhook integration tests. Spins up a real local HTTP receiver
 * inside the test so we can assert headers, body, and HMAC signature
 * match what a subscriber would see in production.
 */

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_webhook_admin_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

// Receiver state shared across requests inside a single receiver server.
interface Capture {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function makeReceiver(handler: (c: Capture) => { status: number; body?: string }): Promise<{
  url: string;
  captures: Capture[];
  close: () => Promise<void>;
}> {
  const captures: Capture[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const capture: Capture = {
          url: req.url ?? '',
          method: req.method ?? '',
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
          ),
          body,
        };
        captures.push(capture);
        const response = handler(capture);
        res.statusCode = response.status;
        res.end(response.body ?? '');
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        captures,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

const app = createApp({ enableLogger: false });
const TABLES_TO_CLEAN = [
  TABLES.WebhookDelivery,
  TABLES.WebhookEndpoint,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Campaign,
  TABLES.Payout,
  TABLES.ApiKey,
  TABLES.Partner,
  TABLES.Config,
];

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

// waitFor polls until a predicate returns true (the dispatcher is async
// and fires-and-forgets). 2s budget is generous.
async function waitFor<T>(fn: () => Promise<T | null | false>, attempts = 40, stepMs = 50): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}

describe.skipIf(skipIntegration)('webhooks', () => {
  let receiver: Awaited<ReturnType<typeof makeReceiver>>;
  afterEach(async () => {
    if (receiver) await receiver.close();
  });

  it('dispatches commission.paid to a subscribed endpoint with a valid HMAC signature', async () => {
    receiver = await makeReceiver(() => ({ status: 200, body: 'ok' }));

    // Create endpoint + capture the signing secret.
    const createRes = await request(app)
      .post('/webhooks')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ url: receiver.url, events: ['commission.paid'] });
    expect(createRes.status).toBe(201);
    const secret = createRes.body.secret as string;
    const endpointId = createRes.body.endpoint.id as string;

    // Set up a partner + commission; take the full flow: approve + run payouts.
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'wh@e.com', name: 'WH' });
    const partnerId = partnerRes.body.id;
    const campaignRes = await request(app)
      .post('/campaigns')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'WH', commissionRule: { type: 'percent', value: 20 } });
    const campaignId = campaignRes.body.id;
    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `wh_${Date.now()}`, campaignId, destinationUrl: 'https://e.com' });
    const linkId = linkRes.body.id;

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId,
      partnerId,
      campaignId,
      landingUrl: 'x',
      ipHash: 'x',
      userAgent: 'x',
      referer: null,
      fraudFlag: null,
    });
    const userId = `u_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });
    await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 100 });

    // Approve + run payouts — fires commission.approved, payout.created, commission.paid.
    const accrued = await db(TABLES.Commission).where({ partnerId, status: 'accrued' }).first();
    await request(app)
      .post(`/commissions/${accrued!.id}/approve`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    await request(app).post('/payouts/run').set('Authorization', `Bearer ${ADMIN_KEY}`);

    // Wait until the receiver logged a commission.paid capture.
    const capture = await waitFor(async () => receiver.captures.find((c) => c.headers['x-openpartner-event'] === 'commission.paid') ?? null);
    expect(capture.method).toBe('POST');
    expect(capture.headers['content-type']).toContain('application/json');
    expect(capture.headers['x-openpartner-event']).toBe('commission.paid');
    expect(capture.headers['x-openpartner-delivery']).toMatch(/^evt_/);

    // Verify the signature.
    const timestamp = capture.headers['x-openpartner-timestamp']!;
    const signature = capture.headers['x-openpartner-signature']!;
    const expected = createHmac('sha256', secret).update(`${timestamp}.${capture.body}`).digest('hex');
    expect(signature).toBe(expected);

    // Envelope shape.
    const envelope = JSON.parse(capture.body);
    expect(envelope.event).toBe('commission.paid');
    expect(envelope.data.partnerId).toBe(partnerId);
    expect(Number(envelope.data.amount)).toBe(20); // 20% of 100

    // Delivery row is marked delivered.
    const deliveries = await request(app)
      .get(`/webhooks/${endpointId}/deliveries`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    const paid = deliveries.body.deliveries.find((d: { eventType: string }) => d.eventType === 'commission.paid');
    expect(paid.status).toBe('delivered');
    expect(paid.httpStatus).toBe(200);
  });

  it('records failures and supports retry', async () => {
    let mode: 'fail' | 'succeed' = 'fail';
    receiver = await makeReceiver(() => (mode === 'fail' ? { status: 500, body: 'nope' } : { status: 200, body: 'ok' }));

    const createRes = await request(app)
      .post('/webhooks')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ url: receiver.url, events: ['commission.approved'] });
    const endpointId = createRes.body.endpoint.id;

    // Create a commission and approve it → will fire a commission.approved
    // event, receiver returns 500, delivery should be failed.
    const partner = (
      await request(app)
        .post('/partners')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ email: 'r@e.com', name: 'R' })
    ).body;
    const campaign = (
      await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ name: 'R', commissionRule: { type: 'percent', value: 10 } })
    ).body;
    const link = (
      await request(app)
        .post(`/partners/${partner.id}/links`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ linkKey: `r_${Date.now()}`, campaignId: campaign.id, destinationUrl: 'https://e.com' })
    ).body;
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: link.id,
      partnerId: partner.id,
      campaignId: campaign.id,
      landingUrl: 'x',
      ipHash: 'x',
      userAgent: 'x',
      referer: null,
      fraudFlag: null,
    });
    const uid = `ru_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId: uid });
    await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId: uid, type: 'invoice_paid', value: 100 });
    const accrued = await db(TABLES.Commission).where({ partnerId: partner.id, status: 'accrued' }).first();
    await request(app).post(`/commissions/${accrued!.id}/approve`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    const delivery = await waitFor(async () => {
      const list = await db(TABLES.WebhookDelivery).where({ endpointId }).orderBy('createdAt', 'desc').first();
      return list?.status === 'failed' ? list : null;
    });
    expect(delivery.httpStatus).toBe(500);
    expect(delivery.attempts).toBe(1);

    // Flip the receiver + retry via the admin endpoint.
    mode = 'succeed';
    const retryRes = await request(app)
      .post(`/webhooks/${endpointId}/deliveries/${delivery.id}/retry`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.delivery.status).toBe('delivered');
    expect(retryRes.body.delivery.attempts).toBe(2);
    expect(retryRes.body.delivery.httpStatus).toBe(200);
  });

  it('skips endpoints that are inactive or subscribed to other events', async () => {
    receiver = await makeReceiver(() => ({ status: 200, body: 'ok' }));

    // One active endpoint for commission.approved only. One inactive.
    const active = (
      await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ url: receiver.url, events: ['commission.approved'] })
    ).body;
    const inactive = (
      await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ url: receiver.url, events: ['commission.paid', 'partnership.approved'] })
    ).body;
    await request(app)
      .patch(`/webhooks/${inactive.endpoint.id}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ active: false });

    // Trigger attribution.created → neither endpoint should fire since
    // neither is subscribed to it AND the second is inactive anyway.
    const partner = (
      await request(app)
        .post('/partners')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ email: 's@e.com', name: 'S' })
    ).body;
    const campaign = (
      await request(app)
        .post('/campaigns')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ name: 'S', commissionRule: { type: 'percent', value: 10 } })
    ).body;
    const link = (
      await request(app)
        .post(`/partners/${partner.id}/links`)
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ linkKey: `s_${Date.now()}`, campaignId: campaign.id, destinationUrl: 'https://e.com' })
    ).body;
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: link.id,
      partnerId: partner.id,
      campaignId: campaign.id,
      landingUrl: 'x',
      ipHash: 'x',
      userAgent: 'x',
      referer: null,
      fraudFlag: null,
    });
    const uid = `su_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId: uid });
    await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId: uid, type: 'invoice_paid', value: 50 });

    // attribution.created fired, but neither endpoint subscribed.
    await new Promise((r) => setTimeout(r, 300));
    const attributionCaptures = receiver.captures.filter(
      (c) => c.headers['x-openpartner-event'] === 'attribution.created',
    );
    expect(attributionCaptures).toHaveLength(0);

    // Approve to trigger commission.approved — the ACTIVE endpoint
    // subscribed to it fires. The inactive one, subscribed to other
    // events anyway, does not.
    const accrued = await db(TABLES.Commission).where({ partnerId: partner.id, status: 'accrued' }).first();
    await request(app).post(`/commissions/${accrued!.id}/approve`).set('Authorization', `Bearer ${ADMIN_KEY}`);

    await waitFor(async () => {
      const d = await db(TABLES.WebhookDelivery).where({ endpointId: active.endpoint.id }).first();
      return d?.status === 'delivered' ? d : null;
    });

    const activeDeliveries = await db(TABLES.WebhookDelivery).where({ endpointId: active.endpoint.id });
    expect(activeDeliveries).toHaveLength(1);
    expect(activeDeliveries[0]!.eventType).toBe('commission.approved');

    const inactiveDeliveries = await db(TABLES.WebhookDelivery).where({ endpointId: inactive.endpoint.id });
    expect(inactiveDeliveries).toHaveLength(0);
  });

  it('PATCH updates url/events/active; DELETE soft-disables by default', async () => {
    receiver = await makeReceiver(() => ({ status: 200 }));
    const createRes = await request(app)
      .post('/webhooks')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ url: receiver.url, events: ['commission.paid'], label: 'first' });
    const id = createRes.body.endpoint.id;

    const patch = await request(app)
      .patch(`/webhooks/${id}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ events: ['*'], label: 'everything' });
    expect(patch.status).toBe(200);
    expect(patch.body.endpoint.events).toEqual(['*']);
    expect(patch.body.endpoint.label).toBe('everything');

    await request(app).delete(`/webhooks/${id}`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    const after = await db(TABLES.WebhookEndpoint).where({ id }).first();
    expect(after).toBeDefined();
    expect(after!.active).toBe(false);
  });
});
