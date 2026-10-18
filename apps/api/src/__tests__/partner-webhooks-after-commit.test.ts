/**
 * partner.created, partnership.approved and partner.activated fire only once
 * the request transaction that wrote the partner has committed (on-commit.ts).
 *
 * POST /partners and POST /auth/magic/verify used to dispatch from inside the
 * request transaction, so a receiver that fetched GET /partners/{id} as soon
 * as partner.created arrived could get a 404, and a request that rolled back
 * after dispatching still announced the partner. The receiver here checks
 * from a pooled connection of its own, outside every request transaction,
 * whether the partner (or their activation) exists when each webhook lands.
 * The slow app holds each request open after the handler answers, so a
 * dispatch from inside the transaction would land while the row is still
 * invisible.
 *
 * Skipped if DATABASE_URL isn't set.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type PartnerRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_partner_after_commit_0123456789ab';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
// The receiver binds 127.0.0.1; this is the self-host-only escape hatch the
// outbound guard honours on selfhost + single.
process.env.OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS = '127.0.0.1/32,::1/128';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { issueMagicLink } = await import('../auth-sessions.js');
const { tenantMiddleware } = await import('../tenancy.js');
const { partnersRouter } = await import('../routes/partners.js');
const { partnerAuthRouter } = await import('../routes/partner-auth.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const TABLES_TO_CLEAN = [
  TABLES.WebhookDelivery,
  TABLES.WebhookEndpoint,
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.Partner,
];

const EVENTS = ['partner.created', 'partnership.approved', 'partner.activated'];

interface Landed {
  event: string;
  /** Was the partner (for partner.activated, their activation) visible
   *  from outside the request? */
  visible: boolean;
}

let landed: Landed[] = [];
let receiver: { url: string; close: () => Promise<void> } | null = null;

/** Answers every delivery only after looking the partner up from a separate
 *  connection (the privileged pool, not any request transaction). */
function startReceiver(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        const envelope = JSON.parse(body) as { event: string; data: { partnerId: string } };
        const row = await db<PartnerRow>(TABLES.Partner).where({ id: envelope.data.partnerId }).first();
        landed.push({
          event: envelope.event,
          visible: envelope.event === 'partner.activated' ? !!row?.activatedAt : !!row,
        });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        close: () => new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };

// The real routers on the real tenant middleware, with every answer held
// back 300ms after the handler gives it, as a slow handler would.
// ?outcome=fail turns the answer into a 500, which rolls the transaction
// back after the handler has queued its webhooks.
const slowApp = express();
slowApp.use(express.json());
slowApp.use(tenantMiddleware);
slowApp.use((req, res, next) => {
  const answer = res.json.bind(res);
  res.json = ((body: unknown) => {
    setTimeout(() => {
      if (req.query.outcome !== 'fail') return answer(body);
      res.status(500);
      answer({ error: 'failed_after_handler' });
    }, 300);
    return res;
  }) as typeof res.json;
  next();
});
slowApp.use(partnerAuthRouter);
slowApp.use(partnersRouter);

beforeAll(async () => {
  if (skipIntegration) return;
  receiver = await startReceiver();
});

afterAll(async () => {
  if (!skipIntegration) for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
  await receiver?.close();
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  landed = [];
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: DEFAULT_TENANT_ID }).del();
  const hook = await request(app).post('/webhooks').set(admin).send({ url: receiver!.url, events: EVENTS });
  expect(hook.status).toBe(201);
});

// A partner created with sendInvite:false is active at once, so POST /partners
// fires partner.activated for them too (#134); both land after commit.
const byEvent = (a: Landed, b: Landed) => a.event.localeCompare(b.event);

describe.skipIf(skipIntegration)('partner webhooks fire after commit', () => {
  it('POST /partners: the partner is visible from another connection when partner.created lands', async () => {
    const res = await request(app).post('/partners').set(admin).send({ email: 'ada@example.com', name: 'Ada', sendInvite: false });
    expect(res.status).toBe(201);
    await waitForLanded(2);
    expect(landed.sort(byEvent)).toEqual([
      { event: 'partner.activated', visible: true },
      { event: 'partner.created', visible: true },
    ]);
  });

  it('a Network-provisioned partner: partner.created and partnership.approved both land once it is visible', async () => {
    const res = await request(app)
      .post('/partners')
      .set(admin)
      .send({
        email: 'net@example.com',
        name: 'Net',
        sendInvite: false,
        metadata: { source: 'openpartner_network', networkCreatorId: 'cr_1' },
      });
    expect(res.status).toBe(201);
    await waitForLanded(3);
    expect(landed.sort(byEvent)).toEqual([
      { event: 'partner.activated', visible: true },
      { event: 'partner.created', visible: true },
      { event: 'partnership.approved', visible: true },
    ]);
  });

  it('a slow POST /partners: nothing lands until it commits, then the partner is there', async () => {
    const res = await request(slowApp)
      .post('/partners')
      .set(admin)
      .send({ email: 'slow@example.com', name: 'Slow', sendInvite: false, metadata: { source: 'openpartner_network' } });
    expect(res.status).toBe(201);
    await waitForLanded(3);
    expect(landed.every((l) => l.visible)).toBe(true);
  });

  it('a POST /partners that rolls back announces nothing', async () => {
    const res = await request(slowApp)
      .post('/partners?outcome=fail')
      .set(admin)
      .send({ email: 'gone@example.com', name: 'Gone', sendInvite: false, metadata: { source: 'openpartner_network' } });
    expect(res.status).toBe(500);
    await settle();
    expect(landed).toEqual([]);
    expect(await db(TABLES.Partner).where({ tenantId: DEFAULT_TENANT_ID })).toHaveLength(0);
  });

  it('POST /auth/magic/verify: the activation is visible from another connection when partner.activated lands', async () => {
    const token = await invitePendingPartner('invitee@example.com');
    const res = await request(app).post('/auth/magic/verify').send({ token });
    expect(res.status).toBe(200);
    await waitForLanded(1);
    expect(landed).toEqual([{ event: 'partner.activated', visible: true }]);
  });

  it('a slow verify: partner.activated lands only once the activation has committed', async () => {
    const token = await invitePendingPartner('slow-invitee@example.com');
    const res = await request(slowApp).post('/auth/magic/verify').send({ token });
    expect(res.status).toBe(200);
    await waitForLanded(1);
    expect(landed).toEqual([{ event: 'partner.activated', visible: true }]);
  });

  it('a verify that rolls back announces nothing, and the partner stays pending', async () => {
    const token = await invitePendingPartner('undone@example.com');
    const res = await request(slowApp).post('/auth/magic/verify?outcome=fail').send({ token });
    expect(res.status).toBe(500);
    await settle();
    expect(landed).toEqual([]);
    const partner = await db<PartnerRow>(TABLES.Partner).where({ email: 'undone@example.com' }).first();
    expect(partner?.activatedAt).toBeNull();
  });
});

// -------- helpers --------

/** A pending partner, inserted directly, and their invite token. */
async function invitePendingPartner(email: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId: DEFAULT_TENANT_ID, email, name: 'Invitee', metadata: {}, activatedAt: null });
  const link = await issueMagicLink(db, {
    tenantId: DEFAULT_TENANT_ID,
    email,
    purpose: 'partner_invite',
    principalKind: 'partner',
    principalId: id,
  });
  return link.plaintext;
}

async function waitForLanded(count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (landed.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  expect(landed).toHaveLength(count);
}

/** Long enough for a stray dispatch to have reached the receiver. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 500));
}
