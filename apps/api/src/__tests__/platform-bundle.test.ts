/**
 * Multi-identity bundles (platform-sessions.ts, routes/platform-auth.ts).
 *
 * The op_bundle_id cookie is a bearer credential: POST /identities/switch
 * mints a session for any identity in the bundle on that cookie alone. So
 * the database stores only its sha256 (PlatformSessionBundle.id).
 *
 *   1. Switching still works: sign in, stack a second identity, switch back.
 *   2. A database-only attacker can't switch: no stored value equals the
 *      cookie, and presenting what the tables hold as the cookie gets
 *      nowhere. A pre-hash (bare ULID) bundle row is just as inert, and the
 *      boot sweep deletes it.
 *   3. The cookie keeps the platform-session cookie's flags, and is set
 *      only when the browser gets a new bundle. The request log never
 *      records its value.
 *   4. A browser left with a pre-hash cookie stays signed in and recovers.
 *   5. Migration 20261020030000 deletes pre-hash bundles and leaves their
 *      sessions signed in; down() deletes hashed ones. Run inside a
 *      transaction that is always rolled back.
 *
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import request, { type Response as TestResponse } from 'supertest';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type PlatformSessionBundleRow, type PlatformSessionRow } from '@openpartner/db';

process.env.OPENPARTNER_TENANCY = 'multi';
delete process.env.NETWORK_URL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { platformSigninToken } = await import('../signin-handoff.js');
const {
  createPlatformBundle,
  createPlatformSession,
  deletePreHashBundles,
  PLATFORM_BUNDLE_COOKIE,
  PLATFORM_SESSION_COOKIE,
  platformSessionTokenHash,
} = await import('../platform-sessions.js');

// The migration lives in packages/db, outside this package's rootDir, so it
// is imported by URL rather than by a path tsc would follow.
const MIGRATION_URL = new URL(
  '../../../../packages/db/migrations/20261020030000_platform_session_bundle_hashed_id.ts',
  import.meta.url,
).href;

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const emails = new Set<string>();
const extraBundleIds = new Set<string>();

function address(tag: string): string {
  const e = `${tag}-${ulid().slice(-8).toLowerCase()}@bundle.test`;
  emails.add(e);
  return e;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function setCookieLine(res: TestResponse, name: string): string | null {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return set?.find((s) => s.startsWith(`${name}=`) && !s.startsWith(`${name}=;`)) ?? null;
}

/** `name=value`, ready for a Cookie header. */
function cookieFrom(res: TestResponse, name: string): string | null {
  return setCookieLine(res, name)?.split(';')[0] ?? null;
}

function valueOf(cookie: string): string {
  return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
}

/** Cookie attributes other than the value and the absolute Expires date. */
function attributes(line: string): string[] {
  return line
    .split(';')
    .slice(1)
    .map((a) => a.trim())
    .filter((a) => !a.startsWith('Expires='))
    .sort();
}

async function verify(email: string, opts: { add?: boolean; cookie?: string } = {}): Promise<TestResponse> {
  const token = await platformSigninToken(db, email, opts.add ?? false);
  const req = request(app).post('/auth/platform-verify');
  if (opts.cookie) req.set('Cookie', opts.cookie);
  const res = await req.send({ token });
  expect(res.status).toBe(200);
  return res;
}

interface Identity {
  sessionId: string;
  email: string;
  isActive: boolean;
}

/** Sign in as `a`, then stack `b` from the same browser. */
async function stackTwo(): Promise<{ a: string; b: string; bundle: string; sessionB: string; identities: Identity[] }> {
  const a = address('a');
  const b = address('b');
  const signinA = await verify(a);
  const bundle = cookieFrom(signinA, PLATFORM_BUNDLE_COOKIE)!;
  expect(bundle).not.toBeNull();
  const addB = await verify(b, { add: true, cookie: `${cookieFrom(signinA, PLATFORM_SESSION_COOKIE)}; ${bundle}` });
  const sessionB = cookieFrom(addB, PLATFORM_SESSION_COOKIE)!;
  const list = await request(app).get('/me/identities').set('Cookie', `${sessionB}; ${bundle}`);
  expect(list.status).toBe(200);
  return { a, b, bundle, sessionB, identities: list.body.identities as Identity[] };
}

afterAll(async () => {
  if (!skipIntegration) {
    const all = [...emails];
    const sessions = await db<PlatformSessionRow>(TABLES.PlatformSession).whereIn('email', all);
    const bundleIds = new Set([...extraBundleIds, ...sessions.map((s) => s.bundleId).filter((b): b is string => !!b)]);
    await db(TABLES.PlatformSession).whereIn('email', all).del();
    if (bundleIds.size) await db(TABLES.PlatformSessionBundle).whereIn('id', [...bundleIds]).del();
    await db(TABLES.MagicLinkToken).whereIn('email', all).del();
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('identity switching', () => {
  it('switches to a stacked identity with the bundle cookie', async () => {
    const { a, b, bundle, sessionB, identities } = await stackTwo();
    expect(identities.map((i) => i.email).sort()).toEqual([a, b].sort());
    expect(identities.find((i) => i.isActive)?.email).toBe(b);

    const target = identities.find((i) => i.email === a)!;
    const sw = await request(app)
      .post('/identities/switch')
      .set('Cookie', `${sessionB}; ${bundle}`)
      .send({ sessionId: target.sessionId });
    expect(sw.status).toBe(200);
    expect(sw.body).toMatchObject({ ok: true, email: a, sessionId: target.sessionId });

    // The rotated cookie is a working session for A.
    const sessionA = cookieFrom(sw, PLATFORM_SESSION_COOKIE)!;
    const me = await request(app).get('/me/workspaces').set('Cookie', sessionA);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(a);

    const after = await request(app).get('/me/identities').set('Cookie', `${sessionA}; ${bundle}`);
    expect((after.body.identities as Identity[]).find((i) => i.isActive)?.email).toBe(a);
  });
});

describe.skipIf(skipIntegration)('what the database holds', () => {
  it('stores only the sha256 of the bundle cookie', async () => {
    const { bundle } = await stackTwo();
    const cookie = valueOf(bundle);

    expect(await db(TABLES.PlatformSessionBundle).where({ id: cookie })).toHaveLength(0);
    expect(await db(TABLES.PlatformSession).where({ bundleId: cookie })).toHaveLength(0);

    const row = await db<PlatformSessionBundleRow>(TABLES.PlatformSessionBundle).where({ id: sha256(cookie) }).first();
    expect(row).toBeDefined();
    expect(row!.id).not.toBe(cookie);
    expect(await db(TABLES.PlatformSession).where({ bundleId: row!.id })).toHaveLength(2);
  });

  it('a database-only attacker cannot switch with what the tables hold', async () => {
    const { bundle, identities } = await stackTwo();
    const storedId = sha256(valueOf(bundle));
    const target = identities[0]!;
    // PlatformSession.bundleId holds the same hash, so the two tables offer
    // a reader one value to try, bare or dressed up as a new-style cookie.
    const stolen = await db<PlatformSessionRow>(TABLES.PlatformSession).where({ id: target.sessionId }).first();
    expect(stolen!.bundleId).toBe(storedId);

    for (const guess of [storedId, `opbundle_${storedId}`]) {
      const sw = await request(app)
        .post('/identities/switch')
        .set('Cookie', `${PLATFORM_BUNDLE_COOKIE}=${guess}`)
        .send({ sessionId: target.sessionId });
      expect(sw.status).toBe(401);
      expect(sw.body.error).toBe('no_bundle');
      expect(cookieFrom(sw, PLATFORM_SESSION_COOKIE)).toBeNull();

      const list = await request(app).get('/me/identities').set('Cookie', `${PLATFORM_BUNDLE_COOKIE}=${guess}`);
      expect(list.body).toEqual({ bundleId: null, identities: [] });
    }

    // The real cookie still works, so the rejections above were the hash.
    const real = await request(app).post('/identities/switch').set('Cookie', bundle).send({ sessionId: target.sessionId });
    expect(real.status).toBe(200);
  });

  it('a pre-hash bundle row (id = cookie) no longer resolves', async () => {
    const email = address('legacy');
    const legacyId = ulid();
    extraBundleIds.add(legacyId);
    await db(TABLES.PlatformSessionBundle).insert({ id: legacyId });
    const session = await createPlatformSession(db, email);
    const row = await db<PlatformSessionRow>(TABLES.PlatformSession)
      .where({ tokenHash: platformSessionTokenHash(session.plaintext) })
      .first();
    await db(TABLES.PlatformSession).where({ id: row!.id }).update({ bundleId: legacyId });

    const sw = await request(app)
      .post('/identities/switch')
      .set('Cookie', `${PLATFORM_BUNDLE_COOKIE}=${legacyId}`)
      .send({ sessionId: row!.id });
    expect(sw.status).toBe(401);
    expect(sw.body.error).toBe('no_bundle');
  });

  it('the boot sweep deletes pre-hash rows and keeps hashed ones', async () => {
    // Table-wide delete, so inside a transaction that is always rolled back.
    const trx = await db.transaction();
    try {
      const legacyId = ulid();
      await trx(TABLES.PlatformSessionBundle).insert({ id: legacyId });
      const fresh = await createPlatformBundle(trx);

      expect(await deletePreHashBundles(trx)).toBeGreaterThanOrEqual(1);
      expect(await trx(TABLES.PlatformSessionBundle).where({ id: legacyId })).toHaveLength(0);
      expect(await trx(TABLES.PlatformSessionBundle).where({ id: fresh.id })).toHaveLength(1);
    } finally {
      await trx.rollback();
    }
  });
});

describe.skipIf(skipIntegration)('the bundle cookie', () => {
  it('keeps the platform-session cookie flags, with a fresh random value', async () => {
    const res = await verify(address('flags'));
    const bundleLine = setCookieLine(res, PLATFORM_BUNDLE_COOKIE)!;
    const sessionLine = setCookieLine(res, PLATFORM_SESSION_COOKIE)!;
    expect(attributes(bundleLine)).toEqual(attributes(sessionLine));
    expect(attributes(bundleLine)).toEqual(expect.arrayContaining(['HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=2592000']));
    expect(valueOf(cookieFrom(res, PLATFORM_BUNDLE_COOKIE)!)).toMatch(/^opbundle_[0-9a-f]{48}$/);
  });

  it('is not re-set when the browser keeps its bundle, and replaced when it gets a new one', async () => {
    const a = address('rot-a');
    const first = await verify(a);
    const bundle = cookieFrom(first, PLATFORM_BUNDLE_COOKIE)!;
    const sessionA = cookieFrom(first, PLATFORM_SESSION_COOKIE)!;

    // Same identity signs in again: same bundle, cookie untouched.
    const again = await verify(a, { cookie: `${sessionA}; ${bundle}` });
    expect(cookieFrom(again, PLATFORM_BUNDLE_COOKIE)).toBeNull();
    const reSession = await db<PlatformSessionRow>(TABLES.PlatformSession)
      .where({ tokenHash: platformSessionTokenHash(valueOf(cookieFrom(again, PLATFORM_SESSION_COOKIE)!)) })
      .first();
    expect(reSession!.bundleId).toBe(sha256(valueOf(bundle)));

    // A different person signs in on this browser: new bundle, new cookie,
    // and the previous identity's sessions are revoked.
    const other = await verify(address('rot-b'), { cookie: `${sessionA}; ${bundle}` });
    const replaced = cookieFrom(other, PLATFORM_BUNDLE_COOKIE)!;
    expect(replaced).not.toBeNull();
    expect(replaced).not.toBe(bundle);
    const live = await db(TABLES.PlatformSession).where({ email: a }).whereNull('revokedAt');
    expect(live).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('the request log', () => {
  it('never records the bundle or platform-session cookie a response sets', async () => {
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
    const token = await platformSigninToken(db, address('log'), false);
    const res = await request(logged).post('/auth/platform-verify').send({ token });
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    const bundle = valueOf(cookieFrom(res, PLATFORM_BUNDLE_COOKIE)!);
    const session = valueOf(cookieFrom(res, PLATFORM_SESSION_COOKIE)!);
    const log = lines.join('');
    expect(log).toContain('/auth/platform-verify');
    expect(log).not.toContain(bundle);
    expect(log).not.toContain(session);
    // Still says which cookies were set.
    expect(log).toContain(`${PLATFORM_BUNDLE_COOKIE}=[REDACTED]`);
    expect(log).toContain(`${PLATFORM_SESSION_COOKIE}=[REDACTED]`);
  });
});

describe.skipIf(skipIntegration)('a browser still holding a pre-hash cookie', () => {
  it('stays signed in, gets a fresh bundle on its next add-account, and signs out cleanly', async () => {
    const a = address('stale-a');
    const signin = await verify(a);
    const sessionA = cookieFrom(signin, PLATFORM_SESSION_COOKIE)!;
    // What the browser holds after the migration deleted its bundle.
    const stale = `${PLATFORM_BUNDLE_COOKIE}=${ulid()}`;

    const me = await request(app).get('/me/workspaces').set('Cookie', `${sessionA}; ${stale}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(a);
    const none = await request(app).get('/me/identities').set('Cookie', `${sessionA}; ${stale}`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ bundleId: null, identities: [] });

    const b = address('stale-b');
    const add = await verify(b, { add: true, cookie: `${sessionA}; ${stale}` });
    const fresh = cookieFrom(add, PLATFORM_BUNDLE_COOKIE)!;
    expect(valueOf(fresh)).toMatch(/^opbundle_[0-9a-f]{48}$/);
    const sessionB = cookieFrom(add, PLATFORM_SESSION_COOKIE)!;
    const listed = await request(app).get('/me/identities').set('Cookie', `${sessionB}; ${fresh}`);
    expect((listed.body.identities as Identity[]).map((i) => i.email)).toEqual([b]);

    const out = await request(app).post('/auth/platform-signout').set('Cookie', `${sessionA}; ${stale}`).send({});
    expect(out.status).toBe(200);
    const cleared = (out.headers['set-cookie'] as unknown as string[]).filter((s) => s.startsWith(`${PLATFORM_BUNDLE_COOKIE}=;`));
    expect(cleared).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('migration 20261020030000_platform_session_bundle_hashed_id', () => {
  it('up() deletes pre-hash bundles and leaves their sessions signed in; down() deletes hashed ones', async () => {
    const migration = (await import(MIGRATION_URL)) as {
      up(knex: Knex): Promise<void>;
      down(knex: Knex): Promise<void>;
    };
    const email = address('migrate');
    const trx = await db.transaction();
    try {
      // A bundle as the old code wrote it: the id is the cookie value.
      const legacyId = ulid();
      await trx(TABLES.PlatformSessionBundle).insert({ id: legacyId });
      const session = await createPlatformSession(trx, email);
      const tokenHash = platformSessionTokenHash(session.plaintext);
      await trx(TABLES.PlatformSession).where({ tokenHash }).update({ bundleId: legacyId });

      await migration.up(trx);

      expect(await trx(TABLES.PlatformSessionBundle).where({ id: legacyId })).toHaveLength(0);
      expect(await trx(TABLES.PlatformSessionBundle)).toHaveLength(0);
      const after = await trx<PlatformSessionRow>(TABLES.PlatformSession).where({ tokenHash }).first();
      expect(after).toMatchObject({ bundleId: null, revokedAt: null });
      expect(after!.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // A bundle written after up() holds a hash, which the pre-hash code
      // would accept as a cookie. down() must not leave it behind.
      const fresh = await createPlatformBundle(trx);
      await trx(TABLES.PlatformSession).where({ tokenHash }).update({ bundleId: fresh.id });

      await migration.down(trx);

      expect(await trx(TABLES.PlatformSessionBundle)).toHaveLength(0);
      const rolledBack = await trx<PlatformSessionRow>(TABLES.PlatformSession).where({ tokenHash }).first();
      expect(rolledBack).toMatchObject({ bundleId: null, revokedAt: null });
    } finally {
      await trx.rollback();
    }
  });
});
