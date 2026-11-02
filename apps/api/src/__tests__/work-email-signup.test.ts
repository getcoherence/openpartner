/**
 * New brands need a work email (brand-review.ts workEmailRequiredFor).
 *
 *   1. isFreeMailAddress matches whole domains, whatever the case.
 *   2. The rule is on by default for the hosted platform, off self-hosted;
 *      GET /signup/settings tells the forms.
 *   3. Public /signup and add-brand (where "Sign up with Google" lands)
 *      refuse a Gmail address with work_email_required, before any Tenant
 *      row exists. A work address still signs up.
 *   4. Existing brands aren't touched: someone who already admins an
 *      approved brand from a Gmail address may still add one.
 *   5. Ops switch it off and on from the console (admins only, audited).
 *
 * Storefront requests (booking-claims.test.ts) follow the same rule.
 * Skipped without DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, isFreeMailAddress, type PlatformAdminRow, type PlatformSessionRow, type TenantRow } from '@openpartner/db';

// Hosted: the rule's default is on.
process.env.OPENPARTNER_MODE = 'revshare';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
const OPS_ADMIN = `ops-we-${ulid().slice(-6).toLowerCase()}@openpartner.test`;
const OPS_SUPPORT = `support-we-${ulid().slice(-6).toLowerCase()}@openpartner.test`;
process.env.PLATFORM_ADMIN_EMAILS = `${OPS_ADMIN},${OPS_SUPPORT}`;
delete process.env.NETWORK_URL; // no auto-enroll side calls
delete process.env.PLATFORM_OPS_EMAIL; // no ops mail

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { __setMailerForTests } = await import('../mailer.js');
const { createPlatformSession, PLATFORM_SESSION_COOKIE } = await import('../platform-sessions.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import('../platform-admin-sessions.js');
const { settleBackgroundScreeningsForTesting } = await import('../sanctions-screening.js');
const { brandSignupDefaults } = await import('../platform-settings.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const slugs: string[] = [];
const emails = new Set<string>();
const operatorIds: string[] = [];

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}
function gmail(tag: string): string {
  const e = `${tag}-${rnd()}@gmail.com`;
  emails.add(e);
  return e;
}
function slug(): string {
  const s = `we${rnd()}`;
  slugs.push(s);
  return s;
}

function signup(adminEmail: string, s = slug()) {
  emails.add(adminEmail.toLowerCase());
  return request(app).post('/signup').send({ slug: s, displayName: 'Work Email Co', adminEmail, adminName: 'Ada', plan: 'flex', country: 'US' });
}

async function platformCookie(email: string): Promise<string> {
  emails.add(email);
  return `${PLATFORM_SESSION_COOKIE}=${(await createPlatformSession(db, email)).plaintext}`;
}

function addBrand(cookie: string, s = slug()) {
  return request(app).post('/me/brands').set('Cookie', cookie).send({ slug: s, displayName: 'Second Brand', plan: 'flex', country: 'US' });
}

async function operatorCookie(email: string, role: 'admin' | 'support'): Promise<string> {
  const admin: PlatformAdminRow = { id: ulid(), email, name: 'Ops', role, createdAt: new Date(), revokedAt: null };
  await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(admin);
  operatorIds.push(admin.id);
  return `${PLATFORM_ADMIN_SESSION_COOKIE}=${(await createPlatformAdminSession(db, admin)).plaintext}`;
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  __setMailerForTests({ async send() {} });
});

afterAll(async () => {
  __setMailerForTests(null);
  if (!skipIntegration) {
    await settleBackgroundScreeningsForTesting();
    const tenantIds = (await db<TenantRow>(TABLES.Tenant).whereIn('slug', slugs).pluck('id')) as string[];
    for (const table of [
      TABLES.SanctionsScreening,
      TABLES.LocationDeclaration,
      TABLES.PasswordCredential,
      TABLES.Session,
      TABLES.MagicLinkToken,
      TABLES.Admin,
      TABLES.Config,
      TABLES.ApiKey,
    ]) {
      await db(table).whereIn('tenantId', tenantIds).del();
    }
    await db(TABLES.Tenant).whereIn('id', tenantIds).del();
    const sessions = await db<PlatformSessionRow>(TABLES.PlatformSession).whereIn('email', [...emails]);
    const bundleIds = [...new Set(sessions.map((s) => s.bundleId).filter((b): b is string => !!b))];
    await db(TABLES.PlatformSession).whereIn('email', [...emails]).del();
    if (bundleIds.length) await db(TABLES.PlatformSessionBundle).whereIn('id', bundleIds).del();
    await db(TABLES.PlatformAuditLog).whereIn('platformAdminEmail', [OPS_ADMIN, OPS_SUPPORT]).del();
    await db(TABLES.PlatformAdminSession).whereIn('platformAdminId', operatorIds).del();
    await db(TABLES.PlatformAdmin).whereIn('id', operatorIds).del();
    await db(TABLES.PlatformSetting).where({ key: 'brandSignup' }).del();
  }
  await db.destroy();
});

describe('isFreeMailAddress', () => {
  it('matches a free mail provider’s whole domain, whatever the case', () => {
    for (const e of [
      'ada@gmail.com',
      'Ada@GMail.COM',
      'ada+brand@gmail.com',
      'ada@googlemail.com',
      'ada@outlook.com',
      'ada@yahoo.co.uk',
      'ada@icloud.com',
      'ada@proton.me',
      'ada@email.com',
      'ada@tutanota.de',
      'ada@gmail.com.',
    ]) {
      expect(isFreeMailAddress(e), e).toBe(true);
    }
    for (const e of ['ada@example.com', 'ada@mail.example.com', 'ada@gmail.example', 'ada@notgmail.com', 'gmail.com', '']) {
      expect(isFreeMailAddress(e), e).toBe(false);
    }
  });

  it('answers at once, and rightly, for long runs of dots or @s (it reads public form input)', () => {
    const started = performance.now();
    // Within an address's length: trailing dots still name the same domain.
    expect(isFreeMailAddress(`ada@gmail.com${'.'.repeat(200)}`)).toBe(true);
    expect(isFreeMailAddress(`ada@${'.'.repeat(240)}x`)).toBe(false);
    expect(isFreeMailAddress(`${'@'.repeat(240)}gmail.com`)).toBe(true);
    expect(isFreeMailAddress('@'.repeat(254))).toBe(false);
    // Longer than any address can be: not one, whatever it ends with.
    expect(isFreeMailAddress(`ada@gmail.com${'.'.repeat(1_000_000)}`)).toBe(false);
    expect(isFreeMailAddress(`ada@${'.'.repeat(1_000_000)}x`)).toBe(false);
    expect(isFreeMailAddress(`${'@'.repeat(1_000_000)}gmail.com`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('the default', () => {
  it('is on for the hosted platform and off self-hosted', () => {
    const mode = process.env.OPENPARTNER_MODE;
    try {
      for (const [m, on] of [['revshare', true], ['flat', true], ['selfhost', false]] as const) {
        process.env.OPENPARTNER_MODE = m;
        expect(brandSignupDefaults(), m).toEqual({ workEmailRequired: on });
      }
    } finally {
      process.env.OPENPARTNER_MODE = mode;
    }
  });
});

describe.skipIf(skipIntegration)('new brands need a work email', () => {
  it('the signup forms are told', async () => {
    expect((await request(app).get('/signup/settings')).body).toEqual({ workEmailRequired: true });
  });

  it('public signup refuses a Gmail address before creating anything, and takes a work one', async () => {
    const s = slug();
    const refused = await signup(gmail('Ada').toUpperCase(), s);
    expect([refused.status, refused.body]).toEqual([403, { error: 'work_email_required' }]);
    expect(await db(TABLES.Tenant).where({ slug: s }).first()).toBeUndefined();

    const work = `ada-${rnd()}@workbrand.test`;
    const ok = await signup(work, s);
    expect(ok.status).toBe(201);
    expect(await db(TABLES.Admin).where({ tenantId: ok.body.tenant.id }).pluck('email')).toEqual([work]);
  });

  it('add-brand (where Sign up with Google lands) refuses a Gmail identity, and /me/workspaces says so', async () => {
    const cookie = await platformCookie(gmail('google'));
    expect((await request(app).get('/me/workspaces').set('Cookie', cookie)).body).toMatchObject({ workspaces: [], workEmailRequired: true });
    const s = slug();
    const res = await addBrand(cookie, s);
    expect([res.status, res.body]).toEqual([403, { error: 'work_email_required' }]);
    expect(await db(TABLES.Tenant).where({ slug: s }).first()).toBeUndefined();

    const work = await platformCookie(`grace-${rnd()}@workbrand.test`);
    expect((await request(app).get('/me/workspaces').set('Cookie', work)).body.workEmailRequired).toBe(false);
    expect((await addBrand(work)).status).toBe(201);
  });

  it('someone already running an approved brand from Gmail keeps it, and may add another', async () => {
    const email = gmail('owner');
    const tenantId = ulid();
    const s = slug();
    await db(TABLES.Tenant).insert({ id: tenantId, slug: s, displayName: 'Old Brand', status: 'active', approvalStatus: 'approved' });
    await db(TABLES.Admin).insert({ id: ulid(), tenantId, email, name: 'Owner', activatedAt: new Date() });
    const cookie = await platformCookie(email);

    const me = await request(app).get('/me/workspaces').set('Cookie', cookie);
    expect(me.body).toMatchObject({ workspaces: [{ tenantSlug: s }], workEmailRequired: false });
    expect((await request(app).post('/workspaces/enter').set('Cookie', cookie).send({ slug: s })).status).toBe(200);

    const added = await addBrand(cookie);
    expect(added.status).toBe(201);
    expect(added.body.approvalStatus).toBe('approved');

    // Public signup applies the same exception.
    expect((await signup(email)).status).toBe(201);

    // Only an approved, active brand they still admin counts: not one in
    // review, a suspended one, or one they were removed from.
    for (const [tag, tenant, revokedAt] of [
      ['pending', { status: 'active', approvalStatus: 'pending' }, null],
      ['suspended', { status: 'suspended', approvalStatus: 'approved' }, null],
      ['revoked', { status: 'active', approvalStatus: 'approved' }, new Date()],
    ] as const) {
      const other = gmail(tag);
      const id = ulid();
      await db(TABLES.Tenant).insert({ id, slug: slug(), displayName: tag, ...tenant });
      await db(TABLES.Admin).insert({ id: ulid(), tenantId: id, email: other, name: tag, activatedAt: new Date(), revokedAt });
      expect((await addBrand(await platformCookie(other))).body, tag).toEqual({ error: 'work_email_required' });
      expect((await signup(other)).body, tag).toEqual({ error: 'work_email_required' });
    }
  });

  it('a Gmail address can’t reclaim an abandoned signup’s slug either', async () => {
    const s = slug();
    const work = `first-${rnd()}@workbrand.test`;
    expect((await signup(work, s)).status).toBe(201);
    const refused = await signup(gmail('reclaim'), s);
    expect([refused.status, refused.body]).toEqual([403, { error: 'work_email_required' }]);
    const tenant = await db<TenantRow>(TABLES.Tenant).where({ slug: s }).first();
    expect(await db(TABLES.Admin).where({ tenantId: tenant!.id }).pluck('email')).toEqual([work]);
  });

  it('ops switch it off and back on; read-only operators can’t', async () => {
    const support = await operatorCookie(OPS_SUPPORT, 'support');
    const admin = await operatorCookie(OPS_ADMIN, 'admin');
    expect((await request(app).get('/platform-admin/brand-signup').set('Cookie', support)).body).toEqual({ settings: { workEmailRequired: true } });
    expect((await request(app).put('/platform-admin/brand-signup').set('Cookie', support).send({ workEmailRequired: false })).status).toBe(403);
    expect((await request(app).put('/platform-admin/brand-signup').set('Cookie', admin).send({ workEmailRequired: 'no' })).status).toBe(400);

    const off = await request(app).put('/platform-admin/brand-signup').set('Cookie', admin).send({ workEmailRequired: false });
    expect([off.status, off.body]).toEqual([200, { settings: { workEmailRequired: false } }]);
    expect((await request(app).get('/signup/settings')).body).toEqual({ workEmailRequired: false });
    expect((await signup(gmail('off'))).status).toBe(201);
    expect(
      await db(TABLES.PlatformAuditLog).where({ platformAdminEmail: OPS_ADMIN, action: 'brand_signup.settings' }).pluck('detail'),
    ).toEqual([{ workEmailRequired: false }]);

    expect((await request(app).put('/platform-admin/brand-signup').set('Cookie', admin).send({ workEmailRequired: true })).status).toBe(200);
    expect((await signup(gmail('on'))).body).toEqual({ error: 'work_email_required' });
  });
});
