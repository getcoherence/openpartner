/**
 * The brand's own promoter profile, openpartner side (brand-profile.ts,
 * routes/settings.ts; the Network's docs/brand-profiles.md).
 *
 *   1. Reading it: the setup form's choices (this brand's activated full
 *      admins, a website guessed from its oldest program) go only to a full
 *      admin's session, and only while there is no profile yet.
 *   2. Creating it: the address must be one of those admins'; the brand's
 *      declared country rides along; the Network's refusal code reaches the
 *      portal. Not for a view-only seat or an API key.
 *   3. Working it: the Promote pages reach the Network's creator routes
 *      through /admin/network/promoter-api/*, as the profile (vendor token
 *      + x-act-as-brand-profile). Only a promoter's paths; the Network's
 *      own answer comes back, status and body. No sign-in link exists.
 *   4. Writes land in the audit log.
 *
 * A local HTTP server plays the Network. Skipped without DATABASE_URL.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type AuditLogRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_brandprofile_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'revshare';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createSession } = await import('../auth-sessions.js');
const { encryptSecret } = await import('../crypto.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

interface Call {
  method: string;
  path: string;
  auth: string | undefined;
  acting: string | undefined;
  contentType: string | undefined;
  bytes: number;
  body: Record<string, unknown> | null;
}
const calls: Call[] = [];
let network: Server;
let networkUrl: string;

const PROFILE = {
  creatorId: 'crt_brand',
  email: 'partnerships@acme.test',
  name: 'Acme',
  handle: 'acme',
  avatarUrl: null,
  profileComplete: false,
  profileMissing: [{ field: 'bio', label: 'Describe what you do (at least 40 characters)' }],
  active: true,
  createdAt: '2026-11-10T00:00:00.000Z',
};
/** What the fake Network holds for the brand being tested. */
let stored: typeof PROFILE | null = null;

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    network = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const isJson = (req.headers['content-type'] ?? '').includes('application/json');
        const body = raw.length && isJson ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : null;
        const path = req.url ?? '';
        calls.push({
          method: req.method ?? '',
          path,
          auth: req.headers.authorization,
          acting: req.headers['x-act-as-brand-profile'] as string | undefined,
          contentType: req.headers['content-type'],
          bytes: raw.length,
          body,
        });
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (path === '/vendors/me/brand-profile' && req.method === 'GET') return json(200, { profile: stored });
        if (path === '/vendors/me/brand-profile' && req.method === 'PUT') {
          if (body?.email === 'taken@acme.test') return json(409, { error: 'email_taken' });
          stored = { ...PROFILE, email: String(body?.email) };
          return json(201, { profile: stored, created: true });
        }
        // Creator routes, reached as the brand's own profile.
        if (path === '/creators/me/requests') return json(200, { requests: [{ id: 'req_1' }] });
        if (path.startsWith('/offerings?')) return json(200, { offerings: [], query: path.slice(path.indexOf('?')) });
        if (path === '/offerings/off_1/apply') return json(409, { error: 'profile_incomplete', missing: [{ field: 'bio', label: 'Describe what you do' }] });
        if (path === '/creators/me' && req.method === 'PATCH') return json(200, { id: 'crt_brand', ...body });
        if (path === '/creators/me/uploads/avatar') return json(200, { avatarUrl: 'https://cdn.example.test/a.png' });
        if (path === '/creators/me/partnerships/prt_1/coupons/cpn_1' && req.method === 'DELETE') {
          res.writeHead(204);
          return res.end();
        }
        if (path === '/creators/me/platforms') {
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end('<script>alert(1)</script>');
        }
        json(404, { error: 'not_found' });
      });
    }).listen(0, '127.0.0.1', () => {
      networkUrl = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
      process.env.NETWORK_URL = networkUrl;
      resolve();
    });
  });
});

const tenants: string[] = [];

afterAll(async () => {
  if (!skipIntegration) {
    for (const tenantId of tenants) {
      await db(TABLES.AuditLog).where({ tenantId }).del();
      await db(TABLES.LocationDeclaration).where({ tenantId }).del();
      await db(TABLES.ApiKey).where({ tenantId }).del();
      await db(TABLES.Session).where({ tenantId }).del();
      await db(TABLES.Partner).where({ tenantId }).del();
      await db(TABLES.Program).where({ tenantId }).del();
      await db(TABLES.Config).where({ tenantId }).del();
      await db(TABLES.Admin).where({ tenantId }).del();
      await db(TABLES.Tenant).where({ id: tenantId }).del();
    }
  }
  if (network) await new Promise<void>((r) => network.close(() => r()));
  await db.destroy();
});

beforeEach(() => {
  calls.length = 0;
  stored = null;
});

interface Brand {
  tenantId: string;
  slug: string;
  ownerEmail: string;
  owner: string;
  viewer: string;
}

/** A brand on the Network with an owner, a second full admin, a view-only
 *  seat, an invited admin who never signed in and a revoked one. */
async function brand(): Promise<Brand> {
  const tenantId = ulid();
  const slug = `bp${ulid().slice(-8).toLowerCase()}`;
  tenants.push(tenantId);
  await db(TABLES.Tenant).insert({ id: tenantId, slug, displayName: 'Acme', status: 'active', approvalStatus: 'approved' });
  const ownerId = ulid();
  const viewerId = ulid();
  const ownerEmail = `owner-${slug}@acme.test`;
  const now = new Date();
  await db<AdminRow>(TABLES.Admin).insert([
    { id: ownerId, tenantId, email: ownerEmail, name: 'Owen Owner', activatedAt: now, createdAt: new Date(now.getTime() - 5000) },
    { id: ulid(), tenantId, email: `partnerships-${slug}@acme.test`, name: 'Partnerships', activatedAt: now, createdAt: new Date(now.getTime() - 4000) },
    { id: viewerId, tenantId, email: `viewer-${slug}@acme.test`, name: 'Vi Viewer', role: 'viewer', activatedAt: now },
    { id: ulid(), tenantId, email: `invited-${slug}@acme.test`, name: 'Ina Invited', activatedAt: null },
    { id: ulid(), tenantId, email: `gone-${slug}@acme.test`, name: 'Gus Gone', activatedAt: now, revokedAt: now },
  ]);
  await db(TABLES.Config).insert({
    tenantId,
    key: 'network_membership',
    value: { enabled: true, networkUrl, vendorTokenCiphertext: encryptSecret('vntok_test_brandprofile'), scopedKeyId: null, autoEnroll: true } as unknown as never,
    updatedAt: now,
  });
  const owner = await createSession(db, { tenantId, principalKind: 'admin', principalId: ownerId });
  const viewer = await createSession(db, { tenantId, principalKind: 'admin', principalId: viewerId });
  return { tenantId, slug, ownerEmail, owner: `op_session=${owner.plaintext}`, viewer: `op_session=${viewer.plaintext}` };
}

async function seedProgram(tenantId: string, destinationUrl: string, createdAt: Date): Promise<void> {
  await db(TABLES.Program).insert({
    id: ulid(),
    tenantId,
    name: 'Launch program',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl,
    createdAt,
  });
}

const path = (b: Brand, suffix = '') => `/t/${b.slug}/admin/network/brand-profile${suffix}`;
const networkCalls = (method: string, p: string) => calls.filter((c) => c.method === method && c.path === p);

describe.skipIf(skipIntegration)('brand profile: reading', () => {
  it('offers a full admin the setup choices while there is no profile', async () => {
    const b = await brand();
    await seedProgram(b.tenantId, 'https://later.acme.test/pricing', new Date());
    await seedProgram(b.tenantId, 'https://www.acme.test/signup?ref=x', new Date(Date.now() - 60_000));

    const r = await request(app).get(path(b)).set('Cookie', b.owner);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      profile: null,
      // Activated, unrevoked full admins, oldest first.
      contacts: [
        { email: b.ownerEmail, name: 'Owen Owner' },
        { email: `partnerships-${b.slug}@acme.test`, name: 'Partnerships' },
      ],
      suggestedWebsite: 'https://www.acme.test',
    });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/vendors/me/brand-profile', auth: 'Bearer vntok_test_brandprofile' });
  });

  it("gives a view-only seat the profile's state and nobody's address", async () => {
    const b = await brand();
    const none = await request(app).get(path(b)).set('Cookie', b.viewer);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ profile: null, contacts: [], suggestedWebsite: null });
  });

  it('returns the profile alone once it exists', async () => {
    const b = await brand();
    stored = PROFILE;
    const r = await request(app).get(path(b)).set('Cookie', b.owner);
    expect(r.body).toEqual({ profile: PROFILE, contacts: [], suggestedWebsite: null });
  });

  it('needs an admin', async () => {
    const b = await brand();
    expect((await request(app).get(path(b))).status).toBe(401);
  });
});

describe.skipIf(skipIntegration)('brand profile: creating', () => {
  it("takes only one of the brand's own admins' addresses", async () => {
    const b = await brand();
    for (const email of [
      'someone@elsewhere.test',
      `viewer-${b.slug}@acme.test`,
      `invited-${b.slug}@acme.test`,
      `gone-${b.slug}@acme.test`,
    ]) {
      const r = await request(app).put(path(b)).set('Cookie', b.owner).send({ email });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'email_not_admin' });
    }
    expect((await request(app).put(path(b)).set('Cookie', b.owner).send({ email: 'nope' })).status).toBe(400);
    expect((await request(app).put(path(b)).set('Cookie', b.owner).send({ email: b.ownerEmail, websiteUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await request(app).put(path(b)).set('Cookie', b.owner).send({ email: b.ownerEmail, name: 'Stripe' })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("sends the address, the website and the brand's declared country", async () => {
    const b = await brand();
    await db(TABLES.LocationDeclaration).insert({
      id: ulid(),
      subjectKind: 'tenant',
      subjectId: b.tenantId,
      tenantId: b.tenantId,
      country: 'DE',
      outsideOccupiedRegions: null,
      ipCountry: null,
      source: 'signup',
      declaredByEmail: b.ownerEmail,
    });
    const other = `PARTNERSHIPS-${b.slug}@acme.test`;
    const r = await request(app).put(path(b)).set('Cookie', b.owner).send({ email: other, websiteUrl: 'https://www.acme.test' });
    expect(r.status).toBe(200);
    expect(r.body.profile.email).toBe(other.toLowerCase());
    expect(networkCalls('PUT', '/vendors/me/brand-profile')[0]!.body).toEqual({
      email: other.toLowerCase(),
      websiteUrl: 'https://www.acme.test',
      country: 'DE',
    });
  });

  it('sends no country when the brand never declared one, and no website when none was given', async () => {
    const b = await brand();
    const r = await request(app).put(path(b)).set('Cookie', b.owner).send({ email: b.ownerEmail });
    expect(r.status).toBe(200);
    expect(networkCalls('PUT', '/vendors/me/brand-profile')[0]!.body).toEqual({ email: b.ownerEmail });
  });

  it("passes the Network's refusal on by its code", async () => {
    const b = await brand();
    await db<AdminRow>(TABLES.Admin).insert({ id: ulid(), tenantId: b.tenantId, email: 'taken@acme.test', name: 'Tia Taken', activatedAt: new Date() });
    const r = await request(app).put(path(b)).set('Cookie', b.owner).send({ email: 'taken@acme.test' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'email_taken' });
  });

  it("isn't for a view-only seat or an API key", async () => {
    const b = await brand();
    const viewer = await request(app).put(path(b)).set('Cookie', b.viewer).send({ email: b.ownerEmail });
    expect(viewer.status).toBe(403);
    expect(viewer.body.error).toBe('read_only');
    const key = await request(app).put(path(b)).set('Authorization', `Bearer ${ADMIN_KEY}`).send({ email: b.ownerEmail });
    expect(key.status).toBe(403);
    expect(key.body).toEqual({ error: 'admin_session_required' });
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)("brand profile: worked from the brand's portal", () => {
  const api = (b: Brand, sub: string) => `/t/${b.slug}/admin/network/promoter-api${sub}`;

  it("forwards a promoter's call as the profile and hands back the Network's own answer", async () => {
    const b = await brand();
    const read = await request(app).get(api(b, '/creators/me/requests')).set('Cookie', b.owner);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ requests: [{ id: 'req_1' }] });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/creators/me/requests', auth: 'Bearer vntok_test_brandprofile', acting: '1' });

    // The query string goes too.
    const listed = await request(app).get(api(b, '/offerings?limit=100&q=mail')).set('Cookie', b.owner);
    expect(listed.body.query).toBe('?limit=100&q=mail');

    // A refusal arrives as the Network wrote it, for the page that reads it.
    const apply = await request(app).post(api(b, '/offerings/off_1/apply')).set('Cookie', b.owner).send({ message: 'hi' });
    expect(apply.status).toBe(409);
    expect(apply.body).toEqual({ error: 'profile_incomplete', missing: [{ field: 'bio', label: 'Describe what you do' }] });
    expect(calls.at(-1)!.body).toEqual({ message: 'hi' });

    const patch = await request(app).patch(api(b, '/creators/me')).set('Cookie', b.owner).send({ bio: 'We sell mail.' });
    expect(patch.body).toEqual({ id: 'crt_brand', bio: 'We sell mail.' });

    // An empty answer is still JSON for the page.
    const del = await request(app).delete(api(b, '/creators/me/partnerships/prt_1/coupons/cpn_1')).set('Cookie', b.owner);
    expect(del.status).toBe(200);
    expect(del.body).toBeNull();
  });

  it('sends an image as the image it is', async () => {
    const b = await brand();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = await request(app).post(api(b, '/creators/me/uploads/avatar')).set('Cookie', b.owner).set('Content-Type', 'image/png').send(png);
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ avatarUrl: 'https://cdn.example.test/a.png' });
    expect(calls.at(-1)).toMatchObject({ contentType: 'image/png', bytes: png.length, acting: '1' });
  });

  it("never renders the Network's answer as a page", async () => {
    const b = await brand();
    const r = await request(app).get(api(b, '/creators/me/platforms')).set('Cookie', b.owner);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.body).toEqual({ raw: '<script>alert(1)</script>', contentType: 'text/html' });
  });

  it("reaches only a promoter's paths", async () => {
    const b = await brand();
    for (const [method, sub] of [
      // The account, a storefront, bookings, messages, sign-in: not a brand's.
      ['get', '/creators/me/password'],
      ['put', '/creators/me/password'],
      ['post', '/creators/me/delete'],
      ['get', '/creators/me/export'],
      ['get', '/creators/me/storefront'],
      ['get', '/creators/me/bookings'],
      ['get', '/creators/me/conversations'],
      ['get', '/creators/me/domains'],
      ['post', '/creators/signin'],
      ['post', '/creators/verify'],
      // Its own vendor routes and the operators' are not creator routes.
      ['get', '/vendors/me'],
      ['get', '/vendors/me/brand-profile'],
      ['get', '/vendors/me/export'],
      ['get', '/vendors/me/requests'],
      ['get', '/vendors/me/discover/creators'],
      // Nothing under a partnership but what the pages use.
      ['post', '/creators/me/partnerships/prt_1/delete'],
      ['get', '/creators/me/partnerships/prt_1/export'],
      ['post', '/admin/creators/signin-token'],
      // Right path, wrong method.
      ['delete', '/creators/me'],
      ['post', '/creators/me/affiliations/aff_1/earnings'],
      // Nothing that could walk out of an allowed prefix.
      ['get', '/offerings/..%2Fcreators%2Fme%2Fpassword'],
      ['get', '/offerings//x'],
      ['get', '/offerings/x/../../admin/creators'],
    ] as const) {
      const r = await request(app)[method](api(b, sub)).set('Cookie', b.owner).send(method === 'get' ? undefined : {});
      expect([method, sub, r.status]).toEqual([method, sub, 404]);
    }
    expect(calls).toHaveLength(0);
  });

  it('lets a view-only seat read and nothing else, and keeps partners out', async () => {
    const b = await brand();
    expect((await request(app).get(api(b, '/creators/me/requests')).set('Cookie', b.viewer)).status).toBe(200);
    const write = await request(app).post(api(b, '/offerings/off_1/apply')).set('Cookie', b.viewer).send({});
    expect(write.status).toBe(403);
    expect(write.body.error).toBe('read_only');
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);

    expect((await request(app).get(api(b, '/creators/me/requests'))).status).toBe(401);
    const partnerId = ulid();
    await db(TABLES.Partner).insert({ id: partnerId, tenantId: b.tenantId, email: `p-${b.slug}@example.test`, name: 'Pat Partner', activatedAt: new Date() });
    const partner = await createSession(db, { tenantId: b.tenantId, principalKind: 'partner', principalId: partnerId });
    const asPartner = await request(app).get(api(b, '/creators/me/requests')).set('Cookie', `op_session=${partner.plaintext}`);
    expect(asPartner.status).toBe(403);
  });

  it('has no sign-in link to hand out', async () => {
    const b = await brand();
    stored = PROFILE;
    expect((await request(app).post(path(b, '/open')).set('Cookie', b.owner).send({})).status).toBe(404);
  });

  it('says so when the brand is not on the Network', async () => {
    const b = await brand();
    await db(TABLES.Config).where({ tenantId: b.tenantId, key: 'network_membership' }).del();
    const r = await request(app).get(api(b, '/creators/me/requests')).set('Cookie', b.owner);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'network_call_failed', detail: 'network_not_configured' });
  });
});

describe.skipIf(skipIntegration)('brand profile: audit log', () => {
  it('records who set the profile up and what was done as it', async () => {
    const b = await brand();
    await request(app).put(path(b)).set('Cookie', b.owner).send({ email: b.ownerEmail });
    await request(app).patch(`/t/${b.slug}/admin/network/promoter-api/creators/me`).set('Cookie', b.owner).send({ bio: 'We sell mail.' });
    // Reads leave no row.
    await request(app).get(`/t/${b.slug}/admin/network/promoter-api/creators/me/requests`).set('Cookie', b.owner);
    const rows = (await db<AuditLogRow>(TABLES.AuditLog).where({ tenantId: b.tenantId }).orderBy('createdAt', 'asc').orderBy('id', 'asc')) as AuditLogRow[];
    expect(rows.map((r) => [r.action, r.actorLabel, r.status])).toEqual([
      ['PUT /admin/network/brand-profile', b.ownerEmail, 200],
      ['PATCH /admin/network/promoter-api/*', b.ownerEmail, 200],
    ]);
    // Field names only, never the address; and which creator route it was.
    expect(rows[0]!.fields).toEqual(['email']);
    expect(rows[1]!.params).toEqual({ '0': 'creators/me' });
    expect(rows[1]!.fields).toEqual(['bio']);
  });
});
