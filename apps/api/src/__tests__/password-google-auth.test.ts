/**
 * Password + Google sign-in: routes/password-auth.ts, routes/google-auth.ts,
 * signin-handoff.ts, passwords.ts. Multi-tenant, over the real HTTP surface.
 *
 * The property every flow here must keep: a password or Google only ever
 * earns the token a sign-in email would carry, and the session comes from
 * the existing verify endpoint. So most tests run the whole round trip —
 * password → token → verify → cookie — rather than stopping at the token.
 *
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request, { type Response } from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type PasswordCredentialRow, type PlatformSessionRow } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
const OPS_EMAIL = `ops-pw-${ulid().slice(-6).toLowerCase()}@openpartner.test`;
process.env.PLATFORM_ADMIN_EMAILS = OPS_EMAIL;
delete process.env.NETWORK_URL; // no auto-enroll side calls
delete process.env.PLATFORM_OPS_EMAIL; // no ops mail
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_OAUTH_REDIRECT_URI;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { issueMagicLink, createSession, SESSION_COOKIE_NAME } = await import('../auth-sessions.js');
const { createPlatformSession, PLATFORM_SESSION_COOKIE } = await import('../platform-sessions.js');
const { __setMailerForTests } = await import('../mailer.js');
type Message = import('../mailer.js').Message;
const {
  hashPassword,
  verifyPassword,
  setPassword,
  platformCredential,
  partnerCredential,
  holdSignupPassword,
  passwordFailures,
} = await import('../passwords.js');
const { GOOGLE_TOKEN_URL, GOOGLE_STATE_COOKIE } = await import('../routes/google-auth.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const PASSWORD = 'correct horse battery';
const sent: Message[] = [];
const tenants: string[] = [];
const emails = new Set<string>();

function rnd(): string {
  return ulid().slice(-8).toLowerCase();
}
function address(tag: string): string {
  const e = `${tag}-${rnd()}@pw.test`;
  emails.add(e);
  return e;
}

async function makeTenant(): Promise<{ id: string; slug: string }> {
  const id = ulid();
  const slug = `pw${rnd()}`;
  await db(TABLES.Tenant).insert({ id, slug, displayName: 'PW Brand', status: 'active' });
  tenants.push(id);
  return { id, slug };
}

async function makeAdmin(tenantId: string, email: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Admin).insert({ id, tenantId, email, name: 'Admin', activatedAt: new Date() });
  return id;
}

async function makePartner(
  tenantId: string,
  email: string,
  overrides: Partial<{ portalAccess: boolean; revokedAt: Date | null }> = {},
): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId,
    email,
    name: 'Partner',
    activatedAt: new Date(),
    portalAccess: overrides.portalAccess ?? true,
    revokedAt: overrides.revokedAt ?? null,
  });
  return id;
}

function cookieFrom(res: Response, name: string): string | null {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = set?.find((s) => s.startsWith(`${name}=`) && !s.startsWith(`${name}=;`));
  return c ? c.split(';')[0]! : null;
}

function tokenFromMail(msg: Message | undefined): string {
  const m = msg?.text.match(/token=([^&\s]+)/);
  if (!m) throw new Error('no token in mail');
  return decodeURIComponent(m[1]!);
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  __setMailerForTests({
    async send(_ctx, msg) {
      sent.push(msg);
    },
  });
});

afterAll(async () => {
  __setMailerForTests(null);
  if (skipIntegration) return;
  for (const tenantId of tenants) {
    for (const table of [
      TABLES.PasswordCredential,
      TABLES.Session,
      TABLES.MagicLinkToken,
      TABLES.Link,
      TABLES.PartnerProgram,
      TABLES.Program,
      TABLES.Partner,
      TABLES.Admin,
      TABLES.Config,
      TABLES.ApiKey,
      TABLES.LocationDeclaration,
    ]) {
      await db(table).where({ tenantId }).del();
    }
    await db(TABLES.Tenant).where({ id: tenantId }).del();
  }
  const all = [...emails, OPS_EMAIL];
  await db(TABLES.PasswordCredential).where({ principalKind: 'platform' }).whereIn('principalId', all).del();
  await db(TABLES.MagicLinkToken).whereIn('email', all).del();
  const sessions = await db<PlatformSessionRow>(TABLES.PlatformSession).whereIn('email', all);
  const bundleIds = [...new Set(sessions.map((s) => s.bundleId).filter((b): b is string => !!b))];
  await db(TABLES.PlatformSession).whereIn('email', all).del();
  if (bundleIds.length) await db(TABLES.PlatformSessionBundle).whereIn('id', bundleIds).del();
  await db(TABLES.PlatformAdminSession).whereIn('email', all).del();
  await db(TABLES.PlatformAdmin).whereIn('email', all).del();
  await db(TABLES.SignupBlocklist).where('value', 'like', '%pw-blocked.test').del();
});

// ---------------------------------------------------------------------------

describe('password hashing', () => {
  it('verifies the password it hashed, and nothing else', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
    expect(await hashPassword(PASSWORD)).not.toBe(stored); // salted
  });

  it('treats a malformed stored hash as a mismatch', async () => {
    expect(await verifyPassword(PASSWORD, 'bcrypt$whatever')).toBe(false);
    expect(await verifyPassword(PASSWORD, 'scrypt$32768$8$1$c2FsdA==$')).toBe(false);
  });
});

describe.skipIf(skipIntegration)('platform password sign-in (/signin/password)', () => {
  it('a correct password earns a token that /auth/platform-verify turns into a session', async () => {
    const { id: tenantId, slug } = await makeTenant();
    const email = address('admin');
    await makeAdmin(tenantId, email);
    await setPassword(db, platformCredential(email), PASSWORD);

    const res = await request(app).post('/signin/password').send({ email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    // No session is set by the password route itself.
    expect(cookieFrom(res, PLATFORM_SESSION_COOKIE)).toBeNull();

    const verify = await request(app).post('/auth/platform-verify').send({ token: res.body.token });
    expect(verify.status).toBe(200);
    const cookie = cookieFrom(verify, PLATFORM_SESSION_COOKIE)!;
    const workspaces = await request(app).get('/me/workspaces').set('Cookie', cookie);
    expect(workspaces.body.workspaces.map((w: { tenantSlug: string }) => w.tenantSlug)).toContain(slug);
  });

  it('add: true issues an add-account token, so verify stacks the identity', async () => {
    const email = address('stack');
    await setPassword(db, platformCredential(email), PASSWORD);
    const res = await request(app).post('/signin/password').send({ email, password: PASSWORD, add: true });
    expect(res.status).toBe(200);
    const row = await db(TABLES.MagicLinkToken).where({ email }).orderBy('createdAt', 'desc').first();
    expect(row.purpose).toBe('platform_add_account');
  });

  it('a wrong password, an unknown address, and no password at all answer the same 401', async () => {
    const email = address('wrong');
    await setPassword(db, platformCredential(email), PASSWORD);
    const noPassword = address('nopass');
    const { id: tenantId } = await makeTenant();
    await makeAdmin(tenantId, noPassword);

    for (const body of [
      { email, password: 'not the password' },
      { email: address('nobody'), password: PASSWORD },
      { email: noPassword, password: PASSWORD },
    ]) {
      const res = await request(app).post('/signin/password').send(body);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_credentials' });
    }
  });

  it('holds an account after 10 wrong passwords — even the right one gets 429', async () => {
    const email = address('locked');
    await setPassword(db, platformCredential(email), PASSWORD);
    for (let i = 0; i < 10; i++) {
      expect((await request(app).post('/signin/password').send({ email, password: `nope-${i}` })).status).toBe(401);
    }
    const res = await request(app).post('/signin/password').send({ email, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('too_many_attempts');
    passwordFailures.reset(`platform|${email}`);
    // Eleven scrypt checks back to back, each deliberately slow.
  }, 30_000);
});

describe.skipIf(skipIntegration)('platform forgot / reset password', () => {
  it('mails a platform reset link to an admin, and nothing to an unknown address', async () => {
    const { id: tenantId } = await makeTenant();
    const email = address('forgot');
    await makeAdmin(tenantId, email);
    sent.length = 0;

    expect((await request(app).post('/password/forgot').send({ email })).status).toBe(200);
    expect((await request(app).post('/password/forgot').send({ email: address('stranger') })).status).toBe(200);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.platform).toBe(true);
    expect(sent[0]!.text).toContain('http://localhost:5673/reset-password?token=');
    expect(sent[0]!.text).toContain('scope=account');
  });

  it('caps reset mail at 3 per address per window', async () => {
    const { id: tenantId } = await makeTenant();
    const email = address('flood');
    await makeAdmin(tenantId, email);
    sent.length = 0;
    for (let i = 0; i < 5; i++) await request(app).post('/password/forgot').send({ email });
    expect(sent.filter((m) => m.to === email)).toHaveLength(3);
  });

  it('reset sets the password, signs the identity out everywhere, and the token is single-use', async () => {
    const { id: tenantId } = await makeTenant();
    const email = address('reset');
    const adminId = await makeAdmin(tenantId, email);
    await setPassword(db, platformCredential(email), PASSWORD);
    const platformSession = await createPlatformSession(db, email);
    const brandSession = await createSession(db, { tenantId, principalKind: 'admin', principalId: adminId });

    sent.length = 0;
    await request(app).post('/password/forgot').send({ email });
    const token = tokenFromMail(sent[0]);

    // Too short: rejected before the token is spent.
    expect((await request(app).post('/password/reset').send({ token, password: 'short' })).status).toBe(400);

    const res = await request(app).post('/password/reset').send({ token, password: 'a brand new passphrase' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
    expect((await request(app).post('/password/reset').send({ token, password: 'a brand new passphrase' })).status).toBe(400);

    expect((await request(app).post('/signin/password').send({ email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/signin/password').send({ email, password: 'a brand new passphrase' })).status).toBe(200);

    // Sessions from before the reset are gone.
    expect(
      await request(app).get('/me/workspaces').set('Cookie', `${PLATFORM_SESSION_COOKIE}=${platformSession.plaintext}`),
    ).toHaveProperty('status', 401);
    const brand = await db(TABLES.Session).where({ id: brandSession.id }).first();
    expect(brand.revokedAt).not.toBeNull();
  });

  it('a sign-in token is not a reset token', async () => {
    const email = address('kind');
    const issued = await issueMagicLink(db, {
      tenantId: DEFAULT_TENANT_ID,
      email,
      purpose: 'platform_signin',
      principalKind: 'platform',
      principalId: email,
    });
    const res = await request(app).post('/password/reset').send({ token: issued.plaintext, password: 'a brand new passphrase' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('wrong_token_kind');
  });
});

describe.skipIf(skipIntegration)('platform /me/password', () => {
  it('sets a first password with just the session, then requires the current one', async () => {
    const email = address('me');
    const session = await createPlatformSession(db, email);
    const cookie = `${PLATFORM_SESSION_COOKIE}=${session.plaintext}`;

    expect((await request(app).get('/me/password')).status).toBe(401);
    expect((await request(app).get('/me/password').set('Cookie', cookie)).body).toEqual({ email, hasPassword: false });

    expect((await request(app).put('/me/password').set('Cookie', cookie).send({ password: PASSWORD })).status).toBe(200);
    expect((await request(app).get('/me/password').set('Cookie', cookie)).body.hasPassword).toBe(true);

    const noCurrent = await request(app).put('/me/password').set('Cookie', cookie).send({ password: 'another passphrase' });
    expect(noCurrent.status).toBe(403);
    expect(noCurrent.body.error).toBe('current_password_incorrect');
    const changed = await request(app)
      .put('/me/password')
      .set('Cookie', cookie)
      .send({ currentPassword: PASSWORD, password: 'another passphrase' });
    expect(changed.status).toBe(200);
    expect((await request(app).post('/signin/password').send({ email, password: 'another passphrase' })).status).toBe(200);
  });
});

describe.skipIf(skipIntegration)('ops console password sign-in', () => {
  it('an operator signs in with the platform password; a non-operator with a valid one gets 401', async () => {
    await setPassword(db, platformCredential(OPS_EMAIL), PASSWORD);
    const res = await request(app).post('/platform-admin/signin/password').send({ email: OPS_EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    const verify = await request(app).post('/auth/platform-admin-verify').send({ token: res.body.token });
    expect(verify.status).toBe(200);
    expect(verify.body.email).toBe(OPS_EMAIL);

    const civilian = address('civilian');
    await setPassword(db, platformCredential(civilian), PASSWORD);
    const denied = await request(app).post('/platform-admin/signin/password').send({ email: civilian, password: PASSWORD });
    expect(denied.status).toBe(401);
  });
});

describe.skipIf(skipIntegration)('brand portal password sign-in (/auth/signin/password)', () => {
  it('a partner signs in to their brand with that brand’s password', async () => {
    const { id: tenantId, slug } = await makeTenant();
    const email = address('partner');
    const partnerId = await makePartner(tenantId, email);
    await setPassword(db, partnerCredential(tenantId, partnerId), PASSWORD);

    const res = await request(app).post(`/t/${slug}/auth/signin/password`).send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('partner');
    const verify = await request(app).post(`/t/${slug}/auth/magic/verify`).send({ token: res.body.token });
    expect(verify.status).toBe(200);
    expect(verify.body.role).toBe('partner');
    expect(cookieFrom(verify, SESSION_COOKIE_NAME)).not.toBeNull();
  });

  it('one brand’s partner password opens no other brand', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const email = address('twobrands');
    const inA = await makePartner(a.id, email);
    await makePartner(b.id, email);
    await setPassword(db, partnerCredential(a.id, inA), PASSWORD);

    expect((await request(app).post(`/t/${a.slug}/auth/signin/password`).send({ email, password: PASSWORD })).status).toBe(200);
    expect((await request(app).post(`/t/${b.slug}/auth/signin/password`).send({ email, password: PASSWORD })).status).toBe(401);
  });

  it('an admin signs in to a brand with their platform password', async () => {
    const { id: tenantId, slug } = await makeTenant();
    const email = address('brandadmin');
    await makeAdmin(tenantId, email);
    await setPassword(db, platformCredential(email), PASSWORD);
    const res = await request(app).post(`/t/${slug}/auth/signin/password`).send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    expect((await request(app).post(`/t/${slug}/auth/magic/verify`).send({ token: res.body.token })).body.role).toBe('admin');
  });

  it('no portal access, or revoked: the same 401 as a wrong password', async () => {
    const { id: tenantId, slug } = await makeTenant();
    const headless = address('headless');
    const revoked = address('revoked');
    const p1 = await makePartner(tenantId, headless, { portalAccess: false });
    const p2 = await makePartner(tenantId, revoked, { revokedAt: new Date() });
    await setPassword(db, partnerCredential(tenantId, p1), PASSWORD);
    await setPassword(db, partnerCredential(tenantId, p2), PASSWORD);
    for (const email of [headless, revoked]) {
      const res = await request(app).post(`/t/${slug}/auth/signin/password`).send({ email, password: PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_credentials');
    }
  });
});

describe.skipIf(skipIntegration)('brand portal forgot / reset password', () => {
  it('a partner’s reset comes from the brand and lands on the brand’s portal; an admin’s is platform mail', async () => {
    const { id: tenantId, slug } = await makeTenant();
    const partnerEmail = address('pforgot');
    const adminEmail = address('aforgot');
    await makePartner(tenantId, partnerEmail);
    await makeAdmin(tenantId, adminEmail);
    sent.length = 0;

    await request(app).post(`/t/${slug}/auth/password/forgot`).send({ email: partnerEmail });
    await request(app).post(`/t/${slug}/auth/password/forgot`).send({ email: adminEmail });
    await request(app).post(`/t/${slug}/auth/password/forgot`).send({ email: address('nobody') });

    expect(sent).toHaveLength(2);
    const partnerMail = sent.find((m) => m.to === partnerEmail)!;
    expect(partnerMail.platform).toBeFalsy();
    expect(partnerMail.text).toContain(`http://localhost:5673/t/${slug}/reset-password?token=`);
    const adminMail = sent.find((m) => m.to === adminEmail)!;
    expect(adminMail.platform).toBe(true);
    expect(adminMail.text).toContain('http://localhost:5673/reset-password?token=');
  });

  it('reset sets the partner password and ends their sessions; the link works only on its own brand', async () => {
    const { id: tenantId, slug } = await makeTenant();
    const other = await makeTenant();
    const email = address('preset');
    const partnerId = await makePartner(tenantId, email);
    const old = await createSession(db, { tenantId, principalKind: 'partner', principalId: partnerId });

    sent.length = 0;
    await request(app).post(`/t/${slug}/auth/password/forgot`).send({ email });
    const token = tokenFromMail(sent[0]);

    expect((await request(app).post(`/t/${other.slug}/auth/password/reset`).send({ token, password: PASSWORD })).status).toBe(400);

    sent.length = 0;
    await request(app).post(`/t/${slug}/auth/password/forgot`).send({ email });
    const fresh = tokenFromMail(sent[0]);
    // A reset link isn't a sign-in link.
    const asSignin = await request(app).post(`/t/${slug}/auth/magic/verify`).send({ token: fresh });
    expect(asSignin.status).toBe(400);
    expect(asSignin.body.error).toBe('wrong_token_kind');

    sent.length = 0;
    await request(app).post(`/t/${slug}/auth/password/forgot`).send({ email });
    const res = await request(app).post(`/t/${slug}/auth/password/reset`).send({ token: tokenFromMail(sent[0]), password: PASSWORD });
    expect(res.status).toBe(200);
    expect((await db(TABLES.Session).where({ id: old.id }).first()).revokedAt).not.toBeNull();
    expect((await request(app).post(`/t/${slug}/auth/signin/password`).send({ email, password: PASSWORD })).status).toBe(200);
  });
});

describe.skipIf(skipIntegration)('brand portal /auth/password (signed in)', () => {
  it('a partner sets and changes their password from a session', async () => {
    const { id: tenantId, slug } = await makeTenant();
    const partnerId = await makePartner(tenantId, address('psession'));
    const s = await createSession(db, { tenantId, principalKind: 'partner', principalId: partnerId });
    const cookie = `${SESSION_COOKIE_NAME}=${s.plaintext}`;

    expect((await request(app).get(`/t/${slug}/auth/password`).set('Cookie', cookie)).body).toEqual({
      managedOn: 'here',
      hasPassword: false,
    });
    expect((await request(app).put(`/t/${slug}/auth/password`).set('Cookie', cookie).send({ password: PASSWORD })).status).toBe(200);
    const row = await db<PasswordCredentialRow>(TABLES.PasswordCredential)
      .where({ tenantId, principalKind: 'partner', principalId: partnerId })
      .first();
    expect(row).toBeDefined();
    expect((await request(app).put(`/t/${slug}/auth/password`).set('Cookie', cookie).send({ password: 'other passphrase' })).status).toBe(403);
  });

  it('a hosted admin’s password is the platform one: managed on /account, not from a brand session', async () => {
    const { id: tenantId, slug } = await makeTenant();
    const adminId = await makeAdmin(tenantId, address('asession'));
    const s = await createSession(db, { tenantId, principalKind: 'admin', principalId: adminId });
    const cookie = `${SESSION_COOKIE_NAME}=${s.plaintext}`;

    const get = await request(app).get(`/t/${slug}/auth/password`).set('Cookie', cookie);
    expect(get.body).toEqual({ managedOn: 'account', accountUrl: 'http://localhost:5673/account' });
    const put = await request(app).put(`/t/${slug}/auth/password`).set('Cookie', cookie).send({ password: PASSWORD });
    expect(put.status).toBe(409);
    expect(put.body.error).toBe('managed_on_account');
  });
});

describe.skipIf(skipIntegration)('password chosen at signup', () => {
  it('starts working when the activation link is redeemed', async () => {
    const slug = `pwsu${rnd()}`;
    const email = address('signup');
    sent.length = 0;
    const res = await request(app).post('/signup').send({
      slug,
      displayName: 'Signup Brand',
      adminEmail: email,
      adminName: 'Ada',
      country: 'US',
      password: PASSWORD,
    });
    expect(res.status).toBe(201);
    tenants.push(res.body.tenant.id);

    // Held, not yet usable.
    expect((await request(app).post('/signin/password').send({ email, password: PASSWORD })).status).toBe(401);

    const activation = sent.find((m) => m.to === email && m.tag === 'admin_invite');
    const verify = await request(app).post(`/t/${slug}/auth/magic/verify`).send({ token: tokenFromMail(activation) });
    expect(verify.status).toBe(200);

    expect((await request(app).post('/signin/password').send({ email, password: PASSWORD })).status).toBe(200);
    const held = await db(TABLES.PasswordCredential).where({ tenantId: res.body.tenant.id, principalKind: 'signup' });
    expect(held).toHaveLength(0);
  });

  it('never replaces a password the address already has', async () => {
    const { id: tenantId, slug } = await makeTenant();
    const email = address('existing');
    const adminId = await makeAdmin(tenantId, email);
    await db(TABLES.Admin).where({ id: adminId }).update({ activatedAt: null });
    await setPassword(db, platformCredential(email), PASSWORD);

    // Someone signs up with this address and their own password; the owner
    // clicks the activation mail.
    const issued = await issueMagicLink(db, {
      tenantId,
      email,
      purpose: 'admin_invite',
      principalKind: 'admin',
      principalId: adminId,
    });
    await holdSignupPassword(db, { tenantId, tokenId: issued.id, password: 'attacker passphrase' });
    expect((await request(app).post(`/t/${slug}/auth/magic/verify`).send({ token: issued.plaintext })).status).toBe(200);

    expect((await request(app).post('/signin/password').send({ email, password: PASSWORD })).status).toBe(200);
    expect((await request(app).post('/signin/password').send({ email, password: 'attacker passphrase' })).status).toBe(401);
  });
});

describe.skipIf(skipIntegration)('add-brand honours the signup blocklist', () => {
  it('a blocked domain can’t create a brand from a platform identity (e.g. after Google sign-in)', async () => {
    await db(TABLES.SignupBlocklist).insert({ id: ulid(), type: 'domain', value: 'pw-blocked.test', reason: 'test' });
    const email = `someone-${rnd()}@pw-blocked.test`;
    emails.add(email);
    const s = await createPlatformSession(db, email);
    const res = await request(app)
      .post('/me/brands')
      .set('Cookie', `${PLATFORM_SESSION_COOKIE}=${s.plaintext}`)
      .send({ slug: `pwb${rnd()}`, displayName: 'Blocked', plan: 'flex', country: 'US' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('signup_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

function withGoogle(): () => void {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  return () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  };
}

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
  expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:5673/api/auth/google/callback');
  return {
    cookie: cookieFrom(res, GOOGLE_STATE_COOKIE)!,
    state: location.searchParams.get('state')!,
    nonce: location.searchParams.get('nonce')!,
  };
}

async function googleCallback(started: Started, claims: Record<string, unknown>, state = started.state): Promise<Response> {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== GOOGLE_TOKEN_URL) throw new Error(`unexpected fetch ${url}`);
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: started.nonce,
        email_verified: true,
        ...claims,
      }),
    ).toString('base64url');
    return new Response(JSON.stringify({ id_token: `header.${payload}.sig` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    return await request(app).get(`/auth/google/callback?code=c0de&state=${encodeURIComponent(state)}`).set('Cookie', started.cookie);
  } finally {
    spy.mockRestore();
  }
}

function tokenFromLocation(res: Response): string {
  return new URL(res.headers.location as string).searchParams.get('token')!;
}

describe.skipIf(skipIntegration)('Google sign-in', () => {
  it('is off until a client id and secret are configured', async () => {
    expect((await request(app).get('/auth/providers')).body).toEqual({ google: false, googleStartUrl: null });
    const restore = withGoogle();
    try {
      expect((await request(app).get('/auth/providers')).body).toEqual({
        google: true,
        googleStartUrl: 'http://localhost:5673/api/auth/google/start',
      });
    } finally {
      restore();
    }
  });

  it('account flow: a verified Google address lands on the platform magic link, which signs it in', async () => {
    const restore = withGoogle();
    try {
      const email = address('google');
      const res = await googleCallback(await googleStart('flow=account'), { email: email.toUpperCase() });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^http:\/\/localhost:5673\/auth\/magic\?token=/);
      const verify = await request(app).post('/auth/platform-verify').send({ token: tokenFromLocation(res) });
      expect(verify.status).toBe(200);
      expect(verify.body.email).toBe(email);
    } finally {
      restore();
    }
  });

  it('refuses a mismatched state, an unverified address, a wrong audience, and a cancel', async () => {
    const restore = withGoogle();
    try {
      const email = address('gbad');
      // One at a time: each callback swaps out global fetch.
      const cases: Array<[(s: Started) => Promise<Response>, string]> = [
        [(s) => googleCallback(s, { email }, 'forged-state'), 'google_failed'],
        [(s) => googleCallback(s, { email, email_verified: false }), 'google_unverified'],
        [(s) => googleCallback(s, { email, aud: 'someone-else' }), 'google_failed'],
        [(s) => googleCallback(s, { email, nonce: 'replayed' }), 'google_failed'],
        [(s) => googleCallback(s, { email, exp: Math.floor(Date.now() / 1000) - 60 }), 'google_failed'],
      ];
      for (const [run, error] of cases) {
        const res = await run(await googleStart('flow=account'));
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(`http://localhost:5673/signin?error=${error}`);
      }
      const started = await googleStart('flow=account');
      const cancelled = await request(app).get(`/auth/google/callback?error=access_denied&state=${started.state}`).set('Cookie', started.cookie);
      expect(cancelled.headers.location).toBe('http://localhost:5673/signin?error=google_cancelled');
      // No state cookie at all.
      const bare = await request(app).get('/auth/google/callback?code=x&state=y');
      expect(bare.headers.location).toBe('http://localhost:5673/signin?error=google_failed');
    } finally {
      restore();
    }
  });

  it('ops flow: operators only', async () => {
    const restore = withGoogle();
    try {
      const ok = await googleCallback(await googleStart('flow=ops'), { email: OPS_EMAIL });
      expect(ok.headers.location).toMatch(/^http:\/\/localhost:5673\/platform\/auth\?token=/);
      expect((await request(app).post('/auth/platform-admin-verify').send({ token: tokenFromLocation(ok) })).status).toBe(200);

      const no = await googleCallback(await googleStart('flow=ops'), { email: address('notops') });
      expect(no.headers.location).toBe('http://localhost:5673/platform/login?error=not_an_operator');
    } finally {
      restore();
    }
  });

  it('the request log never records the authorization code', async () => {
    const restore = withGoogle();
    try {
      const lines: string[] = [];
      const { Writable } = await import('node:stream');
      const logged = createApp({
        logDestination: new Writable({
          write(chunk, _enc, cb) {
            lines.push(String(chunk));
            cb();
          },
        }),
      });
      await request(logged).get('/auth/google/callback?code=4%2F0Asecret-auth-code&state=whatever');
      await new Promise((r) => setImmediate(r));
      const log = lines.join('');
      expect(log).toContain('/auth/google/callback?');
      expect(log).toContain('code=[REDACTED]');
      expect(log).not.toContain('secret-auth-code');
    } finally {
      restore();
    }
  });

  it('portal flow: a brand’s partner lands on that brand’s magic link; a stranger is turned away', async () => {
    const restore = withGoogle();
    try {
      const { id: tenantId, slug } = await makeTenant();
      const email = address('gpartner');
      await makePartner(tenantId, email);

      const res = await googleCallback(await googleStart(`flow=portal&slug=${slug}`), { email });
      expect(res.headers.location).toMatch(new RegExp(`^http://localhost:5673/t/${slug}/auth/magic\\?token=`));
      const verify = await request(app).post(`/t/${slug}/auth/magic/verify`).send({ token: tokenFromLocation(res) });
      expect(verify.status).toBe(200);
      expect(verify.body.role).toBe('partner');

      const stranger = await googleCallback(await googleStart(`flow=portal&slug=${slug}`), { email: address('gstranger') });
      expect(stranger.headers.location).toBe(`http://localhost:5673/t/${slug}/login?error=google_no_account`);
    } finally {
      restore();
    }
  });
});
