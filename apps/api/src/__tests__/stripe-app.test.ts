/**
 * The OpenPartner Stripe App: hosted brands connect their own Stripe
 * account (OAuth install) and its events drive attribution.
 *
 *   - OAuth state: signature, expiry, the tenant + admin binding, and the
 *     encrypted grant the callback hands the portal.
 *   - Code exchange (Stripe's token endpoint is a fetch mock): storage,
 *     test vs live keys, reconnect / replace, an account already connected
 *     to another tenant.
 *   - Refresh-token rotation, including two concurrent refreshes.
 *   - /webhooks/stripe-app: signature, tenant by event.account, livemode,
 *     unknown accounts, uninstall, dedupe, and the self-host mapping end to
 *     end — Payment Link checkout, invoice.paid, a full refund, a promo
 *     code redemption.
 *   - A forwarded conversion for a Stripe transaction the app records.
 *   - Customer rewards minted in the BRAND's account, never the platform's,
 *     including for codes minted before the brand connected (the backfill a
 *     connect starts, and the hourly sweep that retries it).
 *   - Self-host keeps its own path (the stripe-webhook suites cover the
 *     mapping itself).
 *
 * Stripe API reads are a recorded mock that notes the API key each call
 * used, so "the brand's token, never STRIPE_SECRET_KEY" is checked call by
 * call. Requires DATABASE_URL; skipped without it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import Stripe from 'stripe';

const PLATFORM_KEY = 'sk_test_platform_billing_key';
const PLATFORM_WEBHOOK_SECRET = 'whsec_platform_destination_a';
const APP_WEBHOOK_SECRET = 'whsec_stripe_app_endpoint';
const ADMIN_KEY = 'op_test_admin_key_stripe_app_0123456789';
const BRAND_ACCOUNT = 'acct_1BrandOwnStripe';
const BRAND_TOKEN = 'at_brand_access_token';
const PORTAL = 'https://app.openpartner.test';
const RETURN_URL = `${PORTAL}/admin/integrations`;

process.env.OPENPARTNER_MODE = 'revshare';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.PORTAL_URL = PORTAL;
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.STRIPE_SECRET_KEY = PLATFORM_KEY;
process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_WEBHOOK_SECRET;
process.env.STRIPE_APP_CLIENT_ID = 'ca_live_openpartner_app';
process.env.STRIPE_APP_SECRET_KEY = 'sk_live_app_developer';
process.env.STRIPE_APP_CLIENT_ID_TEST = 'ca_test_openpartner_app';
process.env.STRIPE_APP_SECRET_KEY_TEST = 'sk_test_app_developer';
process.env.STRIPE_APP_WEBHOOK_SECRET = APP_WEBHOOK_SECRET;
delete process.env.STRIPE_APP_REDIRECT_URI;
for (const k of ['STRIPE_APP_AUTHORIZE_URL', 'STRIPE_APP_AUTHORIZE_URL_TEST']) delete process.env[k];

// Every Stripe API call any client makes, with the key it was made with.
const stripeApi = vi.hoisted(() => ({
  calls: [] as Array<{ key: string; method: string; args: unknown[] }>,
  impl: {} as Record<string, (...args: unknown[]) => unknown>,
}));

function resetStripeApi() {
  stripeApi.calls.length = 0;
  const missing = (what: string) => async () => {
    throw Object.assign(new Error(`No such ${what}`), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
  };
  Object.assign(stripeApi.impl, {
    'customers.retrieve': async (id: unknown) => ({ id, object: 'customer', metadata: {}, deleted: false }),
    'customers.update': async (id: unknown) => ({ id }),
    'checkout.sessions.list': async () => ({ object: 'list', data: [], has_more: false }),
    'checkout.sessions.retrieve': missing('checkout session'),
    'invoices.retrieve': missing('invoice'),
    'charges.retrieve': missing('charge'),
    'invoicePayments.list': async () => ({ object: 'list', data: [], has_more: false }),
    'promotionCodes.retrieve': missing('promotion code'),
    'promotionCodes.list': async () => ({ object: 'list', data: [] }),
    'promotionCodes.create': async (p: unknown) => ({ id: 'promo_minted', ...(p as object) }),
    'promotionCodes.update': async (id: unknown, p: unknown) => ({ id, ...(p as object) }),
    'coupons.create': async (p: unknown) => ({ id: 'co_minted', ...(p as object) }),
    'coupons.retrieve': missing('coupon'),
  });
}
resetStripeApi();

vi.mock('stripe', async () => {
  const actual = await vi.importActual<typeof import('stripe')>('stripe');
  const Real = actual.default;
  function MockedStripe(this: unknown, key: string, opts?: Stripe.StripeConfig) {
    const instance = new Real(key, opts) as unknown as Record<string, unknown>;
    const call =
      (method: string) =>
      (...args: unknown[]) => {
        stripeApi.calls.push({ key, method, args });
        return stripeApi.impl[method]!(...args);
      };
    instance.customers = { retrieve: call('customers.retrieve'), update: call('customers.update') };
    instance.checkout = {
      sessions: { list: call('checkout.sessions.list'), retrieve: call('checkout.sessions.retrieve') },
    };
    instance.invoices = { retrieve: call('invoices.retrieve') };
    instance.charges = { retrieve: call('charges.retrieve') };
    instance.invoicePayments = { list: call('invoicePayments.list') };
    instance.promotionCodes = {
      retrieve: call('promotionCodes.retrieve'),
      list: call('promotionCodes.list'),
      create: call('promotionCodes.create'),
      update: call('promotionCodes.update'),
    };
    instance.coupons = { create: call('coupons.create'), retrieve: call('coupons.retrieve') };
    return instance;
  }
  (MockedStripe as unknown as { webhooks: unknown }).webhooks = (Real as unknown as { webhooks: unknown }).webhooks;
  return { default: MockedStripe };
});

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});

// Stripe's OAuth token endpoint, as a queue of canned responses.
const oauth = {
  queue: [] as Array<() => Response | Promise<Response>>,
  calls: [] as Array<{ authorization: string; body: URLSearchParams }>,
};
const realFetch = globalThis.fetch;
const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url !== 'https://api.stripe.com/v1/oauth/token') return realFetch(input, init);
  const headers = new Headers(init?.headers);
  oauth.calls.push({ authorization: headers.get('authorization') ?? '', body: new URLSearchParams(String(init?.body ?? '')) });
  const next = oauth.queue.shift();
  if (!next) throw new Error('unexpected OAuth token request');
  return next();
});

function tokenResponse(t: { access: string; refresh: string; account?: string; livemode?: boolean }) {
  return () =>
    new Response(
      JSON.stringify({
        access_token: t.access,
        refresh_token: t.refresh,
        stripe_user_id: t.account ?? BRAND_ACCOUNT,
        livemode: t.livemode ?? true,
        scope: 'stripe_apps',
        token_type: 'bearer',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}
function oauthError(status: number, error: string, description: string) {
  return () =>
    new Response(JSON.stringify({ error, error_description: description }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}
const basicAuth = (key: string) => `Basic ${Buffer.from(`${key}:`).toString('base64')}`;

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createSession } = await import('../auth-sessions.js');
const { decryptSecret, encryptSecret } = await import('../crypto.js');
const {
  STRIPE_APP_PERMISSIONS,
  STRIPE_APP_PERMISSIONS_VERSION,
  StripeAppOAuthError,
  __resetStripeAppTokenCacheForTests,
  allowedReturnUrl,
  stripeAppAuthorizeBase,
  stripeAppInstallUrl,
  brandStripe,
  refreshAccessToken,
  signOAuthState,
  verifyOAuthState,
} = await import('../stripe-app.js');
const {
  __settleCustomerRewardBackfillsForTests,
  backfillCustomerRewards,
  customerRewardDelivery,
  provisionCustomerReward,
  runRewardBackfillSweep,
} = await import('../customer-rewards.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const signer = new Stripe('sk_test_signer');

const FOREIGN_TENANT = '01J0000000STRIPEAPPOTHER00';
const createdAdmins: string[] = [];

const PRODUCT_TABLES = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.Program,
  TABLES.Partner,
  TABLES.TenantStripeConnection,
];

async function cleanProductTables() {
  for (const t of PRODUCT_TABLES) await db(t).del();
}

async function adminCookie(tenantId: string = DEFAULT_TENANT_ID): Promise<{ adminId: string; cookie: string }> {
  const adminId = ulid();
  createdAdmins.push(adminId);
  await db(TABLES.Admin).insert({
    id: adminId,
    tenantId,
    email: `stripe-app-${adminId}@x.test`,
    name: 'Stripe App admin',
    activatedAt: new Date(),
  });
  const { plaintext } = await createSession(db, { tenantId, principalKind: 'admin', principalId: adminId });
  return { adminId, cookie: `op_session=${plaintext}` };
}

/** Start → Stripe → callback, returning the grant the portal would POST. */
async function installGrant(cookie: string, mode: 'live' | 'test' = 'live'): Promise<string> {
  const start = await request(app).post('/stripe-app/connection/start').set('Cookie', cookie).send({ mode, returnUrl: RETURN_URL });
  expect(start.status).toBe(200);
  const state = new URL(start.body.url).searchParams.get('state')!;
  const cb = await request(app).get('/stripe-app/oauth/callback').query({ code: 'ac_one_time_code', state });
  expect(cb.status).toBe(302);
  return new URL(cb.headers.location as string).searchParams.get('stripe_app_grant')!;
}

async function connect(
  cookie: string,
  t: { access?: string; refresh?: string; account?: string; livemode?: boolean; mode?: 'live' | 'test' } = {},
) {
  const grant = await installGrant(cookie, t.mode ?? 'live');
  oauth.queue.push(
    tokenResponse({ access: t.access ?? BRAND_TOKEN, refresh: t.refresh ?? 'rt_initial', account: t.account, livemode: t.livemode }),
  );
  return request(app).post('/stripe-app/connection/complete').set('Cookie', cookie).send({ grant });
}

async function seedConnection(
  o: {
    tenantId?: string;
    account?: string;
    livemode?: boolean;
    access?: string;
    refresh?: string;
    expiresInMs?: number;
    permissionsGranted?: string[] | null;
  } = {},
): Promise<string> {
  const id = `tsc_${ulid()}`;
  const livemode = o.livemode ?? true;
  await db(TABLES.TenantStripeConnection).insert({
    id,
    tenantId: o.tenantId ?? DEFAULT_TENANT_ID,
    stripeAccountId: o.account ?? BRAND_ACCOUNT,
    livemode,
    keyMode: livemode ? 'live' : 'test',
    refreshTokenEnc: encryptSecret(o.refresh ?? 'rt_seeded'),
    accessTokenEnc: encryptSecret(o.access ?? BRAND_TOKEN),
    accessTokenExpiresAt: new Date(Date.now() + (o.expiresInMs ?? 60 * 60 * 1000)),
    permissionsVersion: STRIPE_APP_PERMISSIONS_VERSION,
    permissionsGranted: o.permissionsGranted == null ? null : JSON.stringify(o.permissionsGranted),
  });
  return id;
}

async function connectionRow(id: string) {
  return db(TABLES.TenantStripeConnection).where({ id }).first();
}

interface Seeded {
  partnerId: string;
  programId: string;
  clickId: string;
}

async function seedClick(tenantId: string = DEFAULT_TENANT_ID): Promise<Seeded> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId, name: 'Brand partner', email: `p-${partnerId}@x.test` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId,
    name: 'Default',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify({ type: 'percent', value: 20 }),
    destinationUrl: 'https://brand.test/buy',
  });
  await db(TABLES.Link).insert({
    id: linkId,
    tenantId,
    partnerId,
    programId,
    linkKey: `lk-${linkId}`,
    destinationUrl: 'https://brand.test/buy',
  });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://brand.test/buy',
    ipHash: 'h',
    ts: new Date(),
  });
  return { partnerId, programId, clickId };
}

function appEvent(
  type: string,
  object: Record<string, unknown>,
  o: { account?: string | null; livemode?: boolean; id?: string } = {},
) {
  return {
    id: o.id ?? `evt_${ulid()}`,
    object: 'event',
    type,
    ...(o.account === null ? {} : { account: o.account ?? BRAND_ACCOUNT }),
    livemode: o.livemode ?? true,
    created: Math.floor(Date.now() / 1000),
    api_version: '2026-09-30',
    data: { object },
  };
}

function postSigned(path: string, payload: object, secret: string) {
  const body = JSON.stringify(payload);
  const sig = signer.webhooks.generateTestHeaderString({ payload: body, secret });
  return request(app).post(path).set('content-type', 'application/json').set('stripe-signature', sig).send(body);
}
const postAppEvent = (payload: object) => postSigned('/webhooks/stripe-app', payload, APP_WEBHOOK_SECRET);

/** Payment Link default: mode=payment, no Customer, paid at completion. */
function paymentLinkSession(clickId: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: `cs_live_${ulid()}`,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    amount_total: 5000,
    currency: 'usd',
    client_reference_id: clickId,
    customer: null,
    customer_email: null,
    payment_intent: `pi_${ulid()}`,
    invoice: null,
    total_details: { amount_discount: 0 },
    metadata: {},
    ...extra,
  };
}

const keysUsed = () => [...new Set(stripeApi.calls.map((c) => c.key))];

// A Stripe coupon redemption stamps the tenant's integration as verified;
// put it back for later files.
let couponVerifiedBefore: Date | null = null;

beforeAll(async () => {
  if (skipIntegration) return;
  couponVerifiedBefore =
    (await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first('couponIntegrationVerifiedAt'))
      ?.couponIntegrationVerifiedAt ?? null;
  await db(TABLES.Tenant)
    .insert({ id: FOREIGN_TENANT, slug: 'stripe-app-other', displayName: 'Other brand', status: 'active', approvalStatus: 'approved' })
    .onConflict('id')
    .ignore();
});

afterAll(async () => {
  fetchSpy.mockRestore();
  if (!skipIntegration) {
    await cleanProductTables();
    if (createdAdmins.length > 0) {
      await db(TABLES.Session).whereIn('principalId', createdAdmins).del();
      await db(TABLES.Admin).whereIn('id', createdAdmins).del();
    }
    await db(TABLES.Tenant).where({ id: FOREIGN_TENANT }).del();
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ couponIntegrationVerifiedAt: couponVerifiedBefore });
  }
  process.env.OPENPARTNER_MODE = 'selfhost';
  await db.destroy();
});

beforeEach(async () => {
  resetStripeApi();
  oauth.queue.length = 0;
  oauth.calls.length = 0;
  __resetStripeAppTokenCacheForTests();
  process.env.OPENPARTNER_MODE = 'revshare';
  if (skipIntegration) return;
  await cleanProductTables();
});

// ---------------------------------------------------------------------------

describe('install link base (External test before App Review)', () => {
  const CHANNEL = 'https://marketplace.stripe.com/oauth/v2/chnlink_61VbRZD7GqfQXOlfu41LKsWusNm7ZOpU/authorize';
  const withEnv = (vars: Record<string, string>, fn: () => void) => {
    Object.assign(process.env, vars);
    try {
      fn();
    } finally {
      for (const k of Object.keys(vars)) delete process.env[k];
    }
  };

  it('is the public authorize link by default', () => {
    expect(stripeAppAuthorizeBase('live')).toBe('https://marketplace.stripe.com/oauth/v2/authorize');
  });

  it('takes an External test link pasted whole, for every mode, keeping only its path', () => {
    withEnv({ STRIPE_APP_AUTHORIZE_URL: `${CHANNEL}?client_id=ca_pasted&redirect_uri=https://x.test/cb` }, () => {
      expect(stripeAppAuthorizeBase('live')).toBe(CHANNEL);
      expect(stripeAppAuthorizeBase('test')).toBe(CHANNEL);
      const install = new URL(stripeAppInstallUrl('test', 'st'));
      expect(install.origin + install.pathname).toBe(CHANNEL);
      // client_id comes from STRIPE_APP_CLIENT_ID_TEST, never the pasted link.
      expect(install.searchParams.get('client_id')).toBe('ca_test_openpartner_app');
      expect(install.searchParams.get('redirect_uri')).toBe(`${PORTAL}/api/stripe-app/oauth/callback`);
    });
  });

  it('lets a mode override the shared link, and ignores anything that is not a Stripe authorize link', () => {
    withEnv(
      {
        STRIPE_APP_AUTHORIZE_URL: CHANNEL,
        STRIPE_APP_AUTHORIZE_URL_TEST: 'https://marketplace.stripe.com/oauth/v2/chnlink_TestOnly123/authorize',
      },
      () => {
        expect(stripeAppAuthorizeBase('test')).toBe('https://marketplace.stripe.com/oauth/v2/chnlink_TestOnly123/authorize');
        expect(stripeAppAuthorizeBase('live')).toBe(CHANNEL);
      },
    );
    for (const bad of ['https://evil.test/oauth/v2/authorize', 'http://marketplace.stripe.com/oauth/v2/authorize', 'https://marketplace.stripe.com/elsewhere', 'not a url']) {
      withEnv({ STRIPE_APP_AUTHORIZE_URL: bad }, () => {
        expect(stripeAppAuthorizeBase('live')).toBe('https://marketplace.stripe.com/oauth/v2/authorize');
      });
    }
  });
});

describe('OAuth state', () => {
  const input = { t: DEFAULT_TENANT_ID, a: 'adm_1', m: 'live' as const, r: RETURN_URL };

  it('round-trips, and refuses a tampered payload, a tampered MAC or an expired state', () => {
    const state = signOAuthState(input);
    expect(verifyOAuthState(state)).toMatchObject(input);

    const [payload, mac] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), t: 'other' }))
      .toString('base64url');
    expect(verifyOAuthState(`${forged}.${mac}`)).toBeNull();
    expect(verifyOAuthState(`${payload}.${mac!.slice(0, -2)}xx`)).toBeNull();
    expect(verifyOAuthState(state, Date.now() + 31 * 60 * 1000)).toBeNull();
    expect(verifyOAuthState('garbage')).toBeNull();
  });

  it('only returns to the platform origin or the tenant’s own custom domain', () => {
    expect(allowedReturnUrl(`${PORTAL}/t/acme/admin/integrations`, { customDomain: null })).toBe(
      `${PORTAL}/t/acme/admin/integrations`,
    );
    expect(allowedReturnUrl('https://partners.acme.test/admin/integrations', { customDomain: 'partners.acme.test' })).toBe(
      'https://partners.acme.test/admin/integrations',
    );
    expect(allowedReturnUrl('https://evil.test/admin', { customDomain: null })).toBeNull();
    expect(allowedReturnUrl('http://partners.acme.test/admin', { customDomain: 'partners.acme.test' })).toBeNull();
    expect(allowedReturnUrl('javascript:alert(1)', { customDomain: null })).toBeNull();
  });
});

describe.skipIf(skipIntegration)('connecting a Stripe account', () => {
  it('start → Stripe → callback → complete stores an encrypted connection', async () => {
    const { cookie } = await adminCookie();
    const start = await request(app)
      .post('/stripe-app/connection/start')
      .set('Cookie', cookie)
      .send({ returnUrl: RETURN_URL });
    expect(start.status).toBe(200);
    const install = new URL(start.body.url);
    expect(install.origin + install.pathname).toBe('https://marketplace.stripe.com/oauth/v2/authorize');
    expect(install.searchParams.get('client_id')).toBe('ca_live_openpartner_app');
    expect(install.searchParams.get('redirect_uri')).toBe(`${PORTAL}/api/stripe-app/oauth/callback`);

    const cb = await request(app)
      .get('/stripe-app/oauth/callback')
      .query({ code: 'ac_one_time_code', state: install.searchParams.get('state')! });
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.location as string);
    expect(back.origin + back.pathname).toBe(RETURN_URL);
    // The code only travels encrypted.
    expect(cb.headers.location).not.toContain('ac_one_time_code');

    oauth.queue.push(tokenResponse({ access: BRAND_TOKEN, refresh: 'rt_initial' }));
    const done = await request(app)
      .post('/stripe-app/connection/complete')
      .set('Cookie', cookie)
      .send({ grant: back.searchParams.get('stripe_app_grant') });
    expect(done.status).toBe(200);
    expect(done.body.connection).toMatchObject({ stripeAccountId: BRAND_ACCOUNT, livemode: true, needsReconnect: false, rewards: true });

    expect(oauth.calls).toHaveLength(1);
    expect(oauth.calls[0]!.authorization).toBe(basicAuth('sk_live_app_developer'));
    expect(Object.fromEntries(oauth.calls[0]!.body)).toEqual({ grant_type: 'authorization_code', code: 'ac_one_time_code' });

    const row = await db(TABLES.TenantStripeConnection).where({ tenantId: DEFAULT_TENANT_ID }).whereNull('disconnectedAt').first();
    expect(row.refreshTokenEnc).not.toContain('rt_initial');
    expect(decryptSecret(row.refreshTokenEnc)).toBe('rt_initial');
    expect(decryptSecret(row.accessTokenEnc)).toBe(BRAND_TOKEN);
    expect(row.keyMode).toBe('live');

    const status = await request(app).get('/stripe-app/connection').set('Cookie', cookie);
    expect(status.body).toMatchObject({ available: true, modes: ['live', 'test'], connection: { stripeAccountId: BRAND_ACCOUNT } });
  });

  it('only a signed-in admin may start, and only the admin who started may finish', async () => {
    const asKey = await request(app)
      .post('/stripe-app/connection/start')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ returnUrl: RETURN_URL });
    expect(asKey.status).toBe(403);
    expect(asKey.body.error).toBe('session_required');

    const starter = await adminCookie();
    const other = await adminCookie();
    const grant = await installGrant(starter.cookie);
    const hijack = await request(app).post('/stripe-app/connection/complete').set('Cookie', other.cookie).send({ grant });
    expect(hijack.status).toBe(403);
    expect(hijack.body.error).toBe('state_mismatch');

    const garbage = await request(app).post('/stripe-app/connection/complete').set('Cookie', starter.cookie).send({ grant: 'bm90IGEgZ3JhbnQ=' });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error).toBe('invalid_grant');
    // Nothing reached Stripe's token endpoint.
    expect(oauth.calls).toHaveLength(0);
  });

  it('refuses a bad return URL, and the callback refuses a bad state or reports a cancel', async () => {
    const { cookie } = await adminCookie();
    const bad = await request(app)
      .post('/stripe-app/connection/start')
      .set('Cookie', cookie)
      .send({ returnUrl: 'https://evil.test/steal' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_return_url');

    const forged = await request(app).get('/stripe-app/oauth/callback').query({ code: 'ac_x', state: 'forged.state' });
    expect(forged.status).toBe(400);
    expect(forged.headers.location).toBeUndefined();

    const start = await request(app).post('/stripe-app/connection/start').set('Cookie', cookie).send({ returnUrl: RETURN_URL });
    const state = new URL(start.body.url).searchParams.get('state')!;
    const cancelled = await request(app)
      .get('/stripe-app/oauth/callback')
      .query({ error: 'access_denied', error_description: 'The user denied your request', state });
    expect(cancelled.status).toBe(302);
    const back = new URL(cancelled.headers.location as string);
    expect(back.searchParams.get('stripe_app_error')).toBe('access_denied');
    expect(back.searchParams.get('stripe_app_grant')).toBeNull();
  });

  it('a test-mode link exchanges with the test key, and a livemode mismatch stores nothing', async () => {
    const { cookie } = await adminCookie();
    const ok = await connect(cookie, { mode: 'test', livemode: false });
    expect(ok.status).toBe(200);
    expect(ok.body.connection.livemode).toBe(false);
    expect(oauth.calls[0]!.authorization).toBe(basicAuth('sk_test_app_developer'));
    await db(TABLES.TenantStripeConnection).del();

    const mismatch = await connect(cookie, { mode: 'test', livemode: true });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe('livemode_mismatch');
    expect(await db(TABLES.TenantStripeConnection).count({ c: '*' }).first()).toMatchObject({ c: '0' });
  });

  it('refuses an account already connected to another tenant', async () => {
    await seedConnection({ tenantId: FOREIGN_TENANT });
    const { cookie } = await adminCookie();
    const res = await connect(cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('stripe_account_connected_elsewhere');
    expect(await db(TABLES.TenantStripeConnection).where({ tenantId: DEFAULT_TENANT_ID })).toHaveLength(0);
  });

  it('reconnecting refreshes the same connection; a different account replaces it', async () => {
    const { cookie } = await adminCookie();
    const first = await connect(cookie, { refresh: 'rt_a' });
    expect(first.status).toBe(200);
    const original = await db(TABLES.TenantStripeConnection).where({ tenantId: DEFAULT_TENANT_ID }).first();
    await db(TABLES.TenantStripeConnection)
      .where({ id: original.id })
      .update({ refreshFailedAt: new Date(), refreshError: 'revoked', accessTokenEnc: null });

    const again = await connect(cookie, { refresh: 'rt_b' });
    expect(again.status).toBe(200);
    expect(again.body.replaced).toBe(false);
    const reconnected = await connectionRow(original.id);
    expect(reconnected.refreshFailedAt).toBeNull();
    expect(decryptSecret(reconnected.refreshTokenEnc)).toBe('rt_b');

    const swapped = await connect(cookie, { account: 'acct_1OtherBrandAccount', refresh: 'rt_c' });
    expect(swapped.status).toBe(200);
    expect(swapped.body.replaced).toBe(true);
    const closed = await connectionRow(original.id);
    expect(closed).toMatchObject({ disconnectReason: 'replaced', refreshTokenEnc: null, accessTokenEnc: null });
    expect(closed.disconnectedAt).not.toBeNull();
    const live = await db(TABLES.TenantStripeConnection).where({ tenantId: DEFAULT_TENANT_ID }).whereNull('disconnectedAt');
    expect(live.map((r: { stripeAccountId: string }) => r.stripeAccountId)).toEqual(['acct_1OtherBrandAccount']);
  });

  it('disconnect wipes the tokens and keeps the row as history', async () => {
    const { cookie } = await adminCookie();
    const id = await seedConnection();
    const res = await request(app).delete('/stripe-app/connection').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
    expect(await connectionRow(id)).toMatchObject({ disconnectReason: 'admin', refreshTokenEnc: null, accessTokenEnc: null });
    const status = await request(app).get('/stripe-app/connection').set('Cookie', cookie);
    expect(status.body.connection).toBeNull();
  });

  it('is hosted-only: a self-host has nothing to connect and no app endpoint', async () => {
    process.env.OPENPARTNER_MODE = 'selfhost';
    const { cookie } = await adminCookie();
    const status = await request(app).get('/stripe-app/connection').set('Cookie', cookie);
    expect(status.body).toMatchObject({ available: false, reason: 'selfhost', connection: null });
    const start = await request(app).post('/stripe-app/connection/start').set('Cookie', cookie).send({ returnUrl: RETURN_URL });
    expect(start.status).toBe(404);
    const hook = await postAppEvent(appEvent('invoice.paid', { id: 'in_x', object: 'invoice' }));
    expect(hook.status).toBe(503);
  });
});

describe.skipIf(skipIntegration)('access-token refresh', () => {
  it('refreshes an expired token once, stores the rotated refresh token, and uses the new access token', async () => {
    const id = await seedConnection({ expiresInMs: -60_000, refresh: 'rt_old' });
    oauth.queue.push(tokenResponse({ access: 'at_fresh', refresh: 'rt_new' }));
    // Three callers in one process share the one refresh.
    const clients = await Promise.all([1, 2, 3].map(() => brandStripe({ id, tenantId: DEFAULT_TENANT_ID })));
    expect(oauth.calls).toHaveLength(1);
    expect(Object.fromEntries(oauth.calls[0]!.body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt_old' });
    expect(oauth.calls[0]!.authorization).toBe(basicAuth('sk_live_app_developer'));

    const row = await connectionRow(id);
    expect(decryptSecret(row.refreshTokenEnc)).toBe('rt_new');
    expect(decryptSecret(row.accessTokenEnc)).toBe('at_fresh');
    await clients[0]!.customers.retrieve('cus_check');
    expect(stripeApi.calls.at(-1)).toMatchObject({ key: 'at_fresh', method: 'customers.retrieve' });
  });

  it('two processes refreshing at once burn the refresh token only once', async () => {
    const id = await seedConnection({ expiresInMs: -60_000, refresh: 'rt_1' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    oauth.queue.push(async () => {
      await gate;
      return tokenResponse({ access: 'at_2', refresh: 'rt_2' })();
    });
    // refreshAccessToken directly: no in-process single flight, so only
    // the row lock stands between the two.
    const a = refreshAccessToken(id, DEFAULT_TENANT_ID);
    const b = refreshAccessToken(id, DEFAULT_TENANT_ID);
    await vi.waitFor(() => expect(oauth.calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(oauth.calls).toHaveLength(1);
    release();
    expect(await Promise.all([a, b])).toEqual(['at_2', 'at_2']);
    expect(oauth.calls).toHaveLength(1);
    expect(decryptSecret((await connectionRow(id)).refreshTokenEnc)).toBe('rt_2');
  });

  it('invalid_grant marks the connection "reconnect needed" and stops refreshing', async () => {
    const { cookie } = await adminCookie();
    const id = await seedConnection({ expiresInMs: -60_000 });
    oauth.queue.push(oauthError(400, 'invalid_grant', 'The refresh token has been revoked.'));
    await expect(refreshAccessToken(id, DEFAULT_TENANT_ID)).rejects.toMatchObject({ reason: 'reconnect_needed' });
    const row = await connectionRow(id);
    expect(row.refreshFailedAt).not.toBeNull();
    expect(row.refreshError).toContain('revoked');
    expect(row.accessTokenEnc).toBeNull();

    await expect(brandStripe({ id, tenantId: DEFAULT_TENANT_ID })).rejects.toMatchObject({ reason: 'reconnect_needed' });
    expect(oauth.calls).toHaveLength(1);
    const status = await request(app).get('/stripe-app/connection').set('Cookie', cookie);
    expect(status.body.connection).toMatchObject({ needsReconnect: true, rewards: false });
  });

  it('any other refusal is our misconfiguration: thrown, connection left alone', async () => {
    const id = await seedConnection({ expiresInMs: -60_000 });
    oauth.queue.push(oauthError(401, 'invalid_client', 'Invalid API key provided'));
    await expect(refreshAccessToken(id, DEFAULT_TENANT_ID)).rejects.toBeInstanceOf(StripeAppOAuthError);
    expect((await connectionRow(id)).refreshFailedAt).toBeNull();
  });
});

describe.skipIf(skipIntegration)('/webhooks/stripe-app', () => {
  it('has its own signing secrets: neither Stripe endpoint accepts the other’s deliveries', async () => {
    const event = appEvent('invoice.paid', { id: 'in_x', object: 'invoice', customer: 'cus_x' });
    const unsigned = await request(app).post('/webhooks/stripe-app').set('content-type', 'application/json').send(JSON.stringify(event));
    expect(unsigned.status).toBe(400);
    const platformSigned = await postSigned('/webhooks/stripe-app', event, PLATFORM_WEBHOOK_SECRET);
    expect(platformSigned.status).toBe(400);
    expect(platformSigned.body.error).toBe('invalid_signature');
    const appSignedToPlatform = await postSigned('/webhooks/stripe', event, APP_WEBHOOK_SECRET);
    expect(appSignedToPlatform.status).toBe(400);
  });

  it('skips events with no account, an unknown account, the other mode, a tenant being deleted, or a type it doesn’t map', async () => {
    await seedConnection();
    await seedConnection({ tenantId: FOREIGN_TENANT, account: 'acct_1BrandBeingDeleted' });
    await db(TABLES.Tenant).where({ id: FOREIGN_TENANT }).update({ pendingDeletionAt: new Date() });
    const invoice = { id: 'in_skip', object: 'invoice', customer: 'cus_skip', amount_paid: 100, currency: 'usd' };
    const cases: Array<[object, string]> = [
      [appEvent('invoice.paid', invoice, { account: null }), 'no_account'],
      [appEvent('invoice.paid', invoice, { account: 'acct_1NobodyConnected' }), 'unknown_account'],
      [appEvent('invoice.paid', invoice, { livemode: false }), 'livemode_mismatch'],
      [appEvent('invoice.paid', invoice, { account: 'acct_1BrandBeingDeleted' }), 'tenant_inactive'],
      // Billing and payout events belong to OpenPartner's own account.
      [appEvent('customer.subscription.updated', { id: 'sub_1', object: 'subscription' }), 'unhandled_type'],
      [appEvent('account.updated', { id: BRAND_ACCOUNT, object: 'account' }), 'unhandled_type'],
    ];
    try {
      for (const [event, reason] of cases) {
        const res = await postAppEvent(event);
        expect(res.status).toBe(200);
        expect(res.body.reason).toBe(reason);
      }
    } finally {
      await db(TABLES.Tenant).where({ id: FOREIGN_TENANT }).update({ pendingDeletionAt: null });
    }
    expect(await db(TABLES.Event)).toHaveLength(0);
    expect(stripeApi.calls).toHaveLength(0);
  });

  it('a Payment Link checkout with client_reference_id is attributed end to end, with the brand’s token', async () => {
    const ids = await seedClick();
    const connId = await seedConnection();
    const session = paymentLinkSession(ids.clickId);
    const event = appEvent('checkout.session.completed', session);

    const res = await postAppEvent(event);
    expect(res.status).toBe(200);
    const events = await db(TABLES.Event).orderBy('type', 'desc');
    expect(events.map((e: { type: string }) => e.type)).toEqual(['signup', 'invoice_paid']);
    const revenue = events.find((e: { type: string }) => e.type === 'invoice_paid');
    expect(revenue).toMatchObject({ tenantId: DEFAULT_TENANT_ID, externalEventId: session.id, value: '50.00', currency: 'USD' });
    expect(revenue.metadata).toMatchObject({ via: 'stripe_app', stripeAccountId: BRAND_ACCOUNT, checkoutMode: 'payment' });

    const commissions = await db(TABLES.Commission);
    expect(commissions).toHaveLength(1);
    expect(commissions[0]).toMatchObject({ partnerId: ids.partnerId, amount: '10.00' });
    expect((await connectionRow(connId)).lastEventAt).not.toBeNull();

    // Redelivery: nothing new.
    const again = await postAppEvent(event);
    expect(again.status).toBe(200);
    expect(await db(TABLES.Event)).toHaveLength(2);
    expect(await db(TABLES.Commission)).toHaveLength(1);
    expect(keysUsed().filter((k) => k !== BRAND_TOKEN)).toEqual([]);
  });

  it('invoice.paid and a full refund run the self-host mapping against the brand’s account', async () => {
    const ids = await seedClick();
    await seedConnection();
    // A subscription checkout stitches the Customer to the click.
    const checkout = await postAppEvent(
      appEvent('checkout.session.completed', {
        id: `cs_live_${ulid()}`,
        object: 'checkout.session',
        mode: 'subscription',
        payment_status: 'paid',
        client_reference_id: ids.clickId,
        customer: 'cus_brand_1',
        subscription: 'sub_brand_1',
        total_details: { amount_discount: 0 },
        metadata: {},
      }),
    );
    expect(checkout.status).toBe(200);

    const invoiceRes = await postAppEvent(
      appEvent('invoice.paid', {
        id: 'in_brand_1',
        object: 'invoice',
        customer: 'cus_brand_1',
        amount_paid: 2000,
        currency: 'usd',
        billing_reason: 'subscription_create',
        discounts: [],
        total_discount_amounts: [],
      }),
    );
    expect(invoiceRes.status).toBe(200);
    const invoiceEvent = await db(TABLES.Event).where({ type: 'invoice_paid' }).first();
    // Keyed on the invoice, so a forwarded copy under in_brand_1 is the same Event.
    expect(invoiceEvent).toMatchObject({ userId: 'cus_brand_1', externalEventId: 'in_brand_1', value: '20.00' });
    const [commission] = await db(TABLES.Commission);
    expect(commission).toMatchObject({ amount: '4.00', status: 'accrued' });

    const refund = await postAppEvent(
      appEvent('charge.refunded', {
        id: 'ch_brand_1',
        object: 'charge',
        customer: 'cus_brand_1',
        invoice: 'in_brand_1',
        amount: 2000,
        amount_captured: 2000,
        amount_refunded: 2000,
        currency: 'usd',
        payment_intent: null,
      }),
    );
    expect(refund.status).toBe(200);
    expect(refund.body.corrective).toBe('refund');
    expect((await db(TABLES.Commission).where({ id: commission.id }).first()).status).toBe('reversed');

    // Read-only on customers: the checkout's metadata backfill was skipped.
    expect(stripeApi.calls.some((c) => c.method === 'customers.update')).toBe(false);
    expect(keysUsed()).toEqual([BRAND_TOKEN]);
  });

  it('a basil-shaped refund (no charge.invoice) finds the invoice with the brand’s token', async () => {
    const ids = await seedClick();
    await seedConnection();
    await postAppEvent(
      appEvent('checkout.session.completed', {
        id: `cs_live_${ulid()}`,
        object: 'checkout.session',
        mode: 'subscription',
        payment_status: 'paid',
        client_reference_id: ids.clickId,
        customer: 'cus_brand_basil',
        subscription: 'sub_brand_basil',
        total_details: { amount_discount: 0 },
        metadata: {},
      }),
    );
    // API version 2025-03-31.basil and later: no invoice.charge / payment_intent.
    const invoiceRes = await postAppEvent(
      appEvent('invoice.paid', {
        id: 'in_brand_basil',
        object: 'invoice',
        customer: 'cus_brand_basil',
        amount_paid: 2000,
        currency: 'usd',
        billing_reason: 'subscription_create',
        discounts: [],
        total_discount_amounts: [],
      }),
    );
    expect(invoiceRes.status).toBe(200);
    const [commission] = await db(TABLES.Commission);
    expect(commission).toMatchObject({ amount: '4.00', status: 'accrued' });

    stripeApi.impl['invoicePayments.list'] = async () => ({
      object: 'list',
      has_more: false,
      data: [
        {
          id: 'inpay_brand_basil',
          object: 'invoice_payment',
          amount_paid: 2000,
          currency: 'usd',
          invoice: 'in_brand_basil',
          payment: { type: 'payment_intent', payment_intent: 'pi_brand_basil' },
          status: 'paid',
        },
      ],
    });
    const refund = await postAppEvent(
      appEvent('charge.refunded', {
        id: 'ch_brand_basil',
        object: 'charge',
        customer: 'cus_brand_basil',
        payment_intent: 'pi_brand_basil',
        amount: 2000,
        amount_captured: 2000,
        amount_refunded: 2000,
        currency: 'usd',
      }),
    );

    expect(refund.status).toBe(200);
    expect((await db(TABLES.Commission).where({ id: commission.id }).first()).status).toBe('reversed');
    const lookup = stripeApi.calls.find((c) => c.method === 'invoicePayments.list');
    expect(lookup).toMatchObject({
      key: BRAND_TOKEN,
      args: [expect.objectContaining({ payment: { type: 'payment_intent', payment_intent: 'pi_brand_basil' } })],
    });
    expect(keysUsed()).toEqual([BRAND_TOKEN]);
  });

  it('a partner promo code entered at the brand’s Stripe Checkout credits the partner', async () => {
    const ids = await seedClick();
    await db(TABLES.Click).where({ id: ids.clickId }).del();
    await db(TABLES.Coupon).insert({
      id: `cpn_${ulid()}`,
      tenantId: DEFAULT_TENANT_ID,
      partnerId: ids.partnerId,
      programId: ids.programId,
      code: 'GRACIE15',
      stripePromotionCodeId: 'promo_brand_gracie',
    });
    await seedConnection();

    const res = await postAppEvent(
      appEvent(
        'checkout.session.completed',
        paymentLinkSession(null, {
          customer: 'cus_coupon_1',
          amount_total: 3000,
          discounts: [{ promotion_code: 'promo_brand_gracie' }],
          total_details: { amount_discount: 450 },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const signup = await db(TABLES.Event).where({ type: 'signup' }).first();
    // Both tags survive: how it was attributed, and where it came from.
    expect(signup.metadata).toMatchObject({ source: 'coupon', code: 'GRACIE15', via: 'stripe_app' });
    const [commission] = await db(TABLES.Commission);
    expect(commission).toMatchObject({ partnerId: ids.partnerId, amount: '6.00' });
  });

  describe("a partner code that equals one of the brand's own promos", () => {
    const DAY_S = 24 * 60 * 60;
    const nowS = () => Math.floor(Date.now() / 1000);

    /** A partner code minted a day before the connect: never checked
     *  against the brand's Stripe, and without a promotion code there. */
    async function seedCodeMintedBeforeConnect(fields: { brandChosen?: boolean } = {}): Promise<Seeded> {
      const ids = await seedClick();
      await db(TABLES.Click).where({ id: ids.clickId }).del();
      await db(TABLES.Coupon).insert({
        id: `cpn_${ulid()}`,
        tenantId: DEFAULT_TENANT_ID,
        partnerId: ids.partnerId,
        programId: ids.programId,
        code: 'WELCOME10',
        createdAt: new Date((nowS() - DAY_S) * 1000),
        ...fields,
      });
      await seedConnection();
      return ids;
    }

    /** The brand's promotion code WELCOME10, as promotionCodes.retrieve returns it. */
    function welcomePromo(fields: { created?: number; metadata?: Record<string, string> } = {}) {
      const promo = {
        id: 'promo_brand_welcome',
        object: 'promotion_code',
        code: 'WELCOME10',
        active: true,
        // The brand's sitewide promo, running for a year.
        created: nowS() - 365 * DAY_S,
        metadata: {},
        ...fields,
      };
      stripeApi.impl['promotionCodes.retrieve'] = async () => promo;
      return promo;
    }

    const checkoutWith = (promoId: string) =>
      appEvent(
        'checkout.session.completed',
        paymentLinkSession(null, {
          customer: 'cus_welcome_1',
          amount_total: 3000,
          discounts: [{ promotion_code: promoId }],
          total_details: { amount_discount: 300 },
        }),
      );

    it("the brand's own sitewide promo credits no partner", async () => {
      await seedCodeMintedBeforeConnect();
      const promo = welcomePromo();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const res = await postAppEvent(checkoutWith(promo.id));
        expect(res.status).toBe(200);
        expect(await db(TABLES.Click).where({ landingUrl: 'coupon://WELCOME10' })).toHaveLength(0);
        expect(await db(TABLES.Identity)).toHaveLength(0);
        expect(await db(TABLES.Commission)).toHaveLength(0);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("brand's own promo"),
          expect.objectContaining({ code: 'WELCOME10', stripeObject: promo.id }),
        );
      } finally {
        warn.mockRestore();
      }
      expect(keysUsed()).toEqual([BRAND_TOKEN]);
    });

    it('a promotion code OpenPartner minted for the code credits the partner, by its string', async () => {
      const ids = await seedCodeMintedBeforeConnect();
      // Minted in this account, but its id isn't on the row (an earlier
      // connection's, say).
      const promo = welcomePromo({ metadata: { source: 'openpartner', openpartner_code: 'WELCOME10' } });
      const res = await postAppEvent(checkoutWith(promo.id));
      expect(res.status).toBe(200);
      const [commission] = await db(TABLES.Commission);
      expect(commission).toMatchObject({ partnerId: ids.partnerId, amount: '6.00' });
    });

    it("a code the brand's admin chose to map its own promo still credits the partner", async () => {
      const ids = await seedCodeMintedBeforeConnect({ brandChosen: true });
      const promo = welcomePromo();
      const res = await postAppEvent(checkoutWith(promo.id));
      expect(res.status).toBe(200);
      const [commission] = await db(TABLES.Commission);
      expect(commission).toMatchObject({ partnerId: ids.partnerId, amount: '6.00' });
    });

    it('a promotion code the brand made for the code after it was minted credits the partner', async () => {
      // The setup the portal asks for when a program's discount isn't minted
      // for the brand: a promotion code with the partner's string.
      const ids = await seedCodeMintedBeforeConnect();
      const promo = welcomePromo({ created: nowS() - 60 });
      const res = await postAppEvent(checkoutWith(promo.id));
      expect(res.status).toBe(200);
      const [commission] = await db(TABLES.Commission);
      expect(commission).toMatchObject({ partnerId: ids.partnerId, amount: '6.00' });
    });
  });

  it('an uninstall closes the connection in that mode only, and later events are skipped', async () => {
    const connId = await seedConnection();
    const testUninstall = await postAppEvent(
      appEvent('account.application.deauthorized', { id: 'ca_app', object: 'application' }, { livemode: false }),
    );
    expect(testUninstall.body.deauthorized).toBe(0);
    expect((await connectionRow(connId)).disconnectedAt).toBeNull();

    const liveUninstall = await postAppEvent(appEvent('apps.install.deleted', { id: 'appinst_1', object: 'apps.install', deleted: true }));
    expect(liveUninstall.body.deauthorized).toBe(1);
    expect(await connectionRow(connId)).toMatchObject({ disconnectReason: 'deauthorized', refreshTokenEnc: null });

    const after = await postAppEvent(appEvent('invoice.paid', { id: 'in_after', object: 'invoice', customer: 'cus_after' }));
    expect(after.body.reason).toBe('unknown_account');
  });

  it('records the permissions an install granted', async () => {
    const connId = await seedConnection();
    await postAppEvent(
      appEvent('apps.install.updated', {
        id: 'appinst_1',
        object: 'apps.install',
        account: BRAND_ACCOUNT,
        livemode: true,
        permissions_granted: ['event_read', 'invoice_read'],
      }),
    );
    expect((await connectionRow(connId)).permissionsGranted).toEqual(['event_read', 'invoice_read']);
  });
});

describe.skipIf(skipIntegration)('a forwarded conversion for a payment the app records', () => {
  it('is refused while the connection is healthy, whichever key form, and accepted once it isn’t', async () => {
    const ids = await seedClick();
    const connId = await seedConnection();
    const auth = { Authorization: `Bearer ${ADMIN_KEY}` };

    for (const key of ['in_1ForwardedInvoice', 'cs_live_a1ForwardedSession', 'cs_test_a1ForwardedSession']) {
      const res = await request(app)
        .post('/attribution/conversions')
        .set(auth)
        .send({ clickId: ids.clickId, type: 'invoice_paid', value: 20, externalEventId: key });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('recorded_from_stripe');
    }
    const viaEvents = await request(app)
      .post('/attribution/events')
      .set(auth)
      .send({ userId: 'user_1', type: 'invoice_paid', value: 20, externalEventId: 'in_1ForwardedInvoice' });
    expect(viaEvents.status).toBe(409);
    expect(viaEvents.body.error).toBe('recorded_from_stripe');

    // The brand's own order ids can't be matched to Stripe, so they record.
    const own = await request(app)
      .post('/attribution/conversions')
      .set(auth)
      .send({ clickId: ids.clickId, type: 'loan_funded', value: 20, externalEventId: 'order-881' });
    expect(own.status).toBe(200);

    // A connection waiting for a reconnect records nothing, so forwarding is
    // the brand's only path again.
    await db(TABLES.TenantStripeConnection).where({ id: connId }).update({ refreshFailedAt: new Date() });
    const fallback = await request(app)
      .post('/attribution/conversions')
      .set(auth)
      .send({ clickId: ids.clickId, type: 'invoice_paid', value: 20, externalEventId: 'in_1ForwardedInvoice' });
    expect(fallback.status).toBe(200);
  });
});

describe.skipIf(skipIntegration)('customer rewards on hosted', () => {
  const reward = { type: 'percent_off' as const, value: 15, duration: 'once' as const };

  it('are minted in the connected brand account, never the platform account', async () => {
    await seedConnection({ access: 'at_rewards' });
    expect(await customerRewardDelivery(DEFAULT_TENANT_ID)).toBe('stripe');
    const minted = await provisionCustomerReward(DEFAULT_TENANT_ID, reward, 'BRAND15', 'Spring');
    expect(minted).toEqual({ stripeCouponId: 'co_minted', stripePromotionCodeId: 'promo_minted' });
    expect(stripeApi.calls.map((c) => [c.method, c.key])).toEqual([
      ['coupons.create', 'at_rewards'],
      ['promotionCodes.create', 'at_rewards'],
    ]);
  });

  it('are skipped without a connection, or when the install withheld the write permissions', async () => {
    expect(await customerRewardDelivery(DEFAULT_TENANT_ID)).toBe('brand');
    expect(await provisionCustomerReward(DEFAULT_TENANT_ID, reward, 'BRAND15', 'Spring')).toBeNull();

    await seedConnection({ permissionsGranted: ['event_read', 'invoice_read'] });
    expect(await customerRewardDelivery(DEFAULT_TENANT_ID)).toBe('brand');
    expect(await provisionCustomerReward(DEFAULT_TENANT_ID, reward, 'BRAND15', 'Spring')).toBeNull();
    expect(stripeApi.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Codes minted before the brand connected (the usual order: partners are
// granted programs, and so get their codes, before Stripe is connected).
// ---------------------------------------------------------------------------

interface FakePromo {
  id: string;
  object: 'promotion_code';
  code: string;
  active: boolean;
  metadata: Record<string, string>;
  promotion: { type: 'coupon'; coupon: string };
}

/**
 * Promotion codes and coupons kept per access token, so each connected
 * account has its own, the way Stripe scopes them. The API key of the call
 * being served is the one stripeApi.calls just recorded.
 */
function fakeRewardAccounts() {
  const accounts = new Map<string, { promos: Map<string, FakePromo>; coupons: Set<string> }>();
  const account = (key: string) => {
    if (!accounts.has(key)) accounts.set(key, { promos: new Map(), coupons: new Set() });
    return accounts.get(key)!;
  };
  const current = () => account(stripeApi.calls.at(-1)!.key);
  const missing = (what: string) =>
    Object.assign(new Error(`No such ${what}`), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
  let next = 0;
  Object.assign(stripeApi.impl, {
    'coupons.create': async (p: unknown) => {
      const id = `co_fake_${++next}`;
      current().coupons.add(id);
      return { id, object: 'coupon', ...(p as object) };
    },
    'coupons.retrieve': async (id: unknown) => {
      if (!current().coupons.has(id as string)) throw missing('coupon');
      return { id, object: 'coupon' };
    },
    'promotionCodes.create': async (p: unknown) => {
      const params = p as { code: string; metadata?: Record<string, string>; promotion: FakePromo['promotion'] };
      const promos = current().promos;
      if ([...promos.values()].some((x) => x.active && x.code.toLowerCase() === params.code.toLowerCase())) {
        throw Object.assign(new Error('An active promotion code with that code already exists.'), {
          type: 'StripeInvalidRequestError',
        });
      }
      const promo: FakePromo = {
        id: `promo_fake_${++next}`,
        object: 'promotion_code',
        code: params.code,
        active: true,
        metadata: params.metadata ?? {},
        promotion: params.promotion,
      };
      promos.set(promo.id, promo);
      return promo;
    },
    'promotionCodes.retrieve': async (id: unknown) => {
      const promo = current().promos.get(id as string);
      if (!promo) throw missing('promotion code');
      return promo;
    },
    'promotionCodes.list': async (p: unknown) => {
      const code = (p as { code: string }).code.toLowerCase();
      return { object: 'list', data: [...current().promos.values()].filter((x) => x.code.toLowerCase() === code), has_more: false };
    },
    'promotionCodes.update': async (id: unknown, p: unknown) => Object.assign(current().promos.get(id as string)!, p),
  });
  return {
    promos: (key: string) => [...account(key).promos.values()],
    /** One of the brand's own promotion codes, created in its Dashboard. */
    seedBrandPromo(key: string, code: string) {
      const id = `promo_brand_${++next}`;
      account(key).promos.set(id, { id, object: 'promotion_code', code, active: true, metadata: {}, promotion: { type: 'coupon', coupon: 'co_brand' } });
    },
  };
}

const PERCENT_15 = JSON.stringify({ type: 'percent_off', value: 15, duration: 'once' });

/** A partner on a program, holding `codes` with no Stripe ids, as minted
 *  before any connection. */
async function seedRewardCodes(codes: string[], o: { reward?: string | null } = {}) {
  const partnerId = ulid();
  const programId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, name: 'Code partner', email: `c-${partnerId}@x.test` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Spring',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify({ type: 'percent', value: 20 }),
    destinationUrl: 'https://brand.test/buy',
    customerReward: o.reward === undefined ? PERCENT_15 : o.reward,
  });
  for (const code of codes) {
    await db(TABLES.Coupon).insert({ id: `cpn_${ulid()}`, tenantId: DEFAULT_TENANT_ID, partnerId, programId, code });
  }
  return { partnerId, programId };
}

const couponByCode = (code: string) => db(TABLES.Coupon).where({ tenantId: DEFAULT_TENANT_ID, code }).first();
const callsTo = (method: string) => stripeApi.calls.filter((c) => c.method === method);

describe.skipIf(skipIntegration)('connecting backfills partner codes minted before it', () => {
  it('creates each code’s promotion code once, leaves the brand’s own codes alone, and a reconnect adds none', async () => {
    const brand = fakeRewardAccounts();
    await seedRewardCodes(['ALPHA15', 'BRAVO15', 'WELCOME10']);
    await seedRewardCodes(['PLAIN20'], { reward: null });
    await seedRewardCodes(['RETIRED15']);
    await db(TABLES.Coupon).where({ code: 'RETIRED15' }).update({ deactivatedAt: new Date() });
    const suspended = await seedRewardCodes(['SUSPENDED15']);
    await db(TABLES.Partner).where({ id: suspended.partnerId }).update({ revokedAt: new Date() });
    // The brand's own sitewide promo already has one of the strings.
    brand.seedBrandPromo(BRAND_TOKEN, 'WELCOME10');

    const { cookie } = await adminCookie();
    const res = await connect(cookie);
    expect(res.status).toBe(200);
    await __settleCustomerRewardBackfillsForTests();

    const created = brand.promos(BRAND_TOKEN).filter((p) => p.metadata.source === 'openpartner');
    expect(created.map((p) => p.code).sort()).toEqual(['ALPHA15', 'BRAVO15']);
    for (const code of ['ALPHA15', 'BRAVO15']) {
      const row = await couponByCode(code);
      const promo = created.find((p) => p.code === code)!;
      expect(row).toMatchObject({ stripePromotionCodeId: promo.id, stripeCouponId: promo.promotion.coupon });
      expect(promo.metadata).toEqual({ source: 'openpartner', openpartner_code: code });
    }
    const couponParams = callsTo('coupons.create').map((c) => c.args[0] as { name: string });
    expect(couponParams.map((p) => p.name).sort()).toEqual(['OpenPartner — Spring (ALPHA15)', 'OpenPartner — Spring (BRAVO15)']);
    for (const p of couponParams) expect(p).toMatchObject({ percent_off: 15, duration: 'once' });
    for (const code of ['WELCOME10', 'PLAIN20', 'RETIRED15', 'SUSPENDED15']) {
      expect((await couponByCode(code)).stripePromotionCodeId).toBeNull();
    }
    expect(keysUsed()).toEqual([BRAND_TOKEN]);

    // Integrations says one code isn't in Stripe, instead of claiming all are.
    const status = await request(app).get('/stripe-app/connection').set('Cookie', cookie);
    expect(status.body.connection).toMatchObject({
      rewards: true,
      rewardCodesNotInStripe: 1,
      rewardCodesSyncing: false,
      rewardCodesChecked: true,
    });

    // Reconnecting the same account checks what's there and creates nothing.
    stripeApi.calls.length = 0;
    expect((await connect(cookie, { refresh: 'rt_again' })).status).toBe(200);
    await __settleCustomerRewardBackfillsForTests();
    expect(callsTo('coupons.create')).toHaveLength(0);
    expect(callsTo('promotionCodes.create')).toHaveLength(0);
    expect(callsTo('promotionCodes.retrieve').map((c) => c.args[0]).sort()).toEqual(created.map((p) => p.id).sort());

    // A pass whose write was lost: the promo is found by its code and
    // recorded, not created a second time.
    const alpha = created.find((p) => p.code === 'ALPHA15')!;
    await db(TABLES.Coupon).where({ code: 'ALPHA15' }).update({ stripeCouponId: null, stripePromotionCodeId: null });
    stripeApi.calls.length = 0;
    expect((await connect(cookie, { refresh: 'rt_third' })).status).toBe(200);
    await __settleCustomerRewardBackfillsForTests();
    expect(callsTo('promotionCodes.create')).toHaveLength(0);
    expect(await couponByCode('ALPHA15')).toMatchObject({ stripePromotionCodeId: alpha.id, stripeCouponId: alpha.promotion.coupon });
    expect(brand.promos(BRAND_TOKEN).filter((p) => p.code === 'ALPHA15')).toHaveLength(1);
  });

  it('a different Stripe account gets promotion codes of its own; switching back reuses the first account’s', async () => {
    const brand = fakeRewardAccounts();
    await seedRewardCodes(['ALPHA15']);
    const { cookie } = await adminCookie();

    await connect(cookie);
    await __settleCustomerRewardBackfillsForTests();
    const [first] = brand.promos(BRAND_TOKEN);
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBe(first!.id);

    // Live → another account (or test mode): the stored promo isn't there.
    const swapped = await connect(cookie, { account: 'acct_1OtherBrandAccount', access: 'at_other_account' });
    expect(swapped.body.replaced).toBe(true);
    await __settleCustomerRewardBackfillsForTests();
    const [other] = brand.promos('at_other_account');
    expect(other).toMatchObject({ code: 'ALPHA15', active: true });
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBe(other!.id);

    // Back to the first account: its promo is still there and ours.
    stripeApi.calls.length = 0;
    await connect(cookie);
    await __settleCustomerRewardBackfillsForTests();
    expect(callsTo('promotionCodes.create')).toHaveLength(0);
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBe(first!.id);
    expect(brand.promos(BRAND_TOKEN)).toHaveLength(1);
  });

  it('touches nothing when the install withheld the write permissions', async () => {
    fakeRewardAccounts();
    await seedRewardCodes(['ALPHA15']);
    await seedConnection({ permissionsGranted: ['event_read', 'invoice_read', 'promotion_code_read'] });
    const { cookie } = await adminCookie();

    // A reconnect keeps the grant list Stripe sent for the install.
    const res = await connect(cookie);
    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ rewards: false, rewardCodesNotInStripe: 0 });
    await __settleCustomerRewardBackfillsForTests();
    expect(stripeApi.calls).toHaveLength(0);
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBeNull();
    // Nor does the hourly sweep look at this tenant.
    expect(await runRewardBackfillSweep()).toEqual([]);
    expect(stripeApi.calls).toHaveLength(0);
  });

  it('a Stripe outage never fails the connect; the pass stops and the hourly sweep finishes it', async () => {
    fakeRewardAccounts();
    await seedRewardCodes(['ALPHA15', 'BRAVO15']);
    const create = stripeApi.impl['coupons.create']!;
    stripeApi.impl['coupons.create'] = async () => {
      throw Object.assign(new Error('Stripe is having trouble'), { type: 'StripeAPIError' });
    };
    const { cookie } = await adminCookie();

    const res = await connect(cookie);
    expect(res.status).toBe(200);
    await __settleCustomerRewardBackfillsForTests();
    // One try, not one per code: an outage would fail every one of them.
    expect(callsTo('coupons.create')).toHaveLength(1);
    const status = await request(app).get('/stripe-app/connection').set('Cookie', cookie);
    expect(status.body.connection).toMatchObject({ rewardCodesNotInStripe: 2, rewardCodesChecked: false });

    stripeApi.impl['coupons.create'] = create;
    const swept = await runRewardBackfillSweep();
    expect(swept).toEqual([
      expect.objectContaining({
        tenantId: DEFAULT_TENANT_ID,
        pending: 2,
        verified: false,
        result: expect.objectContaining({ provisioned: 2, stopped: null, verified: true }),
      }),
    ]);
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toMatch(/^promo_fake_/);
    expect((await couponByCode('BRAVO15')).stripePromotionCodeId).toMatch(/^promo_fake_/);

    // Nothing left: the next sweep makes no Stripe call at all.
    stripeApi.calls.length = 0;
    expect(await runRewardBackfillSweep()).toEqual([]);
    expect(stripeApi.calls).toHaveLength(0);
  });

  it('a code Stripe refuses is skipped, and the rest still get theirs', async () => {
    fakeRewardAccounts();
    await seedRewardCodes(['ALPHA15', 'BRAVO15']);
    const create = stripeApi.impl['promotionCodes.create']!;
    stripeApi.impl['promotionCodes.create'] = async (p: unknown) => {
      if ((p as { code: string }).code === 'ALPHA15') {
        throw Object.assign(new Error('Invalid code'), { type: 'StripeInvalidRequestError' });
      }
      return create(p);
    };
    const { cookie } = await adminCookie();

    expect((await connect(cookie)).status).toBe(200);
    await __settleCustomerRewardBackfillsForTests();
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBeNull();
    expect((await couponByCode('BRAVO15')).stripePromotionCodeId).toMatch(/^promo_fake_/);
  });

  it('a switch whose check stopped early is finished by the sweep, against the new account', async () => {
    const brand = fakeRewardAccounts();
    await seedRewardCodes(['ALPHA15']);
    const { cookie } = await adminCookie();
    await connect(cookie);
    await __settleCustomerRewardBackfillsForTests();
    const [first] = brand.promos(BRAND_TOKEN);

    const retrieve = stripeApi.impl['promotionCodes.retrieve']!;
    stripeApi.impl['promotionCodes.retrieve'] = async () => {
      throw Object.assign(new Error('Rate limited'), { type: 'StripeRateLimitError' });
    };
    await connect(cookie, { account: 'acct_1OtherBrandAccount', access: 'at_other_account' });
    await __settleCustomerRewardBackfillsForTests();
    // Still the first account's promo, which this checkout doesn't have, and
    // the card doesn't claim otherwise.
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBe(first!.id);
    const status = await request(app).get('/stripe-app/connection').set('Cookie', cookie);
    expect(status.body.connection).toMatchObject({ rewardCodesNotInStripe: 0, rewardCodesChecked: false });

    stripeApi.impl['promotionCodes.retrieve'] = retrieve;
    const swept = await runRewardBackfillSweep();
    expect(swept).toEqual([expect.objectContaining({ verified: false, result: expect.objectContaining({ provisioned: 1, verified: true }) })]);
    const [other] = brand.promos('at_other_account');
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBe(other!.id);
    expect(await runRewardBackfillSweep()).toEqual([]);
  });

  /** Holds the first call to `method` (made with `key`, if given) once it
   *  has done its work, until released. */
  function pauseFirst(method: string, key?: string) {
    const real = stripeApi.impl[method]!;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const arrived = new Promise<void>((r) => (reached = r));
    let paused = false;
    stripeApi.impl[method] = async (...args: unknown[]) => {
      const matches = key === undefined || stripeApi.calls.at(-1)!.key === key;
      const out = await real(...args);
      if (!paused && matches) {
        paused = true;
        reached();
        await gate;
      }
      return out;
    };
    return { arrived, release };
  }

  it('a pass that outlives a switch to another account can’t record the old account’s promo under it', async () => {
    // Two processes: one still provisioning through the old connection, the
    // other checking the new one. Neither is queued behind the other.
    const brand = fakeRewardAccounts();
    await seedRewardCodes(['ALPHA15']);
    const oldConnection = await seedConnection();
    const oldPass = pauseFirst('promotionCodes.create', BRAND_TOKEN);
    const stale = backfillCustomerRewards(DEFAULT_TENANT_ID, { verifyExisting: false });
    await oldPass.arrived; // the old account's promo exists, not yet recorded

    await db(TABLES.TenantStripeConnection)
      .where({ id: oldConnection })
      .update({ disconnectedAt: new Date(), disconnectReason: 'replaced', refreshTokenEnc: null, accessTokenEnc: null });
    await seedConnection({ account: 'acct_1OtherBrandAccount', access: 'at_other_account' });
    const newPass = pauseFirst('promotionCodes.list', 'at_other_account');
    const checking = backfillCustomerRewards(DEFAULT_TENANT_ID, { verifyExisting: true });
    await newPass.arrived; // read the code as having no promo

    oldPass.release();
    expect(await stale).toMatchObject({ provisioned: 0, skipped: 1 });
    newPass.release();
    expect(await checking).toMatchObject({ provisioned: 1, verified: true });

    const [other] = brand.promos('at_other_account');
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBe(other!.id);
    // The old account's promo stays there, like any promo minted under a
    // previous connection.
    expect(brand.promos(BRAND_TOKEN)).toEqual([expect.objectContaining({ active: true })]);
  });

  it('a pass that outlives a disconnect and reconnect of the same account: the next pass adopts its promo', async () => {
    const brand = fakeRewardAccounts();
    await seedRewardCodes(['ALPHA15']);
    const { cookie } = await adminCookie();
    const paused = pauseFirst('promotionCodes.create');

    await connect(cookie);
    await paused.arrived;
    // Disconnect closes the row; connecting again opens a new one.
    expect((await request(app).delete('/stripe-app/connection').set('Cookie', cookie)).body.disconnected).toBe(true);
    expect((await connect(cookie)).status).toBe(200);
    paused.release();
    await __settleCustomerRewardBackfillsForTests();

    const promos = brand.promos(BRAND_TOKEN);
    expect(promos).toEqual([expect.objectContaining({ code: 'ALPHA15', active: true })]);
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBe(promos[0]!.id);
  });

  it('a suspended partner’s code loses another account’s promo id, and gets one of its own once reinstated', async () => {
    const brand = fakeRewardAccounts();
    const { partnerId } = await seedRewardCodes(['ALPHA15']);
    const { cookie } = await adminCookie();
    await connect(cookie);
    await __settleCustomerRewardBackfillsForTests();
    expect(brand.promos(BRAND_TOKEN)).toHaveLength(1);

    await db(TABLES.Partner).where({ id: partnerId }).update({ revokedAt: new Date() });
    await connect(cookie, { account: 'acct_1OtherBrandAccount', access: 'at_other_account' });
    await __settleCustomerRewardBackfillsForTests();
    // Checked and cleared, but nothing created while suspended.
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBeNull();
    expect(brand.promos('at_other_account')).toHaveLength(0);

    await db(TABLES.Partner).where({ id: partnerId }).update({ revokedAt: null });
    expect(await runRewardBackfillSweep()).toEqual([expect.objectContaining({ verified: true, result: expect.objectContaining({ provisioned: 1 }) })]);
    const [other] = brand.promos('at_other_account');
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBe(other!.id);
  });

  it('two passes at once: the one that finds the other’s promo records it, and it isn’t released', async () => {
    const brand = fakeRewardAccounts();
    await seedRewardCodes(['ALPHA15']);
    await seedConnection();
    const paused = pauseFirst('promotionCodes.create');

    const slow = backfillCustomerRewards(DEFAULT_TENANT_ID, { verifyExisting: false });
    await paused.arrived;
    expect(await backfillCustomerRewards(DEFAULT_TENANT_ID, { verifyExisting: false })).toMatchObject({ linked: 1 });
    paused.release();
    expect(await slow).toMatchObject({ provisioned: 0, skipped: 1 });

    const [promo] = brand.promos(BRAND_TOKEN);
    expect(brand.promos(BRAND_TOKEN)).toHaveLength(1);
    expect(promo!.active).toBe(true);
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBe(promo!.id);
  });

  it('a code deactivated mid-pass keeps no live promo', async () => {
    const brand = fakeRewardAccounts();
    const { partnerId } = await seedRewardCodes(['ALPHA15']);
    await seedConnection();
    const paused = pauseFirst('promotionCodes.create');

    const pass = backfillCustomerRewards(DEFAULT_TENANT_ID, { verifyExisting: false });
    await paused.arrived;
    const coupon = await couponByCode('ALPHA15');
    const retired = await request(app)
      .delete(`/partners/${partnerId}/coupons/${coupon.id}`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(retired.status).toBe(200);
    paused.release();
    expect(await pass).toMatchObject({ skipped: 1 });

    expect(brand.promos(BRAND_TOKEN)).toEqual([expect.objectContaining({ code: 'ALPHA15', active: false })]);
    expect((await couponByCode('ALPHA15')).stripePromotionCodeId).toBeNull();
  });

  it('retiring a code deactivates the promo a backfill recorded', async () => {
    const brand = fakeRewardAccounts();
    const { partnerId } = await seedRewardCodes(['ALPHA15']);
    await seedConnection();
    expect(await backfillCustomerRewards(DEFAULT_TENANT_ID, { verifyExisting: false })).toMatchObject({ provisioned: 1 });

    const coupon = await couponByCode('ALPHA15');
    await request(app).delete(`/partners/${partnerId}/coupons/${coupon.id}`).set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(brand.promos(BRAND_TOKEN)).toEqual([expect.objectContaining({ id: coupon.stripePromotionCodeId, active: false })]);
  });

  it('reads every page of a code’s promotion codes before deciding it is free', async () => {
    fakeRewardAccounts();
    await seedRewardCodes(['ALPHA15']);
    await seedConnection();
    const oursRetired = { id: 'promo_ours_old', code: 'ALPHA15', active: false, metadata: { source: 'openpartner', openpartner_code: 'ALPHA15' } };
    const brandOwn = { id: 'promo_brand_old', code: 'ALPHA15', active: false, metadata: {} };
    stripeApi.impl['promotionCodes.list'] = async (p: unknown) =>
      (p as { starting_after?: string }).starting_after === oursRetired.id
        ? { object: 'list', data: [brandOwn], has_more: false }
        : { object: 'list', data: [oursRetired], has_more: true };

    expect(await backfillCustomerRewards(DEFAULT_TENANT_ID, { verifyExisting: false })).toMatchObject({ taken: 1, provisioned: 0 });
    expect(callsTo('promotionCodes.list')).toHaveLength(2);
    expect(callsTo('promotionCodes.create')).toHaveLength(0);
  });
});

describe('the app manifest', () => {
  it('requests exactly the permissions the code documents, with OAuth install', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(new URL('../../../../stripe-app/stripe-app.json', import.meta.url), 'utf8'),
    ) as {
      permissions: Array<{ permission: string; purpose: string }>;
      stripe_api_access_type: string;
      distribution_type: string;
      allowed_redirect_uris: string[];
    };
    expect(manifest.permissions).toEqual(STRIPE_APP_PERMISSIONS);
    expect(manifest.stripe_api_access_type).toBe('oauth');
    expect(manifest.distribution_type).toBe('public');
    expect(manifest.allowed_redirect_uris[0]).toBe('https://app.openpartner.dev/api/stripe-app/oauth/callback');
    // Least privilege: nothing that moves money or edits customers.
    const names = manifest.permissions.map((p) => p.permission);
    expect(names.filter((n) => n.endsWith('_write')).sort()).toEqual(['coupon_write', 'promotion_code_write']);
  });
});
