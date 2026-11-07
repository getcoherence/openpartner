/**
 * Partner Discover's proxies onto the Network's public feeds, in the brand
 * portal (/network/discover):
 *
 *   GET /network/discover/brands → GET /marketplace/brands (one entry per brand)
 *   GET /network/discover        → GET /offerings (the per-program feed, which
 *                                  the portal groups on a Network without the
 *                                  brand feed)
 *
 * Both are public on the Network, so they go with the brand's bearer and no
 * x-act-as-vendor-partner header. A Network without the brand feed answers
 * 404, which has to reach the portal as 404 for it to fall back. A local HTTP
 * server plays the Network. Skipped if DATABASE_URL isn't set.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { encryptSecret } from '../crypto.js';
import { createSession } from '../auth-sessions.js';

process.env.OPENPARTNER_MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';
process.env.OPENPARTNER_TENANCY = process.env.OPENPARTNER_TENANCY ?? 'single';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

interface NetCall {
  method: string;
  path: string;
  actingAs: string | undefined;
  authorization: string | undefined;
}

let receiver: Server;
let receiverUrl: string;
const calls: NetCall[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    receiver = createServer((req, res) => {
      calls.push({
        method: req.method ?? '',
        path: req.url ?? '',
        actingAs: req.headers['x-act-as-vendor-partner'] as string | undefined,
        authorization: req.headers.authorization,
      });
      res.writeHead(nextResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextResponse.body));
    }).listen(0, '127.0.0.1', () => {
      receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
      resolve();
    });
  });

  const value = {
    enabled: true,
    networkUrl: receiverUrl,
    vendorTokenCiphertext: encryptSecret('vntok_discovertest'),
    scopedKeyId: null,
    autoEnroll: true,
  };
  await db(TABLES.Config).insert({
    tenantId: DEFAULT_TENANT_ID,
    key: 'network_membership',
    value: value as unknown as never,
    updatedAt: new Date(),
  });
  partnerId = ulid();
  await db(TABLES.Partner).insert({
    id: partnerId,
    tenantId: DEFAULT_TENANT_ID,
    email: 'discover-partner@example.test',
    name: 'Dee Discover',
    activatedAt: new Date(),
  });
  const session = await createSession(db, { tenantId: DEFAULT_TENANT_ID, principalKind: 'partner', principalId: partnerId });
  cookie = `op_session=${session.plaintext}`;
});

afterAll(async () => {
  if (receiver) await new Promise<void>((r) => receiver.close(() => r()));
  if (!skipIntegration) {
    await db(TABLES.Session).where({ tenantId: DEFAULT_TENANT_ID, principalId: partnerId }).del();
    await db(TABLES.Partner).where({ id: partnerId }).del();
    await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();
  }
  await db.destroy();
});

let partnerId: string;
let cookie: string;

beforeEach(() => {
  calls.length = 0;
  nextResponse = { status: 200, body: {} };
});

function expectPublicCall(path: string): void {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe('GET');
  expect(calls[0]?.path).toBe(path);
  expect(calls[0]?.authorization).toBe('Bearer vntok_discovertest');
  expect(calls[0]?.actingAs).toBeUndefined();
}

describe.skipIf(skipIntegration)('GET /network/discover/brands', () => {
  it('forwards sort and limit to the Network’s brand feed and returns it as is', async () => {
    const brands = [{ vendorId: 'vnd_1', vendorName: 'Mixed Media', programCount: 2, offerings: [] }];
    nextResponse = { status: 200, body: { brands } };
    const res = await request(app)
      .get('/network/discover/brands?limit=100&sort=popular&q=ignored')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ brands });
    expectPublicCall('/marketplace/brands?sort=popular&limit=100');
  });

  it('passes a Network’s 404 through, so the portal can fall back', async () => {
    nextResponse = { status: 404, body: { error: 'not_found' } };
    const res = await request(app).get('/network/discover/brands?limit=100').set('Cookie', cookie);
    expect(res.status).toBe(404);
    expectPublicCall('/marketplace/brands?limit=100');
  });

  it('needs a signed-in caller', async () => {
    const res = await request(app).get('/network/discover/brands');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('GET /network/discover', () => {
  it('forwards the limit the fallback asks for', async () => {
    nextResponse = { status: 200, body: { offerings: [] } };
    const res = await request(app).get('/network/discover?limit=100&sort=popular').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expectPublicCall('/offerings?sort=popular&limit=100');
  });
});
