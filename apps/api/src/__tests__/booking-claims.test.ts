/**
 * Storefront requests continue as brands, and the brand side of
 * conversations and paid bookings (openpartner-network
 * docs/creator-storefront.md §8; routes/booking-claims.ts, settings.ts).
 *
 *   1. /booking-claims/preview reads the request with the Network admin
 *      key, and says whether the address already has a brand.
 *   2. /booking-claims/signup creates a pending brand for that address with
 *      no plan, activated, signed in (platform + tenant sessions), enrolled
 *      on the Network, and claims the request into it with the brand's
 *      booking fee rate (Revshare with no plan).
 *   3. An address that already has any identity here (an admin row, even
 *      revoked; an operator; a platform password) must sign in instead.
 *   4. The brand's proxies send the signed-in admin and the fee rate;
 *      a brand in review can claim, write and pay but not reach out.
 *   5. Tracking a booking (an offering) needs a plan.
 *
 * A local HTTP server plays the Network. Skipped without DATABASE_URL.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type TenantRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_bookingclaims_0123456789abcdef01';
const NETWORK_ADMIN = 'netadm_test_bookingclaims_0123456789abcd';
process.env.ADMIN_API_KEY = ADMIN_KEY;
// Hosted revshare: a brand with no plan pays the Revshare booking fee.
process.env.OPENPARTNER_MODE = 'revshare';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.NETWORK_ADMIN_API_KEY = NETWORK_ADMIN;
delete process.env.PLATFORM_OPS_EMAIL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createSession } = await import('../auth-sessions.js');
const { encryptSecret } = await import('../crypto.js');
const { settleBackgroundScreeningsForTesting } = await import('../sanctions-screening.js');
const { suggestSlug } = await import('../routes/booking-claims.js');
const { platformCredential, setPassword } = await import('../passwords.js');
const { createApiKeyRow } = await import('../auth.js');
const { NETWORK_FEDERATION_SCOPES } = await import('../routes/api-keys.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const TOKEN = `opbk_${'a'.repeat(48)}`;
const EXPIRED = `opbk_${'e'.repeat(48)}`;
const REQUESTER = `grace-${ulid().slice(-6).toLowerCase()}@newbrand.test`;
/** Links sent to addresses that already have some identity here. */
const OTHER_TOKENS = new Map<string, string>(
  ['revoked', 'operator', 'envop', 'password', 'race'].map((k, i) => [`opbk_${String(i + 1).repeat(48)}`, `${k}-${ulid().slice(-6).toLowerCase()}@other.test`]),
);

interface Call {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown> | null;
}
const calls: Call[] = [];
let network: Server;
let networkUrl: string;

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    network = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : null;
        const path = req.url ?? '';
        calls.push({ method: req.method ?? '', path, auth: req.headers.authorization, body });
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (path === '/bookings/preview') {
          if (req.headers.authorization !== `Bearer ${NETWORK_ADMIN}`) return json(401, { error: 'unauthorized' });
          if (body?.token === EXPIRED) return json(410, { error: 'expired' });
          const other = OTHER_TOKENS.get(String(body?.token));
          if (body?.token !== TOKEN && !other) return json(404, { error: 'invalid_or_used' });
          return json(200, {
            creator: { id: 'crt_ada', name: 'Ada Lovelace', handle: 'ada', avatarUrl: null },
            packageTitle: 'Deep dive',
            contactName: 'Grace Hopper',
            contactEmail: other ?? REQUESTER,
            company: 'New Brand Co',
            website: null,
            brief: 'A deep-dive post about our app, please.',
            budgetNote: null,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          });
        }
        if (path === '/vendors/signup') {
          return json(201, { vendorId: `vnd_${ulid()}`, vendorToken: 'vntok_test_bookingclaims', status: 'active', displayName: body?.displayName });
        }
        if (path === '/vendors/me/bookings/claim') return json(201, { booking: { id: 'bkr_1' }, conversationId: 'cnv_claimed' });
        if (path === '/vendors/me/conversations' && req.method === 'POST') return json(201, { conversationId: 'cnv_new', message: {} });
        if (/^\/vendors\/me\/conversations\/[^/]+\/messages$/.test(path)) return json(201, { message: {} });
        if (/^\/vendors\/me\/conversations\/[^/]+\/realtime$/.test(path)) return json(200, { ticket: 'tkt_v', expiresAt: '2026-10-25T21:00:00.000Z' });
        if (/^\/vendors\/me\/bookings\/[^/]+\/checkout$/.test(path)) return json(200, { url: 'https://checkout.stripe.test/cs_1' });
        if (path === '/vendors/me/bookings' && req.method === 'POST') return json(201, { booking: { id: 'bkr_2' }, conversationId: 'cnv_new' });
        json(404, { error: 'not_found' });
      });
    }).listen(0, '127.0.0.1', () => {
      networkUrl = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
      process.env.NETWORK_URL = networkUrl;
      resolve();
    });
  });
});

const slugs: string[] = [];

/** Every row any test made for these brands, then the brands. */
async function purge(slug: string): Promise<void> {
  const tenant = (await db<TenantRow>(TABLES.Tenant).where({ slug }).first()) as TenantRow | undefined;
  if (!tenant) return;
  const tables = (await db('information_schema.columns')
    .where({ table_schema: 'public', column_name: 'tenantId' })
    .andWhereNot('table_name', TABLES.Tenant)
    .pluck('table_name')) as string[];
  // Children first: retry tables an FK holds back until a pass deletes nothing new.
  for (let pass = 0; pass < 4; pass += 1) {
    for (const t of tables) {
      try {
        await db(t).where({ tenantId: tenant.id }).del();
      } catch {
        /* an FK still points here; the next pass gets it */
      }
    }
  }
  await db(TABLES.Tenant).where({ id: tenant.id }).del();
}

afterEach(async () => {
  if (skipIntegration) return;
  await settleBackgroundScreeningsForTesting();
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const s of slugs) await purge(s);
    const others = [...OTHER_TOKENS.values()];
    const signedIn = [REQUESTER, ...others];
    const sessions = (await db(TABLES.PlatformSession).whereIn('email', signedIn).select('bundleId')) as Array<{ bundleId: string | null }>;
    await db(TABLES.PlatformSession).whereIn('email', signedIn).del();
    const bundles = sessions.map((s) => s.bundleId).filter((b): b is string => !!b);
    if (bundles.length) await db(TABLES.PlatformSessionBundle).whereIn('id', bundles).del();
    await db(TABLES.PlatformAdmin).whereIn('email', others).del();
    await db(TABLES.PasswordCredential).where({ principalKind: 'platform' }).whereIn('principalId', others).del();
  }
  if (network) await new Promise<void>((r) => network.close(() => r()));
  await db.destroy();
});

/** A brand with a session, a Network membership and a given review/plan. */
async function brand(opts: { approvalStatus?: TenantRow['approvalStatus']; plan?: TenantRow['billingPlan'] } = {}) {
  const tenantId = ulid();
  const slug = `bc${ulid().slice(-8).toLowerCase()}`;
  slugs.push(slug);
  await db(TABLES.Tenant).insert({
    id: tenantId,
    slug,
    displayName: 'Acme',
    status: 'active',
    approvalStatus: opts.approvalStatus ?? 'approved',
    billingPlan: opts.plan ?? null,
  });
  const adminId = ulid();
  await db<AdminRow>(TABLES.Admin).insert({ id: adminId, tenantId, email: `owner-${slug}@acme.test`, name: 'Owen Owner', activatedAt: new Date() });
  await db(TABLES.Config).insert({
    tenantId,
    key: 'network_membership',
    value: {
      enabled: true,
      networkUrl,
      vendorTokenCiphertext: encryptSecret('vntok_test_existing'),
      scopedKeyId: null,
      autoEnroll: true,
    } as unknown as never,
    updatedAt: new Date(),
  });
  const session = await createSession(db, { tenantId, principalKind: 'admin', principalId: adminId });
  return { tenantId, slug, cookie: `op_session=${session.plaintext}`, email: `owner-${slug}@acme.test` };
}

function last(path: string | RegExp): Call | undefined {
  return [...calls].reverse().find((c) => (typeof path === 'string' ? c.path === path : path.test(c.path)));
}

describe.skipIf(skipIntegration)('booking claims', () => {
  it('previews the request behind a link, and refuses a bad or expired one', async () => {
    const shown = await request(app).post('/booking-claims/preview').send({ token: TOKEN });
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      creator: { name: 'Ada Lovelace', handle: 'ada' },
      packageTitle: 'Deep dive',
      email: REQUESTER,
      accountExists: false,
      suggested: { displayName: 'New Brand Co', slug: 'new-brand-co' },
    });
    expect(last('/bookings/preview')!.auth).toBe(`Bearer ${NETWORK_ADMIN}`);
    expect((await request(app).post('/booking-claims/preview').send({ token: 'nope' })).status).toBe(404);
    expect(await request(app).post('/booking-claims/preview').send({ token: EXPIRED })).toMatchObject({ status: 410, body: { error: 'expired' } });
  });

  it('creates a pending brand for the address, signs it in and sends the request', async () => {
    const slug = `nb${ulid().slice(-8).toLowerCase()}`;
    slugs.push(slug);
    const res = await request(app)
      .post('/booking-claims/signup')
      .send({ token: TOKEN, displayName: 'New Brand Co', slug, country: 'US' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tenant: { slug }, approvalStatus: 'pending', conversationId: 'cnv_claimed', claimError: null });

    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []).map((c) => c.split('=')[0]);
    expect(cookies).toEqual(expect.arrayContaining(['op_session', 'op_platform_session', 'op_bundle_id']));

    const tenant = (await db<TenantRow>(TABLES.Tenant).where({ slug }).first())!;
    expect(tenant).toMatchObject({ approvalStatus: 'pending', billingPlan: null, status: 'active' });
    const admin = (await db<AdminRow>(TABLES.Admin).where({ tenantId: tenant.id }).first())!;
    expect(admin).toMatchObject({ email: REQUESTER, name: 'Grace Hopper' });
    expect(admin.activatedAt).toBeTruthy();

    expect(last('/vendors/signup')!.body).toMatchObject({ reviewStatus: 'pending', tier: 'hosted' });
    const claim = last('/vendors/me/bookings/claim')!;
    expect(claim.auth).toBe('Bearer vntok_test_bookingclaims');
    expect(claim.body).toEqual({ token: TOKEN, authorName: 'Grace Hopper', authorEmail: REQUESTER, bookingFeeBps: 1000 });

    // Now the address has a brand: the link only offers sign-in.
    expect((await request(app).post('/booking-claims/preview').send({ token: TOKEN })).body.accountExists).toBe(true);
    const again = await request(app).post('/booking-claims/signup').send({ token: TOKEN, displayName: 'Other', slug: `x${slug}`, country: 'US' });
    expect(again).toMatchObject({ status: 409, body: { error: 'account_exists' } });
  });

  it('any existing identity for the address signs in instead: a revoked admin, an operator, a platform password', async () => {
    const [revoked, operator, envop, password] = [...OTHER_TOKENS.entries()];
    // An admin revoked from a suspended brand.
    const old = await brand();
    await db(TABLES.Admin).where({ tenantId: old.tenantId }).update({ email: revoked![1], revokedAt: new Date() });
    await db(TABLES.Tenant).where({ id: old.tenantId }).update({ status: 'suspended' });
    // An ops-console operator, even a revoked one.
    await db(TABLES.PlatformAdmin).insert({ id: ulid(), email: operator![1], name: 'Op', role: 'support', revokedAt: new Date() });
    // An operator only in PLATFORM_ADMIN_EMAILS.
    const before = process.env.PLATFORM_ADMIN_EMAILS;
    process.env.PLATFORM_ADMIN_EMAILS = envop![1];
    // A platform password with no brand left.
    await setPassword(db, platformCredential(password![1]), 'correct horse battery staple');
    try {
      for (const [token] of [revoked!, operator!, envop!, password!]) {
        expect((await request(app).post('/booking-claims/preview').send({ token })).body.accountExists).toBe(true);
        const res = await request(app).post('/booking-claims/signup').send({ token, displayName: 'X', slug: `y${ulid().slice(-8).toLowerCase()}`, country: 'US' });
        expect(res).toMatchObject({ status: 409, body: { error: 'account_exists' } });
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    } finally {
      if (before === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
      else process.env.PLATFORM_ADMIN_EMAILS = before;
    }
  });

  it('two signups from one link at once make one brand', async () => {
    const [token, email] = [...OTHER_TOKENS.entries()].find(([, e]) => e.startsWith('race-'))!;
    const pick = () => {
      const slug = `rc${ulid().slice(-8).toLowerCase()}`;
      slugs.push(slug);
      return request(app).post('/booking-claims/signup').send({ token, displayName: 'Race Co', slug, country: 'US' });
    };
    const results = await Promise.all([pick(), pick()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body).toEqual({ error: 'account_exists' });
    expect(await db(TABLES.Admin).whereRaw('lower("email") = ?', [email])).toHaveLength(1);
  });

  it('refuses reserved and taken workspace addresses, and countries it does not serve', async () => {
    expect((await request(app).post('/booking-claims/signup').send({ token: TOKEN, displayName: 'X', slug: 'admin', country: 'US' })).body).toEqual({
      error: 'slug_reserved',
    });
    const taken = await brand();
    const res = await request(app).post('/booking-claims/signup').send({ token: TOKEN, displayName: 'X', slug: taken.slug, country: 'US' });
    // The address has a brand by now (the test before), which is checked first.
    expect(res.status).toBe(409);
    expect((await request(app).post('/booking-claims/signup').send({ token: TOKEN, displayName: 'X', slug: 'okayslug', country: 'KP' })).status).toBeGreaterThanOrEqual(400);
  });

  it('suggests a workspace address from the company, else the email domain', () => {
    expect(suggestSlug('Acme & Sons, Ltd.', 'a@b.test')).toBe('acme-sons-ltd');
    expect(suggestSlug(null, 'grace@notewise.io')).toBe('notewise');
    expect(suggestSlug('Ab', 'x@y.z')).toBe('');
  });
});

describe.skipIf(skipIntegration)('brand proxies', () => {
  it('claims a request into a signed-in brand, with the admin and the fee rate', async () => {
    const b = await brand({ approvalStatus: 'pending' });
    const res = await request(app).post(`/t/${b.slug}/admin/network/bookings/claim`).set('Cookie', b.cookie).send({ token: TOKEN });
    expect(res.status).toBe(201);
    expect(last('/vendors/me/bookings/claim')!.body).toEqual({ token: TOKEN, authorName: 'Owen Owner', authorEmail: b.email, bookingFeeBps: 1000 });
  });

  it('a brand in review writes in its conversations and pays, but cannot reach out', async () => {
    const b = await brand({ approvalStatus: 'pending' });
    const reach = await request(app).post(`/t/${b.slug}/admin/network/conversations`).set('Cookie', b.cookie).send({ creatorId: 'crt_ada', body: 'Hi!' });
    expect(reach).toMatchObject({ status: 403, body: { error: 'brand_pending_review' } });
    const reply = await request(app).post(`/t/${b.slug}/admin/network/conversations/cnv_1/messages`).set('Cookie', b.cookie).send({ body: 'Thanks!' });
    expect(reply.status).toBe(201);
    expect(last(/\/vendors\/me\/conversations\/cnv_1\/messages$/)!.body).toEqual({ body: 'Thanks!', authorName: 'Owen Owner', authorEmail: b.email });
    const pay = await request(app).post(`/t/${b.slug}/admin/network/bookings/bkr_1/checkout`).set('Cookie', b.cookie).send({ returnPath: '/admin/network/messages/cnv_1' });
    expect(pay.body).toEqual({ url: 'https://checkout.stripe.test/cs_1' });
    expect(last(/\/checkout$/)!.body).toEqual({ returnPath: '/admin/network/messages/cnv_1', feeRateBps: 1000 });

    // Watching the thread live: a ticket under the admin's name, and the socket on this brand's Network.
    const live = await request(app).post(`/t/${b.slug}/admin/network/conversations/cnv_1/realtime`).set('Cookie', b.cookie).send({ authorName: 'Someone else' });
    expect(live.body).toEqual({ ticket: 'tkt_v', expiresAt: '2026-10-25T21:00:00.000Z', url: `${networkUrl.replace(/^http/, 'ws')}/realtime` });
    expect(last(/\/realtime$/)!.body).toEqual({ authorName: 'Owen Owner' });
  });

  it('an approved brand starts conversations and books; tracking needs a plan', async () => {
    const b = await brand();
    const start = await request(app).post(`/t/${b.slug}/admin/network/conversations`).set('Cookie', b.cookie).send({ creatorId: 'crt_ada', body: 'Hi Ada!' });
    expect(start.status).toBe(201);
    expect(last('/vendors/me/conversations')!.body).toEqual({ creatorId: 'crt_ada', body: 'Hi Ada!', authorName: 'Owen Owner', authorEmail: b.email });

    // The browser can't set the fee rate or who is acting.
    const book = await request(app)
      .post(`/t/${b.slug}/admin/network/bookings`)
      .set('Cookie', b.cookie)
      .send({ creatorId: 'crt_ada', brief: 'A deep-dive post, please, in November.', bookingFeeBps: 0, authorEmail: 'someone@else.test', extra: 'x' });
    expect(book.status).toBe(201);
    expect(last('/vendors/me/bookings')!.body).toEqual({
      creatorId: 'crt_ada',
      brief: 'A deep-dive post, please, in November.',
      authorName: 'Owen Owner',
      authorEmail: b.email,
      bookingFeeBps: 1000,
    });

    const tracked = await request(app)
      .post(`/t/${b.slug}/admin/network/bookings`)
      .set('Cookie', b.cookie)
      .send({ creatorId: 'crt_ada', offeringId: 'off_1', brief: 'A deep-dive post, please, in November.' });
    expect(tracked).toMatchObject({ status: 402, body: { error: 'plan_required' } });
    const track = await request(app).post(`/t/${b.slug}/admin/network/bookings/bkr_1/track`).set('Cookie', b.cookie).send({ offeringId: 'off_1' });
    expect(track.status).toBe(402);
  });

  it('an API key acts with no person behind it', async () => {
    const b = await brand();
    await request(app).post(`/t/${b.slug}/admin/network/conversations/cnv_1/messages`).set('Authorization', `Bearer ${ADMIN_KEY}`).send({ body: 'Automated hello' });
    expect(last(/\/vendors\/me\/conversations\/cnv_1\/messages$/)!.body).toEqual({ body: 'Automated hello' });
  });
});

describe.skipIf(skipIntegration)('who may receive the brand’s Network mail', () => {
  it('names the addresses still activated, unrevoked admins, else the longest-standing one', async () => {
    const b = await brand();
    const later = new Date(Date.now() + 60_000);
    await db<AdminRow>(TABLES.Admin).insert([
      { id: ulid(), tenantId: b.tenantId, email: 'gone@acme.test', name: 'Gone', activatedAt: new Date(), revokedAt: new Date(), createdAt: later },
      { id: ulid(), tenantId: b.tenantId, email: 'invited@acme.test', name: 'Invited', activatedAt: null, createdAt: later },
      { id: ulid(), tenantId: b.tenantId, email: 'second@acme.test', name: 'Second', activatedAt: new Date(), createdAt: later },
    ] as never);
    const network = await createApiKeyRow(db, { tenantId: b.tenantId, scopes: [...NETWORK_FEDERATION_SCOPES], label: 'network_federation' });
    const ask = (emails: string[], key = network.plaintext) =>
      request(app).post(`/t/${b.slug}/network/notify-recipients`).set('Authorization', `Bearer ${key}`).send({ emails });

    expect((await ask(['Second@Acme.test', 'gone@acme.test'])).body).toEqual({ active: ['second@acme.test'], fallback: null });
    expect((await ask(['gone@acme.test', 'invited@acme.test'])).body).toEqual({ active: [], fallback: b.email });
    expect((await ask([])).status).toBe(400);

    // Only the Network's key (or an admin) may ask.
    const clicksOnly = await createApiKeyRow(db, { tenantId: b.tenantId, scopes: ['clicks:write'], label: 'clicks' });
    expect((await ask(['second@acme.test'], clicksOnly.plaintext)).status).toBe(403);
    expect((await request(app).post(`/t/${b.slug}/network/notify-recipients`).send({ emails: ['second@acme.test'] })).status).toBe(401);
  });
});
