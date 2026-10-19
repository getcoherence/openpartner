/**
 * Countries the hosted platform doesn't serve (country-access.ts).
 *
 * Multi-tenant mode, real HTTP surface:
 *   1. Brand signup refuses a blocked declared country (sanctions or
 *      policy), a blocked request country, and a Ukrainian signup that
 *      hasn't confirmed it is outside the occupied regions. An allowed
 *      signup records a LocationDeclaration.
 *   2. Sign-in refuses requests from a blocked country.
 *   3. The ops console reads and edits the list; edits are audited and
 *      take effect at once; enforce:false turns refusals off.
 *   4. Existing brands answer the location question; a blocked answer is
 *      refused and still recorded.
 *   5. Partner join requires a country on the hosted platform and refuses
 *      blocked ones.
 *
 * The IP lookup is stubbed: tests set what country "the request comes from".
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import {
  TABLES,
  type LocationDeclarationRow,
  type PlatformAdminRow,
  type TenantRow,
} from '@openpartner/db';

const ADMIN_KEY = 'op_test_countryaccess_0123456789abcdef01';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.PLATFORM_ADMIN_EMAILS = 'ops-country@openpartner.test';
delete process.env.NETWORK_URL;
delete process.env.PLATFORM_OPS_EMAIL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { setIpCountryLookupForTesting } = await import('../geoip.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import(
  '../platform-admin-sessions.js'
);

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const OPS_EMAIL = 'ops-country@openpartner.test';
const createdTenantIds: string[] = [];
let operatorId: string | null = null;
let settingExisted = false;
/** Where the stubbed lookup says the request comes from. */
let requestCountry: string | null = 'US';

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}

async function signup(body: Record<string, unknown>) {
  const slug = `ca${rnd()}`;
  const res = await request(app)
    .post('/signup')
    .send({
      slug,
      displayName: 'Country Test',
      adminEmail: `admin-${rnd()}@example.test`,
      adminName: 'Admin',
      plan: 'flex',
      ...body,
    });
  const tenant = await db<TenantRow>(TABLES.Tenant).where({ slug }).first();
  if (tenant) createdTenantIds.push(tenant.id);
  return { res, tenant };
}

async function declarations(subjectId: string): Promise<LocationDeclarationRow[]> {
  return db<LocationDeclarationRow>(TABLES.LocationDeclaration).where({ subjectId }).orderBy('createdAt', 'asc');
}

async function operatorCookie(): Promise<string> {
  const existing = await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ email: OPS_EMAIL }).first();
  let admin: PlatformAdminRow;
  if (existing) {
    admin = existing;
  } else {
    admin = { id: ulid(), email: OPS_EMAIL, name: 'Ops', role: 'admin', createdAt: new Date(), revokedAt: null };
    await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(admin);
  }
  operatorId = admin.id;
  const session = await createPlatformAdminSession(db, admin);
  return `${PLATFORM_ADMIN_SESSION_COOKIE}=${session.plaintext}`;
}

/** A live, approved brand with a plan, as a pre-existing customer. */
async function seedBrand(): Promise<TenantRow> {
  const id = ulid();
  const slug = `ca${rnd()}`;
  await db(TABLES.Tenant).insert({
    id,
    slug,
    displayName: 'Existing Brand',
    status: 'active',
    approvalStatus: 'approved',
    billingPlan: 'enterprise',
  });
  createdTenantIds.push(id);
  return (await db<TenantRow>(TABLES.Tenant).where({ id }).first())!;
}

beforeAll(async () => {
  if (skipIntegration) return;
  settingExisted = !!(await db(TABLES.PlatformSetting).where({ key: 'countryAccess' }).first());
  setIpCountryLookupForTesting(async () => requestCountry);
});

beforeEach(async () => {
  requestCountry = 'US';
  if (skipIntegration) return;
  // Every test starts from the shipped defaults.
  await db(TABLES.PlatformSetting).where({ key: 'countryAccess' }).del();
});

afterEach(async () => {
  if (skipIntegration) return;
  for (const tenantId of createdTenantIds.splice(0)) {
    for (const table of [
      TABLES.LocationDeclaration,
      TABLES.Partner,
      TABLES.Admin,
      TABLES.MagicLinkToken,
      TABLES.Session,
      TABLES.Config,
      TABLES.ApiKey,
    ]) {
      await db(table).where({ tenantId }).del();
    }
    await db(TABLES.Tenant).where({ id: tenantId }).del();
  }
});

afterAll(async () => {
  setIpCountryLookupForTesting(null);
  if (!skipIntegration) {
    if (!settingExisted) await db(TABLES.PlatformSetting).where({ key: 'countryAccess' }).del();
    await db(TABLES.PlatformAuditLog).where({ platformAdminEmail: OPS_EMAIL }).del();
    if (operatorId) {
      await db(TABLES.PlatformAdminSession).where({ platformAdminId: operatorId }).del();
      await db(TABLES.PlatformAdmin).where({ id: operatorId }).del();
    }
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('country access — brand signup', () => {
  it('records where an allowed brand is based', async () => {
    requestCountry = 'DE';
    const { res, tenant } = await signup({ country: 'us' });
    expect(res.status).toBe(201);
    const rows = await declarations(tenant!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subjectKind: 'tenant',
      tenantId: tenant!.id,
      country: 'US',
      ipCountry: 'DE',
      source: 'signup',
      outsideOccupiedRegions: null,
    });
  });

  it('requires a valid country', async () => {
    expect((await signup({})).res.status).toBe(400);
    expect((await signup({ country: 'ZZ' })).res.status).toBe(400);
  });

  it.each([['RU'], ['IR'], ['CU'], ['KP']])('refuses a brand based in %s and creates nothing', async (country) => {
    const { res, tenant } = await signup({ country });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('country_not_supported');
    expect(tenant).toBeUndefined();
  });

  it('refuses a signup coming from a blocked country, whatever it declares', async () => {
    requestCountry = 'KP';
    const { res, tenant } = await signup({ country: 'US' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('country_not_supported');
    expect(tenant).toBeUndefined();
  });

  it('asks a Ukrainian brand to confirm it is outside the occupied regions', async () => {
    const refused = await signup({ country: 'UA' });
    expect(refused.res.status).toBe(400);
    expect(refused.res.body.error).toBe('occupied_region_confirmation_required');
    expect(refused.tenant).toBeUndefined();

    const ok = await signup({ country: 'UA', outsideOccupiedRegions: true });
    expect(ok.res.status).toBe(201);
    expect((await declarations(ok.tenant!.id))[0]).toMatchObject({ country: 'UA', outsideOccupiedRegions: true });
  });
});

describe.skipIf(skipIntegration)('country access — sign-in', () => {
  it('refuses sign-in from a blocked country and allows it elsewhere', async () => {
    requestCountry = 'CU';
    const blocked = await request(app).post('/signin').send({ email: `x-${rnd()}@example.test` });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('country_not_supported');

    requestCountry = 'FR';
    const allowed = await request(app).post('/signin').send({ email: `x-${rnd()}@example.test` });
    expect(allowed.status).toBe(200);
  });

  it('refuses the tenant sign-in and magic-link verify from a blocked country', async () => {
    const brand = await seedBrand();
    requestCountry = 'IR';
    const signin = await request(app).post(`/t/${brand.slug}/auth/signin`).send({ email: `p-${rnd()}@example.test` });
    expect(signin.status).toBe(403);
    const verify = await request(app).post(`/t/${brand.slug}/auth/magic/verify`).send({ token: 'not-a-real-token' });
    expect(verify.status).toBe(403);
  });
});

describe.skipIf(skipIntegration)('country access — ops console', () => {
  it('ships sanctions-only defaults, takes policy entries from the operator, and audits edits', async () => {
    const cookie = await operatorCookie();
    const read = await request(app).get('/platform-admin/country-access').set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body.settings.enforce).toBe(true);
    const defaults = read.body.settings.blocked as Array<{ code: string; basis: string }>;
    expect(defaults).toEqual(
      expect.arrayContaining([
        { code: 'CU', basis: 'sanctions' },
        { code: 'IR', basis: 'sanctions' },
        { code: 'KP', basis: 'sanctions' },
        { code: 'RU', basis: 'sanctions' },
      ]),
    );
    expect(defaults.filter((b) => b.basis === 'policy')).toEqual([]);

    // AQ stands in for any country an operator chooses not to serve.
    expect((await signup({ country: 'AQ' })).res.status).toBe(201);
    const put = await request(app)
      .put('/platform-admin/country-access')
      .set('Cookie', cookie)
      .send({ blocked: [...defaults.filter((b) => b.code !== 'RU'), { code: 'aq', basis: 'policy' }] });
    expect(put.status).toBe(200);
    expect(put.body.settings.blocked).toContainEqual({ code: 'AQ', basis: 'policy' });

    // Takes effect at once.
    expect((await signup({ country: 'AQ' })).res.status).toBe(403);
    expect((await signup({ country: 'RU' })).res.status).toBe(201);

    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'country_access.settings', platformAdminEmail: OPS_EMAIL });
    expect(audit.length).toBeGreaterThan(0);
  });

  it('rejects unknown codes and stops refusing when enforcement is off', async () => {
    const cookie = await operatorCookie();
    const bad = await request(app)
      .put('/platform-admin/country-access')
      .set('Cookie', cookie)
      .send({ blocked: [{ code: 'QQ', basis: 'policy' }] });
    expect(bad.status).toBe(400);

    await request(app).put('/platform-admin/country-access').set('Cookie', cookie).send({ enforce: false }).expect(200);
    expect((await signup({ country: 'RU' })).res.status).toBe(201);
  });

  it('shows the declared country in the review queue', async () => {
    const { tenant } = await signup({ country: 'CA' });
    const cookie = await operatorCookie();
    const res = await request(app).get('/platform-admin/brands?status=pending').set('Cookie', cookie);
    const row = (res.body.brands as Array<{ id: string; country: string | null }>).find((b) => b.id === tenant!.id);
    expect(row?.country).toBe('CA');
  });
});

describe.skipIf(skipIntegration)('country access — existing brands', () => {
  it('asks once, records the answer, and refuses a blocked one', async () => {
    const brand = await seedBrand();
    const auth = { Authorization: `Bearer ${ADMIN_KEY}` };

    const before = await request(app).get(`/t/${brand.slug}/account/location`).set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ required: true, country: null });

    const blocked = await request(app).put(`/t/${brand.slug}/account/location`).set(auth).send({ country: 'RU' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('country_not_supported');
    // Kept as the compliance record even though it was refused.
    expect((await declarations(brand.id)).map((d) => d.country)).toEqual(['RU']);

    const ok = await request(app).put(`/t/${brand.slug}/account/location`).set(auth).send({ country: 'GB' });
    expect(ok.status).toBe(200);
    const after = await request(app).get(`/t/${brand.slug}/account/location`).set(auth);
    expect(after.body.country).toBe('GB');
  });
});

describe.skipIf(skipIntegration)('country access — partner join', () => {
  const application = {
    websiteUrl: 'https://creator.example',
    socialUrls: ['https://youtube.com/@creator'],
    audienceSize: '10k_50k',
    pitch: 'Weekly tutorials for indie founders; I would demo the product in a launch video.',
  };

  it('requires a country, refuses blocked ones, and records allowed ones', async () => {
    const brand = await seedBrand();
    const join = (body: Record<string, unknown>) =>
      request(app)
        .post(`/t/${brand.slug}/partner-signup`)
        .send({ email: `partner-${rnd()}@example.test`, name: 'Partner', application, ...body });

    const missing = await join({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('country_required');

    const blocked = await join({ country: 'IR' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('country_not_supported');

    const ok = await join({ country: 'DE' });
    expect(ok.status).toBe(201);
    const partner = await db(TABLES.Partner).where({ tenantId: brand.id }).first();
    expect((await declarations(partner.id))[0]).toMatchObject({
      subjectKind: 'partner',
      tenantId: brand.id,
      country: 'DE',
      source: 'join',
    });
  });
});
