/**
 * "Continue with Google" for OpenPartner Network creators: the `creator`
 * flow in routes/google-auth.ts (docs/creator-sign-in.md).
 *
 * Google only proves the address. The callback asks the Network,
 * server-to-server over NETWORK_ADMIN_API_KEY, for the token its sign-in
 * email would carry (POST /admin/creators/signin-token) and lands on
 * /creator/auth/magic, where POST /creators/verify through the proxy makes
 * the session. With no creator, it lands on /creator/signup holding the
 * verified address in a signed cookie, and POST /auth/google/creator-signup
 * has the Network create the creator (POST /admin/creators/signup).
 *
 * Google counts as proof only where it is authoritative for the address: a
 * Gmail address, or a Workspace account (`hd`). The stubbed ID tokens carry
 * `hd: 'example.com'` unless a test says otherwise.
 *
 * A local HTTP server plays the Network; Google's token endpoint is a fetch
 * stub. No database needed.
 */

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Response as TestResponse } from 'supertest';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const ADMIN_KEY = 'netadm_test_creator_google_0123456789abcdef';

const { createApp } = await import('../app.js');
const { GOOGLE_TOKEN_URL, GOOGLE_STATE_COOKIE, GOOGLE_CREATOR_SIGNUP_COOKIE } = await import('../routes/google-auth.js');
const { macValue } = await import('../crypto.js');

const app = createApp({ enableLogger: false });
const realFetch = globalThis.fetch;

// ----- the fake Network -----

interface NetworkCall {
  method: string;
  path: string;
  authorization: string | undefined;
  clientIp: string | undefined;
  body: Record<string, unknown>;
}
let network: Server;
let networkUrl: string;
const calls: NetworkCall[] = [];
/** Per-test answers, keyed by "METHOD /path". */
let answers: Record<string, { status: number; body: unknown }> = {};

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['NETWORK_URL', 'NETWORK_ADMIN_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI'];

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  await new Promise<void>((resolve) => {
    network = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push({
          method: req.method ?? '',
          path: req.url ?? '',
          authorization: req.headers.authorization,
          clientIp: req.headers['x-openpartner-client-ip'] as string | undefined,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
        const answer = answers[`${req.method} ${req.url}`] ?? { status: 404, body: { error: 'not_found' } };
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    }).listen(0, '127.0.0.1', () => {
      networkUrl = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await new Promise<void>((r) => network.close(() => r()));
});

beforeEach(() => {
  calls.length = 0;
  answers = {};
  process.env.NETWORK_URL = networkUrl;
  process.env.NETWORK_ADMIN_API_KEY = ADMIN_KEY;
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
});

// ----- helpers -----

function cookieFrom(res: TestResponse, name: string): string | null {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = set?.find((s) => s.startsWith(`${name}=`) && !s.startsWith(`${name}=;`));
  return c ? c.split(';')[0]! : null;
}

function setCookieLine(res: TestResponse, name: string): string | undefined {
  return (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((s) => s.startsWith(`${name}=`));
}

interface Started {
  cookie: string;
  state: string;
  nonce: string;
}

async function googleStart(): Promise<Started> {
  const res = await request(app).get('/auth/google/start?flow=creator');
  expect(res.status).toBe(302);
  const location = new URL(res.headers.location as string);
  expect(location.origin).toBe('https://accounts.google.com');
  // The one redirect URI, on the platform origin.
  expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:5673/api/auth/google/callback');
  return {
    cookie: cookieFrom(res, GOOGLE_STATE_COOKIE)!,
    state: location.searchParams.get('state')!,
    nonce: location.searchParams.get('nonce')!,
  };
}

/** The callback, with Google's token endpoint stubbed and every other
 *  request (the fake Network) passed through. */
async function googleCallback(started: Started, claims: Record<string, unknown>, app_ = app): Promise<TestResponse> {
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
        hd: 'example.com',
        sub: 'google-sub-123',
        name: 'Ada From Google',
        picture: 'https://lh3.googleusercontent.com/a/photo',
        ...claims,
      }),
    ).toString('base64url');
    return new Response(JSON.stringify({ id_token: `header.${payload}.sig`, access_token: 'ya29.access' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    return await request(app_)
      .get(`/auth/google/callback?code=c0de&state=${encodeURIComponent(started.state)}`)
      .set('Cookie', started.cookie)
      .set('X-Forwarded-For', '198.51.100.7');
  } finally {
    spy.mockRestore();
  }
}

function signupCookie(email: string, exp: number): string {
  const value = `${Buffer.from(email).toString('base64url')}.${exp}`;
  return `${GOOGLE_CREATOR_SIGNUP_COOKIE}=${value}.${macValue('creator-google-signup', value)}`;
}

/** The proxy's signed-address header, checked the way the Network does. */
function vouchedIp(header: string | undefined): string | null {
  const m = /^([0-9A-Fa-f.:]+);t=(\d+);sig=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return null;
  const sig = createHmac('sha256', ADMIN_KEY).update(`${m[1]}.${m[2]}`).digest('hex');
  return sig === m[3] ? m[1]! : null;
}

// ----- tests -----

describe('Google sign-in for creators: start', () => {
  it('starts the round trip on the platform origin', async () => {
    const started = await googleStart();
    expect(started.cookie).toBeTruthy();
  });

  it('is unavailable without the Network admin channel', async () => {
    delete process.env.NETWORK_ADMIN_API_KEY;
    const res = await request(app).get('/auth/google/start?flow=creator');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5673/creator/login?error=google_unavailable');
  });

  it('is unavailable without Google configured', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await request(app).get('/auth/google/start?flow=creator');
    expect(res.headers.location).toBe('http://localhost:5673/creator/login?error=google_unavailable');
  });
});

describe('Google sign-in for creators: an existing creator', () => {
  it('asks the Network for a sign-in token over the admin key and lands on the creator magic link', async () => {
    answers['POST /admin/creators/signin-token'] = { status: 200, body: { ok: true, token: 'opmlcreator_from_network' } };
    const res = await googleCallback(await googleStart(), { email: 'Ada@Example.COM' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5673/creator/auth/magic?token=opmlcreator_from_network');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    // Only the verified address — nothing else about the Google account.
    expect(call.body).toEqual({ email: 'ada@example.com' });
    // The browser's own address, signed, for the Network's country check.
    expect(vouchedIp(call.clientIp)).toBe('198.51.100.7');
    // No signup cookie, no session cookie of ours: verify makes the session.
    expect(setCookieLine(res, GOOGLE_CREATOR_SIGNUP_COOKIE)).toBeUndefined();
  });

  it('takes Google’s word only where Google is authoritative: Gmail, or a Workspace domain', async () => {
    answers['POST /admin/creators/signin-token'] = { status: 200, body: { ok: true, token: 'opmlcreator_t' } };
    // A Google account opened on another provider's address: verified once,
    // but the address may have changed hands since.
    const elsewhere = await googleCallback(await googleStart(), { email: 'ada@yahoo.example', hd: undefined });
    expect(elsewhere.headers.location).toBe('http://localhost:5673/creator/login?error=google_not_authoritative');
    expect(calls).toHaveLength(0);

    const gmail = await googleCallback(await googleStart(), { email: 'ada@gmail.com', hd: undefined });
    expect(gmail.headers.location).toBe('http://localhost:5673/creator/auth/magic?token=opmlcreator_t');
    const workspace = await googleCallback(await googleStart(), { email: 'ada@studio.example', hd: 'studio.example' });
    expect(workspace.headers.location).toBe('http://localhost:5673/creator/auth/magic?token=opmlcreator_t');
    expect(calls.map((c) => c.body.email)).toEqual(['ada@gmail.com', 'ada@studio.example']);
  });

  it('a non-authoritative address never reaches signup either', async () => {
    answers['POST /admin/creators/signin-token'] = { status: 404, body: { error: 'no_creator' } };
    const res = await googleCallback(await googleStart(), { email: 'new@outlook.example', hd: undefined });
    expect(res.headers.location).toBe('http://localhost:5673/creator/login?error=google_not_authoritative');
    expect(setCookieLine(res, GOOGLE_CREATOR_SIGNUP_COOKIE)).toBeUndefined();
  });

  it('turns an unverified Google address away without asking the Network', async () => {
    const res = await googleCallback(await googleStart(), { email: 'ada@example.com', email_verified: false });
    expect(res.headers.location).toBe('http://localhost:5673/creator/login?error=google_unverified');
    expect(calls).toHaveLength(0);
  });

  it('shows the Network’s refusal: a blocked creator, a country it doesn’t serve', async () => {
    answers['POST /admin/creators/signin-token'] = { status: 403, body: { error: 'creator_not_active' } };
    const blocked = await googleCallback(await googleStart(), { email: 'blocked@example.com' });
    expect(blocked.headers.location).toBe('http://localhost:5673/creator/login?error=creator_not_active');

    answers['POST /admin/creators/signin-token'] = { status: 403, body: { error: 'country_not_supported' } };
    const country = await googleCallback(await googleStart(), { email: 'ada@example.com' });
    expect(country.headers.location).toBe('http://localhost:5673/creator/login?error=country_not_supported');
  });

  it('a Network failure is a plain google_failed', async () => {
    answers['POST /admin/creators/signin-token'] = { status: 500, body: { error: 'internal_error' } };
    const res = await googleCallback(await googleStart(), { email: 'ada@example.com' });
    expect(res.headers.location).toBe('http://localhost:5673/creator/login?error=google_failed');
  });

  it('the request log never records the code or the sign-in token', async () => {
    answers['POST /admin/creators/signin-token'] = { status: 200, body: { ok: true, token: 'opmlcreator_secret_token' } };
    const lines: string[] = [];
    const logged = createApp({
      logDestination: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    });
    const res = await googleCallback(await googleStart(), { email: 'ada@example.com' }, logged);
    expect(res.headers.location).toContain('opmlcreator_secret_token');
    await new Promise((r) => setImmediate(r));
    const log = lines.join('');
    expect(log).toContain('/auth/google/callback?');
    expect(log).not.toContain('c0de');
    expect(log).not.toContain('opmlcreator_secret_token');
  });
});

describe('Google sign-in for creators: no creator yet', () => {
  async function landOnSignup(email = 'new@example.com'): Promise<{ res: TestResponse; cookie: string }> {
    answers['POST /admin/creators/signin-token'] = { status: 404, body: { error: 'no_creator' } };
    const res = await googleCallback(await googleStart(), { email });
    return { res, cookie: cookieFrom(res, GOOGLE_CREATOR_SIGNUP_COOKIE)! };
  }

  it('lands on signup with the verified address in a signed cookie, never the URL', async () => {
    const { res, cookie } = await landOnSignup('New@Example.com');
    expect(res.headers.location).toBe('http://localhost:5673/creator/signup?google=1');
    expect(res.headers.location).not.toContain('example.com');
    const line = setCookieLine(res, GOOGLE_CREATOR_SIGNUP_COOKIE)!;
    expect(line).toMatch(/; HttpOnly/);
    expect(line).toMatch(/; Secure/);
    expect(line).toMatch(/; SameSite=Lax/);
    expect(line).toMatch(/Max-Age=900/);

    const read = await request(app).get('/auth/google/creator-signup').set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ email: 'new@example.com' });
  });

  it('finishing signup has the Network create the creator for the cookie’s address, and returns its token', async () => {
    const { cookie } = await landOnSignup();
    answers['POST /admin/creators/signup'] = { status: 201, body: { ok: true, token: 'opmlcreator_signup' } };
    calls.length = 0;

    const res = await request(app)
      .post('/auth/google/creator-signup')
      .set('Cookie', cookie)
      .set('X-Forwarded-For', '192.0.2.44')
      .send({ name: 'Ada', handle: 'ada', country: 'GB' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, token: 'opmlcreator_signup' });
    // Single use: the cookie is cleared.
    expect(setCookieLine(res, GOOGLE_CREATOR_SIGNUP_COOKIE)).toMatch(/^op_creator_google_signup=;/);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/admin/creators/signup');
    expect(calls[0]!.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(calls[0]!.body).toEqual({ email: 'new@example.com', name: 'Ada', handle: 'ada', country: 'GB' });
    expect(vouchedIp(calls[0]!.clientIp)).toBe('192.0.2.44');
  });

  it('the address can’t come from the form', async () => {
    const { cookie } = await landOnSignup();
    calls.length = 0;
    const res = await request(app)
      .post('/auth/google/creator-signup')
      .set('Cookie', cookie)
      .send({ name: 'Ada', country: 'GB', email: 'someone-else@example.com' });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('the Network’s answers pass through (handle taken, country refused)', async () => {
    const { cookie } = await landOnSignup();
    answers['POST /admin/creators/signup'] = { status: 409, body: { error: 'handle_taken' } };
    const taken = await request(app).post('/auth/google/creator-signup').set('Cookie', cookie).send({ name: 'Ada', handle: 'ada', country: 'GB' });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: 'handle_taken' });

    answers['POST /admin/creators/signup'] = { status: 403, body: { error: 'country_not_supported' } };
    const refused = await request(app).post('/auth/google/creator-signup').set('Cookie', cookie).send({ name: 'Ada', country: 'RU' });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'country_not_supported' });
    // The cookie survives a refusal, so the creator can fix the form.
    expect(setCookieLine(refused, GOOGLE_CREATOR_SIGNUP_COOKIE)).toBeUndefined();
  });

  it('an address that has an account by now gets no token, and the proof is spent', async () => {
    const { cookie } = await landOnSignup();
    answers['POST /admin/creators/signup'] = { status: 409, body: { error: 'creator_exists' } };
    const res = await request(app).post('/auth/google/creator-signup').set('Cookie', cookie).send({ name: 'Ada', country: 'GB' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'creator_exists' });
    expect(setCookieLine(res, GOOGLE_CREATOR_SIGNUP_COOKIE)).toMatch(/^op_creator_google_signup=;/);
  });

  it('refuses a missing, tampered or expired cookie', async () => {
    const tampered = signupCookie('victim@example.com', Date.now() + 60_000).replace(/\.[^.]+$/, '.forged');
    const expired = signupCookie('ada@example.com', Date.now() - 1000);
    for (const cookie of [null, tampered, expired]) {
      const r = request(app).get('/auth/google/creator-signup');
      const read = await (cookie ? r.set('Cookie', cookie) : r);
      expect(read.status).toBe(404);
      expect(read.body).toEqual({ error: 'google_signup_expired' });
      const p = request(app).post('/auth/google/creator-signup');
      const post = await (cookie ? p.set('Cookie', cookie) : p).send({ name: 'Ada', country: 'GB' });
      expect(post.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
    // A fresh, correctly signed cookie works.
    const fresh = await request(app).get('/auth/google/creator-signup').set('Cookie', signupCookie('ada@example.com', Date.now() + 60_000));
    expect(fresh.body).toEqual({ email: 'ada@example.com' });
  });

  it('“use a different email” drops the cookie', async () => {
    const res = await request(app).delete('/auth/google/creator-signup');
    expect(res.status).toBe(200);
    expect(setCookieLine(res, GOOGLE_CREATOR_SIGNUP_COOKIE)).toMatch(/^op_creator_google_signup=;/);
  });
});
