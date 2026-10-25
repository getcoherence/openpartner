/**
 * Creator review in the ops console: approve / reject / hold a Network
 * creator, message them, and the ops alert for creators ready for review.
 *
 * The Network owns creators and their review state (its creator-review.ts);
 * these routes forward the operator's decision with their email on the
 * record and the ops inbox as Reply-To, and audit it here. A tiny
 * in-process server stands in for the Network.
 *
 * Skipped when DATABASE_URL is unset, like the rest of the integration suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type PlatformAdminRow } from '@openpartner/db';

process.env.ADMIN_API_KEY = 'op_test_creatorreview_0123456789abcdef01';
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.PLATFORM_OPS_EMAIL = 'ops-inbox@openpartner.test';
delete process.env.NETWORK_URL;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { __setMailerForTests } = await import('../mailer.js');
const { alertOpsToCreatorsAwaitingReview } = await import('../network-creator-review-alert.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import('../platform-admin-sessions.js');
import type { Mailer, Message } from '../mailer.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

class CapturingMailer implements Mailer {
  readonly sent: Message[] = [];
  fail = false;
  async send(_ctx: unknown, msg: Message): Promise<void> {
    if (this.fail) throw new Error('smtp down');
    this.sent.push(msg);
  }
}
let mailer: CapturingMailer;

const createdOperators: string[] = [];
const ALERTED_KEY = 'network_creator_review_alerted';

async function makeOperator(role: 'admin' | 'support'): Promise<{ cookie: string; email: string; id: string }> {
  const admin: PlatformAdminRow = {
    id: ulid(),
    email: `${role}-${ulid().slice(-8).toLowerCase()}@openpartner.test`,
    name: 'Ops',
    role,
    createdAt: new Date(),
    revokedAt: null,
  };
  await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(admin);
  createdOperators.push(admin.id);
  const session = await createPlatformAdminSession(db, admin);
  return { cookie: `${PLATFORM_ADMIN_SESSION_COOKIE}=${session.plaintext}`, email: admin.email, id: admin.id };
}

/** A Network creator row as GET /admin/creators returns it. */
function creator(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id}@creator.test`,
    name: `Creator ${id}`,
    handle: id,
    status: 'active',
    avatarUrl: null,
    bio: null,
    categories: [],
    blockedAt: null,
    blockedReason: null,
    blockedByEmail: null,
    lastSignInAt: null,
    createdAt: '2026-10-25T00:00:00.000Z',
    affiliationCount: 0,
    platformCount: 1,
    profileComplete: true,
    profileMissing: [],
    reviewStatus: 'pending',
    ...over,
  };
}

// ----- fake Network -----
interface NetCall { method: string; path: string; body: unknown }
let netServer: Server;
let netUrl = '';
let netCalls: NetCall[] = [];
/** Answer per call; the default is { ok: true }. */
let netHandler: (call: NetCall) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    netServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const call = {
          method: req.method ?? '',
          path: req.url ?? '',
          body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
        };
        netCalls.push(call);
        const reply = netHandler(call);
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    }).listen(0, '127.0.0.1', () => {
      netUrl = `http://127.0.0.1:${(netServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  mailer = new CapturingMailer();
  __setMailerForTests(mailer);
  netCalls = [];
  netHandler = () => ({ status: 200, body: { ok: true } });
  process.env.NETWORK_URL = netUrl;
  process.env.NETWORK_ADMIN_API_KEY = 'netadm_test_key_0123456789abcdef';
});

afterEach(async () => {
  if (skipIntegration) return;
  delete process.env.NETWORK_URL;
  delete process.env.NETWORK_ADMIN_API_KEY;
  await db(TABLES.PlatformSetting).where({ key: ALERTED_KEY }).del();
  if (createdOperators.length) await db(TABLES.PlatformAuditLog).whereIn('platformAdminId', createdOperators).del();
});

afterAll(async () => {
  __setMailerForTests(null);
  if (netServer) await new Promise<void>((r) => netServer.close(() => r()));
  if (!skipIntegration && createdOperators.length) {
    await db(TABLES.PlatformAuditLog).whereIn('platformAdminId', createdOperators).del();
    await db(TABLES.PlatformAdminSession).whereIn('platformAdminId', createdOperators).del();
    await db(TABLES.PlatformAdmin).whereIn('id', createdOperators).del();
  }
});

// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('GET /platform-admin/creators', () => {
  it('adds pending creators beyond the newest page, once each', async () => {
    const op = await makeOperator('support');
    netHandler = (call) =>
      call.path.includes('review=pending')
        ? { status: 200, body: { creators: [creator('crt_new'), creator('crt_held')] } }
        : { status: 200, body: { creators: [creator('crt_new'), creator('crt_old', { reviewStatus: 'approved' })] } };
    const res = await request(app).get('/platform-admin/creators').set('Cookie', op.cookie);
    expect(res.status).toBe(200);
    expect(res.body.creators.map((c: { id: string }) => c.id)).toEqual(['crt_new', 'crt_old', 'crt_held']);
    expect(netCalls.map((c) => c.path).sort()).toEqual(['/admin/creators?limit=500', '/admin/creators?limit=500&review=pending']);
  });
});

describe.skipIf(skipIntegration)('POST /platform-admin/creators/:id/review', () => {
  it('is for admins, with a valid decision', async () => {
    const support = await makeOperator('support');
    expect((await request(app).post('/platform-admin/creators/crt_1/review').set('Cookie', support.cookie).send({ status: 'approved' })).status).toBe(403);
    const admin = await makeOperator('admin');
    expect((await request(app).post('/platform-admin/creators/crt_1/review').set('Cookie', admin.cookie).send({ status: 'maybe' })).status).toBe(400);
    expect(netCalls).toHaveLength(0);
  });

  it('forwards the decision with the operator and the ops inbox, and audits a change', async () => {
    const admin = await makeOperator('admin');
    netHandler = () => ({ status: 200, body: { ok: true, reviewStatus: 'rejected', changed: true, notified: true } });
    const res = await request(app)
      .post('/platform-admin/creators/crt_1/review')
      .set('Cookie', admin.cookie)
      .send({ status: 'rejected', reason: '  Profile must be in English.  ', notifyCreator: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, reviewStatus: 'rejected', changed: true, notified: true });
    expect(netCalls).toEqual([
      {
        method: 'POST',
        path: '/admin/creators/crt_1/review',
        body: {
          status: 'rejected',
          reason: 'Profile must be in English.',
          reviewedByEmail: admin.email,
          notifyCreator: true,
          replyTo: 'ops-inbox@openpartner.test',
        },
      },
    ]);
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'creator.reject', targetId: 'crt_1' }).first();
    expect(audit?.detail).toEqual({ reason: 'Profile must be in English.', notified: true });
  });

  it('records nothing when the state was already that, and holds with pending', async () => {
    const admin = await makeOperator('admin');
    netHandler = () => ({ status: 200, body: { ok: true, reviewStatus: 'approved', changed: false, notified: false } });
    const same = await request(app).post('/platform-admin/creators/crt_2/review').set('Cookie', admin.cookie).send({ status: 'approved' });
    expect(same.body.changed).toBe(false);
    expect(await db(TABLES.PlatformAuditLog).where({ targetId: 'crt_2' })).toEqual([]);

    netHandler = () => ({ status: 200, body: { ok: true, reviewStatus: 'pending', changed: true, notified: false } });
    await request(app).post('/platform-admin/creators/crt_2/review').set('Cookie', admin.cookie).send({ status: 'pending' });
    expect((netCalls.at(-1)!.body as { notifyCreator: boolean }).notifyCreator).toBe(false);
    expect(await db(TABLES.PlatformAuditLog).where({ action: 'creator.hold', targetId: 'crt_2' }).first()).toBeDefined();
  });

  it('passes on a Network 404, and 502s anything else', async () => {
    const admin = await makeOperator('admin');
    netHandler = () => ({ status: 404, body: { error: 'not_found' } });
    const missing = await request(app).post('/platform-admin/creators/crt_x/review').set('Cookie', admin.cookie).send({ status: 'approved' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
    netHandler = () => ({ status: 500, body: { error: 'boom' } });
    expect((await request(app).post('/platform-admin/creators/crt_x/review').set('Cookie', admin.cookie).send({ status: 'approved' })).status).toBe(502);
  });

  it('503s without NETWORK_URL', async () => {
    const admin = await makeOperator('admin');
    delete process.env.NETWORK_URL;
    const res = await request(app).post('/platform-admin/creators/crt_1/review').set('Cookie', admin.cookie).send({ status: 'approved' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('network_not_configured');
  });
});

describe.skipIf(skipIntegration)('creator messages', () => {
  const MESSAGE = {
    id: 'cmsg_1',
    body: 'Please write your profile in English.',
    sentByEmail: 'x',
    createdAt: '2026-10-25T10:00:00.000Z',
    emailedAt: '2026-10-25T10:00:00.000Z',
    readAt: null,
  };

  it('sends a message as the operator, emailed by default, and audits it', async () => {
    const support = await makeOperator('support');
    expect((await request(app).post('/platform-admin/creators/crt_1/messages').set('Cookie', support.cookie).send({ body: 'hi' })).status).toBe(403);

    const admin = await makeOperator('admin');
    expect((await request(app).post('/platform-admin/creators/crt_1/messages').set('Cookie', admin.cookie).send({ body: '   ' })).status).toBe(400);
    expect((await request(app).post('/platform-admin/creators/crt_1/messages').set('Cookie', admin.cookie).send({ body: 'x'.repeat(2001) })).status).toBe(400);
    expect(netCalls).toHaveLength(0);

    netHandler = () => ({ status: 201, body: { ok: true, message: MESSAGE, emailed: true } });
    const res = await request(app)
      .post('/platform-admin/creators/crt_1/messages')
      .set('Cookie', admin.cookie)
      .send({ body: ' Please write your profile in English. ' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, message: MESSAGE, emailed: true });
    expect(netCalls).toEqual([
      {
        method: 'POST',
        path: '/admin/creators/crt_1/messages',
        body: {
          body: 'Please write your profile in English.',
          sentByEmail: admin.email,
          email: true,
          replyTo: 'ops-inbox@openpartner.test',
        },
      },
    ]);
    const audit = await db(TABLES.PlatformAuditLog).where({ action: 'creator.message', targetId: 'crt_1' }).first();
    expect(audit?.detail).toEqual({ messageId: 'cmsg_1', body: 'Please write your profile in English.', emailed: true });

    await request(app).post('/platform-admin/creators/crt_1/messages').set('Cookie', admin.cookie).send({ body: 'portal only', email: false });
    expect((netCalls.at(-1)!.body as { email: boolean }).email).toBe(false);
  });

  it('passes on a blocked creator, and lets any operator read the history', async () => {
    const admin = await makeOperator('admin');
    netHandler = () => ({ status: 409, body: { error: 'creator_not_active' } });
    const blocked = await request(app).post('/platform-admin/creators/crt_1/messages').set('Cookie', admin.cookie).send({ body: 'hi' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('creator_not_active');
    expect(await db(TABLES.PlatformAuditLog).where({ action: 'creator.message', targetId: 'crt_1' })).toEqual([]);

    const support = await makeOperator('support');
    netHandler = () => ({ status: 200, body: { messages: [MESSAGE] } });
    const list = await request(app).get('/platform-admin/creators/crt_1/messages').set('Cookie', support.cookie);
    expect(list.status).toBe(200);
    expect(list.body.messages).toEqual([MESSAGE]);
    expect(netCalls.at(-1)).toMatchObject({ method: 'GET', path: '/admin/creators/crt_1/messages' });
  });
});

describe.skipIf(skipIntegration)('ops alert for creators ready for review', () => {
  const opsMail = () => mailer.sent.filter((m) => m.tag === 'ops_network_creators_pending');

  it('emails once per creator who finished their profile, never for thin ones', async () => {
    let pending = [
      creator('crt_ready', { name: 'Ada', handle: 'ada' }),
      creator('crt_thin', { profileComplete: false }),
      creator('crt_blocked', { status: 'blocked' }),
    ];
    netHandler = () => ({ status: 200, body: { creators: pending } });

    expect(await alertOpsToCreatorsAwaitingReview()).toEqual({ ready: 1, alerted: 1 });
    expect(netCalls[0]!.path).toBe('/admin/creators?limit=500&review=pending');
    const [mail] = opsMail();
    expect(mail).toMatchObject({ to: 'ops-inbox@openpartner.test', subject: '[Review] Creator Ada (@ada) is waiting' });
    expect(mail!.text).toContain('http://localhost:5673/platform/creators');

    // Still waiting next run: not announced again.
    expect(await alertOpsToCreatorsAwaitingReview()).toEqual({ ready: 1, alerted: 0 });
    expect(opsMail()).toHaveLength(1);

    pending = [...pending, creator('crt_next', { name: 'Grace', handle: 'grace' })];
    expect(await alertOpsToCreatorsAwaitingReview()).toEqual({ ready: 2, alerted: 1 });
    expect(opsMail().at(-1)!.text).toContain('Grace (@grace)');
    expect(opsMail().at(-1)!.text).not.toContain('Ada');
  });

  it('retries next run when the email fails', async () => {
    netHandler = () => ({ status: 200, body: { creators: [creator('crt_ready')] } });
    mailer.fail = true;
    expect(await alertOpsToCreatorsAwaitingReview()).toEqual({ ready: 1, alerted: 0 });
    mailer.fail = false;
    expect(await alertOpsToCreatorsAwaitingReview()).toEqual({ ready: 1, alerted: 1 });
  });

  it('skips a Network that predates the review gate, and runs without one configured', async () => {
    const { reviewStatus: _omit, ...legacy } = creator('crt_legacy');
    netHandler = () => ({ status: 200, body: { creators: [legacy] } });
    expect(await alertOpsToCreatorsAwaitingReview()).toEqual({ skipped: 'network_predates_review_gate', ready: 0, alerted: 0 });
    expect(opsMail()).toEqual([]);

    delete process.env.NETWORK_ADMIN_API_KEY;
    expect((await alertOpsToCreatorsAwaitingReview()).skipped).toBe('network_admin_not_configured');
  });
});
