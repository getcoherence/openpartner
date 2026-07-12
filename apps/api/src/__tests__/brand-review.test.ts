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
  for (const table of [TABLES.Admin, TABLES.MagicLinkToken, TABLES.Session, TABLES.Config, TABLES.ApiKey]) {
    await db(table).where({ tenantId: t.id }).del();
  }
  await db(TABLES.Tenant).where({ id: t.id }).del();
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterEach(async () => {
  if (skipIntegration) return;
  for (const slug of createdSlugs.splice(0)) await purgeSlug(slug);
  if (createdBlocklistValues.length) {
    await db(TABLES.SignupBlocklist).whereIn('value', createdBlocklistValues.splice(0)).del();
  }
});

afterAll(async () => {
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
