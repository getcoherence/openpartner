/**
 * End-to-end coverage for brand approval (anti-spam).
 *
 * Multi-tenant mode. Exercises the real HTTP surface:
 *   1. Public /signup lands a brand in 'pending' (not live).
 *   2. The signup blocklist refuses a banned email domain.
 *   3. Operator auth: /platform-admin/me, and the magic-link verify path.
 *   4. Approve flips a pending brand to approved + active.
 *   5. Reject suspends the brand AND (with banDomain) bans the domain, which
 *      then blocks a fresh signup from that domain.
 *   6. The approval gate 403s partner onboarding while pending, and lifts on
 *      approval.
 *   7. A 'support' operator is read-only.
 *
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type PlatformAdminRow, type TenantRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_brandreview_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.PLATFORM_ADMIN_EMAILS = 'ops@openpartner.test';
delete process.env.NETWORK_URL; // no auto-enroll side calls
delete process.env.PLATFORM_OPS_EMAIL; // no ops mail during tests

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { issueMagicLink } = await import('../auth-sessions.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import(
  '../platform-admin-sessions.js'
);

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const createdSlugs: string[] = [];
const createdBlocklistValues: string[] = [];
const createdOperatorIds: string[] = [];

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}

/** Sign up a brand and return its row. */
async function signup(overrides: Partial<{ slug: string; adminEmail: string; displayName: string }> = {}) {
  const slug = overrides.slug ?? `rev${rnd()}`;
  createdSlugs.push(slug);
  const res = await request(app)
    .post('/signup')
    .send({
      slug,
      displayName: overrides.displayName ?? 'Test Brand',
      adminEmail: overrides.adminEmail ?? `admin-${rnd()}@example.test`,
      adminName: 'Test Admin',
      plan: 'flex',
    });
  return { res, slug };
}

async function makeOperator(role: 'admin' | 'support'): Promise<string> {
  const admin: PlatformAdminRow = {
    id: ulid(),
    email: role === 'admin' ? 'ops@openpartner.test' : `support-${rnd()}@openpartner.test`,
    name: 'Ops',
    role,
    createdAt: new Date(),
    revokedAt: null,
  };
  // Upsert on email (ops@ may already exist from a prior test / verify).
  const existing = await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ email: admin.email }).first();
  if (existing) {
    await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ id: existing.id }).update({ role, revokedAt: null });
    admin.id = existing.id;
  } else {
    await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(admin);
    createdOperatorIds.push(admin.id);
  }
  const session = await createPlatformAdminSession(db, admin);
  return `${PLATFORM_ADMIN_SESSION_COOKIE}=${session.plaintext}`;
}

async function tenantBySlug(slug: string): Promise<TenantRow | undefined> {
  return db<TenantRow>(TABLES.Tenant).where({ slug }).first();
}

async function purgeSlug(slug: string): Promise<void> {
  const t = await tenantBySlug(slug);
  if (!t) return;
  // FK order: children before Tenant.
  for (const table of [
    TABLES.Link,
    TABLES.PartnerProgram,
    TABLES.Program,
    TABLES.Partner,
    TABLES.Admin,
    TABLES.MagicLinkToken,
    TABLES.Session,
    TABLES.Config,
    TABLES.ApiKey,
  ]) {
    await db(table).where({ tenantId: t.id }).del();
  }
  await db(TABLES.Tenant).where({ id: t.id }).del();
}

async function seedProgram(tenantId: string, destinationUrl: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId,
    name: 'Test Program',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl,
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  return id;
}

// In-process stand-in for the Network coordinator, so we can assert that a
// takedown actually propagates across the federation boundary.
interface NetCall { method: string; path: string; authorization?: string; body: unknown }
let netServer: Server;
let netUrl = '';
let netCalls: NetCall[] = [];

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    netServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        netCalls.push({
          method: req.method ?? '',
          path: req.url ?? '',
          authorization: req.headers.authorization,
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }).listen(0, '127.0.0.1', () => {
      netUrl = `http://127.0.0.1:${(netServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

/** Federate a tenant to the fake Network so moderation has somewhere to go.
 *  The vendorToken is what the offering PATCH authenticates with (the vendor
 *  rail); the brand-level suspend goes over the admin key instead. */
async function federate(tenantId: string, vendorId: string): Promise<void> {
  const { encryptSecret } = await import('../crypto.js');
  const value = {
    enabled: true,
    networkUrl: netUrl,
    vendorId,
    vendorTokenCiphertext: encryptSecret('vntok_test'),
    autoEnroll: true,
    scopedKeyId: null,
  };
  await db(TABLES.Config)
    .insert({ tenantId, key: 'network_membership', value: value as unknown as never, updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: value as unknown as never, updatedAt: new Date() });
}

afterEach(async () => {
  if (skipIntegration) return;
  netCalls = [];
  for (const slug of createdSlugs.splice(0)) await purgeSlug(slug);
  if (createdBlocklistValues.length) {
    await db(TABLES.SignupBlocklist).whereIn('value', createdBlocklistValues.splice(0)).del();
  }
});

afterAll(async () => {
  if (netServer) await new Promise<void>((r) => netServer.close(() => r()));
  if (!skipIntegration) {
    // Clean every operator this suite touched — the ops@ bootstrap row is
    // also created implicitly by the verify test via env-allowlist upsert.
    const opRows = await db<PlatformAdminRow>(TABLES.PlatformAdmin)
      .where('email', 'ops@openpartner.test')
      .orWhere('email', 'like', 'support-%@openpartner.test');
    const opIds = [...new Set([...createdOperatorIds, ...opRows.map((r) => r.id)])];
    if (opIds.length) {
      await db(TABLES.PlatformAdminSession).whereIn('platformAdminId', opIds).del();
      await db(TABLES.PlatformAdmin).whereIn('id', opIds).del();
    }
    await db(TABLES.PlatformAuditLog)
      .where('platformAdminEmail', 'ops@openpartner.test')
      .orWhere('platformAdminEmail', 'like', 'support-%@openpartner.test')
      .del();
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('brand approval — signup + gate', () => {
  it('public signup lands a brand in pending review', async () => {
    const { res, slug } = await signup();
    expect(res.status).toBe(201);
    const t = await tenantBySlug(slug);
    expect(t?.approvalStatus).toBe('pending');
    expect(t?.status).toBe('active'); // can sign in + configure
  });

  it('signup is refused for a blocklisted domain', async () => {
    const domain = `spam-${rnd()}.test`;
    createdBlocklistValues.push(domain);
    await db(TABLES.SignupBlocklist).insert({
      id: ulid(),
      type: 'domain',
      value: domain,
      reason: 'test',
      createdByEmail: 'ops@openpartner.test',
    });
    const res = await request(app).post('/signup').send({
      slug: `rev${rnd()}`,
      displayName: 'Spammer',
      adminEmail: `danny@${domain}`,
      adminName: 'Danny',
      plan: 'flex',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('signup_unavailable');
  });

  it('gates partner onboarding while pending, lifts on approval', async () => {
    const { slug } = await signup();
    const t = await tenantBySlug(slug);

    // Pending → 403 brand_pending_review (approval gate runs before the plan gate).
    const gated = await request(app)
      .post(`/t/${slug}/partners`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: `p-${rnd()}@example.test`, name: 'P' });
    expect(gated.status).toBe(403);
    expect(gated.body.error).toBe('brand_pending_review');

    // Approve, then the approval gate no longer blocks (a later billing gate
    // may still 402 — the point is it's no longer the approval 403).
    const cookie = await makeOperator('admin');
    const approve = await request(app)
      .post(`/platform-admin/brands/${t!.id}/approve`)
      .set('Cookie', cookie)
      .send({});
    expect(approve.status).toBe(200);
    expect((await tenantBySlug(slug))?.approvalStatus).toBe('approved');

    const after = await request(app)
      .post(`/t/${slug}/partners`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: `p2-${rnd()}@example.test`, name: 'P2' });
    expect(after.body?.error).not.toBe('brand_pending_review');
  });
});

describe.skipIf(skipIntegration)('brand approval — operator console', () => {
  it('rejects unauthenticated console access', async () => {
    const res = await request(app).get('/platform-admin/me');
    expect(res.status).toBe(401);
  });

  it('returns the operator identity when authed', async () => {
    const cookie = await makeOperator('admin');
    const res = await request(app).get('/platform-admin/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'ops@openpartner.test', role: 'admin' });
  });

  it('verifies a magic-link token into an operator session', async () => {
    const email = 'ops@openpartner.test';
    const issued = await issueMagicLink(db, {
      tenantId: DEFAULT_TENANT_ID,
      email,
      purpose: 'platform_admin_signin',
      principalKind: 'platform',
      principalId: email,
    });
    const res = await request(app).post('/auth/platform-admin-verify').send({ token: issued.plaintext });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
    expect(res.body.role).toBe('admin');
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie?.join(';')).toContain(PLATFORM_ADMIN_SESSION_COOKIE);
  });

  it('reject suspends the brand and bans its domain, blocking re-signup', async () => {
    const domain = `evil-${rnd()}.test`;
    createdBlocklistValues.push(domain);
    const { slug } = await signup({ adminEmail: `boss@${domain}` });
    const t = await tenantBySlug(slug);

    const cookie = await makeOperator('admin');
    const rej = await request(app)
      .post(`/platform-admin/brands/${t!.id}/reject`)
      .set('Cookie', cookie)
      .send({ reason: 'phishing', notifyBrand: false, banDomain: true });
    expect(rej.status).toBe(200);
    expect(rej.body.bannedDomain).toBe(domain);

    const after = await tenantBySlug(slug);
    expect(after?.approvalStatus).toBe('rejected');
    expect(after?.status).toBe('suspended'); // fully dark

    const entry = await db(TABLES.SignupBlocklist).where({ type: 'domain', value: domain }).first();
    expect(entry).toBeDefined();

    // A fresh signup from the banned domain is refused.
    const reSignup = await request(app).post('/signup').send({
      slug: `rev${rnd()}`,
      displayName: 'Evil Again',
      adminEmail: `other@${domain}`,
      adminName: 'Other',
      plan: 'flex',
    });
    expect(reSignup.status).toBe(403);
  });

  it('rejecting a brand suspends its Vendor on the Network (pulls the marketplace listing)', async () => {
    process.env.NETWORK_ADMIN_API_KEY = 'netadm_test_key_0123456789abcdef';
    const { slug } = await signup();
    const t = (await tenantBySlug(slug))!;
    await federate(t.id, 'vnd_spam');

    const cookie = await makeOperator('admin');
    await request(app)
      .post(`/platform-admin/brands/${t.id}/reject`)
      .set('Cookie', cookie)
      .send({ reason: 'phishing', notifyBrand: false })
      .expect(200);

    // Local suspend alone leaves the brand listed on the marketplace — the
    // Network has to be told, or the spam listing keeps taking applications.
    const suspend = netCalls.find((c) => c.path === '/admin/vendors/vnd_spam/suspend');
    expect(suspend, 'expected the Network vendor to be suspended').toBeDefined();
    expect(suspend!.method).toBe('POST');
    expect(suspend!.authorization).toBe('Bearer netadm_test_key_0123456789abcdef');
    expect((suspend!.body as { reason: string }).reason).toBe('phishing');

    // Reinstating puts them back.
    netCalls = [];
    await request(app)
      .post(`/platform-admin/brands/${t.id}/reinstate`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);
    expect(netCalls.find((c) => c.path === '/admin/vendors/vnd_spam/reactivate')).toBeDefined();
  });

  it('a support operator is read-only', async () => {
    const { slug } = await signup();
    const t = await tenantBySlug(slug);
    const cookie = await makeOperator('support');
    const res = await request(app)
      .post(`/platform-admin/brands/${t!.id}/approve`)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('read_only_operator');
  });
});

describe.skipIf(skipIntegration)('creator moderation (Network-proxied)', () => {
  // Scope NETWORK_URL to this block — leaving it set would make the signup
  // tests start auto-enrolling brands against the fake Network.
  afterEach(() => {
    delete process.env.NETWORK_URL;
  });

  it('lists creators and blocks/unblocks one via the Network admin API', async () => {
    process.env.NETWORK_URL = netUrl;
    process.env.NETWORK_ADMIN_API_KEY = 'netadm_test_key_0123456789abcdef';
    const cookie = await makeOperator('admin');

    const list = await request(app).get('/platform-admin/creators').set('Cookie', cookie);
    expect(list.status).toBe(200);
    // The fake Network replies {ok:true}; we only assert the call shape.
    expect(netCalls.find((c) => c.method === 'GET' && c.path.startsWith('/admin/creators'))).toBeDefined();

    netCalls = [];
    const block = await request(app)
      .post('/platform-admin/creators/crt_123/block')
      .set('Cookie', cookie)
      .send({ reason: 'spam profile' });
    expect(block.status).toBe(200);
    const call = netCalls.find((c) => c.path === '/admin/creators/crt_123/block');
    expect(call).toBeDefined();
    expect(call!.authorization).toBe('Bearer netadm_test_key_0123456789abcdef');
    expect(call!.body).toMatchObject({ reason: 'spam profile', blockedByEmail: 'ops@openpartner.test' });

    netCalls = [];
    await request(app)
      .post('/platform-admin/creators/crt_123/unblock')
      .set('Cookie', cookie)
      .send({})
      .expect(200);
    expect(netCalls.find((c) => c.path === '/admin/creators/crt_123/unblock')).toBeDefined();
  });

  it('a support operator cannot block a creator', async () => {
    process.env.NETWORK_URL = netUrl;
    const cookie = await makeOperator('support');
    const res = await request(app)
      .post('/platform-admin/creators/crt_x/block')
      .set('Cookie', cookie)
      .send({ reason: 'spam' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('read_only_operator');
  });
});

describe.skipIf(skipIntegration)('program moderation', () => {
  it('lists a brand programs (with destination) and blocks/unblocks one', async () => {
    const { slug } = await signup();
    const t = (await tenantBySlug(slug))!;
    const dest = 'https://scam.example.test/verify';
    const programId = await seedProgram(t.id, dest);
    const cookie = await makeOperator('admin');

    const list = await request(app).get(`/platform-admin/brands/${t.id}/programs`).set('Cookie', cookie);
    expect(list.status).toBe(200);
    const prog = (list.body.programs as Array<{ id: string; destinationUrl: string; blockedAt: string | null }>).find(
      (p) => p.id === programId,
    );
    expect(prog?.destinationUrl).toBe(dest); // the phishing tell is visible
    expect(prog?.blockedAt).toBeNull();

    const block = await request(app)
      .post(`/platform-admin/programs/${programId}/block`)
      .set('Cookie', cookie)
      .send({ reason: 'phishing destination' });
    expect(block.status).toBe(200);
    let row = await db(TABLES.Program).where({ id: programId }).first();
    expect(row!.blockedAt).not.toBeNull();
    expect(row!.blockedReason).toBe('phishing destination');
    expect(row!.blockedByEmail).toBe('ops@openpartner.test');

    const unblock = await request(app)
      .post(`/platform-admin/programs/${programId}/unblock`)
      .set('Cookie', cookie)
      .send({});
    expect(unblock.status).toBe(200);
    row = await db(TABLES.Program).where({ id: programId }).first();
    expect(row!.blockedAt).toBeNull();
  });

  it('blocking a program unpublishes its marketplace offering', async () => {
    const { slug } = await signup();
    const t = (await tenantBySlug(slug))!;
    await federate(t.id, 'vnd_prog');
    const programId = await seedProgram(t.id, 'https://scam.example.test/verify');
    // Program is listed on the marketplace.
    await db(TABLES.Program).where({ id: programId }).update({ networkOfferingId: 'off_123', shareOnNetwork: true });

    const cookie = await makeOperator('admin');
    await request(app)
      .post(`/platform-admin/programs/${programId}/block`)
      .set('Cookie', cookie)
      .send({ reason: 'phishing' })
      .expect(200);

    // The offering must be unpublished on the Network — otherwise the dead
    // program keeps taking creator applications from the marketplace.
    const patch = netCalls.find((c) => c.path.includes('/offerings/off_123'));
    expect(patch, 'expected a PATCH to the offering').toBeDefined();
    expect((patch!.body as { published: boolean }).published).toBe(false);
  });

  it('a support operator cannot block a program', async () => {
    const { slug } = await signup();
    const t = (await tenantBySlug(slug))!;
    const programId = await seedProgram(t.id, 'https://x.test');
    const cookie = await makeOperator('support');
    const res = await request(app)
      .post(`/platform-admin/programs/${programId}/block`)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('read_only_operator');
  });
});
