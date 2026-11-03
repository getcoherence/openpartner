/**
 * View-only seats (docs/view-only-seats.md).
 *
 * The coverage test walks every route in the app and sends each one a
 * viewer's request: every write behind requireAuth must answer read_only
 * unless VIEWER_ALLOWED_WRITES lets it through, every denied read must
 * too, and every write that doesn't use requireAuth must be named in
 * OPEN_WRITES below with why a viewer's session doesn't reach it. A new
 * route fails here until it's classified.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { RequestHandler } from 'express';
import { ulid } from 'ulid';

process.env.OPENPARTNER_TENANCY = 'single';
const ADMIN_KEY = 'op_test_view_only_0123456789abcdef0123456';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createSession } = await import('../auth-sessions.js');
const { VIEWER_ALLOWED_WRITES, VIEWER_DENIED_READS } = await import('../view-only.js');
const { __setMailerForTests } = await import('../mailer.js');
const mail: Array<{ to: string; subject: string }> = [];
__setMailerForTests({ send: async (_ctx: unknown, m: { to: string; subject: string }) => void mail.push(m) });

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

/** Writes that don't go through requireAuth, and why a viewer's tenant
 *  session isn't what they act on. */
const OPEN_WRITES: Record<string, string> = {
  'POST /webhooks/stripe': 'signed by Stripe',
  'POST /webhooks/stripe-app': 'signed by Stripe',
  'POST /webhooks/paypal/:connectionId': 'verified with PayPal',
  'POST /install': 'first-run install, before any admin exists',
  'POST /install/resend': 'first-run install, before any admin exists',
  'POST /signup': 'public brand signup',
  'POST /booking-claims/preview': 'public storefront claim',
  'POST /booking-claims/signup': 'public storefront claim',
  'POST /signin': 'asks for a sign-in link',
  'POST /auth/platform-verify': 'platform sign-in link',
  'POST /me/brands': "the platform identity's own new brand",
  'POST /workspaces/enter': 'the platform identity enters its own seat',
  'POST /identities/switch': "the platform identity's own sign-ins",
  'DELETE /identities/:sessionId': "the platform identity's own sign-ins",
  'POST /auth/platform-signout': 'signs out',
  'POST /auth/platform-admin-verify': 'ops console, its own operator auth',
  'POST /signin/password': 'platform sign-in',
  'POST /password/forgot': 'platform password reset',
  'POST /password/reset': 'platform password reset',
  'PUT /me/password': "the platform identity's own password",
  'POST /auth/google/creator-signup': 'creator signup',
  'DELETE /auth/google/creator-signup': 'creator signup',
  'POST /email/unsubscribe': 'signed unsubscribe link',
  'POST /auth/signin': 'tenant sign-in',
  'POST /auth/magic/verify': 'tenant sign-in link',
  'POST /auth/signout': 'signs out',
  'POST /auth/signin/password': 'tenant sign-in',
  'POST /auth/password/forgot': 'tenant password reset',
  'POST /auth/password/reset': 'tenant password reset',
  'POST /partner-signup': 'public partner join form',
  'POST /attribution/identify': 'browser SDK, unauthenticated',
  'POST /attribution/landing': 'browser SDK, unauthenticated',
};

/** The ops console: requirePlatformAdmin, with read-only support operators. */
const isOpsConsole = (key: string) => / \/platform-admin\//.test(key);

type Handler = RequestHandler & { guard?: string };
interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> };
  name?: string;
  handle?: { stack?: Layer[] };
}
interface RouteInfo {
  key: string;
  method: string;
  path: string;
  auth: boolean;
}

function routesOf(stack: Layer[]): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        const auth = layer.route.stack.some((s) => s.handle.guard === 'requireAuth');
        out.push({ key: `${method.toUpperCase()} ${layer.route.path}`, method, path: layer.route.path, auth });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...routesOf(layer.handle.stack));
    }
  }
  return out;
}

const app = createApp({ enableLogger: false });
const routes = [
  ...new Map(routesOf((app as unknown as { _router: { stack: Layer[] } })._router.stack).map((r) => [r.key, r])).values(),
];
const isWrite = (r: RouteInfo) => r.method !== 'get' && r.method !== 'head';
/** A concrete URL for a route pattern: every :param becomes "x". */
const urlFor = (path: string) => path.replace(/:[A-Za-z]+/g, 'x');

const admins: string[] = [];

async function seat(role: 'admin' | 'viewer', email: string): Promise<{ id: string; cookie: string }> {
  const id = ulid();
  await db(TABLES.Admin).insert({ id, tenantId: DEFAULT_TENANT_ID, email, name: email.split('@')[0], role, activatedAt: new Date() });
  admins.push(id);
  const session = await createSession(db, { tenantId: DEFAULT_TENANT_ID, principalKind: 'admin', principalId: id });
  return { id, cookie: `op_session=${session.plaintext}` };
}

async function wipe(): Promise<void> {
  if (admins.length === 0) return;
  await db(TABLES.Session).whereIn('principalId', admins).del();
  await db(TABLES.MagicLinkToken).whereIn('principalId', admins).del();
  await db(TABLES.Admin).whereIn('id', admins).del();
  admins.length = 0;
}

afterAll(async () => {
  __setMailerForTests(null);
  if (!skipIntegration) await wipe();
  await db.destroy();
});

describe('view-only route lists', () => {
  it('name only real routes', () => {
    const keys = new Set(routes.map((r) => r.key));
    const stale = [...Object.keys(VIEWER_ALLOWED_WRITES), ...Object.keys(VIEWER_DENIED_READS), ...Object.keys(OPEN_WRITES)].filter(
      (k) => !keys.has(k),
    );
    expect(stale).toEqual([]);
  });

  it('classify every write that skips requireAuth', () => {
    const unclassified = routes
      .filter((r) => isWrite(r) && !r.auth && !(r.key in OPEN_WRITES) && !isOpsConsole(r.key))
      .map((r) => r.key);
    expect(unclassified, 'gate these with requireAuth, or name them in OPEN_WRITES with a reason').toEqual([]);
  });

  it('allow writes and deny reads only behind requireAuth', () => {
    const byKey = new Map(routes.map((r) => [r.key, r]));
    const ungated = [...Object.keys(VIEWER_ALLOWED_WRITES), ...Object.keys(VIEWER_DENIED_READS)].filter((k) => !byKey.get(k)?.auth);
    expect(ungated).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('a viewer', () => {
  let viewer: { id: string; cookie: string };
  let admin: { id: string; cookie: string };

  beforeEach(async () => {
    await wipe();
    admin = await seat('admin', `full-${ulid().toLowerCase()}@example.com`);
    viewer = await seat('viewer', `viewer-${ulid().toLowerCase()}@example.com`);
  });

  it('is refused every write behind requireAuth, except their own account', async () => {
    const wrong: string[] = [];
    for (const r of routes.filter((x) => isWrite(x) && x.auth)) {
      const agent = request(app) as unknown as Record<string, (url: string) => request.Test>;
      const res = await agent[r.method]!(urlFor(r.path)).set('Cookie', viewer.cookie).send({});
      const refused = res.status === 403 && res.body?.error === 'read_only';
      if (refused === r.key in VIEWER_ALLOWED_WRITES) wrong.push(`${r.key} → ${res.status} ${JSON.stringify(res.body)}`);
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it('is refused the reads that hand over credentials or bulk data', async () => {
    const wrong: string[] = [];
    for (const key of Object.keys(VIEWER_DENIED_READS)) {
      const res = await request(app).get(urlFor(key.slice('GET '.length))).set('Cookie', viewer.cookie);
      if (res.status !== 403 || res.body?.error !== 'read_only') wrong.push(`${key} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('reads the admin portal', async () => {
    for (const path of ['/partners', '/programs', '/commissions', '/payouts', '/admins', '/admin/overview', '/api-keys']) {
      const res = await request(app).get(path).set('Cookie', viewer.cookie);
      expect([path, res.status]).toEqual([path, 200]);
    }
    const who = await request(app).get('/auth/whoami').set('Cookie', viewer.cookie);
    expect(who.body).toMatchObject({ role: 'admin', admin: { id: viewer.id, role: 'viewer' } });
    const introspect = await request(app).get('/auth/introspect').set('Cookie', viewer.cookie);
    expect(introspect.body).toEqual({ role: 'admin', unrestricted: false, viewOnly: true });
  });

  it('reaches their own password', async () => {
    // Past the gate to the route's own validation (a real change would
    // leave a platform password behind).
    const res = await request(app).put('/auth/password').set('Cookie', viewer.cookie).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  it('is a full admin again on the next request after a promotion', async () => {
    const promote = await request(app).patch(`/admins/${viewer.id}`).set('Cookie', admin.cookie).send({ role: 'admin' });
    expect(promote.status).toBe(200);
    expect(promote.body.role).toBe('admin');
    const res = await request(app).post('/admins').set('Cookie', viewer.cookie).send({ name: 'Third', email: 'third@example.com' });
    expect(res.status).toBe(201);
    admins.push(res.body.id);
  });

  it('leaves full admins and keys alone', async () => {
    const asAdmin = await request(app).get('/export.json').set('Cookie', admin.cookie);
    expect(asAdmin.status).toBe(200);
    const asKey = await request(app).get('/export.json').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(asKey.status).toBe(200);
  });
});

describe.skipIf(skipIntegration)('seat management', () => {
  beforeEach(wipe);

  it('invites with a role, admin by default', async () => {
    const owner = await seat('admin', 'owner@example.com');
    const viewer = await request(app)
      .post('/admins')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ivy', email: 'ivy@example.com', role: 'viewer' });
    expect(viewer.status).toBe(201);
    expect(viewer.body.role).toBe('viewer');
    expect(mail.find((m) => m.to === 'ivy@example.com')?.subject).toMatch(/^You've been invited to view /);
    admins.push(viewer.body.id);
    const full = await request(app).post('/admins').set('Cookie', owner.cookie).send({ name: 'Al', email: 'al@example.com' });
    expect(full.body.role).toBe('admin');
    admins.push(full.body.id);
    const bad = await request(app)
      .post('/admins')
      .set('Cookie', owner.cookie)
      .send({ name: 'Bo', email: 'bo@example.com', role: 'owner' });
    expect(bad.status).toBe(400);
  });

  it("won't demote or revoke the last full admin, whatever viewers remain", async () => {
    const owner = await seat('admin', 'owner@example.com');
    const other = await seat('admin', 'other@example.com');
    const viewer = await seat('viewer', 'viewer@example.com');

    // The bootstrap key has no seat of its own, so "own role" doesn't apply.
    const key = (r: request.Test) => r.set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect((await key(request(app).patch(`/admins/${other.id}`)).send({ role: 'viewer' })).status).toBe(200);
    const demote = await key(request(app).patch(`/admins/${owner.id}`)).send({ role: 'viewer' });
    expect(demote.status).toBe(409);
    expect(demote.body.error).toBe('cannot_demote_last_active_admin');
    const revoke = await key(request(app).post(`/admins/${owner.id}/revoke`)).send({});
    expect(revoke.status).toBe(409);
    expect(revoke.body.error).toBe('cannot_revoke_last_active_admin');

    // A viewer can always go.
    expect((await key(request(app).post(`/admins/${viewer.id}/revoke`)).send({})).status).toBe(200);
  });

  it("won't let a signed-in admin change their own role", async () => {
    const owner = await seat('admin', 'owner@example.com');
    await seat('admin', 'other@example.com');
    const res = await request(app).patch(`/admins/${owner.id}`).set('Cookie', owner.cookie).send({ role: 'viewer' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_change_own_role');
  });

  it('demotes on the next request, without ending the session', async () => {
    const owner = await seat('admin', 'owner@example.com');
    const other = await seat('admin', 'other@example.com');
    expect((await request(app).patch(`/admins/${other.id}`).set('Cookie', owner.cookie).send({ role: 'viewer' })).status).toBe(200);
    const read = await request(app).get('/partners').set('Cookie', other.cookie);
    expect(read.status).toBe(200);
    const write = await request(app).post('/admins').set('Cookie', other.cookie).send({ name: 'X', email: 'x@example.com' });
    expect(write.status).toBe(403);
    expect(write.body.error).toBe('read_only');
  });

  it("leaves viewers out of the Network's recipients", async () => {
    await seat('admin', 'owner@example.com');
    await seat('viewer', 'viewer@example.com');
    const res = await request(app)
      .post('/network/notify-recipients')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ emails: ['viewer@example.com'] });
    expect(res.body).toEqual({ active: [], fallback: 'owner@example.com' });
  });
});
