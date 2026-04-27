/**
 * End-to-end tests for the creator self-signup flow + Network push.
 *
 * Spins up a local HTTP receiver in-process to act as the Network. The
 * vendor side calls the receiver via the URL we save into
 * `network_membership` Config; assertions cover:
 *
 *   1. Signup without Network: Partner row + magic link, no Network call.
 *   2. Signup with Network ON + autoEnroll: pushes /partners/upsert,
 *      stamps Partner.metadata.network.{creatorId,preExisting}.
 *   3. Signup with Network down: Partner row still created, NetworkOutbox
 *      row enqueued for retry.
 *   4. Backfill reconciliation: a vendor that flips Network on after
 *      having existing partners pushes them all; pre-existing creators
 *      (matching email already on Network) get preExisting=true stamp.
 *   5. Outbox drain: the scheduler-callable drainOutbox retries pending
 *      rows and removes them on success.
 *   6. Admin POST /partners and /partners/:id/revoke also push when
 *      Network is enabled.
 *   7. require_review policy: signup creates Partner with activatedAt=null
 *      and still pushes (status='pending').
 *
 * Skipped if DATABASE_URL isn't set, like the rest of the integration
 * suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_network_admin_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.PORTAL_URL = 'http://localhost:5673';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { drainOutbox } = await import('../network-client.js');
const { encryptSecret } = await import('../crypto.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

// In-process Network receiver. Each test configures `mockResponse` to
// either succeed or fail; `received` captures every call.
interface ReceivedCall {
  path: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}
let receiver: Server;
let receiverUrl: string;
let received: ReceivedCall[] = [];
let mockResponse: { status: number; body: unknown } = {
  status: 200,
  body: { networkCreatorId: 'crt_default', alreadyExisted: false, affiliations: [] },
};
// Email-keyed store so we can simulate Network-side dedup for the
// late-join backfill test. When a request comes in with an email we've
// seen, return the same networkCreatorId + alreadyExisted=true.
const networkCreators = new Map<string, string>();

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        received.push({
          path: req.url ?? '',
          method: req.method ?? '',
          authorization: req.headers.authorization,
          body,
        });
        // Email-dedup simulation for backfill test
        const email = (body && typeof body === 'object' && 'email' in body) ? (body as { email: string }).email : null;
        if (email && networkCreators.has(email)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            networkCreatorId: networkCreators.get(email),
            alreadyExisted: true,
            affiliations: [{ vendorId: 'vnd_other', vendorPartnerId: 'pp_other', status: 'active', displayName: 'Other Vendor' }],
          }));
          return;
        }
        res.writeHead(mockResponse.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(mockResponse.body));
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
  received = [];
  networkCreators.clear();
  mockResponse = {
    status: 200,
    body: { networkCreatorId: `crt_${ulid()}`, alreadyExisted: false, affiliations: [] },
  };
  for (const t of [
    TABLES.NetworkOutbox,
    TABLES.MagicLinkToken,
    TABLES.Partner,
    TABLES.Config,
  ]) {
    await db(t).whereIn('tenantId', [DEFAULT_TENANT_ID]).del();
  }
});

afterEach(async () => {
  if (skipIntegration) return;
  for (const t of [
    TABLES.NetworkOutbox,
    TABLES.MagicLinkToken,
    TABLES.Partner,
    TABLES.Config,
  ]) {
    await db(t).whereIn('tenantId', [DEFAULT_TENANT_ID]).del();
  }
});

async function configureNetwork(opts: { enabled: boolean; autoEnroll?: boolean; url?: string }): Promise<void> {
  const value = {
    enabled: opts.enabled,
    networkUrl: opts.url ?? receiverUrl,
    vendorTokenCiphertext: encryptSecret('vntok_test'),
    scopedKeyId: null,
    autoEnroll: opts.autoEnroll ?? true,
  };
  await db(TABLES.Config)
    .insert({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership', value: value as unknown as never, updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: value as unknown as never, updatedAt: new Date() });
}

describe.skipIf(skipIntegration)('partner-signup + network push', () => {
  it('signup without Network: creates Partner + magic link, no Network call', async () => {
    const res = await request(app)
      .post('/partner-signup')
      .send({ email: 'creator1@example.test', name: 'Creator One' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');

    const partner = await db(TABLES.Partner).where({ email: 'creator1@example.test' }).first();
    expect(partner).toBeDefined();
    expect(partner!.activatedAt).not.toBeNull();
    expect(received).toHaveLength(0);
  });

  it('signup with Network on: pushes /partners/upsert and stamps networkCreatorId', async () => {
    await configureNetwork({ enabled: true });
    const expectedCreatorId = `crt_${ulid()}`;
    mockResponse = {
      status: 200,
      body: {
        networkCreatorId: expectedCreatorId,
        alreadyExisted: false,
        affiliations: [],
      },
    };

    const res = await request(app)
      .post('/partner-signup')
      .send({ email: 'creator2@example.test', name: 'Creator Two' });
    expect(res.status).toBe(201);

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/partners/upsert');
    expect(received[0]!.authorization).toBe('Bearer vntok_test');
    const sent = received[0]!.body as { email: string; metadata?: { source: string } };
    expect(sent.email).toBe('creator2@example.test');
    expect(sent.metadata?.source).toBe('self_signup');

    const partner = await db(TABLES.Partner).where({ email: 'creator2@example.test' }).first();
    const meta = partner!.metadata as { network?: { creatorId: string; preExisting: boolean } };
    expect(meta.network?.creatorId).toBe(expectedCreatorId);
    expect(meta.network?.preExisting).toBe(false);
  });

  it('signup with Network down: Partner row created, NetworkOutbox enqueued', async () => {
    await configureNetwork({ enabled: true });
    mockResponse = { status: 503, body: { error: 'unavailable' } };

    const res = await request(app)
      .post('/partner-signup')
      .send({ email: 'creator3@example.test', name: 'Creator Three' });
    expect(res.status).toBe(201);

    const partner = await db(TABLES.Partner).where({ email: 'creator3@example.test' }).first();
    expect(partner).toBeDefined();

    const outbox = await db(TABLES.NetworkOutbox).where({ tenantId: DEFAULT_TENANT_ID });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.op).toBe('partner_upsert');
    expect(outbox[0]!.attempts).toBe(1);
    expect(outbox[0]!.status).toBe('pending');
  });

  it('drainOutbox retries enqueued rows and deletes them on success', async () => {
    await configureNetwork({ enabled: true });
    // First push fails → enqueued.
    mockResponse = { status: 503, body: {} };
    await request(app)
      .post('/partner-signup')
      .send({ email: 'creator4@example.test', name: 'Creator Four' });
    expect((await db(TABLES.NetworkOutbox)).length).toBe(1);

    // Make outbox row eligible NOW (otherwise nextAttemptAt is in the future).
    await db(TABLES.NetworkOutbox).update({ nextAttemptAt: new Date(Date.now() - 1000) });

    // Recover the Network and drain.
    mockResponse = {
      status: 200,
      body: { networkCreatorId: 'crt_recovered', alreadyExisted: false, affiliations: [] },
    };
    const result = await drainOutbox(db, DEFAULT_TENANT_ID);
    expect(result.drained).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.dead).toBe(0);

    const remaining = await db(TABLES.NetworkOutbox);
    expect(remaining).toHaveLength(0);
  });

  it('require_review policy: Partner created with activatedAt=null and still pushes (status=pending)', async () => {
    await configureNetwork({ enabled: true });
    await db(TABLES.Config)
      .insert({
        tenantId: DEFAULT_TENANT_ID,
        key: 'partner_signup',
        value: { policy: 'require_review' } as unknown as never,
        updatedAt: new Date(),
      })
      .onConflict(['tenantId', 'key'])
      .merge({ value: { policy: 'require_review' } as unknown as never, updatedAt: new Date() });

    const res = await request(app)
      .post('/partner-signup')
      .send({ email: 'pending@example.test', name: 'Pending Creator' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_review');

    const partner = await db(TABLES.Partner).where({ email: 'pending@example.test' }).first();
    expect(partner!.activatedAt).toBeNull();

    expect(received).toHaveLength(1);
    expect((received[0]!.body as { status: string }).status).toBe('pending');
  });

  it('admin POST /partners pushes to Network when enabled', async () => {
    await configureNetwork({ enabled: true });
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'invited@example.test', name: 'Invited' });
    expect(res.status).toBe(201);

    expect(received).toHaveLength(1);
    expect((received[0]!.body as { metadata: { source: string } }).metadata.source).toBe('admin_invite');
  });

  it('admin POST /partners/:id/revoke pushes a revoke regardless of autoEnroll', async () => {
    // autoEnroll OFF — but revoke should still mirror so Network stops matching.
    await configureNetwork({ enabled: true, autoEnroll: false });

    const create = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'revoke-target@example.test', name: 'Revoke Target' });
    expect(create.status).toBe(201);
    expect(received).toHaveLength(0); // autoEnroll off → no upsert

    const revoke = await request(app)
      .post(`/partners/${create.body.id}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ reason: 'test', notify: false });
    expect(revoke.status).toBe(200);

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/partners/upsert');
    expect((received[0]!.body as { status: string; vendorPartnerId: string }).status).toBe('revoked');
  });

  it('backfill reconciliation: pre-existing Network creators come back with alreadyExisted=true', async () => {
    // Two partners sit in the vendor's DB BEFORE Network is enabled.
    const p1 = ulid();
    const p2 = ulid();
    await db(TABLES.Partner).insert([
      { id: p1, tenantId: DEFAULT_TENANT_ID, email: 'preexisting@example.test', name: 'PreExisting', activatedAt: new Date() },
      { id: p2, tenantId: DEFAULT_TENANT_ID, email: 'fresh@example.test', name: 'Fresh', activatedAt: new Date() },
    ]);

    // Simulate that 'preexisting@example.test' already has a Network identity
    // from another vendor — receiver returns the same id with alreadyExisted=true.
    networkCreators.set('preexisting@example.test', 'crt_preexisting_already');

    await configureNetwork({ enabled: true });

    const res = await request(app)
      .post('/config/network/backfill')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 2, pushed: 2, queued: 0 });

    const refreshed1 = await db(TABLES.Partner).where({ id: p1 }).first();
    const refreshed2 = await db(TABLES.Partner).where({ id: p2 }).first();
    const meta1 = refreshed1!.metadata as { network?: { creatorId: string; preExisting: boolean } };
    const meta2 = refreshed2!.metadata as { network?: { creatorId: string; preExisting: boolean } };
    expect(meta1.network?.creatorId).toBe('crt_preexisting_already');
    expect(meta1.network?.preExisting).toBe(true);
    expect(meta2.network?.preExisting).toBe(false);
  });

  it('GET /config/network never leaks the vendor token', async () => {
    await configureNetwork({ enabled: true });
    const res = await request(app)
      .get('/config/network')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('vendorToken');
    expect(res.body).not.toHaveProperty('vendorTokenCiphertext');
    expect(res.body.hasVendorToken).toBe(true);
    expect(res.body.networkUrl).toBe(receiverUrl);
  });
});
