/**
 * Brand-initiated partner sign-in (routes/partner-signin-link.ts): the
 * brand's backend mints a single-use, short-lived link that signs one of
 * its users in to the partner portal, for an in-app "Refer & earn" that
 * shouldn't ask for a second login.
 *
 *   - the link signs the right partner in, once; a second use fails;
 *   - an expired link fails;
 *   - partners /auth/signin wouldn't mail, and brands still in review, are
 *     refused, and so is everything but an API key holding the scope —
 *     the Network federation key above all;
 *   - the link is on the brand's white-label domain when it has one;
 *   - each mint is recorded and rate-limited.
 *
 * Multi-tenant, so the path-based and custom-domain links both get built.
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type MagicLinkTokenRow, type PartnerSigninLinkLogRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_signin_link_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
delete process.env.NETWORK_URL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { createSession } = await import('../auth-sessions.js');
const { NETWORK_FEDERATION_SCOPES } = await import('../routes/api-keys.js');
const { SIGNIN_LINK_TTL_MS } = await import('../routes/partner-signin-link.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const createdTenants: string[] = [];

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}

interface Brand {
  id: string;
  slug: string;
}

async function seedBrand(opts: { customDomain?: string; approvalStatus?: string } = {}): Promise<Brand> {
  const id = ulid();
  const slug = `sl${rnd()}`;
  await db(TABLES.Tenant).insert({
    id,
    slug,
    displayName: `Brand ${slug}`,
    status: 'active',
    approvalStatus: opts.approvalStatus ?? 'approved',
    customDomain: opts.customDomain ?? null,
    whiteLabel: !!opts.customDomain,
  });
  createdTenants.push(id);
  return { id, slug };
}

async function seedPartner(brand: Brand, extra: Record<string, unknown> = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: brand.id,
    email: `p-${rnd()}@brand.test`,
    name: 'Riya',
    metadata: {},
    activatedAt: new Date(),
    ...extra,
  });
  return id;
}

function mint(brand: Brand, partnerId: string, body: object = {}, key = ADMIN_KEY) {
  return request(app)
    .post(`/t/${brand.slug}/partners/${partnerId}/signin-link`)
    .set('Authorization', `Bearer ${key}`)
    .send(body);
}

function mintBy(brand: Brand, body: object, key = ADMIN_KEY) {
  return request(app).post(`/t/${brand.slug}/partners/signin-link`).set('Authorization', `Bearer ${key}`).send(body);
}

function tokenOf(url: string): string {
  const token = new URL(url).searchParams.get('token');
  if (!token) throw new Error(`no token in ${url}`);
  return token;
}

function verify(brand: Brand, token: string) {
  return request(app).post(`/t/${brand.slug}/auth/magic/verify`).send({ token });
}

async function tokensFor(partnerId: string): Promise<MagicLinkTokenRow[]> {
  return db<MagicLinkTokenRow>(TABLES.MagicLinkToken).where({ principalKind: 'partner', principalId: partnerId });
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterEach(async () => {
  if (skipIntegration) return;
  for (const id of createdTenants.splice(0)) {
    for (const t of [
      TABLES.PartnerSigninLinkLog,
      TABLES.Session,
      TABLES.MagicLinkToken,
      TABLES.ApiKey,
      TABLES.Config,
      TABLES.Admin,
      TABLES.Partner,
    ]) {
      await db(t).where({ tenantId: id }).del();
    }
    await db(TABLES.Tenant).where({ id }).del();
  }
});

afterAll(async () => {
  await db.destroy();
});

describe.skipIf(skipIntegration)('POST /partners/:id/signin-link', () => {
  it('signs the named partner in once; a second use fails', async () => {
    const brand = await seedBrand();
    const riya = await seedPartner(brand);
    const other = await seedPartner(brand);

    const res = await mint(brand, riya);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.partnerId).toBe(riya);
    expect(res.body.url.startsWith(`http://localhost:5673/t/${brand.slug}/auth/magic?token=`)).toBe(true);

    const token = tokenOf(res.body.url);
    const first = await verify(brand, token);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, role: 'partner', partner: { id: riya } });

    // The cookie it sets is Riya's session, not the other partner's.
    const cookie = (first.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('op_session='))!.split(';')[0]!;
    const whoami = await request(app).get(`/t/${brand.slug}/auth/whoami`).set('Cookie', cookie);
    expect(whoami.status).toBe(200);
    expect(whoami.body).toMatchObject({ role: 'partner', partnerId: riya });
    expect(whoami.body.partnerId).not.toBe(other);

    const second = await verify(brand, token);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_or_expired_token');

    // The token is a sign-in link of its own kind, five minutes long, and
    // the mint is on record with the key that asked for it.
    const [row] = await tokensFor(riya);
    expect(row!.purpose).toBe('partner_signin_link');
    expect(row!.consumedAt).not.toBeNull();
    const ttl = new Date(row!.expiresAt).getTime() - new Date(row!.createdAt).getTime();
    expect(ttl).toBeLessThanOrEqual(SIGNIN_LINK_TTL_MS + 1_000);
    expect(ttl).toBeGreaterThan(SIGNIN_LINK_TTL_MS - 5_000);
    expect(new Date(res.body.expiresAt).getTime()).toBe(new Date(row!.expiresAt).getTime());

    const log = await db<PartnerSigninLinkLogRow>(TABLES.PartnerSigninLinkLog).where({ tenantId: brand.id });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      partnerId: riya,
      magicLinkTokenId: row!.id,
      actorKind: 'operator_key',
      actorId: null,
      returnTo: null,
    });
    expect(log[0]!.ip).toBeTruthy();
  });

  it('an expired link fails', async () => {
    const brand = await seedBrand();
    const riya = await seedPartner(brand);
    const res = await mint(brand, riya);
    expect(res.status).toBe(201);
    expect(new Date(res.body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + SIGNIN_LINK_TTL_MS);

    await db(TABLES.MagicLinkToken)
      .where({ principalId: riya })
      .update({ expiresAt: new Date(Date.now() - 1_000) });
    const used = await verify(brand, tokenOf(res.body.url));
    expect(used.status).toBe(400);
    expect(used.body.error).toBe('invalid_or_expired_token');
    expect(used.headers['set-cookie']).toBeUndefined();
  });

  it('refuses partners /auth/signin would not mail, and mints nothing for them', async () => {
    const brand = await seedBrand();
    const cases: Array<[string, Record<string, unknown>, number, string]> = [
      ['revoked', { revokedAt: new Date() }, 409, 'partner_revoked'],
      ['no portal access', { portalAccess: false }, 409, 'portal_access_disabled'],
      [
        'applicant held for review',
        { activatedAt: null, metadata: { review: { status: 'pending' } } },
        409,
        'pending_review',
      ],
      ['invited, not yet accepted', { activatedAt: null }, 409, 'partner_not_activated'],
    ];
    for (const [label, extra, status, error] of cases) {
      const id = await seedPartner(brand, extra);
      const res = await mint(brand, id);
      expect({ label, status: res.status, error: res.body.error }).toEqual({ label, status, error });
      expect(await tokensFor(id)).toEqual([]);
    }

    const missing = await mint(brand, ulid());
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('partner_not_found');

    // Another brand's partner is unknown here.
    const elsewhere = await seedBrand();
    const theirs = await seedPartner(elsewhere);
    const cross = await mint(brand, theirs);
    expect(cross.status).toBe(404);
    expect(await tokensFor(theirs)).toEqual([]);

    expect(await db(TABLES.PartnerSigninLinkLog).where({ tenantId: brand.id })).toEqual([]);
  });

  it('refuses a brand still in review', async () => {
    const brand = await seedBrand({ approvalStatus: 'pending' });
    const riya = await seedPartner(brand);
    for (const res of [await mint(brand, riya), await mintBy(brand, { email: 'x@brand.test' })]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('brand_pending_review');
    }
    expect(await tokensFor(riya)).toEqual([]);
  });

  it('a link minted before the partner was revoked no longer signs them in', async () => {
    const brand = await seedBrand();
    const riya = await seedPartner(brand);
    const res = await mint(brand, riya);
    expect(res.status).toBe(201);
    await db(TABLES.Partner).where({ id: riya }).update({ revokedAt: new Date() });
    const used = await verify(brand, tokenOf(res.body.url));
    expect(used.status).toBe(403);
    expect(used.body.error).toBe('partner_revoked');
  });
});

describe.skipIf(skipIntegration)('who may mint a sign-in link', () => {
  it('a key holding partners:signin may, and the mint records that key', async () => {
    const brand = await seedBrand();
    const riya = await seedPartner(brand);
    const key = await createApiKeyRow(db, { tenantId: brand.id, scopes: ['partners:signin'], label: 'app' });
    const res = await mint(brand, riya, {}, key.plaintext);
    expect(res.status).toBe(201);
    const [log] = await db<PartnerSigninLinkLogRow>(TABLES.PartnerSigninLinkLog).where({ tenantId: brand.id });
    expect(log).toMatchObject({ actorKind: 'api_key', actorId: key.id, partnerId: riya });

    // An unscoped admin key may too.
    const admin = await createApiKeyRow(db, { tenantId: brand.id, label: 'admin' });
    expect((await mint(brand, riya, {}, admin.plaintext)).status).toBe(201);
  });

  it('the Network federation key may not, with its own scopes or with partners:signin added', async () => {
    const brand = await seedBrand();
    const riya = await seedPartner(brand);

    // Its real scope set: partners:write doesn't stand in for partners:signin.
    const federation = await createApiKeyRow(db, { tenantId: brand.id, scopes: [...NETWORK_FEDERATION_SCOPES], label: 'network' });
    const refused = await mint(brand, riya, {}, federation.plaintext);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'forbidden_scope', required: 'partners:signin' });

    // Even if the scope were ever added to it, the key is refused by id.
    await db(TABLES.ApiKey)
      .where({ id: federation.id })
      .update({ scopes: JSON.stringify([...NETWORK_FEDERATION_SCOPES, 'partners:signin']) as unknown as never });
    await db(TABLES.Config).insert({
      tenantId: brand.id,
      key: 'network_membership',
      value: JSON.stringify({ enabled: true, networkUrl: '', vendorTokenCiphertext: '', scopedKeyId: federation.id, autoEnroll: false }),
    });
    const stillRefused = await mint(brand, riya, {}, federation.plaintext);
    expect(stillRefused.status).toBe(403);
    expect(stillRefused.body.error).toBe('forbidden');
    const byEmail = await mintBy(brand, { email: 'anyone@brand.test' }, federation.plaintext);
    expect(byEmail.status).toBe(403);

    expect(await tokensFor(riya)).toEqual([]);
  });

  it('other keys and portal sessions may not', async () => {
    const brand = await seedBrand();
    const riya = await seedPartner(brand);

    const linksOnly = await createApiKeyRow(db, { tenantId: brand.id, scopes: ['links:write'], label: 'links' });
    const scoped = await mint(brand, riya, {}, linksOnly.plaintext);
    expect(scoped.status).toBe(403);
    expect(scoped.body).toMatchObject({ error: 'forbidden_scope', required: 'partners:signin' });

    const partnerKey = await createApiKeyRow(db, { tenantId: brand.id, partnerId: riya, label: 'own' });
    expect((await mint(brand, riya, {}, partnerKey.plaintext)).status).toBe(403);

    // A brand admin signed in to the portal: this is a server-to-server call.
    const adminId = ulid();
    await db(TABLES.Admin).insert({ id: adminId, tenantId: brand.id, email: `a-${rnd()}@brand.test`, name: 'Ada', activatedAt: new Date() });
    const session = await createSession(db, { tenantId: brand.id, principalKind: 'admin', principalId: adminId });
    const viaSession = await request(app)
      .post(`/t/${brand.slug}/partners/${riya}/signin-link`)
      .set('Cookie', `op_session=${session.plaintext}`)
      .send({});
    expect(viaSession.status).toBe(403);
    expect(viaSession.body.error).toBe('api_key_required');

    const anonymous = await request(app).post(`/t/${brand.slug}/partners/${riya}/signin-link`).send({});
    expect(anonymous.status).toBe(401);

    expect(await tokensFor(riya)).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('where the link lands', () => {
  it("uses the brand's white-label domain, and signs in on that host", async () => {
    const domain = `refer-${rnd()}.brand.test`;
    const brand = await seedBrand({ customDomain: domain });
    const riya = await seedPartner(brand);

    const res = await mint(brand, riya, { returnTo: '/links' });
    expect(res.status).toBe(201);
    const url = new URL(res.body.url);
    expect(url.origin).toBe(`https://${domain}`);
    expect(url.pathname).toBe('/auth/magic');
    expect(url.searchParams.get('next')).toBe('/links');

    // The portal on that domain posts the token to its own /api, which
    // resolves the brand from the Host header.
    const used = await request(app).post('/auth/magic/verify').set('Host', domain).send({ token: tokenOf(res.body.url) });
    expect(used.status).toBe(200);
    expect(used.body.partner.id).toBe(riya);

    const [log] = await db<PartnerSigninLinkLogRow>(TABLES.PartnerSigninLinkLog).where({ tenantId: brand.id });
    expect(log!.returnTo).toBe('/links');
  });

  it('takes a portal path for returnTo and nothing that leaves the portal', async () => {
    const brand = await seedBrand();
    const riya = await seedPartner(brand);
    const ok = await mint(brand, riya, { returnTo: '/commissions?program=p1' });
    expect(ok.status).toBe(201);
    expect(new URL(ok.body.url).searchParams.get('next')).toBe('/commissions?program=p1');

    for (const returnTo of ['https://evil.test/', '//evil.test/x', '/\\evil.test', '/.//evil.test', 'links', '/a b']) {
      const res = await mint(brand, riya, { returnTo });
      expect({ returnTo, status: res.status }).toEqual({ returnTo, status: 400 });
    }
    const extra = await mint(brand, riya, { partnerId: riya });
    expect(extra.status).toBe(400);
  });
});

describe.skipIf(skipIntegration)('POST /partners/signin-link (by email or metadata)', () => {
  it("finds the partner by email or by the brand's own user id", async () => {
    const brand = await seedBrand();
    const email = `ada-${rnd()}@brand.test`;
    const ada = await seedPartner(brand, { email, metadata: { appUserId: 'u_123', plan: 'pro' } });
    await seedPartner(brand, { metadata: { appUserId: 'u_456' } });

    const byEmail = await mintBy(brand, { email: email.toUpperCase() });
    expect(byEmail.status).toBe(201);
    expect(byEmail.body.partnerId).toBe(ada);

    const byMeta = await mintBy(brand, { metadata: { appUserId: 'u_123' }, returnTo: '/links' });
    expect(byMeta.status).toBe(201);
    expect(byMeta.body.partnerId).toBe(ada);
    const used = await verify(brand, tokenOf(byMeta.body.url));
    expect(used.body.partner.id).toBe(ada);

    // Matched as stored: the string id isn't the number.
    expect((await mintBy(brand, { metadata: { appUserId: 123 } })).status).toBe(404);
    expect((await mintBy(brand, { email: 'nobody@brand.test' })).status).toBe(404);
  });

  it('wants exactly one identifier, and refuses an ambiguous one', async () => {
    const brand = await seedBrand();
    const email = `ada-${rnd()}@brand.test`;
    await seedPartner(brand, { email, metadata: { team: 'growth' } });
    await seedPartner(brand, { metadata: { team: 'growth' } });

    for (const body of [{}, { email, metadata: { team: 'growth' } }, { metadata: {} }, { metadata: { team: 'growth', x: 'y' } }]) {
      const res = await mintBy(brand, body);
      expect({ body, status: res.status, error: res.body.error }).toEqual({ body, status: 400, error: 'invalid_body' });
    }
    const ambiguous = await mintBy(brand, { metadata: { team: 'growth' } });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error).toBe('ambiguous_partner');
  });

  it('applies the same refusals', async () => {
    const brand = await seedBrand();
    const email = `off-${rnd()}@brand.test`;
    await seedPartner(brand, { email, portalAccess: false });
    const res = await mintBy(brand, { email });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('portal_access_disabled');
  });
});

describe.skipIf(skipIntegration)('sign-in link rate limit', () => {
  it('caps the links one partner can be sent in a minute', async () => {
    const brand = await seedBrand();
    const riya = await seedPartner(brand);
    for (let i = 0; i < 10; i += 1) expect((await mint(brand, riya)).status).toBe(201);
    const over = await mint(brand, riya);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('rate_limited');
    expect(over.headers['retry-after']).toBe('60');
    expect(await tokensFor(riya)).toHaveLength(10);

    // Someone else at the same brand is unaffected.
    expect((await mint(brand, await seedPartner(brand))).status).toBe(201);
  });
});
