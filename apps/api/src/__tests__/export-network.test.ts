/**
 * The brand's Network records in the workspace export (GET /export.json →
 * `network`): its storefront conversations, messages and bookings, read from
 * the Network's GET /vendors/me/export.
 *
 *   - On the Network: the rows come back under `network.tables`, fetched
 *     with the brand's vendor token.
 *   - Not on the Network (no membership, or disabled): `not_connected`, and
 *     no call.
 *   - A Network outage, error or garbled answer never fails the export: the
 *     local tables come back and `network` says `skipped` and why.
 *   - POST /import takes the bundle as it was downloaded and ignores the
 *     section.
 *
 * A local HTTP server plays the Network. Skipped if DATABASE_URL isn't set.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { encryptSecret } from '../crypto.js';

const ADMIN_KEY = 'op_test_export_network_0123456789abcdef01';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = process.env.OPENPARTNER_TENANCY ?? 'single';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const NETWORK_EXPORT = {
  exportedAt: '2026-10-25T09:00:00.000Z',
  vendorId: 'ven_acme',
  tables: {
    Conversation: [{ id: 'cnv_1', creatorId: 'crt_ada', vendorId: 'ven_acme', vendorNotifyEmail: 'grace@acme.test' }],
    ConversationMessage: [
      { id: 'cnm_1', conversationId: 'cnv_1', author: 'vendor', authorName: 'Grace', kind: 'text', body: 'Hi Ada!' },
      { id: 'cnm_2', conversationId: 'cnv_1', author: 'system', kind: 'event', event: 'paid', bookingId: 'bkr_1' },
    ],
    BookingRequest: [
      { id: 'bkr_1', creatorId: 'crt_ada', vendorId: 'ven_acme', status: 'paid', amountMinor: 100000, feeMinor: 10000, paymentIntentId: 'pi_1' },
    ],
  },
  creators: [{ id: 'crt_ada', name: 'Ada Lovelace', handle: 'ada', avatarUrl: null }],
};

interface NetCall {
  method: string;
  path: string;
  authorization: string | undefined;
}

let network: Server;
let networkUrl: string;
/** A port nothing listens on. */
let deadUrl: string;
const calls: NetCall[] = [];
let reply: { status: number; body: string; dropMidBody?: boolean } = { status: 200, body: JSON.stringify(NETWORK_EXPORT) };

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  network = createServer((req, res) => {
    calls.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    if (reply.dropMidBody) {
      res.write(reply.body.slice(0, 20));
      res.flushHeaders();
      setTimeout(() => req.socket.destroy(), 50);
      return;
    }
    res.end(reply.body);
  });
  networkUrl = await listen(network);
  const closed = createServer();
  deadUrl = await listen(closed);
  await new Promise<void>((r) => closed.close(() => r()));
});

async function clean(): Promise<void> {
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();
  await db(TABLES.Partner).where({ tenantId: DEFAULT_TENANT_ID, email: 'export-network@example.test' }).del();
}

afterAll(async () => {
  if (network) await new Promise<void>((r) => network.close(() => r()));
  if (!skipIntegration) await clean();
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  await clean();
  calls.length = 0;
  reply = { status: 200, body: JSON.stringify(NETWORK_EXPORT) };
});

async function joinNetwork(opts: { enabled?: boolean; url?: string; token?: boolean } = {}): Promise<void> {
  const value = {
    enabled: opts.enabled ?? true,
    networkUrl: opts.url ?? networkUrl,
    vendorTokenCiphertext: opts.token === false ? '' : encryptSecret('vntok_exporttest'),
    scopedKeyId: null,
    autoEnroll: false,
  };
  await db(TABLES.Config)
    .insert({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership', value: value as unknown as never, updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: value as unknown as never, updatedAt: new Date() });
}

async function seedPartner(): Promise<string> {
  const [row] = await db(TABLES.Partner)
    .insert({ id: `ptn_exnet_${Date.now()}`, tenantId: DEFAULT_TENANT_ID, email: 'export-network@example.test', name: 'Export Network' })
    .returning('id');
  return (row as { id: string }).id;
}

function exportJson() {
  return request(app).get('/export.json').set('Authorization', `Bearer ${ADMIN_KEY}`);
}

describe.skipIf(skipIntegration)('GET /export.json — network', () => {
  it("includes the brand's Network rows, fetched with its vendor token", async () => {
    await joinNetwork();
    const res = await exportJson();
    expect(res.status).toBe(200);
    expect(res.body.network).toEqual({
      status: 'included',
      exportedAt: NETWORK_EXPORT.exportedAt,
      tables: NETWORK_EXPORT.tables,
      creators: NETWORK_EXPORT.creators,
    });
    expect(calls).toEqual([{ method: 'GET', path: '/vendors/me/export', authorization: 'Bearer vntok_exporttest' }]);
    // The local tables are all still there, and none of them is a Network one.
    expect(Object.keys(res.body.tables)).toContain('Partner');
    expect(res.body.tables.Conversation).toBeUndefined();
  });

  it('says not_connected, and calls nobody, without a vendor token', async () => {
    expect((await exportJson()).body.network).toEqual({ status: 'not_connected' });
    // Connect started but never verified: no token yet.
    await joinNetwork({ enabled: false, token: false });
    expect((await exportJson()).body.network).toEqual({ status: 'not_connected' });
    expect(calls).toHaveLength(0);
  });

  it('still reads the records when the brand switched the Network off', async () => {
    await joinNetwork({ enabled: false });
    expect((await exportJson()).body.network.status).toBe('included');
    expect(calls).toHaveLength(1);
    // Nothing else goes through while it's off.
    const offerings = await request(app).get('/admin/network/offerings').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(offerings.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('a Network error leaves the local export whole and records the skip', async () => {
    const partnerId = await seedPartner();
    await joinNetwork();
    reply = { status: 503, body: '<html>upstream unavailable</html>' };
    const res = await exportJson();
    expect(res.status).toBe(200);
    expect(res.body.network).toEqual({ status: 'skipped', reason: 'network_error', httpStatus: 503 });
    expect(res.body.tables.Partner.map((p: { id: string }) => p.id)).toContain(partnerId);
  });

  it('an unreachable Network is skipped, not an error', async () => {
    await joinNetwork({ url: deadUrl });
    const res = await exportJson();
    expect(res.status).toBe(200);
    expect(res.body.network).toEqual({ status: 'skipped', reason: 'network_unreachable' });
    // So is a connection that drops while the answer is coming in.
    await joinNetwork();
    reply = { status: 200, body: JSON.stringify(NETWORK_EXPORT), dropMidBody: true };
    const dropped = await exportJson();
    expect(dropped.status).toBe(200);
    expect(dropped.body.network).toEqual({ status: 'skipped', reason: 'network_unreachable' });
  });

  it('an answer that is not an export is skipped too', async () => {
    await joinNetwork();
    for (const body of [
      JSON.stringify({ ok: true }),
      'not json',
      // Well-formed, but missing the tables it promises.
      JSON.stringify({ exportedAt: NETWORK_EXPORT.exportedAt, tables: {}, creators: [] }),
      JSON.stringify({ ...NETWORK_EXPORT, exportedAt: 'yesterday' }),
    ]) {
      reply = { status: 200, body };
      expect((await exportJson()).body.network, body).toEqual({ status: 'skipped', reason: 'invalid_response' });
    }
  });

  it('POST /import takes the downloaded bundle and leaves the Network section alone', async () => {
    await seedPartner();
    await joinNetwork();
    const bundle = (await exportJson()).body;
    expect(bundle.network.status).toBe('included');
    const res = await request(app).post('/import').set('Authorization', `Bearer ${ADMIN_KEY}`).send(bundle);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.report.inserted)).not.toContain('Conversation');
    expect(res.body.report.skipped.Partner).toBeGreaterThanOrEqual(1);
  });
});
