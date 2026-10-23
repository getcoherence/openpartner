/**
 * Pay with PayPal (docs/paypal-payouts.md), against a fake PayPal
 * (fake-paypal.ts):
 *
 *   - connecting verifies the credentials, seals the secret and webhook
 *     id, never returns, logs or exports them;
 *   - a send takes exactly the payouts a PayPal file would, stamps them so
 *     no file or other batch can, and posts one batch whose
 *     sender_batch_id and PayPal-Request-Id are the batch id;
 *   - an unknown outcome (timeout, 5xx) is re-sent and reaches the same
 *     batch: nobody is paid twice, whatever crashes or retries;
 *   - a definite refusal frees the payouts only when no earlier attempt
 *     could have landed; past 29 days nothing is re-sent;
 *   - status: paid items confirm with PayPal's ids, failed / returned /
 *     refunded ones go back to pending and admins are emailed, unclaimed
 *     ones wait (or are cancelled, then released);
 *   - webhooks are verified by PayPal against the registered webhook and
 *     the exact bytes, and only prompt a fresh read;
 *   - one tenant's batch, webhook or PayPal listing never touches
 *     another's payouts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Writable } from 'node:stream';
import { ulid } from 'ulid';
import { FakePaypal } from './fake-paypal.js';

const ADMIN_KEY = 'op_test_paypal_payouts_admin_0123456789abcd';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.CSL_API_KEY = '';

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { __setMailerForTests } = await import('../mailer.js');
const { __setPaypalFetchForTests } = await import('../paypal-api.js');
const { decryptSecret } = await import('../crypto.js');
const profiles = await import('../payout-profile.js');
const files = await import('../manual-payout-files.js');
const paypal = await import('../paypal-payouts.js');
const connection = await import('../paypal-connection.js');

const T = DEFAULT_TENANT_ID;
const OTHER = 'paypal-test-other';
const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const CLIENT_ID = 'AbCdEfClientIdForSandbox0123456789';
const SECRET = 'EFGhSecretValueNeverToBeSeen0123456789xyz';

const admin = {
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${ADMIN_KEY}`),
  post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', `Bearer ${ADMIN_KEY}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${ADMIN_KEY}`),
};

let fake: FakePaypal;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const logs: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };

async function partner(name: string, tenantId = T): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId, name, email: `${name.toLowerCase()}-${id.toLowerCase()}@partner.test`, activatedAt: new Date() });
  return id;
}

async function payout(partnerId: string, amount: string, currency: string, runId: string, tenantId = T): Promise<string> {
  const id = ulid();
  await db(TABLES.Payout).insert({ id, tenantId, partnerId, amount, currency, method: 'manual', status: 'pending', metadata: { runId, commissionCount: 1 } });
  return id;
}

async function paypalPartner(name: string, amount: string, runId: string, currency = 'USD', tenantId = T) {
  const partnerId = await partner(name, tenantId);
  const parsed = profiles.parsePayoutDetails({ method: 'paypal', email: `${name.toLowerCase()}@pay.test` });
  if (!parsed.ok) throw new Error('bad fixture');
  await profiles.savePayoutProfile(db, tenantId, partnerId, parsed.details, 'partner');
  return { partnerId, payoutId: await payout(partnerId, amount, currency, runId, tenantId) };
}

async function connect(environment: 'live' | 'sandbox' = 'live') {
  const res = await admin.post('/config/paypal', { environment, clientId: CLIENT_ID, clientSecret: SECRET });
  expect(res.status).toBe(201);
  return res.body.connection as { id: string; active: boolean; webhook: { registered: boolean } };
}

async function payoutRow(id: string) {
  return db(TABLES.Payout).where({ id }).first();
}

const stampOf = (row: { metadata: Record<string, unknown> }) => row.metadata.manualExport as Record<string, unknown> | undefined;

async function cleanup(): Promise<void> {
  await db(TABLES.Payout).whereIn('tenantId', [T, OTHER]).del();
  await db(TABLES.PaypalPayoutBatch).whereIn('tenantId', [T, OTHER]).del();
  await db(TABLES.PaypalConnection).whereIn('tenantId', [T, OTHER]).del();
  await db(TABLES.PartnerPayoutProfile).whereIn('tenantId', [T, OTHER]).del();
  await db(TABLES.Partner).whereIn('tenantId', [T, OTHER]).del();
  await db(TABLES.Admin).whereIn('tenantId', [T, OTHER]).where('email', 'like', '%@paypal-admin.test').del();
  await db(TABLES.Tenant).where({ id: OTHER }).del();
}

beforeAll(async () => {
  if (skipIntegration) return;
  __setMailerForTests({
    async send(_ctx, msg) {
      sent.push({ to: msg.to, subject: msg.subject, text: msg.text });
    },
  });
  // Every console line any test writes, to prove no credential reaches one.
  for (const k of ['log', 'warn', 'error'] as const) {
    console[k] = (...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
});

beforeEach(async () => {
  if (skipIntegration) return;
  await cleanup();
  sent.length = 0;
  fake = new FakePaypal();
  fake.addApp({ env: 'live', clientId: CLIENT_ID, secret: SECRET });
  __setPaypalFetchForTests(fake.fetch);
  process.env.PORTAL_URL = 'https://portal.brand.example';
  await db(TABLES.Admin).insert({ id: ulid(), tenantId: T, email: `ops-${ulid().toLowerCase()}@paypal-admin.test`, name: 'Ops', activatedAt: new Date() });
});

afterEach(() => {
  files.MAX_ROWS.paypal = 5000;
  process.env.OPENPARTNER_TENANCY = 'single';
});

afterAll(async () => {
  Object.assign(console, original);
  // Nothing anywhere in the run printed a credential.
  const all = logs.join('\n');
  expect(all).not.toContain(SECRET);
  expect(all).not.toMatch(/A21AA[0-9a-f]{32}/);
  __setMailerForTests(null);
  __setPaypalFetchForTests(null);
  if (!skipIntegration) await cleanup();
  await db.destroy();
});

// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('connecting PayPal', () => {
  it('verifies with a token call, seals the secret and webhook id, never returns them', async () => {
    const res = await admin.post('/config/paypal', { environment: 'live', clientId: CLIENT_ID, clientSecret: SECRET });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.connection).toMatchObject({
      environment: 'live',
      clientIdPreview: 'AbCdEf…6789',
      payoutsEnabled: true,
      active: true,
      webhook: { registered: true, error: null },
    });

    const row = await db(TABLES.PaypalConnection).where({ id: res.body.connection.id }).first();
    expect(row.clientSecretEnc).not.toContain(SECRET);
    expect(decryptSecret(row.clientSecretEnc)).toBe(SECRET);
    const [hook] = [...fake.webhooks.values()];
    expect(hook!.url).toBe(`https://portal.brand.example/api/webhooks/paypal/${res.body.connection.id}`);
    expect(JSON.stringify(row)).not.toContain(hook!.id);
    expect(decryptSecret(row.webhookIdEnc)).toBe(hook!.id);

    const list = await admin.get('/config/paypal');
    expect(list.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect(list.body.connections).toHaveLength(1);
  });

  it('refuses credentials PayPal refuses, and stores nothing', async () => {
    const res = await admin.post('/config/paypal', { environment: 'live', clientId: CLIENT_ID, clientSecret: 'WrongSecret0123456789' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('credentials_refused');
    expect(await db(TABLES.PaypalConnection).where({ tenantId: T })).toHaveLength(0);
    // Live credentials don't work in sandbox, and the other way round.
    expect((await admin.post('/config/paypal', { environment: 'sandbox', clientId: CLIENT_ID, clientSecret: SECRET })).status).toBe(422);
  });

  it('answers a bad body by naming fields, never echoing values', async () => {
    const res = await admin.post('/config/paypal', { environment: 'sandbox', clientId: CLIENT_ID, clientSecret: 'has spaces and a secret!' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('has spaces');
  });

  it('registers no webhook where PayPal can’t reach the deployment; batches are polled', async () => {
    process.env.PORTAL_URL = 'http://localhost:5673';
    const conn = await connect();
    expect(conn.webhook).toMatchObject({ registered: false, error: expect.stringContaining('public https') });
    expect(fake.webhooks.size).toBe(0);
  });

  it('keeps one environment active, switches only when asked, and disconnects once nothing is in flight', async () => {
    fake.addApp({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET });
    const sandbox = await connect('sandbox');
    const live = await connect('live');
    // The first one connected sends; connecting live later doesn't switch.
    expect(sandbox.active).toBe(true);
    expect(live.active).toBe(false);
    expect((await admin.post('/config/paypal/live/activate')).body.connection.active).toBe(true);
    expect((await db(TABLES.PaypalConnection).where({ id: sandbox.id }).first()).active).toBe(false);

    // A batch in flight pins the live app.
    const runId = ulid();
    await paypalPartner('Ada', '10.00', runId);
    expect((await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' })).body.batch.environment).toBe('live');
    const refused = await admin.delete('/config/paypal/live');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'open_batches', openBatches: 1 });

    // Sandbox has nothing in flight: it goes, webhook and secret with it.
    expect((await admin.delete('/config/paypal/sandbox')).status).toBe(204);
    const gone = await db(TABLES.PaypalConnection).where({ id: sandbox.id }).first();
    expect(gone).toMatchObject({ disconnectReason: 'admin', clientSecretEnc: null, accessTokenEnc: null, webhookIdEnc: null, active: false });
    expect([...fake.webhooks.values()].some((w) => w.url.endsWith(sandbox.id))).toBe(false);
  });

  it('moves in-flight batches to a new secret for the same app, refuses another app’s', async () => {
    const first = await connect();
    const runId = ulid();
    await paypalPartner('Ada', '10.00', runId);
    const sent1 = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    expect(sent1.status).toBe(201);

    const appId = fake.apps[0]!.appId;
    fake.addApp({ env: 'live', clientId: 'OtherAppClientId0123456789', secret: 'OtherSecret0123456789' });
    const other = await admin.post('/config/paypal', { environment: 'live', clientId: 'OtherAppClientId0123456789', clientSecret: 'OtherSecret0123456789' });
    expect(other.status).toBe(409);

    // A rotated secret for the same app.
    fake.apps[0]!.secret = 'RotatedSecret0123456789abc';
    const rotated = await admin.post('/config/paypal', { environment: 'live', clientId: CLIENT_ID, clientSecret: 'RotatedSecret0123456789abc' });
    expect(rotated.status).toBe(201);
    expect(rotated.body.connection).toMatchObject({ appId, active: true, openBatches: 1 });
    const batch = await db(TABLES.PaypalPayoutBatch).where({ id: sent1.body.batch.batchId }).first();
    expect(batch.connectionId).toBe(rotated.body.connection.id);
    expect((await db(TABLES.PaypalConnection).where({ id: first.id }).first()).disconnectReason).toBe('replaced');
  });

  it('leaves the connection and its batches out of every export', async () => {
    await connect();
    const runId = ulid();
    await paypalPartner('Ada', '10.00', runId);
    await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });

    const json = await admin.get('/export.json');
    expect(json.status).toBe(200);
    const text = JSON.stringify(json.body);
    expect(text).not.toContain(SECRET);
    expect(Object.keys(json.body.tables ?? json.body)).not.toEqual(expect.arrayContaining(['PaypalConnection']));
    expect(text).not.toContain('PaypalConnection');
    expect(text).not.toContain('PaypalPayoutBatch');
    const sql = await admin.get('/export.sql');
    expect(sql.text).not.toContain(SECRET);
    expect(sql.text).not.toContain('"PaypalConnection"');
    expect((await admin.get('/export/PaypalConnection.csv')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('sending a run with PayPal', () => {
  it('posts one batch of exactly what a PayPal file would take, and stamps it', async () => {
    await connect();
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    const bob = await paypalPartner('Bob', '25.50', runId);
    const inr = await paypalPartner('Ravi', '1000.00', runId, 'INR');
    const big = await paypalPartner('Big', '60000.01', runId);
    const none = await payout(await partner('NoDetails'), '5.00', 'USD', runId);

    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    expect(res.status).toBe(201);
    const batchId = res.body.batch.batchId;
    expect(res.body.batch).toMatchObject({ state: 'submitted', itemCount: 2, total: '35.50', currency: 'USD', environment: 'live' });

    expect(fake.createCalls).toBe(1);
    const create = fake.seen.find((s) => s.path === '/v1/payments/payouts')!;
    expect(create.requestId).toBe(`openpartner-payout-batch-${batchId}`);
    const body = JSON.parse(create.body!);
    expect(body.sender_batch_header.sender_batch_id).toBe(batchId);
    expect(body.items).toEqual([
      expect.objectContaining({ recipient_type: 'EMAIL', receiver: 'ada@pay.test', amount: { value: '10.00', currency: 'USD' }, sender_item_id: ada.payoutId, purpose: 'SERVICES' }),
      expect.objectContaining({ receiver: 'bob@pay.test', amount: { value: '25.50', currency: 'USD' }, sender_item_id: bob.payoutId }),
    ]);

    for (const id of [ada.payoutId, bob.payoutId]) {
      expect(stampOf(await payoutRow(id))).toMatchObject({ exportId: batchId, provider: 'paypal', via: 'api', payoutBatchId: res.body.batch.payoutBatchId });
    }
    for (const id of [inr.payoutId, big.payoutId, none]) expect(stampOf(await payoutRow(id))).toBeUndefined();

    // Neither a file nor a second batch can take them.
    expect(await files.createManualExport(db, T, runId, 'paypal', 'USD', 'admin')).toBeNull();
    expect((await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' })).status).toBe(404);
    expect(fake.createCalls).toBe(1);

    const run = (await admin.get(`/payouts/runs/${runId}`)).body;
    expect(run).toMatchObject({ inPaypalBatches: 2, exports: [], ready: [] });
    expect(Object.fromEntries(run.excluded.map((e: { reason: string; count: number }) => [e.reason, e.count]))).toEqual({
      currency_not_supported: 1,
      over_paypal_limit: 1,
      no_payout_details: 1,
    });
    const listed = (await admin.get(`/payouts/runs/${runId}/payouts`)).body.payouts.find((p: { payoutId: string }) => p.payoutId === ada.payoutId);
    expect(listed.export).toMatchObject({ exportId: batchId, via: 'api', provider: 'paypal' });

    // The file routes can't reach an API batch.
    expect((await admin.post(`/payouts/exports/${batchId}/discard`)).status).toBe(404);
    expect((await admin.post(`/payouts/exports/${batchId}/confirm`)).status).toBe(404);
    expect((await admin.get(`/payouts/exports/${batchId}.csv`)).status).toBe(404);
    // Nor can marking sent by hand, while PayPal decides.
    const one = await admin.post(`/payouts/${ada.payoutId}/confirm`);
    expect(one.status).toBe(409);
    expect(one.body.reason).toBe('in_paypal_batch');
    const bulk = await admin.post('/payouts/confirm', { payoutIds: [ada.payoutId] });
    expect(bulk.body.notConfirmable).toEqual([expect.objectContaining({ payoutId: ada.payoutId, reason: 'in_paypal_batch' })]);
  });

  it('never releases a restored bundle’s API stamp: it can only be marked sent (finding: orphan discard)', async () => {
    await connect();
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    const batchId = (await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' })).body.batch.batchId as string;
    // Restored elsewhere: the payout keeps its stamp, the batch didn't
    // travel, and PayPal may still pay it.
    await db(TABLES.PaypalPayoutBatch).where({ id: batchId }).del();
    expect((await admin.post(`/payouts/exports/${batchId}/discard`)).status).toBe(404);
    expect(stampOf(await payoutRow(ada.payoutId))).toMatchObject({ exportId: batchId });
    // Checked in PayPal and paid: the admin marks it sent.
    const sent = await admin.post(`/payouts/${ada.payoutId}/confirm`);
    expect(sent.status).toBe(200);
    expect(sent.body.payout.status).toBe('paid');
  });

  it('refuses INR, an unconnected brand, and an empty run', async () => {
    const runId = ulid();
    await paypalPartner('Ravi', '1000.00', runId, 'INR');
    expect((await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' })).body.error).toBe('paypal_not_connected');
    await connect();
    const inr = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'INR' });
    expect(inr.status).toBe(422);
    expect(inr.body.error).toBe('currency_not_supported');
    expect((await admin.post(`/payouts/runs/${ulid()}/paypal-batches`, { currency: 'USD' })).status).toBe(404);
    expect(fake.createCalls).toBe(0);
  });

  it('sends whole units where PayPal takes no decimals, and splits at the batch cap', async () => {
    await connect();
    files.MAX_ROWS.paypal = 2;
    const runId = ulid();
    for (const n of ['A', 'B', 'C']) await paypalPartner(`Huf${n}`, '1000.40', runId, 'HUF');
    const first = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'HUF' });
    const second = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'HUF' });
    expect([first.body.batch.itemCount, second.body.batch.itemCount]).toEqual([2, 1]);
    const bodies = fake.seen.filter((s) => s.path === '/v1/payments/payouts').map((s) => JSON.parse(s.body!));
    expect(bodies[0].items[0].amount).toEqual({ value: '1000', currency: 'HUF' });
    expect(new Set([bodies[0].sender_batch_header.sender_batch_id, bodies[1].sender_batch_header.sender_batch_id]).size).toBe(2);
  });

  it('keeps do-not-pay payouts out, as files do', async () => {
    await connect();
    const runId = ulid();
    const blocked = await paypalPartner('Declared', '10.00', runId);
    const fine = await paypalPartner('Fine', '10.00', runId);
    await db(TABLES.LocationDeclaration).insert({ id: ulid(), subjectKind: 'partner', subjectId: blocked.partnerId, tenantId: T, country: 'IR', source: 'join' });
    process.env.OPENPARTNER_TENANCY = 'multi';
    try {
      const out = await paypal.sendRunWithPaypal(T, runId, 'USD', 'admin');
      expect(out.ok && out.batch.itemCount).toBe(1);
      const body = JSON.parse(fake.seen.find((s) => s.path === '/v1/payments/payouts')!.body!);
      expect(body.items.map((i: { sender_item_id: string }) => i.sender_item_id)).toEqual([fine.payoutId]);
    } finally {
      process.env.OPENPARTNER_TENANCY = 'single';
      await db(TABLES.LocationDeclaration).where({ subjectId: blocked.partnerId }).del();
    }
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('retries never pay twice', () => {
  async function seeded() {
    await connect();
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    const bob = await paypalPartner('Bob', '20.00', runId);
    return { runId, ada, bob };
  }

  it('a timeout after PayPal created the batch: re-sent, same batch, one payment', async () => {
    const { runId } = await seeded();
    fake.faults.create.push('network_after');
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    expect(res.body.batch.state).toBe('posted');
    expect(fake.created).toBe(1);

    // The lease holds off an immediate second worker…
    const early = await paypal.runPaypalPayoutsJob(db);
    expect(early.posted).toEqual([]);
    // …and once it lapses the re-send reaches the batch PayPal made.
    const later = new Date(Date.now() + 3 * 60 * 1000);
    const out = await paypal.runPaypalPayoutsJob(db, { now: () => later });
    expect(out.submitted).toEqual([res.body.batch.batchId]);
    expect(fake.createCalls).toBe(2);
    expect(fake.created).toBe(1);
    const reqIds = fake.seen.filter((s) => s.path === '/v1/payments/payouts').map((s) => s.requestId);
    expect(new Set(reqIds).size).toBe(1);
    const bodies = fake.seen.filter((s) => s.path === '/v1/payments/payouts').map((s) => s.body);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('a 5xx before anything was made: re-sent, made once', async () => {
    const { runId } = await seeded();
    fake.faults.create.push('500_before');
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    expect(res.body.batch).toMatchObject({ state: 'posted', lastError: expect.stringContaining('Outcome unknown') });
    expect(fake.created).toBe(0);
    await paypal.runPaypalPayoutsJob(db, { now: () => new Date(Date.now() + 3 * 60 * 1000) });
    expect(fake.created).toBe(1);
    expect((await paypal.getPaypalBatch(db, T, res.body.batch.batchId))!.state).toBe('submitted');
  });

  it('PayPal forgot the request id: the duplicate sender_batch_id leads back to the batch', async () => {
    const { runId } = await seeded();
    fake.faults.create.push('network_after');
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    fake.forgetRequestIds();
    await paypal.runPaypalPayoutsJob(db, { now: () => new Date(Date.now() + 3 * 60 * 1000) });
    const batch = (await paypal.getPaypalBatch(db, T, res.body.batch.batchId))!;
    expect(batch.state).toBe('submitted');
    expect(batch.payoutBatchId).toBe(fake.batchBySender(res.body.batch.batchId)!.payout_batch_id);
    expect(fake.created).toBe(1);
  });

  it('a refusal on the first send fails the batch and frees its payouts; admins hear why', async () => {
    const { runId, ada } = await seeded();
    fake.faults.create.push({ status: 422, name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds.' });
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    expect(res.body.batch).toMatchObject({ state: 'failed', lastError: expect.stringContaining('INSUFFICIENT_FUNDS'), summary: { released: 2 } });
    const row = await payoutRow(ada.payoutId);
    expect(row.status).toBe('pending');
    expect(stampOf(row)).toBeUndefined();
    expect(row.metadata.paypalReleases).toEqual([expect.objectContaining({ batchId: res.body.batch.batchId, reason: 'not_sent' })]);
    expect(sent.some((m) => m.subject.includes('wasn\'t sent') && m.text.includes('INSUFFICIENT_FUNDS'))).toBe(true);

    // Once topped up, a new batch takes them.
    const again = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    expect(again.body.batch).toMatchObject({ state: 'submitted', itemCount: 2 });
    expect(again.body.batch.batchId).not.toBe(res.body.batch.batchId);
  });

  it('a refusal after an unknown outcome is held for the admin, never released on its own', async () => {
    const { runId, ada } = await seeded();
    fake.faults.create.push('network_before', { status: 422, name: 'VALIDATION_ERROR' });
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    expect(res.body.batch.state).toBe('posted');
    await paypal.runPaypalPayoutsJob(db, { now: () => new Date(Date.now() + 3 * 60 * 1000) });
    const held = (await admin.get(`/payouts/paypal-batches/${res.body.batch.batchId}`)).body.batch;
    expect(held.state).toBe('reconcile_required');
    expect(stampOf(await payoutRow(ada.payoutId))).toMatchObject({ exportId: res.body.batch.batchId });
    expect(sent.some((m) => m.subject.includes('needs you to check it'))).toBe(true);
    expect(await files.createManualExport(db, T, runId, 'paypal', 'USD', 'admin')).toBeNull();

    // The admin checked PayPal: it never went out.
    const released = await admin.post(`/payouts/paypal-batches/${res.body.batch.batchId}/resolve`, { action: 'release' });
    expect(released.body.batch).toMatchObject({ state: 'released' });
    expect(stampOf(await payoutRow(ada.payoutId))).toBeUndefined();
    expect(fake.created).toBe(0);
  });

  it('a held batch the admin finds in PayPal is linked, after checking it is ours', async () => {
    const { runId } = await seeded();
    fake.faults.create.push('network_after', { status: 422, name: 'VALIDATION_ERROR' });
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    fake.forgetRequestIds();
    // PayPal now refuses the re-send outright (a duplicate it can't link).
    fake.faults.create.unshift({ status: 422, name: 'VALIDATION_ERROR' });
    await paypal.runPaypalPayoutsJob(db, { now: () => new Date(Date.now() + 3 * 60 * 1000) });
    const batchId = res.body.batch.batchId;
    expect((await paypal.getPaypalBatch(db, T, batchId))!.state).toBe('reconcile_required');

    const theirs = fake.batchBySender(batchId)!;
    const wrong = await admin.post(`/payouts/paypal-batches/${batchId}/resolve`, { action: 'link', payoutBatchId: 'PBNOTOURS1234' });
    expect(wrong.status).toBe(422);
    const linked = await admin.post(`/payouts/paypal-batches/${batchId}/resolve`, { action: 'link', payoutBatchId: theirs.payout_batch_id });
    expect(linked.body.batch).toMatchObject({ state: 'submitted', payoutBatchId: theirs.payout_batch_id });
    expect(fake.created).toBe(1);
  });

  it('never re-sends past 29 days: held instead', async () => {
    const { runId } = await seeded();
    fake.faults.create.push('network_before');
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    const calls = fake.createCalls;
    const out = await paypal.runPaypalPayoutsJob(db, { now: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
    expect(out.held).toEqual([res.body.batch.batchId]);
    expect(fake.createCalls).toBe(calls);
    const retry = await admin.post(`/payouts/paypal-batches/${res.body.batch.batchId}/resolve`, { action: 'retry' });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe('not_retryable');
  });

  it('a batch committed but never posted (no token yet) goes out once, later', async () => {
    const { runId } = await seeded();
    fake.faults.token.push('network_before');
    // The cached token from connecting would be used; drop it.
    await db(TABLES.PaypalConnection).where({ tenantId: T }).update({ accessTokenEnc: null });
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    expect(res.body.batch.state).toBe('intent');
    expect(fake.createCalls).toBe(0);
    await Promise.all([
      paypal.runPaypalPayoutsJob(db, { now: () => new Date(Date.now() + 3 * 60 * 1000) }),
      paypal.runPaypalPayoutsJob(db, { now: () => new Date(Date.now() + 3 * 60 * 1000) }),
    ]);
    expect(fake.createCalls).toBe(1);
    expect(fake.created).toBe(1);
  });

  it('a refused secret on the first send fails cleanly; nothing reached PayPal', async () => {
    const { runId, ada } = await seeded();
    await db(TABLES.PaypalConnection).where({ tenantId: T }).update({ accessTokenEnc: null });
    fake.apps[0]!.secret = 'RevokedAtPayPal0123456789';
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    expect(res.body.batch).toMatchObject({ state: 'failed', lastError: expect.stringContaining('refused') });
    expect(fake.createCalls).toBe(0);
    expect(stampOf(await payoutRow(ada.payoutId))).toBeUndefined();
    expect((await admin.get('/config/paypal')).body.connections[0].lastError).toContain('refused');
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('following a batch', () => {
  async function submitted() {
    await connect();
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    const bob = await paypalPartner('Bob', '20.00', runId);
    const cy = await paypalPartner('Cy', '30.00', runId);
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    return { runId, ada, bob, cy, batchId: res.body.batch.batchId as string };
  }
  const sync = (batchId: string) => admin.post(`/payouts/paypal-batches/${batchId}/sync`);

  it('confirms paid items with PayPal’s ids, frees failed ones, and tells the admins', async () => {
    const { ada, bob, cy, batchId } = await submitted();
    fake.setItem(batchId, ada.payoutId, 'SUCCESS');
    fake.setItem(batchId, bob.payoutId, 'FAILED', 'RECEIVER_ACCOUNT_LOCKED');
    const res = await sync(batchId);
    expect(res.body.batch).toMatchObject({ state: 'submitted', summary: { paid: 1, released: 1, unclaimed: 0, processing: 1 } });

    const paid = await payoutRow(ada.payoutId);
    const item = fake.batchBySender(batchId)!.items.find((i) => i.sender_item_id === ada.payoutId)!;
    expect(paid.status).toBe('paid');
    expect(paid.completedAt).not.toBeNull();
    expect(stampOf(paid)!.paypal).toMatchObject({ itemId: item.payout_item_id, status: 'SUCCESS', transactionId: item.transaction_id, amount: '10.00' });

    const failed = await payoutRow(bob.payoutId);
    expect(failed.status).toBe('pending');
    expect(stampOf(failed)).toBeUndefined();
    expect(failed.metadata.paypalReleases).toEqual([expect.objectContaining({ reason: 'failed', status: 'FAILED', error: 'RECEIVER_ACCOUNT_LOCKED' })]);
    const mail = sent.find((m) => m.subject.includes("didn't go through"))!;
    expect(mail.text).toContain('Bob');
    expect(mail.text).toContain('RECEIVER_ACCOUNT_LOCKED');
    expect(mail.text).not.toContain('bob@pay.test');

    // A second look changes nothing and emails no one again.
    sent.length = 0;
    await sync(batchId);
    expect(sent).toHaveLength(0);

    fake.setItem(batchId, cy.payoutId, 'SUCCESS');
    fake.setBatchStatus(batchId, 'SUCCESS');
    expect((await sync(batchId)).body.batch).toMatchObject({ state: 'completed', summary: { paid: 2, released: 1 } });
  });

  it('keeps an unclaimed payout in the batch until it is returned or cancelled', async () => {
    const { ada, bob, batchId } = await submitted();
    fake.setItem(batchId, ada.payoutId, 'UNCLAIMED', 'RECEIVER_UNREGISTERED');
    fake.setItem(batchId, bob.payoutId, 'UNCLAIMED', 'RECEIVER_UNREGISTERED');
    const res = await sync(batchId);
    expect(res.body.batch.summary).toMatchObject({ unclaimed: 2 });
    expect(stampOf(await payoutRow(ada.payoutId))).toMatchObject({ paypal: expect.objectContaining({ status: 'UNCLAIMED' }) });
    expect(sent.find((m) => m.text.includes('unclaimed'))).toBeTruthy();
    // Still not confirmable or exportable while PayPal holds the money.
    expect((await admin.post(`/payouts/${ada.payoutId}/confirm`)).status).toBe(409);

    // The admin cancels Ada's: PayPal returns it, the payout is freed.
    const cancel = await admin.post(`/payouts/${ada.payoutId}/paypal-cancel`);
    expect(cancel.body).toMatchObject({ ok: true, released: true, status: 'RETURNED' });
    const row = await payoutRow(ada.payoutId);
    expect(stampOf(row)).toBeUndefined();
    expect(row.metadata.paypalReleases).toEqual([expect.objectContaining({ reason: 'unclaimed_canceled' })]);

    // Bob's is returned by PayPal after 30 days.
    fake.setItem(batchId, bob.payoutId, 'RETURNED');
    await sync(batchId);
    expect(stampOf(await payoutRow(bob.payoutId))).toBeUndefined();
    // Cancelling something that isn't unclaimed is refused.
    expect((await admin.post(`/payouts/${bob.payoutId}/paypal-cancel`)).status).toBe(404);
  });

  it('a claim that beats the cancel follows PayPal', async () => {
    const { ada, batchId } = await submitted();
    fake.setItem(batchId, ada.payoutId, 'UNCLAIMED');
    await sync(batchId);
    fake.setItem(batchId, ada.payoutId, 'SUCCESS');
    const cancel = await admin.post(`/payouts/${ada.payoutId}/paypal-cancel`);
    expect(cancel.body).toMatchObject({ ok: true, released: false, status: 'SUCCESS' });
    expect((await payoutRow(ada.payoutId)).status).toBe('paid');
  });

  it('a paid item later refunded is owed again', async () => {
    const { ada, bob, cy, batchId } = await submitted();
    for (const p of [ada, bob, cy]) fake.setItem(batchId, p.payoutId, 'SUCCESS');
    fake.setBatchStatus(batchId, 'SUCCESS');
    expect((await sync(batchId)).body.batch.state).toBe('completed');
    fake.setItem(batchId, ada.payoutId, 'REFUNDED');
    await sync(batchId);
    const row = await payoutRow(ada.payoutId);
    expect(row).toMatchObject({ status: 'pending', completedAt: null });
    expect(stampOf(row)).toBeUndefined();
    expect((await paypal.getPaypalBatch(db, T, batchId))!.summary).toMatchObject({ paid: 2, released: 1 });
  });

  it('a denied batch frees every payout', async () => {
    const { ada, bob, cy, batchId } = await submitted();
    fake.setBatchStatus(batchId, 'DENIED');
    const res = await sync(batchId);
    expect(res.body.batch).toMatchObject({ state: 'denied', summary: { released: 3 } });
    for (const p of [ada, bob, cy]) expect(stampOf(await payoutRow(p.payoutId))).toBeUndefined();
  });

  it('polls on the schedule and backs off', async () => {
    const { ada, batchId } = await submitted();
    fake.setItem(batchId, ada.payoutId, 'SUCCESS');
    const soon = new Date(Date.now() + 90 * 1000);
    const out = await paypal.runPaypalPayoutsJob(db, { now: () => soon });
    expect(out.synced).toEqual([batchId]);
    expect((await payoutRow(ada.payoutId)).status).toBe('paid');
    const next = (await db(TABLES.PaypalPayoutBatch).where({ id: batchId }).first()).nextSyncAt as Date;
    expect(next.getTime()).toBeGreaterThan(soon.getTime());
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('PayPal webhooks', () => {
  async function ready() {
    const conn = await connect();
    const webhookId = [...fake.webhooks.values()][0]!.id;
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    const batchId = (await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' })).body.batch.batchId as string;
    const pb = fake.batchBySender(batchId)!;
    return { conn, webhookId, ada, batchId, pb };
  }
  const deliver = (connectionId: string, d: { headers: Record<string, string>; body: string }) =>
    request(app).post(`/webhooks/paypal/${connectionId}`).set(d.headers).send(d.body);

  it('a verified event prompts a fresh read; the payload itself is never trusted', async () => {
    const { conn, webhookId, ada, batchId, pb } = await ready();
    fake.setItem(batchId, ada.payoutId, 'SUCCESS');
    // The payload claims FAILED; PayPal's own record says SUCCESS. Odd
    // spacing and escapes prove the exact bytes are what gets verified.
    const body = `{ "event_type" : "PAYMENT.PAYOUTS-ITEM.FAILED", "resource": {"payout_batch_id":"${pb.payout_batch_id}", "transaction_status":"FAILED", "note":"caf\\u00e9"} }`;
    const res = await deliver(conn.id, fake.signDelivery(webhookId, body));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect((await payoutRow(ada.payoutId)).status).toBe('paid');
  });

  it('refuses a bad signature, one signed for another webhook, and a foreign cert host', async () => {
    const { conn, webhookId, ada, batchId, pb } = await ready();
    fake.setItem(batchId, ada.payoutId, 'FAILED');
    const body = JSON.stringify({ event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { batch_header: { payout_batch_id: pb.payout_batch_id } } });

    const tampered = fake.signDelivery(webhookId, body);
    expect((await deliver(conn.id, { ...tampered, body: body.replace('SUCCESS', 'DENIED') })).status).toBe(400);
    expect((await deliver(conn.id, fake.signDelivery('WH-SOMEONEELSES', body))).status).toBe(400);
    const foreign = fake.signDelivery(webhookId, body, { certUrl: 'https://evil.example/cert.pem' });
    expect((await deliver(conn.id, foreign)).body.error).toBe('missing_signature');
    const { 'paypal-transmission-sig': _sig, ...unsigned } = fake.signDelivery(webhookId, body).headers;
    expect((await deliver(conn.id, { headers: unsigned, body })).status).toBe(400);
    // None of them changed anything.
    expect(stampOf(await payoutRow(ada.payoutId))).toMatchObject({ exportId: batchId });
  });

  it('acknowledges events for a gone connection or another batch without acting', async () => {
    const { conn, webhookId } = await ready();
    const other = JSON.stringify({ event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { batch_header: { payout_batch_id: 'PBSOMEONEELSE' } } });
    expect((await deliver(conn.id, fake.signDelivery(webhookId, other))).body).toMatchObject({ skipped: 'unknown_batch' });
    expect((await deliver(ulid(), fake.signDelivery(webhookId, other))).body).toMatchObject({ skipped: 'not_connected' });
    expect((await request(app).post('/webhooks/paypal/not-a-ulid').send('{}')).status).toBe(404);
  });

  it('a batch event naming our own id finds a batch whose POST answer never came', async () => {
    const conn = await connect();
    const webhookId = [...fake.webhooks.values()][0]!.id;
    const runId = ulid();
    await paypalPartner('Ada', '10.00', runId);
    fake.faults.create.push('network_after');
    const batchId = (await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' })).body.batch.batchId as string;
    const pb = fake.batchBySender(batchId)!;
    // Past the lease, PayPal tells us before the next poll does.
    await db(TABLES.PaypalPayoutBatch).where({ id: batchId }).update({ leaseAt: new Date(Date.now() - 10 * 60 * 1000) });
    const body = JSON.stringify({
      event_type: 'PAYMENT.PAYOUTSBATCH.PROCESSING',
      resource: { batch_header: { payout_batch_id: pb.payout_batch_id, sender_batch_header: { sender_batch_id: batchId } } },
    });
    expect((await deliver(conn.id, fake.signDelivery(webhookId, body))).status).toBe(200);
    expect((await paypal.getPaypalBatch(db, T, batchId))!).toMatchObject({ state: 'submitted', payoutBatchId: pb.payout_batch_id });
    expect(fake.created).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe.skipIf(skipIntegration)('review findings', () => {
  it('a sandbox batch is a rehearsal: test money never marks a real payout paid', async () => {
    fake.addApp({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET });
    await connect('sandbox');
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    const bob = await paypalPartner('Bob', '20.00', runId);
    const cy = await paypalPartner('Cy', '30.00', runId);
    const batchId = (await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' })).body.batch.batchId as string;
    fake.setItem(batchId, ada.payoutId, 'SUCCESS');
    fake.setItem(batchId, bob.payoutId, 'UNCLAIMED');
    // Still processing one: nothing released yet, nothing paid.
    await admin.post(`/payouts/paypal-batches/${batchId}/sync`);
    expect((await payoutRow(ada.payoutId)).status).toBe('pending');
    expect(stampOf(await payoutRow(ada.payoutId))).toMatchObject({ exportId: batchId, paypal: expect.objectContaining({ status: 'SUCCESS' }) });

    fake.setItem(batchId, cy.payoutId, 'FAILED');
    const done = (await admin.post(`/payouts/paypal-batches/${batchId}/sync`)).body.batch;
    expect(done).toMatchObject({ state: 'completed', rehearsal: { paid: 1, unclaimed: 1, failed: 1 }, summary: { paid: 0, released: 3 } });
    for (const p of [ada, bob, cy]) {
      const row = await payoutRow(p.payoutId);
      expect(row.status).toBe('pending');
      expect(stampOf(row)).toBeUndefined();
    }
    // A live batch can take them now.
    expect((await paypal.listRunPaypalBatches(db, T, runId))[0]!.environment).toBe('sandbox');
  });

  it('a sandbox batch can be released while still open', async () => {
    fake.addApp({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET });
    await connect('sandbox');
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    const batchId = (await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' })).body.batch.batchId as string;
    const res = await admin.post(`/payouts/paypal-batches/${batchId}/resolve`, { action: 'release' });
    expect(res.body.batch.state).toBe('released');
    expect(stampOf(await payoutRow(ada.payoutId))).toBeUndefined();
  });

  it('PayPal said yes but the answer can’t be read: held as unknown, re-sent, made once (finding: unreadable 2xx)', async () => {
    await connect();
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    fake.faults.create.push('garbled_after');
    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' });
    expect(res.body.batch.state).toBe('posted');
    expect(stampOf(await payoutRow(ada.payoutId))).toMatchObject({ exportId: res.body.batch.batchId });
    await paypal.runPaypalPayoutsJob(db, { now: () => new Date(Date.now() + 3 * 60 * 1000) });
    expect((await paypal.getPaypalBatch(db, T, res.body.batch.batchId))!.state).toBe('submitted');
    expect(fake.created).toBe(1);
  });

  it('a confirm racing a batch that stamps the payout loses (finding: confirm race)', async () => {
    const conn = await connect();
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    // A send, mid-transaction: stamped and its batch written, not committed.
    const trx = await db.transaction();
    const batchId = ulid();
    const stamp = { exportId: batchId, provider: 'paypal', currency: 'USD', at: new Date().toISOString(), by: 'admin', via: 'api' };
    await trx(TABLES.Payout)
      .where({ id: ada.payoutId })
      .update({ metadata: trx.raw(`metadata || jsonb_build_object('manualExport', ?::jsonb)`, [JSON.stringify(stamp)]) });
    await trx(TABLES.PaypalPayoutBatch).insert({
      id: batchId, tenantId: T, connectionId: conn.id, environment: 'live', runId, currency: 'USD', itemCount: 1, total: '10.00', createdBy: 'admin',
    });
    // The confirm reads the payout as unstamped, then waits on its row lock.
    const confirming = files.confirmManualPayouts(db, T, [ada.payoutId]);
    for (let i = 0; i < 200; i += 1) {
      const { rows } = (await db.raw('select count(*)::int as n from pg_locks where not granted')) as { rows: Array<{ n: number }> };
      if (rows[0]!.n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await trx.commit();
    const out = await confirming;
    expect(out.confirmed).toEqual([]);
    expect(out.notConfirmable).toEqual([expect.objectContaining({ payoutId: ada.payoutId, reason: 'in_paypal_batch' })]);
    expect((await payoutRow(ada.payoutId)).status).toBe('pending');
  });

  it('repairs stamps a crash left on an ended batch, however long ago (finding: repair window)', async () => {
    await connect();
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    fake.faults.create.push({ status: 422, name: 'INSUFFICIENT_FUNDS' });
    const batchId = (await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' })).body.batch.batchId as string;
    // As if the process died after failing the batch, before freeing it.
    const stamp = { exportId: batchId, provider: 'paypal', currency: 'USD', at: new Date().toISOString(), by: 'admin', via: 'api' };
    await db(TABLES.Payout)
      .where({ id: ada.payoutId })
      .update({ metadata: db.raw(`metadata || jsonb_build_object('manualExport', ?::jsonb)`, [JSON.stringify(stamp)]) });
    await db(TABLES.PaypalPayoutBatch).where({ id: batchId }).update({ updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });
    const out = await paypal.runPaypalPayoutsJob(db);
    expect(out.repaired).toBe(1);
    expect(stampOf(await payoutRow(ada.payoutId))).toBeUndefined();
  });

  it('keeps reading a finished live batch, so a late refund is caught without webhooks (finding: late refunds)', async () => {
    process.env.PORTAL_URL = 'http://localhost:5673';
    await connect();
    const runId = ulid();
    const ada = await paypalPartner('Ada', '10.00', runId);
    const batchId = (await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD' })).body.batch.batchId as string;
    fake.setItem(batchId, ada.payoutId, 'SUCCESS');
    fake.setBatchStatus(batchId, 'SUCCESS');
    expect((await admin.post(`/payouts/paypal-batches/${batchId}/sync`)).body.batch.state).toBe('completed');
    fake.setItem(batchId, ada.payoutId, 'REFUNDED');
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const out = await paypal.runPaypalPayoutsJob(db, { now: () => tomorrow });
    expect(out.synced).toContain(batchId);
    expect((await payoutRow(ada.payoutId)).status).toBe('pending');
  });
});

describe.skipIf(skipIntegration)('tenant isolation', () => {
  it('one tenant’s batches, webhooks and PayPal listings never touch another’s payouts', async () => {
    await db(TABLES.Tenant).insert({ id: OTHER, slug: OTHER, displayName: 'Other', status: 'active' });
    // Tenant A (default) and tenant B each connect their own app.
    const connA = await connect();
    const hookA = [...fake.webhooks.values()][0]!.id;
    fake.addApp({ env: 'live', clientId: 'TenantBClientId0123456789', secret: 'TenantBSecret0123456789' });
    await connection.connectPaypal(db, OTHER, { environment: 'live', clientId: 'TenantBClientId0123456789', clientSecret: 'TenantBSecret0123456789', adminId: null });

    const runA = ulid();
    const runB = ulid();
    const a = await paypalPartner('Ada', '10.00', runA);
    const b = await paypalPartner('Bea', '10.00', runB, 'USD', OTHER);
    const sentA = await paypal.sendRunWithPaypal(T, runA, 'USD', 'admin');
    const sentB = await paypal.sendRunWithPaypal(OTHER, runB, 'USD', 'admin');
    if (!sentA.ok || !sentB.ok) throw new Error('send failed');
    // B's run isn't A's to send.
    expect((await paypal.sendRunWithPaypal(T, runB, 'USD', 'admin')).ok).toBe(false);

    // PayPal's listing of A's batch names B's payout too (a hostile or
    // confused listing): only A's own payout moves.
    const pbA = fake.batchBySender(sentA.batch.batchId)!;
    pbA.items.push({ ...pbA.items[0]!, payout_item_id: 'PIFOREIGN', sender_item_id: b.payoutId, transaction_status: 'FAILED' });
    fake.setItem(sentA.batch.batchId, a.payoutId, 'SUCCESS');
    await paypal.syncPaypalBatchNow(db, T, sentA.batch.batchId);
    expect((await payoutRow(a.payoutId)).status).toBe('paid');
    expect(stampOf(await payoutRow(b.payoutId))).toMatchObject({ exportId: sentB.batch.batchId });

    // A webhook to A's connection naming B's PayPal batch is ignored.
    const pbB = fake.batchBySender(sentB.batch.batchId)!;
    fake.setItem(sentB.batch.batchId, b.payoutId, 'FAILED');
    const body = JSON.stringify({ event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { batch_header: { payout_batch_id: pbB.payout_batch_id } } });
    const res = await request(app).post(`/webhooks/paypal/${connA.id}`).set(fake.signDelivery(hookA, body).headers).send(body);
    expect(res.body).toMatchObject({ skipped: 'unknown_batch' });
    expect(stampOf(await payoutRow(b.payoutId))).toMatchObject({ exportId: sentB.batch.batchId });

    // A's admin can't see, sync, settle or cancel B's.
    expect((await admin.get(`/payouts/paypal-batches/${sentB.batch.batchId}`)).status).toBe(404);
    expect((await admin.post(`/payouts/paypal-batches/${sentB.batch.batchId}/sync`)).status).toBe(404);
    expect((await admin.post(`/payouts/paypal-batches/${sentB.batch.batchId}/resolve`, { action: 'release' })).status).toBe(404);
    expect((await admin.post(`/payouts/${b.payoutId}/paypal-cancel`)).status).toBe(404);
    expect((await admin.get('/config/paypal')).body.connections).toHaveLength(1);
  });
});

describe('PayPal amounts and limits', () => {
  it('formats API amounts with a point, whole units where PayPal takes none', () => {
    expect(paypal.paypalApiAmount('1234.5', 'EUR')).toBe('1234.50');
    expect(paypal.paypalApiAmount('1000.40', 'JPY')).toBe('1000');
    expect(paypal.paypalApiAmount('10', 'USD')).toBe('10.00');
  });

  it('knows PayPal’s per-item limits', () => {
    expect(files.overPaypalItemLimit('60000.00', 'USD')).toBe(false);
    expect(files.overPaypalItemLimit('60000.01', 'USD')).toBe(true);
    expect(files.overPaypalItemLimit('16000.00', 'EUR')).toBe(false);
    expect(files.overPaypalItemLimit('9999999', 'CNY')).toBe(false);
  });
});

describe('logging', () => {
  it.skipIf(skipIntegration)('the request log never carries the secret', async () => {
    const lines: string[] = [];
    const logged = createApp({
      enableLogger: true,
      logDestination: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }) as unknown as NodeJS.WritableStream,
    } as Parameters<typeof createApp>[0]);
    await request(logged).post('/config/paypal').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ environment: 'live', clientId: CLIENT_ID, clientSecret: SECRET });
    await request(logged).post('/config/paypal').set('Authorization', `Bearer ${ADMIN_KEY}`).send({ environment: 'live', clientId: CLIENT_ID, clientSecret: `${SECRET}!` });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
