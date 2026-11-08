/**
 * The audit log (docs/audit-log.md).
 *
 * The coverage test walks every route in the app: each write behind
 * requireAuth needs a label in AUDIT_ACTION_LABELS or a reason in
 * NOT_AUDITED, so a new route fails here until it's classified.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { RequestHandler } from 'express';
import { ulid } from 'ulid';

process.env.OPENPARTNER_TENANCY = 'single';
const ADMIN_KEY = 'op_test_audit_log_0123456789abcdef01234567';
process.env.ADMIN_API_KEY = ADMIN_KEY;

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createSession, issueMagicLink } = await import('../auth-sessions.js');
const { createApiKeyRow } = await import('../auth.js');
const { AUDIT_ACTION_LABELS, AUDITED_READS, NOT_AUDITED } = await import('../audit-log.js');
const { __setMailerForTests } = await import('../mailer.js');
__setMailerForTests({ send: async () => {} });

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const T = DEFAULT_TENANT_ID;

type Handler = RequestHandler & { guard?: string };
interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> };
  name?: string;
  handle?: { stack?: Layer[] };
}
interface RouteInfo {
  key: string;
  method: string;
  auth: boolean;
}

function routesOf(stack: Layer[]): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        const auth = layer.route.stack.some((s) => s.handle.guard === 'requireAuth');
        out.push({ key: `${method.toUpperCase()} ${layer.route.path}`, method, auth });
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

describe('audit log route lists', () => {
  it('classify every write behind requireAuth', () => {
    const unclassified = routes
      .filter((r) => isWrite(r) && r.auth && !(r.key in AUDIT_ACTION_LABELS) && !(r.key in NOT_AUDITED))
      .map((r) => r.key);
    expect(unclassified, 'label these in AUDIT_ACTION_LABELS, or name them in NOT_AUDITED with a reason').toEqual([]);
  });

  it('name only real routes behind requireAuth', () => {
    const gated = new Set(routes.filter((r) => r.auth).map((r) => r.key));
    const events = new Set(['signin']);
    const stale = [...Object.keys(AUDIT_ACTION_LABELS), ...Object.keys(NOT_AUDITED)].filter((k) => !gated.has(k) && !events.has(k));
    expect(stale).toEqual([]);
  });

  it('label every audited read, and never both log and skip a route', () => {
    expect([...AUDITED_READS].filter((k) => !(k in AUDIT_ACTION_LABELS))).toEqual([]);
    expect(Object.keys(NOT_AUDITED).filter((k) => k in AUDIT_ACTION_LABELS)).toEqual([]);
  });
});

const admins: string[] = [];
const programs: string[] = [];
const keys: string[] = [];

async function seat(role: 'admin' | 'viewer', email: string): Promise<{ id: string; cookie: string }> {
  const id = ulid();
  await db(TABLES.Admin).insert({ id, tenantId: T, email, name: email.split('@')[0], role, activatedAt: new Date() });
  admins.push(id);
  const session = await createSession(db, { tenantId: T, principalKind: 'admin', principalId: id });
  return { id, cookie: `op_session=${session.plaintext}` };
}

async function entries(): Promise<Array<Record<string, unknown>>> {
  return db(TABLES.AuditLog).where({ tenantId: T }).orderBy('createdAt', 'desc').orderBy('id', 'desc');
}

async function wipe(): Promise<void> {
  await db(TABLES.AuditLog).where({ tenantId: T }).del();
  if (programs.length) await db(TABLES.Program).whereIn('id', programs).del();
  if (keys.length) await db(TABLES.ApiKey).whereIn('id', keys).del();
  if (admins.length) {
    await db(TABLES.Session).whereIn('principalId', admins).del();
    await db(TABLES.MagicLinkToken).whereIn('principalId', admins).del();
    await db(TABLES.Admin).whereIn('id', admins).del();
  }
  programs.length = 0;
  keys.length = 0;
  admins.length = 0;
}

afterAll(async () => {
  __setMailerForTests(null);
  if (!skipIntegration) await wipe();
  await db.destroy();
});

describe.skipIf(skipIntegration)('the audit log', () => {
  let admin: { id: string; cookie: string };
  let ownerEmail: string;
  const email = () => ownerEmail;

  beforeEach(async () => {
    await wipe();
    ownerEmail = `owner-${ulid().toLowerCase()}@example.com`;
    admin = await seat('admin', ownerEmail);
  });

  async function newProgram(auth: (r: request.Test) => request.Test = (r) => r.set('Cookie', admin.cookie)) {
    const res = await auth(request(app).post('/programs')).send({ name: 'Pro plan', commissionRule: { type: 'percent', value: 20 }, destinationUrl: 'https://example.com/pricing' });
    expect(res.status).toBe(201);
    programs.push(res.body.id);
    return res.body.id as string;
  }

  it("records an admin's change: who, what, which record, and what changed", async () => {
    const id = await newProgram();
    const res = await request(app).patch(`/programs/${id}`).set('Cookie', admin.cookie).send({ name: 'Pro annual' });
    expect(res.status).toBe(200);

    const [update, create] = await entries();
    expect(create).toMatchObject({ action: 'POST /programs', actorKind: 'admin', actorId: admin.id, actorLabel: email(), targetId: id, status: 201 });
    // Field names, never the values.
    expect(create!.fields).toEqual(['commissionRule', 'destinationUrl', 'name']);
    expect(JSON.stringify(create)).not.toContain('Pro plan');
    expect(update).toMatchObject({
      action: 'PATCH /programs/:id',
      targetId: id,
      params: { id },
      fields: ['name'],
      detail: { changes: { name: { from: 'Pro plan', to: 'Pro annual' } } },
    });

    const list = await request(app).get('/audit-log').set('Cookie', admin.cookie);
    expect(list.status).toBe(200);
    expect(list.body.entries[0]).toMatchObject({ label: 'Updated a program', targetName: 'Pro annual', actorLabel: email() });
  });

  it('keeps no entry for a refused write', async () => {
    const bad = await request(app).post('/programs').set('Cookie', admin.cookie).send({ name: '' });
    expect(bad.status).toBe(400);
    expect(await entries()).toEqual([]);
  });

  it('names API keys and the operator key', async () => {
    const key = await createApiKeyRow(db, { tenantId: T, label: 'crm-sync' });
    keys.push(key.id);
    await newProgram((r) => r.set('Authorization', `Bearer ${key.plaintext}`));
    await newProgram((r) => r.set('Authorization', `Bearer ${ADMIN_KEY}`));
    const [operator, apiKey] = await entries();
    expect(apiKey).toMatchObject({ actorKind: 'api_key', actorId: key.id, actorLabel: 'crm-sync' });
    expect(operator).toMatchObject({ actorKind: 'operator_key', actorId: null, actorLabel: null });

    // The filter's choices: who the log names, the operator key aside.
    const actors = await request(app).get('/audit-log/actors').set('Cookie', admin.cookie);
    expect(actors.body).toEqual({ actors: [{ actorId: key.id, actorKind: 'api_key', actorLabel: 'crm-sync' }] });
  });

  it('logs the reads that hand over bulk data, not ordinary ones', async () => {
    expect((await request(app).get('/partners').set('Cookie', admin.cookie)).status).toBe(200);
    expect(await entries()).toEqual([]);
    expect((await request(app).get('/export.json').set('Cookie', admin.cookie)).status).toBe(200);
    expect(await entries()).toMatchObject([{ action: 'GET /export.json', fields: null }]);
  });

  it('skips traffic that is not an admin decision', async () => {
    const res = await request(app).post('/config/mail/test').set('Cookie', admin.cookie).send({});
    expect(res.status).toBe(200);
    expect(await entries()).toEqual([]);
  });

  it('records a sign-in', async () => {
    const link = await issueMagicLink(db, { tenantId: T, email: email(), purpose: 'admin_signin', principalKind: 'admin', principalId: admin.id });
    const res = await request(app).post('/auth/magic/verify').send({ token: link.plaintext });
    expect(res.status).toBe(200);
    expect(await entries()).toMatchObject([{ action: 'signin', actorKind: 'admin', actorId: admin.id, actorLabel: email(), detail: { via: 'link' } }]);
  });

  it('is for full admins: view-only seats are refused', async () => {
    const viewer = await seat('viewer', `viewer-${ulid().toLowerCase()}@example.com`);
    for (const path of ['/audit-log', '/audit-log.csv']) {
      const res = await request(app).get(path).set('Cookie', viewer.cookie);
      expect([path, res.status, res.body.error]).toEqual([path, 403, 'read_only']);
    }
  });

  it('pages newest first and filters', async () => {
    const id = await newProgram();
    for (const name of ['B', 'C', 'D']) {
      await request(app).patch(`/programs/${id}`).set('Cookie', admin.cookie).send({ name });
    }
    const first = await request(app).get('/audit-log?limit=2').set('Cookie', admin.cookie);
    expect(first.body.entries.map((e: { detail: { changes: { name: { to: string } } } }) => e.detail.changes.name.to)).toEqual(['D', 'C']);
    const second = await request(app).get(`/audit-log?limit=2&cursor=${first.body.nextCursor}`).set('Cookie', admin.cookie);
    expect(second.body.entries.map((e: { action: string }) => e.action)).toEqual(['PATCH /programs/:id', 'POST /programs']);
    expect(second.body.nextCursor).toBeNull();

    const creates = await request(app).get('/audit-log?action=POST%20/programs').set('Cookie', admin.cookie);
    expect(creates.body.entries).toHaveLength(1);
  });

  it('downloads as CSV, and the download is itself on record', async () => {
    await newProgram();
    const csv = await request(app).get('/audit-log.csv').set('Cookie', admin.cookie);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Created a program');
    expect((await entries())[0]).toMatchObject({ action: 'GET /audit-log.csv' });
  });

  it('rolls the change back when its entry fails to write, so nothing lands unlogged', async () => {
    const id = await newProgram();
    // The entry's insert fails for this one action, as a broken insert would.
    await db.raw(`create or replace function audit_log_test_refuse() returns trigger language plpgsql as $$
      begin raise exception 'audit insert refused'; end $$`);
    await db.raw(`create trigger audit_log_test_refuse before insert on "AuditLog" for each row
      when (new.action = 'PATCH /programs/:id') execute function audit_log_test_refuse()`);
    try {
      const res = await request(app).patch(`/programs/${id}`).set('Cookie', admin.cookie).send({ name: 'Never' });
      expect(res.status).toBe(500);
    } finally {
      await db.raw('drop trigger if exists audit_log_test_refuse on "AuditLog"');
      await db.raw('drop function if exists audit_log_test_refuse()');
    }
    expect((await db(TABLES.Program).where({ id }).first())?.name).toBe('Pro plan');
    expect((await entries()).map((e) => e.action)).toEqual(['POST /programs']);
  });
});
