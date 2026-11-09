/**
 * "Continue with Google" on /signin (flow=account) for an address that is
 * only a Network creator: accountLanding in routes/google-auth.ts.
 *
 * /signin is where brands and creators both sign in. Google there used to
 * mint a platform session for any address, so a creator with no brand met
 * /workspaces' empty list and was sent to /brands/new. Now:
 *   - no brand seat /workspaces would list, not an operator, and the Network
 *     gives a sign-in token → the creator landing (/creator/auth/magic);
 *   - a brand and a creator account → the brand path, Network not asked;
 *   - neither → the brand path, on to /brands/new (Google brand signup);
 *   - account_add → always the brand path: it adds a brand account.
 *
 * A local HTTP server plays the Network; Google's token endpoint is a fetch
 * stub. Skipped when DATABASE_URL is unset, like the rest of the
 * integration suite.
 */

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Response as TestResponse } from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type PlatformSessionRow } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
const OPS_EMAIL = `ops-sgc-${ulid().slice(-6).toLowerCase()}@sgc.test`;
process.env.PLATFORM_ADMIN_EMAILS = OPS_EMAIL;
delete process.env.PLATFORM_OPS_EMAIL;
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const ADMIN_KEY = 'netadm_test_signin_google_0123456789abcdef';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { PLATFORM_SESSION_COOKIE } = await import('../platform-sessions.js');
const { GOOGLE_TOKEN_URL, GOOGLE_STATE_COOKIE } = await import('../routes/google-auth.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const realFetch = globalThis.fetch;

// ----- the fake Network -----

let network: Server;
let networkUrl: string;
const calls: Array<{
  path: string;
  authorization: string | undefined;
  clientIp: string | undefined;
  body: Record<string, unknown>;
}> = [];
/** This test's answer to POST /admin/creators/signin-token. */
let signinToken: { status: number; body: unknown } = { status: 404, body: { error: 'no_creator' } };

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['NETWORK_URL', 'NETWORK_ADMIN_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI'];

const tenants: string[] = [];
const emails = new Set<string>([OPS_EMAIL]);

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}
function address(tag: string): string {
  const e = `${tag}-${rnd()}@sgc.test`;
  emails.add(e);
  return e;
}

async function makeTenant(status: 'active' | 'cancelled' = 'active'): Promise<{ id: string; slug: string }> {
  const id = ulid();
  const slug = `sgc${rnd()}`;
  await db(TABLES.Tenant).insert({ id, slug, displayName: 'SGC Brand', status });
  tenants.push(id);
  return { id, slug };
}

async function makeAdmin(
  tenantId: string,
  email: string,
  seat: Partial<{ revokedAt: Date | null; activatedAt: Date | null; role: 'admin' | 'viewer' }> = {},
): Promise<void> {
  await db(TABLES.Admin).insert({ id: ulid(), tenantId, email, name: 'Admin', activatedAt: new Date(), ...seat });
}

/** The proxy's signed-address header, checked the way the Network does. */
function vouchedIp(header: string | undefined): string | null {
  const m = /^([0-9A-Fa-f.:]+);t=(\d+);sig=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return null;
  const sig = createHmac('sha256', ADMIN_KEY).update(`${m[1]}.${m[2]}`).digest('hex');
  return sig === m[3] ? m[1]! : null;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  await new Promise<void>((resolve) => {
    network = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push({
          path: req.url ?? '',
          authorization: req.headers.authorization,
          clientIp: req.headers['x-openpartner-client-ip'] as string | undefined,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
        const answer =
          req.method === 'POST' && req.url === '/admin/creators/signin-token'
            ? signinToken
            : { status: 404, body: { error: 'not_found' } };
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    }).listen(0, '127.0.0.1', () => {
      networkUrl = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
      resolve();
    });
  });
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await new Promise<void>((r) => network.close(() => r()));
  if (skipIntegration) return;
  for (const tenantId of tenants) {
    for (const table of [TABLES.Session, TABLES.MagicLinkToken, TABLES.Admin]) await db(table).where({ tenantId }).del();
    await db(TABLES.Tenant).where({ id: tenantId }).del();
  }
  const all = [...emails];
  await db(TABLES.MagicLinkToken).whereIn('email', all).del();
  const sessions = await db<PlatformSessionRow>(TABLES.PlatformSession).whereIn('email', all);
  const bundleIds = [...new Set(sessions.map((s) => s.bundleId).filter((b): b is string => !!b))];
  await db(TABLES.PlatformSession).whereIn('email', all).del();
  if (bundleIds.length) await db(TABLES.PlatformSessionBundle).whereIn('id', bundleIds).del();
});

beforeEach(() => {
  calls.length = 0;
  signinToken = { status: 404, body: { error: 'no_creator' } };
  process.env.NETWORK_URL = networkUrl;
  process.env.NETWORK_ADMIN_API_KEY = ADMIN_KEY;
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
});

// ----- the Google round trip -----

interface Started {
  cookie: string;
  state: string;
  nonce: string;
}

async function googleStart(query: string): Promise<Started> {
  const res = await request(app).get(`/auth/google/start?${query}`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.location as string);
  expect(location.origin).toBe('https://accounts.google.com');
  const set = res.headers['set-cookie'] as unknown as string[];
  return {
    cookie: set.find((s) => s.startsWith(`${GOOGLE_STATE_COOKIE}=`))!.split(';')[0]!,
    state: location.searchParams.get('state')!,
    nonce: location.searchParams.get('nonce')!,
  };
}

/** Sign in with Google from /signin (or "Add another account", with
 *  flow=account_add) as `email`: Google's token endpoint stubbed, every
 *  other request (the fake Network) passed through. */
async function viaGoogle(email: string, query = 'flow=account', claims: Record<string, unknown> = {}): Promise<TestResponse> {
  const started = await googleStart(query);
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== GOOGLE_TOKEN_URL) return realFetch(input, init);
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: started.nonce,
        email_verified: true,
        hd: 'sgc.test',
        email,
        ...claims,
      }),
    ).toString('base64url');
    return new Response(JSON.stringify({ id_token: `header.${payload}.sig` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const res = await request(app)
      .get(`/auth/google/callback?code=c0de&state=${encodeURIComponent(started.state)}`)
      .set('Cookie', started.cookie)
      .set('X-Forwarded-For', '198.51.100.7');
    expect(res.status).toBe(302);
    return res;
  } finally {
    spy.mockRestore();
  }
}

const BRAND_LANDING = /^http:\/\/localhost:5673\/auth\/magic\?token=/;

/** Follow the brand path's landing: verify, then list workspaces. */
async function workspacesAfter(res: TestResponse): Promise<string[]> {
  expect(res.headers.location).toMatch(BRAND_LANDING);
  const token = new URL(res.headers.location as string).searchParams.get('token')!;
  const verify = await request(app).post('/auth/platform-verify').send({ token });
  expect(verify.status).toBe(200);
  const cookie = (verify.headers['set-cookie'] as unknown as string[])
    .find((s) => s.startsWith(`${PLATFORM_SESSION_COOKIE}=`))!
    .split(';')[0]!;
  const list = await request(app).get('/me/workspaces').set('Cookie', cookie);
  return (list.body.workspaces as Array<{ tenantSlug: string }>).map((w) => w.tenantSlug);
}

async function platformTokens(email: string): Promise<Array<{ purpose: string }>> {
  return db(TABLES.MagicLinkToken).where({ email }).select('purpose');
}

async function platformSessions(email: string): Promise<number> {
  return (await db(TABLES.PlatformSession).where({ email })).length;
}

function asCreator(token = 'opmlcreator_from_network'): void {
  signinToken = { status: 200, body: { ok: true, token } };
}

// ----- tests -----

describe.skipIf(skipIntegration)('Google on /signin: a creator with no brand', () => {
  it('lands in the creator portal with the Network’s sign-in token, and gets no platform session', async () => {
    asCreator();
    const email = address('creator');
    const res = await viaGoogle(email.toUpperCase());

    expect(res.headers.location).toBe('http://localhost:5673/creator/auth/magic?token=opmlcreator_from_network');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/admin/creators/signin-token');
    expect(calls[0]!.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    // Only the verified address, and the browser's own, signed, for the
    // Network's country check.
    expect(calls[0]!.body).toEqual({ email });
    expect(vouchedIp(calls[0]!.clientIp)).toBe('198.51.100.7');
    expect(await platformTokens(email)).toEqual([]);
    expect(await platformSessions(email)).toBe(0);
  });

  it('only an address Google is authoritative for gets as far as the Network', async () => {
    asCreator();
    // A Google account opened on another provider's address.
    const res = await viaGoogle(`elsewhere-${rnd()}@mail.example`, 'flow=account', { hd: undefined });
    expect(res.headers.location).toBe('http://localhost:5673/signin?error=google_not_authoritative');
    expect(calls).toHaveLength(0);
  });

  it('drops ?next=, a page inside a brand', async () => {
    asCreator();
    const res = await viaGoogle(address('creatornext'), `flow=account&next=${encodeURIComponent('/admin/partners')}`);
    expect(res.headers.location).toBe('http://localhost:5673/creator/auth/magic?token=opmlcreator_from_network');
  });

  it('a seat /workspaces wouldn’t list is no brand: revoked, or in a cancelled brand', async () => {
    asCreator();
    const email = address('formerbrand');
    await makeAdmin((await makeTenant()).id, email, { revokedAt: new Date() });
    await makeAdmin((await makeTenant('cancelled')).id, email);
    const res = await viaGoogle(email);
    expect(res.headers.location).toBe('http://localhost:5673/creator/auth/magic?token=opmlcreator_from_network');
  });

  it('a suspended or blocked creator hears so on /signin, and gets no platform session', async () => {
    signinToken = { status: 403, body: { error: 'creator_not_active' } };
    const email = address('blocked');
    const next = '/admin/partners';
    const res = await viaGoogle(email, `flow=account&next=${encodeURIComponent(next)}`);
    expect(res.headers.location).toBe(
      `http://localhost:5673/signin?error=creator_not_active&next=${encodeURIComponent(next)}`,
    );
    expect(await platformTokens(email)).toEqual([]);
    expect(await platformSessions(email)).toBe(0);
  });
});

describe.skipIf(skipIntegration)('Google on /signin: everyone else keeps the brand path', () => {
  it('a seat not activated yet, or view-only, is a brand: /workspaces lists it', async () => {
    asCreator();
    const email = address('seats');
    const pending = await makeTenant();
    const viewer = await makeTenant();
    await makeAdmin(pending.id, email, { activatedAt: null });
    await makeAdmin(viewer.id, email, { role: 'viewer' });
    const res = await viaGoogle(email);
    expect(calls).toHaveLength(0);
    expect((await workspacesAfter(res)).sort()).toEqual([pending.slug, viewer.slug].sort());
  });

  it('a Network answer that isn’t a sign-in or a refusal: the brand path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const answer of [
        { status: 200, body: { ok: true } },
        { status: 200, body: { ok: true, token: '' } },
        // Only the Network's 403 means a creator it won't sign in.
        { status: 500, body: { error: 'creator_not_active' } },
      ]) {
        signinToken = answer;
        const email = address('odd');
        const res = await viaGoogle(email);
        expect(res.headers.location).toMatch(BRAND_LANDING);
        expect(await platformTokens(email)).toEqual([{ purpose: 'platform_signin' }]);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('a brand and a creator account: the brand, and the Network isn’t asked', async () => {
    asCreator();
    const email = address('both');
    const { id, slug } = await makeTenant();
    await makeAdmin(id, email);
    const res = await viaGoogle(email);
    expect(calls).toHaveLength(0);
    expect(await workspacesAfter(res)).toEqual([slug]);
  });

  it('neither: the brand path with no workspaces, so /workspaces goes on to /brands/new', async () => {
    const email = address('neither');
    const res = await viaGoogle(email);
    expect(calls.map((c) => c.body)).toEqual([{ email }]);
    expect(await workspacesAfter(res)).toEqual([]);
  });

  it('“Add another account” adds a brand account, even for a creator: the Network isn’t asked', async () => {
    asCreator();
    const email = address('add');
    const res = await viaGoogle(email, 'flow=account_add');
    expect(res.headers.location).toMatch(BRAND_LANDING);
    expect(calls).toHaveLength(0);
    expect(await platformTokens(email)).toEqual([{ purpose: 'platform_add_account' }]);
  });

  it('an operator who is also a creator keeps the platform session', async () => {
    asCreator();
    const res = await viaGoogle(OPS_EMAIL);
    expect(res.headers.location).toMatch(BRAND_LANDING);
    expect(calls).toHaveLength(0);
  });

  it('the Network’s country check, an error or no Network at all: the brand path, as before', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lookupWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes('creator lookup failed')).length;
    try {
      // Checked before the Network looks the address up: no sign of a creator.
      signinToken = { status: 403, body: { error: 'country_not_supported' } };
      expect((await viaGoogle(address('country'))).headers.location).toMatch(BRAND_LANDING);
      signinToken = { status: 403, body: { error: 'occupied_region_confirmation_required' } };
      expect((await viaGoogle(address('region'))).headers.location).toMatch(BRAND_LANDING);
      expect(lookupWarnings()).toBe(0);

      signinToken = { status: 500, body: { error: 'internal_error' } };
      expect((await viaGoogle(address('neterror'))).headers.location).toMatch(BRAND_LANDING);
      expect(lookupWarnings()).toBe(1);

      process.env.NETWORK_URL = 'http://127.0.0.1:1';
      expect((await viaGoogle(address('netdown'))).headers.location).toMatch(BRAND_LANDING);
      expect(lookupWarnings()).toBe(2);

      calls.length = 0;
      process.env.NETWORK_URL = networkUrl;
      delete process.env.NETWORK_ADMIN_API_KEY;
      expect((await viaGoogle(address('nokey'))).headers.location).toMatch(BRAND_LANDING);
      expect(calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
