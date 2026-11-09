/**
 * Two-step sign-in (two-factor.ts, docs/two-step-sign-in.md): setting it
 * up, signing in with it, recovery codes, the brand's rule, and sessions
 * that stay nobody's until the code is in.
 *
 * The clock is faked for Date only: each new code needs a later 30-second
 * step than the last one accepted.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';

process.env.OPENPARTNER_TENANCY = 'single';
const ADMIN_KEY = 'op_test_two_factor_0123456789abcdef0123456';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createSession, issueMagicLink, resolveSession } = await import('../auth-sessions.js');
const { createPlatformSession, resolvePlatformSession } = await import('../platform-sessions.js');
const { totpCode } = await import('../totp.js');
const { ADMIN_SECURITY_CONFIG_KEY, MAX_CODE_ATTEMPTS, TWO_FACTOR_SETUP_ROUTES, finishPendingSignIn, reserveCodeAttempt, wrongCode } =
  await import('../two-factor.js');
const { hardDeleteExpiredTenants } = await import('../scheduler.js');
const { __setMailerForTests } = await import('../mailer.js');
const mail: Array<{ to: string; subject: string }> = [];
__setMailerForTests({ send: async (_ctx: unknown, m: { to: string; subject: string }) => void mail.push(m) });

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const T = DEFAULT_TENANT_ID;
const app = createApp({ enableLogger: false });

const admins: string[] = [];
const emails: string[] = [];

let clock = Date.now();
/** Thirty-one seconds on: the next step's code. */
function tick(): void {
  clock += 31_000;
  vi.setSystemTime(clock);
}

async function seat(role: 'admin' | 'viewer' = 'admin'): Promise<{ id: string; email: string; cookie: string; sessionId: string }> {
  const id = ulid();
  const email = `tf-${id.toLowerCase()}@example.com`;
  await db(TABLES.Admin).insert({ id, tenantId: T, email, name: 'Ada', role, activatedAt: new Date() });
  admins.push(id);
  emails.push(email);
  const session = await createSession(db, { tenantId: T, principalKind: 'admin', principalId: id });
  return { id, email, cookie: `op_session=${session.plaintext}`, sessionId: session.id };
}

function cookieFrom(res: request.Response): string {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const found = set.find((c) => c.startsWith('op_session='));
  if (!found) throw new Error('no op_session cookie');
  return found.split(';')[0]!;
}

/** Set up and turn on two-step for a signed-in admin. */
async function enroll(cookie: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await request(app).post('/auth/two-factor/setup').set('Cookie', cookie).send({});
  expect(setup.status).toBe(200);
  tick();
  const on = await request(app).post('/auth/two-factor/enable').set('Cookie', cookie).send({ code: totpCode(setup.body.secret) });
  expect(on.status).toBe(200);
  return { secret: setup.body.secret, recoveryCodes: on.body.recoveryCodes };
}

/** An emailed sign-in link, redeemed: the cookie it sets and the answer. */
async function signIn(admin: { id: string; email: string }): Promise<{ cookie: string; body: Record<string, unknown> }> {
  const link = await issueMagicLink(db, { tenantId: T, email: admin.email, purpose: 'admin_signin', principalKind: 'admin', principalId: admin.id });
  const res = await request(app).post('/auth/magic/verify').send({ token: link.plaintext });
  expect(res.status).toBe(200);
  return { cookie: cookieFrom(res), body: res.body };
}

async function wipe(): Promise<void> {
  await db(TABLES.Config).where({ tenantId: T, key: ADMIN_SECURITY_CONFIG_KEY }).del();
  if (emails.length) {
    await db(TABLES.TwoFactorCredential).whereIn('principalId', emails).del();
    await db(TABLES.PlatformSession).whereIn('email', emails).del();
  }
  if (admins.length) {
    await db(TABLES.Session).whereIn('principalId', admins).del();
    await db(TABLES.MagicLinkToken).whereIn('principalId', admins).del();
    await db(TABLES.Admin).whereIn('id', admins).del();
  }
  admins.length = 0;
  emails.length = 0;
  mail.length = 0;
}

afterAll(async () => {
  __setMailerForTests(null);
  if (!skipIntegration) await wipe();
  await db.destroy();
});

describe('two-step setup routes', () => {
  it('name real routes', () => {
    const keys = new Set<string>();
    const walk = (stack: Array<{ route?: { path: string; methods: Record<string, boolean> }; name?: string; handle?: { stack?: unknown[] } }>) => {
      for (const l of stack) {
        if (l.route) for (const m of Object.keys(l.route.methods)) keys.add(`${m.toUpperCase()} ${l.route.path}`);
        else if (l.name === 'router' && l.handle?.stack) walk(l.handle.stack as typeof stack);
      }
    };
    walk((app as unknown as { _router: { stack: Parameters<typeof walk>[0] } })._router.stack);
    expect(Object.keys(TWO_FACTOR_SETUP_ROUTES).filter((k) => !keys.has(k))).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('two-step sign-in', () => {
  beforeEach(async () => {
    await wipe();
    clock = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns on with a first code, ends the other sessions and mails the person', async () => {
    const admin = await seat();
    const other = await createSession(db, { tenantId: T, principalKind: 'admin', principalId: admin.id });
    const platform = await createPlatformSession(db, admin.email);

    const setup = await request(app).post('/auth/two-factor/setup').set('Cookie', admin.cookie).send({});
    expect(setup.body.otpauthUri).toContain(encodeURIComponent(admin.email));
    expect(setup.headers['cache-control']).toBe('no-store');
    const wrong = await request(app).post('/auth/two-factor/enable').set('Cookie', admin.cookie).send({ code: '000000' });
    expect(wrong.status).toBe(400);
    tick();
    const on = await request(app).post('/auth/two-factor/enable').set('Cookie', admin.cookie).send({ code: totpCode(setup.body.secret) });
    expect(on.status).toBe(200);
    expect(on.body.recoveryCodes).toHaveLength(10);
    expect(on.body.recoveryCodes[0]).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const status = await request(app).get('/auth/two-factor').set('Cookie', admin.cookie);
    expect(status.body).toMatchObject({ enabled: true, verified: true, recoveryCodesLeft: 10, requiredByBrand: false });
    expect(await db(TABLES.Session).where({ id: other.id }).first('revokedAt')).toMatchObject({ revokedAt: expect.any(Date) });
    expect(await resolvePlatformSession(db, platform.plaintext)).toBeNull();
    expect(mail.map((m) => [m.to, m.subject])).toEqual([[admin.email, 'Two-step sign-in is on']]);
    // The secret is stored sealed.
    const row = await db(TABLES.TwoFactorCredential).where({ principalId: admin.email }).first();
    expect(row.secret).not.toContain(setup.body.secret);
    const audit = await db(TABLES.AuditLog).where({ tenantId: T, actorId: admin.id, action: 'POST /auth/two-factor/enable' }).first();
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(on.body.recoveryCodes[0]);
  });

  it('holds a new sign-in until its code is entered, and records it then', async () => {
    const admin = await seat();
    const { secret } = await enroll(admin.cookie);

    const { cookie, body } = await signIn(admin);
    expect(body.twoFactorRequired).toBe(true);
    const held = await request(app).get('/partners').set('Cookie', cookie);
    expect([held.status, held.body.error]).toEqual([401, 'two_factor_required']);
    expect(await db(TABLES.AuditLog).where({ tenantId: T, actorId: admin.id, action: 'signin' })).toEqual([]);

    const wrong = await request(app).post('/auth/two-factor/verify').set('Cookie', cookie).send({ code: '123456' });
    expect(wrong.body).toEqual({ error: 'invalid_code', attemptsLeft: 4 });
    tick();
    const code = totpCode(secret);
    const ok = await request(app).post('/auth/two-factor/verify').set('Cookie', cookie).send({ code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/partners').set('Cookie', cookie)).status).toBe(200);
    const [signin] = await db(TABLES.AuditLog).where({ tenantId: T, actorId: admin.id, action: 'signin' });
    expect(signin.detail).toEqual({ via: 'link', secondFactor: 'totp' });

    // The same code never works twice.
    const again = await signIn(admin);
    const replay = await request(app).post('/auth/two-factor/verify').set('Cookie', again.cookie).send({ code });
    expect(replay.body.error).toBe('invalid_code');
  });

  it('ends a pending session after five wrong codes', async () => {
    const admin = await seat();
    const { secret } = await enroll(admin.cookie);
    const { cookie } = await signIn(admin);
    for (let i = 4; i >= 1; i -= 1) {
      const res = await request(app).post('/auth/two-factor/verify').set('Cookie', cookie).send({ code: '111111' });
      expect(res.body.attemptsLeft).toBe(i);
    }
    const last = await request(app).post('/auth/two-factor/verify').set('Cookie', cookie).send({ code: '111111' });
    expect([last.status, last.body.error]).toEqual([401, 'too_many_attempts']);
    tick();
    const late = await request(app).post('/auth/two-factor/verify').set('Cookie', cookie).send({ code: totpCode(secret) });
    expect([late.status, late.body.error]).toEqual([401, 'no_pending_sign_in']);
  });

  it('spends the tries before checking, so parallel guesses get no more than five', async () => {
    const admin = await seat();
    await enroll(admin.cookie);
    const { cookie } = await signIn(admin);
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => request(app).post('/auth/two-factor/verify').set('Cookie', cookie).send({ code: '222222' })),
    );
    expect(answers.filter((r) => r.body.error === 'invalid_code')).toHaveLength(4);
    expect(answers.filter((r) => r.status === 401 && r.body.error === 'too_many_attempts')).toHaveLength(4);
    const row = await db(TABLES.Session).where({ principalId: admin.id, secondFactorPending: true }).first();
    expect(row).toMatchObject({ secondFactorAttempts: 5, revokedAt: expect.any(Date) });
  });

  it('never accepts a session that skipped the code, however it was made', async () => {
    const admin = await seat();
    const { secret } = await enroll(admin.cookie);
    // As a sign-in that read "off" just before the turn-on would leave one.
    const raced = await createSession(db, { tenantId: T, principalKind: 'admin', principalId: admin.id });
    await db(TABLES.Session).where({ id: raced.id }).update({ secondFactorPending: false });
    expect(await resolveSession(db, raced.plaintext, T)).toBeNull();
    const rawPlatform = await createPlatformSession(db, admin.email);
    await db(TABLES.PlatformSession).where({ email: admin.email, secondFactorPending: true }).update({ secondFactorPending: false });
    expect(await resolvePlatformSession(db, rawPlatform.plaintext)).toBeNull();

    // And setting up again can't replace the authenticator that's on.
    const again = await request(app).post('/auth/two-factor/setup').set('Cookie', admin.cookie).send({});
    expect([again.status, again.body.error]).toEqual([409, 'already_enabled']);
    tick();
    const pending = await signIn(admin);
    const ok = await request(app).post('/auth/two-factor/verify').set('Cookie', pending.cookie).send({ code: totpCode(secret) });
    expect(ok.status).toBe(200);
  });

  it('takes each recovery code once', async () => {
    const admin = await seat();
    const { recoveryCodes } = await enroll(admin.cookie);
    const first = await signIn(admin);
    const used = await request(app)
      .post('/auth/two-factor/verify')
      .set('Cookie', first.cookie)
      .send({ code: recoveryCodes[3]!.toLowerCase().replace(/-/g, ' ') });
    expect(used.body).toMatchObject({ ok: true, usedRecoveryCode: true });
    const second = await signIn(admin);
    const reused = await request(app).post('/auth/two-factor/verify').set('Cookie', second.cookie).send({ code: recoveryCodes[3] });
    expect(reused.body.error).toBe('invalid_code');
    const status = await request(app).get('/auth/two-factor').set('Cookie', first.cookie);
    expect(status.body.recoveryCodesLeft).toBe(9);
  });

  it('holds an OpenPartner account sign-in the same way, and carries the code into a brand', async () => {
    const admin = await seat();
    const { secret } = await enroll(admin.cookie);
    const platform = await createPlatformSession(db, admin.email);
    expect(platform.secondFactorPending).toBe(true);
    expect(await resolvePlatformSession(db, platform.plaintext)).toBeNull();

    tick();
    const res = await request(app)
      .post('/auth/platform-two-factor')
      .set('Cookie', `op_platform_session=${platform.plaintext}`)
      .send({ code: totpCode(secret) });
    expect(res.body).toMatchObject({ ok: true, email: admin.email });
    const passed = await resolvePlatformSession(db, platform.plaintext);
    expect(passed?.secondFactorAt).toBeInstanceOf(Date);

    // Entering a brand from that account needs no second code.
    const entered = await createSession(db, { tenantId: T, principalKind: 'admin', principalId: admin.id, secondFactorAt: passed!.secondFactorAt });
    expect(entered.secondFactorPending).toBe(false);
    expect(await resolveSession(db, entered.plaintext, T)).toMatchObject({ secondFactorAt: expect.any(Date) });
  });

  it('turns off with a code, and sign-ins stop asking', async () => {
    const admin = await seat();
    const { secret } = await enroll(admin.cookie);
    const refused = await request(app).post('/auth/two-factor/disable').set('Cookie', admin.cookie).send({ code: '000000' });
    expect(refused.body.error).toBe('invalid_code');
    tick();
    const off = await request(app).post('/auth/two-factor/disable').set('Cookie', admin.cookie).send({ code: totpCode(secret) });
    expect(off.status).toBe(200);
    expect((await signIn(admin)).body.twoFactorRequired).toBeUndefined();
    expect(mail.map((m) => m.subject)).toEqual(['Two-step sign-in is on', 'Two-step sign-in is off']);
    // The session kept no longer counts as two-step: a brand rule asks again.
    expect((await request(app).get('/auth/two-factor').set('Cookie', admin.cookie)).body.verified).toBe(false);
    await request(app).post('/config/admin-security').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ requireTwoFactor: true });
    const asked = await request(app).get('/partners').set('Cookie', admin.cookie);
    expect(asked.body.error).toBe('two_factor_setup_required');
  });

  it('stops counting a proof from before two-step was turned off and on again', async () => {
    const admin = await seat();
    const first = await enroll(admin.cookie);
    const oldProof = (await db(TABLES.Session).where({ id: admin.sessionId }).first()).secondFactorAt as Date;
    tick();
    await request(app).post('/auth/two-factor/disable').set('Cookie', admin.cookie).send({ code: totpCode(first.secret) });
    await enroll(admin.cookie);
    // As entering a brand from an account session verified before would.
    const carried = await createSession(db, { tenantId: T, principalKind: 'admin', principalId: admin.id, secondFactorAt: oldProof });
    expect(await resolveSession(db, carried.plaintext, T)).toBeNull();
    expect((await request(app).get('/partners').set('Cookie', admin.cookie)).status).toBe(200);
  });

  it('never lets a late wrong code end a sign-in that already went through', async () => {
    const admin = await seat();
    await enroll(admin.cookie);
    const platform = await createPlatformSession(db, admin.email);
    const row = await db(TABLES.PlatformSession).where({ email: admin.email, secondFactorPending: true }).first();
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) await reserveCodeAttempt(db, TABLES.PlatformSession, row.id);
    expect(await finishPendingSignIn(db, TABLES.PlatformSession, row.id)).toBe(true);
    expect(await wrongCode(db, TABLES.PlatformSession, row.id, MAX_CODE_ATTEMPTS)).toBe(0);
    expect(await resolvePlatformSession(db, platform.plaintext)).toMatchObject({ id: row.id });
  });

  it('makes new recovery codes with a code, and the old ones stop working', async () => {
    const admin = await seat();
    const { secret, recoveryCodes } = await enroll(admin.cookie);
    tick();
    const fresh = await request(app).post('/auth/two-factor/recovery-codes').set('Cookie', admin.cookie).send({ code: totpCode(secret) });
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    const pending = await signIn(admin);
    const old = await request(app).post('/auth/two-factor/verify').set('Cookie', pending.cookie).send({ code: recoveryCodes[0] });
    expect(old.body.error).toBe('invalid_code');
    const ok = await request(app).post('/auth/two-factor/verify').set('Cookie', pending.cookie).send({ code: fresh.body.recoveryCodes[0] });
    expect(ok.status).toBe(200);
  });

  it("is a person's: API keys can't set it up, and viewers can", async () => {
    const asKey = await request(app).post('/auth/two-factor/setup').set('Authorization', `Bearer ${ADMIN_KEY}`).send({});
    expect([asKey.status, asKey.body.error]).toEqual([403, 'session_required']);
    const viewer = await seat('viewer');
    await enroll(viewer.cookie);
    const admins = await request(app).get('/admins').set('Cookie', viewer.cookie);
    expect(admins.body.admins.find((a: { id: string }) => a.id === viewer.id).twoFactor).toBe(true);
  });

  describe('when the brand requires it', () => {
    it('only lets whoever has it turn the rule on', async () => {
      const admin = await seat();
      const early = await request(app).post('/config/admin-security').set('Cookie', admin.cookie).send({ requireTwoFactor: true });
      expect([early.status, early.body.error]).toEqual([409, 'two_factor_not_enabled']);
      await enroll(admin.cookie);
      const on = await request(app).post('/config/admin-security').set('Cookie', admin.cookie).send({ requireTwoFactor: true });
      expect(on.body).toEqual({ requireTwoFactor: true });
      const audit = await db(TABLES.AuditLog).where({ tenantId: T, actorId: admin.id, action: 'POST /config/admin-security' });
      expect(audit).toHaveLength(1);
    });

    it('sends an admin without it to setup, and nowhere else, until they have it', async () => {
      await request(app).post('/config/admin-security').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ requireTwoFactor: true });
      const admin = await seat();
      const blocked = await request(app).get('/partners').set('Cookie', admin.cookie);
      expect([blocked.status, blocked.body.error]).toEqual([403, 'two_factor_setup_required']);
      const who = await request(app).get('/auth/whoami').set('Cookie', admin.cookie);
      expect(who.body.twoFactor).toEqual({ enabled: false, verified: false, required: true });

      await enroll(admin.cookie);
      expect((await request(app).get('/partners').set('Cookie', admin.cookie)).status).toBe(200);
      tick();
      const off = await request(app).post('/auth/two-factor/disable').set('Cookie', admin.cookie).send({ code: '000000' });
      expect([off.status, off.body.error]).toEqual([409, 'required_by_brand']);
      // Keys aren't people: the rule doesn't touch them.
      expect((await request(app).get('/partners').set('Authorization', `Bearer ${ADMIN_KEY}`)).status).toBe(200);
    });
  });

  it("deletes an authenticator once its email's last admin seat is gone", async () => {
    const admin = await seat();
    await enroll(admin.cookie);
    const orphan = `tf-orphan-${ulid().toLowerCase()}@example.com`;
    emails.push(orphan);
    await db(TABLES.TwoFactorCredential).insert({ id: ulid(), tenantId: T, principalKind: 'platform', principalId: orphan, secret: 'sealed' });
    vi.useRealTimers();
    const result = await hardDeleteExpiredTenants();
    expect(result.orphanedTwoFactorDeleted).toBeGreaterThanOrEqual(1);
    expect(await db(TABLES.TwoFactorCredential).where({ principalId: orphan }).first()).toBeUndefined();
    expect(await db(TABLES.TwoFactorCredential).where({ principalId: admin.email }).first()).toBeTruthy();
  });
});
