/**
 * The URLs an install registers with the Network when it connects.
 *
 * POST /config/network/start-connect and /config/network/auto-enroll send
 * the Network an instanceUrl, where it calls this install's API, and a
 * portalCallbackUrl, where its confirmation email sends the admin back. The
 * Network can't change a vendor's instanceUrl once it is active.
 *
 * Single tenancy calls its one tenant "default" in the database, but no URL
 * may carry it: single-tenant tenantMiddleware never strips /t/default. A
 * self-hosted install used to register <host>/api/t/default, and every
 * federation call (POST /partners when a partnership was approved) 404ed.
 * Multi tenancy keeps the slug right after /api.
 *
 * Skipped if DATABASE_URL isn't set, like the rest of the integration suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_netconnect_urls_0123456789abcdef01';
const NETWORK_ADMIN = 'net_admin_test_connect_urls';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.NETWORK_ADMIN_API_KEY = NETWORK_ADMIN;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createSession } = await import('../auth-sessions.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

// The host a self-hoster serves the portal (and its /api proxy) from, and
// the hosted platform's own origin.
const SELFHOST = 'partners.brand.test';
const PLATFORM = 'app.openpartner.dev';

// ----- fake Network: records every /vendors/signup body -----
interface Signup {
  authorization: string | undefined;
  body: { instanceUrl: string; portalCallbackUrl: string; displayName: string };
}
let netServer: Server;
let signups: Signup[] = [];

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    netServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let reply: unknown = {};
        if (req.url === '/vendors/signup') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Signup['body'];
          signups.push({ authorization: req.headers.authorization, body });
          reply = req.headers.authorization
            ? { vendorId: 'vnd_urls', vendorToken: 'vntok_urls', status: 'active', displayName: body.displayName }
            : { vendorId: 'vnd_urls', status: 'pending', emailSent: true };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    }).listen(0, '127.0.0.1', () => {
      process.env.NETWORK_URL = `http://127.0.0.1:${(netServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

// Rows the routes write: a federation ApiKey, network_membership (and the
// onboarding Config auto-enroll may touch), sessions, audit entries.
const createdTenants: string[] = [];
const createdAdmins: string[] = [];
let defaultKeysBefore = new Set<string>();

beforeEach(async () => {
  if (skipIntegration) return;
  signups = [];
  defaultKeysBefore = new Set(await db(TABLES.ApiKey).where({ tenantId: DEFAULT_TENANT_ID }).pluck('id'));
});

afterEach(async () => {
  if (skipIntegration) return;
  process.env.OPENPARTNER_TENANCY = 'single';
  const newDefaultKeys = (await db(TABLES.ApiKey).where({ tenantId: DEFAULT_TENANT_ID }).pluck('id')).filter(
    (id: string) => !defaultKeysBefore.has(id),
  );
  if (newDefaultKeys.length) await db(TABLES.ApiKey).whereIn('id', newDefaultKeys).del();
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();
  if (createdAdmins.length) {
    await db(TABLES.Session).whereIn('principalId', createdAdmins).del();
    await db(TABLES.Admin).whereIn('id', createdAdmins.splice(0)).del();
  }
  for (const id of createdTenants.splice(0)) {
    for (const t of [TABLES.ApiKey, TABLES.Config, TABLES.AuditLog]) await db(t).where({ tenantId: id }).del();
    await db(TABLES.Tenant).where({ id }).del();
  }
});

afterAll(async () => {
  delete process.env.NETWORK_URL;
  delete process.env.NETWORK_ADMIN_API_KEY;
  if (netServer) await new Promise<void>((r) => netServer.close(() => r()));
  await db.destroy();
});

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}

/** An approved brand on the hosted platform (multi tenancy). */
async function seedTenant(): Promise<{ id: string; slug: string }> {
  const id = ulid();
  const slug = `nc${rnd()}`;
  await db(TABLES.Tenant).insert({
    id,
    slug,
    displayName: `Brand ${slug}`,
    status: 'active',
    approvalStatus: 'approved',
  });
  createdTenants.push(id);
  return { id, slug };
}

/** A signed-in admin's session cookie: auto-enroll needs a real Admin row. */
async function adminCookie(tenantId: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Admin).insert({ id, tenantId, email: `admin-${rnd()}@brand.test`, name: 'Ada Admin', activatedAt: new Date() });
  createdAdmins.push(id);
  const session = await createSession(db, { tenantId, principalKind: 'admin', principalId: id });
  return `op_session=${session.plaintext}`;
}

function onlySignup(): Signup {
  expect(signups).toHaveLength(1);
  return signups[0]!;
}

describe.skipIf(skipIntegration)('single tenancy: no /t/default in the URLs the Network gets', () => {
  it('start-connect registers <host>/api and calls back to <host>/admin/network/complete', async () => {
    const res = await request(app)
      .post('/config/network/start-connect')
      .set('Host', SELFHOST)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ contactEmail: 'owner@brand.test', displayName: 'Brand' });
    expect(res.status).toBe(202);

    expect(onlySignup().body).toMatchObject({
      instanceUrl: `http://${SELFHOST}/api`,
      portalCallbackUrl: `http://${SELFHOST}/admin/network/complete`,
    });
  });

  it('auto-enroll registers the same URLs', async () => {
    const res = await request(app)
      .post('/config/network/auto-enroll')
      .set('Host', SELFHOST)
      .set('Cookie', await adminCookie(DEFAULT_TENANT_ID));
    expect(res.status).toBe(200);

    const signup = onlySignup();
    expect(signup.authorization).toBe(`Bearer ${NETWORK_ADMIN}`);
    expect(signup.body).toMatchObject({
      instanceUrl: `http://${SELFHOST}/api`,
      portalCallbackUrl: `http://${SELFHOST}/admin/network/complete`,
    });
  });
});

describe.skipIf(skipIntegration)('multi tenancy: the slug stays in the URLs', () => {
  beforeEach(() => {
    process.env.OPENPARTNER_TENANCY = 'multi';
  });

  it('start-connect registers <host>/api/t/<slug> and calls back to <host>/t/<slug>/admin/network/complete', async () => {
    const { slug } = await seedTenant();
    const res = await request(app)
      .post(`/t/${slug}/config/network/start-connect`)
      .set('Host', PLATFORM)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ contactEmail: 'owner@brand.test' });
    expect(res.status).toBe(202);

    expect(onlySignup().body).toMatchObject({
      instanceUrl: `http://${PLATFORM}/api/t/${slug}`,
      portalCallbackUrl: `http://${PLATFORM}/t/${slug}/admin/network/complete`,
    });
  });

  it('auto-enroll registers the same URLs', async () => {
    const { id, slug } = await seedTenant();
    const res = await request(app)
      .post(`/t/${slug}/config/network/auto-enroll`)
      .set('Host', PLATFORM)
      .set('Cookie', await adminCookie(id));
    expect(res.status).toBe(200);

    const signup = onlySignup();
    expect(signup.authorization).toBe(`Bearer ${NETWORK_ADMIN}`);
    expect(signup.body).toMatchObject({
      instanceUrl: `http://${PLATFORM}/api/t/${slug}`,
      portalCallbackUrl: `http://${PLATFORM}/t/${slug}/admin/network/complete`,
    });
  });
});
