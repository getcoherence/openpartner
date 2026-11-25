/**
 * Ops console: the date self-hosted brands must be paying for Network access
 * from (openpartner-network selfhost-billing.ts). The setting lives on the
 * Network; these routes read it, and set it as the signed-in operator with
 * an audit row. A fake Network stands in for the coordinator.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type PlatformAdminRow } from '@openpartner/db';

const ADMIN_EMAIL = 'ops-shnb@openpartner.test';
const SUPPORT_EMAIL = 'support-shnb@openpartner.test';
process.env.ADMIN_API_KEY = 'op_test_shnb_0123456789abcdef0123456789';
// The ops console only exists on the hosted (multi-tenant) platform.
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.NETWORK_ADMIN_API_KEY = 'netadm_test_key_0123456789abcdef';
delete process.env.NETWORK_URL;
delete process.env.PLATFORM_OPS_EMAIL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import('../platform-admin-sessions.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

interface NetCall { method: string; path: string; authorization?: string; body: unknown }
let netServer: Server;
let netUrl = '';
let netCalls: NetCall[] = [];
const operatorIds: string[] = [];

const STATE = {
  settings: { requiredFrom: null, graceDays: 14 },
  defaults: { requiredFrom: null, graceDays: 14 },
  maxGraceDays: 90,
  updatedAt: null,
  updatedByEmail: null,
  vendors: { listed: 2, paying: 1, held: 0 },
};

beforeAll(async () => {
  if (skipIntegration) return;
  await new Promise<void>((resolve) => {
    netServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        netCalls.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/admin/self-hosted-billing' && req.method === 'GET') return res.end(JSON.stringify(STATE));
        if (req.url === '/admin/self-hosted-billing' && req.method === 'PUT') {
          return res.end(
            JSON.stringify({
              settings: { requiredFrom: body.requiredFrom, graceDays: body.graceDays },
              updatedAt: new Date().toISOString(),
              sweep: { noticed: 1, held: 0, released: 0 },
              vendors: STATE.vendors,
            }),
          );
        }
        res.end(JSON.stringify({ ok: true }));
      });
    }).listen(0, '127.0.0.1', () => {
      netUrl = `http://127.0.0.1:${(netServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterEach(() => {
  netCalls = [];
  delete process.env.NETWORK_URL;
});

afterAll(async () => {
  if (netServer) await new Promise<void>((r) => netServer.close(() => r()));
  if (skipIntegration) return;
  if (operatorIds.length) {
    await db(TABLES.PlatformAdminSession).whereIn('platformAdminId', operatorIds).del();
    await db(TABLES.PlatformAuditLog).whereIn('platformAdminId', operatorIds).del();
    await db(TABLES.PlatformAdmin).whereIn('id', operatorIds).del();
  }
});

async function operator(role: 'admin' | 'support'): Promise<string> {
  const email = role === 'admin' ? ADMIN_EMAIL : SUPPORT_EMAIL;
  let row = await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ email }).first();
  if (!row) {
    row = { id: ulid(), email, name: 'Ops', role, createdAt: new Date(), revokedAt: null };
    await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(row);
  }
  if (!operatorIds.includes(row.id)) operatorIds.push(row.id);
  const session = await createPlatformAdminSession(db, row);
  return `${PLATFORM_ADMIN_SESSION_COOKIE}=${session.plaintext}`;
}

describe.skipIf(skipIntegration)('ops: self-hosted Network subscription date', () => {
  it('reads the Network setting', async () => {
    process.env.NETWORK_URL = netUrl;
    const res = await request(app).get('/platform-admin/fees/self-hosted-network').set('Cookie', await operator('support'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ settings: { requiredFrom: null, graceDays: 14 }, vendors: { listed: 2, paying: 1 } });
    expect(netCalls[0]).toMatchObject({ method: 'GET', path: '/admin/self-hosted-billing', authorization: 'Bearer netadm_test_key_0123456789abcdef' });
  });

  it('sets it as the operator, with an audit row carrying the sweep', async () => {
    process.env.NETWORK_URL = netUrl;
    const requiredFrom = '2027-01-01T00:00:00.000Z';
    const res = await request(app)
      .put('/platform-admin/fees/self-hosted-network')
      .set('Cookie', await operator('admin'))
      .send({ requiredFrom, graceDays: 10 });
    expect(res.status).toBe(200);
    expect(res.body.sweep).toEqual({ noticed: 1, held: 0, released: 0 });
    expect(netCalls[0]).toMatchObject({
      method: 'PUT',
      path: '/admin/self-hosted-billing',
      body: { requiredFrom, graceDays: 10, updatedByEmail: ADMIN_EMAIL },
    });
    const audit = await db(TABLES.PlatformAuditLog)
      .where({ platformAdminEmail: ADMIN_EMAIL, action: 'fees.self_hosted_network' })
      .orderBy('createdAt', 'desc')
      .first();
    expect(audit?.detail).toMatchObject({ requiredFrom, graceDays: 10, sweep: { noticed: 1 } });
  });

  it('turns the gate off with a null date', async () => {
    process.env.NETWORK_URL = netUrl;
    const res = await request(app)
      .put('/platform-admin/fees/self-hosted-network')
      .set('Cookie', await operator('admin'))
      .send({ requiredFrom: null, graceDays: 14 });
    expect(res.status).toBe(200);
    expect(netCalls[0]?.body).toMatchObject({ requiredFrom: null, graceDays: 14 });
  });

  it('refuses read-only operators and bad input before calling the Network', async () => {
    process.env.NETWORK_URL = netUrl;
    const support = await request(app)
      .put('/platform-admin/fees/self-hosted-network')
      .set('Cookie', await operator('support'))
      .send({ requiredFrom: null, graceDays: 14 });
    expect(support.status).toBe(403);

    const cookie = await operator('admin');
    for (const body of [{ requiredFrom: 'soon', graceDays: 14 }, { requiredFrom: null, graceDays: 91 }, { requiredFrom: null }]) {
      expect((await request(app).put('/platform-admin/fees/self-hosted-network').set('Cookie', cookie).send(body)).status).toBe(400);
    }
    expect(netCalls).toHaveLength(0);
  });

  it('answers 503 when no Network is configured', async () => {
    const res = await request(app).get('/platform-admin/fees/self-hosted-network').set('Cookie', await operator('support'));
    expect(res.status).toBe(503);
  });
});
