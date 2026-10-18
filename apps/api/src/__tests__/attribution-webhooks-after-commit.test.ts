/**
 * attribution.created and commission.accrued fire only once the transaction
 * that wrote the rows has committed (on-commit.ts).
 *
 * attributeEvent used to dispatch from inside the caller's transaction, so a
 * receiver that fetched the attribution as soon as the webhook arrived could
 * find nothing, or be told about rows that then rolled back. The receiver
 * here checks from a pooled connection of its own, outside every request
 * transaction, whether the rows exist when each webhook lands. The test
 * routes hold the request open after attributing, so a dispatch from inside
 * the transaction would land while the rows are still invisible.
 *
 * Skipped if DATABASE_URL isn't set.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type EventRow } from '@openpartner/db';

const ADMIN_KEY = 'op_test_attr_after_commit_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
// The receiver binds 127.0.0.1; this is the self-host-only escape hatch the
// outbound guard honours on selfhost + single.
process.env.OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS = '127.0.0.1/32,::1/128';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { attributeEvent } = await import('../attribution.js');
const { onCommit } = await import('../on-commit.js');
const { tenantMiddleware, tenantOf, withTenantTransaction } = await import('../tenancy.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const TABLES_TO_CLEAN = [
  TABLES.WebhookDelivery,
  TABLES.WebhookEndpoint,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Program,
  TABLES.Partner,
];

interface Landed {
  event: string;
  /** Was the row this webhook describes visible from outside the request? */
  visible: boolean;
}

let landed: Landed[] = [];
let receiver: { url: string; close: () => Promise<void> } | null = null;

/** Answers every delivery only after looking the described row up from a
 *  separate connection (the privileged pool, not any request transaction). */
function startReceiver(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        const envelope = JSON.parse(body) as { event: string; data: Record<string, string> };
        const row =
          envelope.event === 'attribution.created'
            ? await db(TABLES.Attribution).where({ id: envelope.data.attributionId }).first()
            : envelope.event === 'commission.accrued'
              ? await db(TABLES.Commission).where({ id: envelope.data.commissionId }).first()
              : undefined;
        landed.push({ event: envelope.event, visible: !!row });
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

// A route on the real tenant middleware that records and attributes a
// conversion, then keeps the transaction open before answering, as a slow
// handler would. `fail` answers 500, which rolls the transaction back.
const slowApp = express();
slowApp.use(express.json());
slowApp.use(tenantMiddleware);
slowApp.post('/attribute/:outcome', async (req, res) => {
  const { db: trx, tenantId } = tenantOf(req);
  const event = await insertConversion(trx, tenantId, req.body.clickId);
  if (req.params.outcome === 'savepoint-rollback') {
    // The attribution happens in a savepoint that rolls back; the request
    // itself commits. Nothing it wrote survives, so nothing may be announced.
    await trx
      .transaction(async (sp) => {
        await attributeEvent(sp, event);
        throw new Error('undo the savepoint');
      })
      .catch(() => {});
  } else {
    await attributeEvent(trx, event);
  }
  await new Promise((r) => setTimeout(r, 300));
  if (req.params.outcome === 'fail') return res.status(500).json({ error: 'failed_after_attributing' });
  res.json({ ok: true, eventId: event.id });
});

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
  const hook = await request(app)
    .post('/webhooks')
    .set(admin)
    .send({ url: receiver!.url, events: ['attribution.created', 'commission.accrued'] });
  expect(hook.status).toBe(201);
});

describe.skipIf(skipIntegration)('attribution webhooks fire after commit', () => {
  it('POST /attribution/conversions: both rows are visible from another connection when the webhooks land', async () => {
    const clickId = await seedClick();
    const res = await request(app)
      .post('/attribution/conversions')
      .set(admin)
      .send({ clickId, type: 'invoice_paid', value: 100, externalEventId: `in_${ulid()}` });
    expect(res.status).toBe(200);
    expect(res.body.attribution.status).toBe('attributed');

    await waitForLanded(2);
    expect(landed.sort((a, b) => a.event.localeCompare(b.event))).toEqual([
      { event: 'attribution.created', visible: true },
      { event: 'commission.accrued', visible: true },
    ]);
  });

  it('a slow request: nothing lands until it commits, then the rows are there', async () => {
    const clickId = await seedClick();
    const res = await request(slowApp).post('/attribute/ok').send({ clickId });
    expect(res.status).toBe(200);
    await waitForLanded(2);
    expect(landed.every((l) => l.visible)).toBe(true);
  });

  it('a request that rolls back announces nothing', async () => {
    const clickId = await seedClick();
    const res = await request(slowApp).post('/attribute/fail').send({ clickId });
    expect(res.status).toBe(500);
    await settle();
    expect(landed).toEqual([]);
    expect(await db(TABLES.Attribution).where({ tenantId: DEFAULT_TENANT_ID })).toHaveLength(0);
  });

  it('an attribution in a savepoint that rolls back announces nothing, though the request commits', async () => {
    const clickId = await seedClick();
    const res = await request(slowApp).post('/attribute/savepoint-rollback').send({ clickId });
    expect(res.status).toBe(200);
    await settle();
    expect(landed).toEqual([]);
    expect(await db(TABLES.Event).where({ id: res.body.eventId }).first()).toBeTruthy();
    expect(await db(TABLES.Attribution).where({ eventId: res.body.eventId })).toHaveLength(0);
  });

  it('a transaction of its own (Stripe webhook, scheduler): after its COMMIT, and never after a rollback', async () => {
    const committedClick = await seedClick();
    await withTenantTransaction(DEFAULT_TENANT_ID, async (trx) => {
      await attributeEvent(trx, await insertConversion(trx, DEFAULT_TENANT_ID, committedClick));
      await new Promise((r) => setTimeout(r, 300));
    });
    await waitForLanded(2);
    expect(landed.every((l) => l.visible)).toBe(true);

    landed = [];
    const rolledBackClick = await seedClick();
    await expect(
      withTenantTransaction(DEFAULT_TENANT_ID, async (trx) => {
        await attributeEvent(trx, await insertConversion(trx, DEFAULT_TENANT_ID, rolledBackClick));
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    await settle();
    expect(landed).toEqual([]);
  });
});

describe('onCommit', () => {
  it('runs at once on the bare pool, where the write is already durable', async () => {
    const ran: string[] = [];
    onCommit({ isTransaction: false } as never, 'bare', () => ran.push('bare'));
    await Promise.resolve();
    expect(ran).toEqual(['bare']);
  });

  it('a job that throws is logged and never reaches the caller', async () => {
    expect(() =>
      onCommit({ isTransaction: false } as never, 'throws', () => {
        throw new Error('boom');
      }),
    ).not.toThrow();
  });
});

// -------- helpers --------

/** A 10%-of-value program with one clean click, inserted directly. */
async function seedClick(): Promise<string> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, name: 'P', email: `p-${partnerId}@example.com` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Shop',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 10 }]),
    destinationUrl: 'https://shop.example.com/',
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId: DEFAULT_TENANT_ID, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: DEFAULT_TENANT_ID,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://shop.example.com/',
    ts: new Date(Date.now() - 60_000),
  });
  return clickId;
}

async function insertConversion(trx: typeof db, tenantId: string, clickId: string): Promise<EventRow> {
  const userId = `u-${ulid()}`;
  await trx(TABLES.Identity).insert({ id: ulid(), tenantId, clickId, userId });
  const [event] = (await trx(TABLES.Event)
    .insert({ id: ulid(), tenantId, userId, type: 'invoice_paid', value: '100.00', currency: 'USD', ts: new Date() })
    .returning('*')) as EventRow[];
  return event!;
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
