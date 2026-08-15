/**
 * Vendor-side admin proxy routes for Network billing.
 *
 * Spins up a local HTTP server acting as the Network's billing
 * endpoints (GET /vendors/me/billing, POST /vendors/me/billing/checkout,
 * POST /vendors/me/billing/portal). Verifies the openpartner main side
 * forwards correctly with the right bearer + body, surfaces Network
 * errors as the right HTTP status, and gates on admin auth.
 *
 * Skipped if DATABASE_URL isn't set.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { encryptSecret } from '../crypto.js';

const ADMIN_KEY = 'op_test_billing_proxy_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';
process.env.OPENPARTNER_TENANCY = process.env.OPENPARTNER_TENANCY ?? 'single';
process.env.PORTAL_URL = process.env.PORTAL_URL ?? 'http://localhost:5673';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

interface NetCall {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
}

let receiver: Server;
let receiverUrl: string;
const calls: NetCall[] = [];
let nextResponse: { status: number; body: unknown } = {
  status: 200,
  body: {
    billingRequired: true,
    bundledWithMainPlan: false,
    subscriptionStatus: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodEnd: null,
    networkPriceConfigured: true,
    networkUsagePriceConfigured: true,
    billingEnabled: true,
  },
};

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        calls.push({
          method: req.method ?? '',
          path: req.url ?? '',
          body,
          authorization: req.headers.authorization,
        });
        res.writeHead(nextResponse.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(nextResponse.body));
      });
    }).listen(0, '127.0.0.1', () => {
      const addr = receiver.address() as AddressInfo;
      receiverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (receiver) await new Promise<void>((r) => receiver.close(() => r()));
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  await db(TABLES.Config).whereIn('tenantId', [DEFAULT_TENANT_ID]).del();
  calls.length = 0;
});

async function configureNetwork(opts: { enabled: boolean }): Promise<void> {
  const value = {
    enabled: opts.enabled,
    networkUrl: receiverUrl,
    vendorTokenCiphertext: encryptSecret('vntok_proxytest'),
    scopedKeyId: null,
    autoEnroll: true,
  };
  await db(TABLES.Config)
    .insert({
      tenantId: DEFAULT_TENANT_ID,
      key: 'network_membership',
      value: value as unknown as never,
      updatedAt: new Date(),
    })
    .onConflict(['tenantId', 'key'])
    .merge({ value: value as unknown as never, updatedAt: new Date() });
}

describe.skipIf(skipIntegration)('GET /admin/network/billing', () => {
  it('proxies with vendor bearer + returns Network payload', async () => {
    await configureNetwork({ enabled: true });
    const res = await request(app)
      .get('/admin/network/billing')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.billingRequired).toBe(true);
    expect(res.body.networkPriceConfigured).toBe(true);

    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.path).toBe('/vendors/me/billing');
    expect(call.authorization).toBe('Bearer vntok_proxytest');
  });

  it('without Network configured: 503 network_call_failed', async () => {
    const res = await request(app)
      .get('/admin/network/billing')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('network_call_failed');
    expect(calls).toHaveLength(0);
  });

  it('without admin auth: 401', async () => {
    await configureNetwork({ enabled: true });
    const res = await request(app).get('/admin/network/billing');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('Network 5xx surfaces as 5xx network_call_failed', async () => {
    await configureNetwork({ enabled: true });
    nextResponse = { status: 503, body: { error: 'billing_not_configured' } };
    const res = await request(app)
      .get('/admin/network/billing')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('network_call_failed');
  });
});

describe.skipIf(skipIntegration)('POST /admin/network/billing/checkout', () => {
  it('forwards body + returns Stripe URL from Network', async () => {
    await configureNetwork({ enabled: true });
    nextResponse = { status: 200, body: { url: 'https://checkout.stripe.test/cs_xxx' } };
    const res = await request(app)
      .post('/admin/network/billing/checkout')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        successUrl: 'https://acme.example.test/admin/network/billing?subscribed=1',
        cancelUrl: 'https://acme.example.test/admin/network/billing',
      });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.test/cs_xxx');

    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/vendors/me/billing/checkout');
    expect((call.body as { successUrl: string }).successUrl).toContain('subscribed=1');
  });

  it('rejects malformed body', async () => {
    await configureNetwork({ enabled: true });
    const res = await request(app)
      .post('/admin/network/billing/checkout')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ successUrl: 'not-a-url', cancelUrl: 'also-not' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
    expect(calls).toHaveLength(0);
  });

  it('Network 400 (e.g. bundled_with_main_plan) surfaces as 400', async () => {
    await configureNetwork({ enabled: true });
    nextResponse = { status: 400, body: { error: 'billing_bundled_with_main_plan' } };
    const res = await request(app)
      .post('/admin/network/billing/checkout')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        successUrl: 'https://acme.example.test/ok',
        cancelUrl: 'https://acme.example.test/x',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('network_call_failed');
    expect(res.body.detail).toContain('billing_bundled_with_main_plan');
  });
});

describe.skipIf(skipIntegration)('POST /admin/network/billing/portal', () => {
  it('forwards returnUrl + returns portal URL', async () => {
    await configureNetwork({ enabled: true });
    nextResponse = { status: 200, body: { url: 'https://billing-portal.stripe.test/bp_xxx' } };
    const res = await request(app)
      .post('/admin/network/billing/portal')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ returnUrl: 'https://acme.example.test/admin/network/billing' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://billing-portal.stripe.test/bp_xxx');

    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/vendors/me/billing/portal');
    expect((call.body as { returnUrl: string }).returnUrl).toBe('https://acme.example.test/admin/network/billing');
  });

  it('rejects malformed returnUrl', async () => {
    await configureNetwork({ enabled: true });
    const res = await request(app)
      .post('/admin/network/billing/portal')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ returnUrl: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });
});
