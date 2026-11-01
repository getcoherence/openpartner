/**
 * The creator index's mailboxes, openpartner side (openpartner-network
 * docs/creator-index.md §5.5; routes/platform-admin.ts,
 * network-mailbox-alert.ts).
 *
 *   1. Connecting is for platform admins: the Network gets the console's
 *      callback URL and the admin, and the start is audited. Microsoft's
 *      code comes back through the admin's session to the Network with who
 *      completed it; success and failure are audited, and Microsoft's
 *      reason reaches the console.
 *   2. The shared mailbox to send as, and disconnecting, are audited.
 *   3. A lost connection emails every platform admin once per loss.
 *
 * A local HTTP server plays the Network. Skipped without DATABASE_URL.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { TABLES, type PlatformAdminRow } from '@openpartner/db';

const NETWORK_ADMIN = 'netadm_test_mailboxes_0123456789abcdef';
process.env.ADMIN_API_KEY = 'op_test_mailboxes_0123456789abcdef0123';
process.env.OPENPARTNER_MODE = 'revshare';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.NETWORK_ADMIN_API_KEY = NETWORK_ADMIN;

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { __setMailerForTests } = await import('../mailer.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import('../platform-admin-sessions.js');
const { alertAdminsToLostMailboxes } = await import('../network-mailbox-alert.js');
import type { Mailer, Message } from '../mailer.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

class CapturingMailer implements Mailer {
  readonly sent: Message[] = [];
  /** Addresses whose send fails. */
  readonly failing = new Set<string>();
  async send(_ctx: unknown, msg: Message): Promise<void> {
    if (this.failing.has(msg.to)) throw new Error('smtp down');
    this.sent.push(msg);
  }
}
const mail = new CapturingMailer();

interface Call {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown> | null;
}
const calls: Call[] = [];
let network: Server;

const SUFFIX = ulid().slice(-6).toLowerCase();
const ADMIN_EMAIL = `ops-${SUFFIX}@openpartner.test`;
const SECOND_ADMIN = `ops2-${SUFFIX}@openpartner.test`;
const SUPPORT_EMAIL = `support-${SUFFIX}@openpartner.test`;
const REVOKED_EMAIL = `gone-${SUFFIX}@openpartner.test`;
const operatorIds: string[] = [];
const ALERTED_KEY = 'network_mailbox_lost_alerted';

const CONNECTION = {
  status: 'connected',
  account: 'keith@openpartner.test',
  accountName: 'Keith Fawcett',
  sendAs: null,
  sendAsName: null,
  connectedAt: '2026-10-31T12:00:00.000Z',
  connectedByEmail: ADMIN_EMAIL,
  lastRefreshedAt: null,
  lostAt: null,
  lostReason: null,
};
/** What the Network says of the mailboxes, for the alert. */
let mailboxes: Record<string, unknown> = {};

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  __setMailerForTests(mail);
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
        if (req.headers.authorization !== `Bearer ${NETWORK_ADMIN}`) return json(401, { error: 'unauthorized' });
        if (path === '/admin/mailboxes' && req.method === 'GET') return json(200, mailboxes);
        const connect = path.match(/^\/admin\/mailboxes\/(outreach|invite)\/connect$/);
        if (connect && req.method === 'POST') {
          if (body?.sendAs === 'keith@openpartner.test') return json(409, { error: 'same_mailbox' });
          return json(200, { authorizeUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?state=s', expiresAt: '2026-10-31T12:10:00.000Z' });
        }
        if (path === '/admin/mailboxes/connect/complete' && req.method === 'POST') {
          if (body?.code === 'bad') return json(400, { error: 'sign_in_failed', detail: 'AADSTS65004: User declined to consent.' });
          if (body?.code === 'late') return json(400, { error: 'invalid_state' });
          return json(200, {
            kind: 'invite',
            mailbox: { configured: true, from: 'creators@openpartner.test', via: 'microsoft_account', connection: { ...CONNECTION, sendAs: 'creators@openpartner.test' } },
          });
        }
        if (path === '/admin/mailboxes/invite/send-as' && req.method === 'PUT') {
          return json(200, { kind: 'invite', mailbox: { configured: true, from: body?.sendAs, connection: { ...CONNECTION, sendAs: body?.sendAs } } });
        }
        const del = path.match(/^\/admin\/mailboxes\/(outreach|invite)$/);
        if (del && req.method === 'DELETE') return json(200, { kind: del[1], removed: del[1] === 'outreach', mailbox: { configured: false, from: null, connection: null } });
        json(404, { error: 'not_found' });
      });
    }).listen(0, '127.0.0.1', () => {
      process.env.NETWORK_URL = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (!skipIntegration) {
    __setMailerForTests(null);
    await db(TABLES.PlatformAuditLog).whereIn('platformAdminEmail', [ADMIN_EMAIL, SUPPORT_EMAIL]).del();
    for (const id of operatorIds) {
      await db(TABLES.PlatformAdminSession).where({ platformAdminId: id }).del();
      await db(TABLES.PlatformAdmin).where({ id }).del();
    }
    await db(TABLES.PlatformSetting).where({ key: ALERTED_KEY }).del();
  }
  if (network) await new Promise<void>((r) => network.close(() => r()));
  await db.destroy();
});

beforeEach(() => {
  calls.length = 0;
  mail.sent.length = 0;
});

async function operator(email: string, role: 'admin' | 'support', revoked = false): Promise<string> {
  let row = (await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ email }).first()) as PlatformAdminRow | undefined;
  if (!row) {
    row = { id: ulid(), email, name: 'Ops', role, createdAt: new Date(), revokedAt: revoked ? new Date() : null } as PlatformAdminRow;
    await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(row);
    operatorIds.push(row.id);
  }
  const session = await createPlatformAdminSession(db, row);
  return `${PLATFORM_ADMIN_SESSION_COOKIE}=${session.plaintext}`;
}

const last = (path: string) => [...calls].reverse().find((c) => c.path === path);
const audits = (action: string) => db(TABLES.PlatformAuditLog).where({ action, platformAdminEmail: ADMIN_EMAIL }).orderBy('createdAt', 'desc');

describe.skipIf(skipIntegration)('creator index mailboxes: connecting', () => {
  it('starts a sign-in for admins only, with the console’s callback and the admin, audited', async () => {
    const support = await operator(SUPPORT_EMAIL, 'support');
    expect((await request(app).post('/platform-admin/creator-index/mailboxes/invite/connect').set('Cookie', support).send({})).status).toBe(403);
    expect((await request(app).post('/platform-admin/creator-index/mailboxes/invite/connect').send({})).status).toBe(401);
    expect(calls).toHaveLength(0);

    const admin = await operator(ADMIN_EMAIL, 'admin');
    const res = await request(app)
      .post('/platform-admin/creator-index/mailboxes/invite/connect')
      .set('Cookie', admin)
      .send({ sendAs: 'OpenPartner <creators@openpartner.test>' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorizeUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?state=s' });
    const call = last('/admin/mailboxes/invite/connect')!;
    expect(call.auth).toBe(`Bearer ${NETWORK_ADMIN}`);
    expect(call.body).toEqual({
      redirectUri: 'http://localhost:5673/platform/mailboxes/callback',
      startedByEmail: ADMIN_EMAIL,
      sendAs: 'OpenPartner <creators@openpartner.test>',
    });
    const [audit] = await audits('creator_index.mailbox_connect_start');
    expect(audit).toMatchObject({ targetType: 'network_mailbox', targetId: 'invite', detail: { sendAs: 'OpenPartner <creators@openpartner.test>' } });

    // The outreach mailbox may be a shared one too.
    expect((await request(app).post('/platform-admin/creator-index/mailboxes/outreach/connect').set('Cookie', admin).send({ sendAs: 'Jo <jo@openpartner.test>' })).status).toBe(200);
    expect(last('/admin/mailboxes/outreach/connect')!.body).toMatchObject({ sendAs: 'Jo <jo@openpartner.test>' });

    const same = await request(app).post('/platform-admin/creator-index/mailboxes/invite/connect').set('Cookie', admin).send({ sendAs: 'keith@openpartner.test' });
    expect(same.status).toBe(409);
    expect(same.body).toEqual({ error: 'same_mailbox' });
    expect((await request(app).post('/platform-admin/creator-index/mailboxes/keith/connect').set('Cookie', admin).send({})).status).toBe(404);
    expect((await request(app).post('/platform-admin/creator-index/mailboxes/invite/connect').set('Cookie', admin).send({ extra: 1 })).status).toBe(400);
  });

  it('relays Microsoft’s code with the admin who completed it, audits who connected, and passes a refusal back', async () => {
    const support = await operator(SUPPORT_EMAIL, 'support');
    const state = 'state-0123456789abcdef0123456789abcdef';
    expect((await request(app).post('/platform-admin/creator-index/mailboxes/callback').set('Cookie', support).send({ state, code: 'good' })).status).toBe(403);

    const admin = await operator(ADMIN_EMAIL, 'admin');
    const ok = await request(app).post('/platform-admin/creator-index/mailboxes/callback').set('Cookie', admin).send({ state, code: 'good' });
    expect(ok.status).toBe(200);
    expect(ok.body.mailbox.connection).toMatchObject({ account: 'keith@openpartner.test', sendAs: 'creators@openpartner.test' });
    expect(last('/admin/mailboxes/connect/complete')!.body).toEqual({ state, code: 'good', completedByEmail: ADMIN_EMAIL });
    const [connected] = await audits('creator_index.mailbox_connected');
    expect(connected).toMatchObject({ targetId: 'invite', detail: { account: 'keith@openpartner.test', sendAs: 'creators@openpartner.test' } });

    const refused = await request(app).post('/platform-admin/creator-index/mailboxes/callback').set('Cookie', admin).send({ state, code: 'bad' });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'sign_in_failed', detail: 'AADSTS65004: User declined to consent.' });
    const late = await request(app).post('/platform-admin/creator-index/mailboxes/callback').set('Cookie', admin).send({ state, code: 'late' });
    expect(late.body).toEqual({ error: 'invalid_state' });
    const failed = await audits('creator_index.mailbox_connect_failed');
    expect(failed.map((a) => a.detail)).toEqual([
      { error: 'invalid_state', reason: null },
      { error: 'sign_in_failed', reason: 'AADSTS65004: User declined to consent.' },
    ]);
    expect((await request(app).post('/platform-admin/creator-index/mailboxes/callback').set('Cookie', admin).send({ state })).status).toBe(400);
  });

  it('sets the shared mailbox to send as, and disconnects, audited', async () => {
    const admin = await operator(ADMIN_EMAIL, 'admin');
    const put = await request(app).put('/platform-admin/creator-index/mailboxes/invite/send-as').set('Cookie', admin).send({ sendAs: 'creators@openpartner.test' });
    expect(put.status).toBe(200);
    expect(last('/admin/mailboxes/invite/send-as')!.body).toEqual({ sendAs: 'creators@openpartner.test' });
    expect((await audits('creator_index.mailbox_send_as'))[0]).toMatchObject({ targetId: 'invite', detail: { sendAs: 'creators@openpartner.test' } });

    const off = await request(app).delete('/platform-admin/creator-index/mailboxes/outreach').set('Cookie', admin);
    expect(off.body).toMatchObject({ kind: 'outreach', removed: true });
    expect(await audits('creator_index.mailbox_disconnect')).toHaveLength(1);
    // Nothing to disconnect: nothing audited.
    await request(app).delete('/platform-admin/creator-index/mailboxes/invite').set('Cookie', admin);
    expect(await audits('creator_index.mailbox_disconnect')).toHaveLength(1);

    const support = await operator(SUPPORT_EMAIL, 'support');
    expect((await request(app).delete('/platform-admin/creator-index/mailboxes/outreach').set('Cookie', support)).status).toBe(403);
  });
});

describe.skipIf(skipIntegration)('creator index mailboxes: a lost connection', () => {
  const lost = (lostAt: string) => ({
    oauthAvailable: true,
    outreach: { configured: false, from: null, via: null, connection: { ...CONNECTION, status: 'lost', lostAt, lostReason: 'AADSTS50173: The provided grant has expired due to it being revoked.' } },
    invite: { configured: true, from: 'creators@openpartner.test', via: 'microsoft_account', connection: { ...CONNECTION, sendAs: 'creators@openpartner.test' } },
  });
  const ours = () => mail.sent.filter((m) => [ADMIN_EMAIL, SECOND_ADMIN, SUPPORT_EMAIL, REVOKED_EMAIL].includes(m.to));

  it('emails every platform admin once per loss', async () => {
    await operator(ADMIN_EMAIL, 'admin');
    await operator(SECOND_ADMIN, 'admin');
    await operator(SUPPORT_EMAIL, 'support');
    await operator(REVOKED_EMAIL, 'admin', true);
    await db(TABLES.PlatformSetting).where({ key: ALERTED_KEY }).del();

    mailboxes = { oauthAvailable: true, outreach: { configured: true, from: 'keith@openpartner.test', connection: CONNECTION }, invite: { configured: false, from: null, connection: null } };
    expect(await alertAdminsToLostMailboxes()).toEqual({ lost: [], alerted: [] });
    expect(ours()).toHaveLength(0);

    mailboxes = lost('2026-11-02T08:00:00.000Z');
    expect(await alertAdminsToLostMailboxes()).toEqual({ lost: ['outreach'], alerted: ['outreach'] });
    expect(ours().map((m) => m.to).sort()).toEqual([ADMIN_EMAIL, SECOND_ADMIN].sort());
    const [first] = ours();
    expect(first!.subject).toBe('[Action] Reconnect the outreach email mailbox');
    expect(first!.text).toContain('keith@openpartner.test');
    expect(first!.text).toContain('AADSTS50173');
    expect(first!.text).toContain('http://localhost:5673/platform/creator-index');

    // Still lost next run: not again.
    expect(await alertAdminsToLostMailboxes()).toEqual({ lost: ['outreach'], alerted: [] });
    expect(ours()).toHaveLength(2);

    // Reconnected, then lost again: a new loss, a new email.
    mailboxes = lost('2026-12-20T08:00:00.000Z');
    expect((await alertAdminsToLostMailboxes()).alerted).toEqual(['outreach']);
    expect(ours()).toHaveLength(4);
  });

  it('tries an admin whose email failed again, and only them', async () => {
    await operator(ADMIN_EMAIL, 'admin');
    await operator(SECOND_ADMIN, 'admin');
    await db(TABLES.PlatformSetting).where({ key: ALERTED_KEY }).del();
    mailboxes = lost('2027-01-05T08:00:00.000Z');
    mail.failing.add(SECOND_ADMIN);
    try {
      expect((await alertAdminsToLostMailboxes()).alerted).toEqual(['outreach']);
      expect(ours().map((m) => m.to)).toEqual([ADMIN_EMAIL]);
    } finally {
      mail.failing.clear();
    }
    expect((await alertAdminsToLostMailboxes()).alerted).toEqual(['outreach']);
    expect(ours().map((m) => m.to)).toEqual([ADMIN_EMAIL, SECOND_ADMIN]);
    expect((await alertAdminsToLostMailboxes()).alerted).toEqual([]);
    expect(ours()).toHaveLength(2);
  });
});
