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
      country: 'US',
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
    // Signup records where the brand is based (country-access.ts).
    TABLES.LocationDeclaration,
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
/** What the fake Network returns for GET /admin/vendors (reconcile job). */
let netVendors: Array<{ id: string; instanceUrl: string; status: string; reviewStatus?: string; displayName?: string }> = [];
/** What the fake Network returns for GET /admin/vendor-review (review queue). */
let netQueue: Array<Record<string, unknown>> = [];

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
        if (req.method === 'GET' && req.url === '/admin/vendors') {
          return res.end(JSON.stringify({ vendors: netVendors }));
        }
        if (req.method === 'GET' && req.url?.startsWith('/admin/vendor-review')) {
          return res.end(JSON.stringify({ vendors: netQueue }));
        }
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
  netVendors = [];
  netQueue = [];
  delete process.env.NETWORK_URL;
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
      country: 'US',
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
      country: 'US',
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
    // ...and its review is marked rejected, so it stays out of discovery even
    // if the suspension is later lifted by some other path.
    const reviewCall = netCalls.find((c) => c.path === '/admin/vendors/vnd_spam/review');
    expect((reviewCall?.body as { status: string } | undefined)?.status).toBe('rejected');

    // Reinstating puts them back: review approved + the suspension undone.
    netCalls = [];
    await request(app)
      .post(`/platform-admin/brands/${t.id}/reinstate`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);
    expect(netCalls.find((c) => c.path === '/admin/vendors/vnd_spam/reactivate')).toBeDefined();
    const reinstated = netCalls.find((c) => c.path === '/admin/vendors/vnd_spam/review');
    expect((reinstated?.body as { status: string } | undefined)?.status).toBe('approved');
  });

  it('approving a pending brand lists it on the Network (review approved, no reactivate)', async () => {
    process.env.NETWORK_ADMIN_API_KEY = 'netadm_test_key_0123456789abcdef';
    const { slug } = await signup();
    const t = (await tenantBySlug(slug))!;
    await federate(t.id, 'vnd_new');

    const cookie = await makeOperator('admin');
    await request(app).post(`/platform-admin/brands/${t.id}/approve`).set('Cookie', cookie).send({}).expect(200);

    const review = netCalls.find((c) => c.path === '/admin/vendors/vnd_new/review');
    expect(review, 'expected the approval to reach the Network').toBeDefined();
    expect(review!.authorization).toBe('Bearer netadm_test_key_0123456789abcdef');
    expect((review!.body as { status: string }).status).toBe('approved');
    // A pending brand's vendor was never suspended, so reactivate would 404.
    expect(netCalls.find((c) => c.path.endsWith('/reactivate'))).toBeUndefined();
  });

  it('hosted signup enrolls the brand on the Network as pending review', async () => {
    process.env.NETWORK_ADMIN_API_KEY = 'netadm_test_key_0123456789abcdef';
    process.env.NETWORK_URL = netUrl;
    await signup();
    const enroll = netCalls.find((c) => c.method === 'POST' && c.path === '/vendors/signup');
    expect(enroll, 'expected auto-enroll on the Network').toBeDefined();
    expect((enroll!.body as { reviewStatus?: string }).reviewStatus).toBe('pending');
  });

  it('reconcile job pushes drifted review states and leaves matching ones alone', async () => {
    process.env.NETWORK_ADMIN_API_KEY = 'netadm_test_key_0123456789abcdef';
    process.env.NETWORK_URL = netUrl;
    const { slug: pendingSlug } = await signup();
    const { slug: approvedSlug } = await signup();
    const { slug: rejectedSlug } = await signup();
    const pending = (await tenantBySlug(pendingSlug))!;
    const approved = (await tenantBySlug(approvedSlug))!;
    const rejected = (await tenantBySlug(rejectedSlug))!;
    await db(TABLES.Tenant).where({ id: approved.id }).update({ approvalStatus: 'approved' });
    await db(TABLES.Tenant).where({ id: rejected.id }).update({ approvalStatus: 'rejected', status: 'suspended' });
    await federate(pending.id, 'vnd_p');
    await federate(approved.id, 'vnd_a');
    await federate(rejected.id, 'vnd_r');
    // What the Network migration leaves behind: everyone backfilled approved.
    netVendors = [
      { id: 'vnd_p', instanceUrl: 'x', status: 'active', reviewStatus: 'approved' },
      { id: 'vnd_a', instanceUrl: 'y', status: 'active', reviewStatus: 'approved' },
      { id: 'vnd_r', instanceUrl: 'z', status: 'suspended', reviewStatus: 'approved' },
    ];
    netCalls = [];

    const { reconcileNetworkReview } = await import('../network-review-reconcile.js');
    const result = await reconcileNetworkReview();
    expect(result.failed).toBe(0);
    expect(result.pushed).toBeGreaterThanOrEqual(2);

    const pushed = (id: string) =>
      (netCalls.find((c) => c.path === `/admin/vendors/${id}/review`)?.body as { status: string } | undefined)?.status;
    expect(pushed('vnd_p')).toBe('pending');
    expect(pushed('vnd_r')).toBe('rejected');
    expect(pushed('vnd_a')).toBeUndefined(); // already in sync, so no call

    // A Network that predates the gate (no reviewStatus field) is skipped.
    netVendors = [{ id: 'vnd_p', instanceUrl: 'x', status: 'active' }];
    netCalls = [];
    const old = await reconcileNetworkReview();
    expect(old.skipped).toBe('network_predates_review_gate');
    expect(netCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
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

describe.skipIf(skipIntegration)('marketplace featured placement (Network-proxied)', () => {
  afterEach(() => {
    delete process.env.NETWORK_URL;
  });

  it('lists Network vendors and replaces the featured list, with an audit row', async () => {
    process.env.NETWORK_URL = netUrl;
    process.env.NETWORK_ADMIN_API_KEY = 'netadm_test_key_0123456789abcdef';
    const cookie = await makeOperator('admin');
    netVendors = [{ id: 'vnd_coh', instanceUrl: 'x', status: 'active', reviewStatus: 'approved' }];

    const list = await request(app).get('/platform-admin/marketplace').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.vendors.map((v: { id: string }) => v.id)).toEqual(['vnd_coh']);

    netCalls = [];
    const until = '2026-12-31T23:59:59Z';
    const put = await request(app)
      .put('/platform-admin/marketplace/featured')
      .set('Cookie', cookie)
      .send({ vendors: [{ id: 'vnd_coh' }, { id: 'vnd_op', until }] });
    expect(put.status).toBe(200);
    const call = netCalls.find((c) => c.method === 'PUT' && c.path === '/admin/featured-vendors');
    expect(call?.authorization).toBe('Bearer netadm_test_key_0123456789abcdef');
    expect(call?.body).toEqual({ vendors: [{ id: 'vnd_coh', until: null }, { id: 'vnd_op', until }] });

    const audit = await db(TABLES.PlatformAuditLog)
      .where({ action: 'marketplace.featured' })
      .orderBy('createdAt', 'desc')
      .first();
    expect(audit?.platformAdminEmail).toBe('ops@openpartner.test');
    expect(audit?.detail).toEqual({ vendors: [{ id: 'vnd_coh', until: null }, { id: 'vnd_op', until }] });
    await db(TABLES.PlatformAuditLog).where({ id: audit!.id }).del();
  });

  it('refuses duplicates and read-only operators without calling the Network', async () => {
    process.env.NETWORK_URL = netUrl;
    const admin = await makeOperator('admin');
    const dup = await request(app)
      .put('/platform-admin/marketplace/featured')
      .set('Cookie', admin)
      .send({ vendors: [{ id: 'vnd_a' }, { id: 'vnd_a' }] });
    expect(dup.status).toBe(400);

    const support = await makeOperator('support');
    const res = await request(app)
      .put('/platform-admin/marketplace/featured')
      .set('Cookie', support)
      .send({ vendors: [] });
    expect(res.status).toBe(403);
    expect(netCalls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('Network vendor review queue', () => {
  const NET_KEY = 'netadm_test_key_0123456789abcdef';
  const queueEntry = (id: string, name: string, instanceUrl: string) => ({
    id,
    displayName: name,
    logoUrl: null,
    instanceUrl,
    tier: 'self_hosted',
    status: 'active',
    contactEmail: `owner@${id}.test`,
    contactName: null,
    partnerCount: 0,
    lastHeartbeatAt: null,
    suspensionReason: null,
    reviewStatus: 'pending',
    reviewedAt: null,
    reviewReason: null,
    createdAt: new Date().toISOString(),
    offeringCount: 1,
    publishedOfferingCount: 1,
    offerings: [{ id: `off_${id}`, title: 'Program', description: null, productUrl: 'https://x.test', published: true, createdAt: new Date().toISOString() }],
  });

  /** A hosted brand federated as vnd_hosted, plus a self-serve vnd_self. */
  async function setup(): Promise<{ slug: string }> {
    process.env.NETWORK_URL = netUrl;
    process.env.NETWORK_ADMIN_API_KEY = NET_KEY;
    const { slug } = await signup();
    const t = (await tenantBySlug(slug))!;
    await federate(t.id, 'vnd_hosted');
    netVendors = [
      { id: 'vnd_hosted', instanceUrl: 'https://app.test/api/t/x', status: 'active', reviewStatus: 'pending', displayName: 'Hosted' },
      { id: 'vnd_self', instanceUrl: 'https://selfhost.example.test', status: 'active', reviewStatus: 'pending', displayName: 'Selfhost Co' },
    ];
    netQueue = [
      queueEntry('vnd_hosted', 'Hosted', 'https://app.test/api/t/x'),
      queueEntry('vnd_self', 'Selfhost Co', 'https://selfhost.example.test'),
    ];
    return { slug };
  }

  it('lists the queue, marking our hosted brands as managed by brand review', async () => {
    const { slug } = await setup();
    const cookie = await makeOperator('support'); // read-only can view
    const res = await request(app).get('/platform-admin/network-vendors').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const byId = new Map((res.body.vendors as Array<{ id: string; managedBy: { slug: string } | null }>).map((v) => [v.id, v]));
    expect(byId.get('vnd_hosted')?.managedBy?.slug).toBe(slug);
    expect(byId.get('vnd_self')?.managedBy).toBeNull();
  });

  it('approves a self-serve vendor on the Network (optionally emailing it) and audits it', async () => {
    await setup();
    const cookie = await makeOperator('admin');
    netCalls = [];
    const res = await request(app)
      .post('/platform-admin/network-vendors/vnd_self/review')
      .set('Cookie', cookie)
      .send({ status: 'approved', notifyVendor: true });
    expect(res.status).toBe(200);
    const call = netCalls.find((c) => c.method === 'POST' && c.path === '/admin/vendors/vnd_self/review');
    expect(call?.authorization).toBe(`Bearer ${NET_KEY}`);
    expect(call?.body).toEqual({ status: 'approved', notifyVendor: true });

    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'network_vendor.approve', targetId: 'vnd_self' }).first();
    expect(audit?.detail).toMatchObject({ displayName: 'Selfhost Co', instanceUrl: 'https://selfhost.example.test' });
    await db(TABLES.PlatformAuditLog).where({ targetId: 'vnd_self' }).del();
  });

  it('refuses hosted brands (brand approval owns them), unknown vendors, and read-only operators', async () => {
    await setup();
    const admin = await makeOperator('admin');
    netCalls = [];
    const hosted = await request(app)
      .post('/platform-admin/network-vendors/vnd_hosted/review')
      .set('Cookie', admin)
      .send({ status: 'approved' });
    expect(hosted.status).toBe(409);
    expect(hosted.body.error).toBe('managed_by_brand_review');

    const unknown = await request(app)
      .post('/platform-admin/network-vendors/vnd_nope/review')
      .set('Cookie', admin)
      .send({ status: 'rejected' });
    expect(unknown.status).toBe(404);

    const support = await makeOperator('support');
    const ro = await request(app)
      .post('/platform-admin/network-vendors/vnd_self/review')
      .set('Cookie', support)
      .send({ status: 'approved' });
    expect(ro.status).toBe(403);
    expect(netCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('the reconcile job alerts the ops inbox once per newly pending self-serve vendor', async () => {
    await setup();
    const { __setMailerForTests } = await import('../mailer.js');
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    __setMailerForTests({ send: async (_ctx, msg) => void sent.push(msg) });
    process.env.PLATFORM_OPS_EMAIL = 'ops-inbox@openpartner.test';
    try {
      const { reconcileNetworkReview } = await import('../network-review-reconcile.js');
      const first = await reconcileNetworkReview();
      expect(first.alerted).toBe(1); // vnd_self only — vnd_hosted is a brand
      const alert = sent.find((m) => m.to === 'ops-inbox@openpartner.test');
      expect(alert?.subject).toContain('Selfhost Co');
      expect(alert?.text).toContain('/platform/vendors');

      sent.length = 0;
      const second = await reconcileNetworkReview();
      expect(second.alerted).toBe(0);
      expect(sent.filter((m) => m.to === 'ops-inbox@openpartner.test')).toHaveLength(0);
    } finally {
      __setMailerForTests(null);
      delete process.env.PLATFORM_OPS_EMAIL;
      await db(TABLES.PlatformSetting).where({ key: 'network_vendor_review_alerted' }).del();
    }
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

    // The brand re-saving the blocked program must not quietly re-list it.
    netCalls = [];
    const { syncCampaignToMarketplace } = await import('../campaign-marketplace-sync.js');
    const blocked = await db(TABLES.Program).where({ id: programId }).first();
    expect(blocked.blockedAt).not.toBeNull();
    await syncCampaignToMarketplace(db, t.id, blocked, '20% of every sale');
    const resync = netCalls.find((c) => c.path.includes('/offerings/off_123'));
    expect(resync, 'expected the sync to touch the offering').toBeDefined();
    expect((resync!.body as { published: boolean }).published).toBe(false);
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
