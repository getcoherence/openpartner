/**
 * Balances PayPal can't send (paypal-send-as.ts, docs/paypal-payouts.md),
 * against the fake PayPal and a stubbed ECB feed:
 *
 *   - the `paypal_payouts` setting is off by default, keeps INR out of
 *     PayPal until it's on, and travels in the export;
 *   - a quote reads the ECB rate (fails closed), rounds each payout on its
 *     own, and signs what it showed for 15 minutes;
 *   - a send freezes exactly the quoted rate into the batch and each
 *     payout's stamp, whatever the ECB says by then, and refuses an
 *     expired, forged or stale quote (changed payouts, PayPal accounts or
 *     PayPal app; a release that lands while the send waits on the row;
 *     a wait that outlasts the quote);
 *   - PayPal's limit applies to the USD amount;
 *   - the ledger stays in INR, and the partner's payout views show both;
 *   - a released payout is re-quoted; a sandbox batch is still a rehearsal.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { FakePaypal } from './fake-paypal.js';
import { ECB_DATE, ecbXml, stubEcbFetch, type EcbStub } from './ecb-fixture.js';

const ADMIN_KEY = 'op_test_paypal_send_as_admin_0123456789abc';
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
const { createSession } = await import('../auth-sessions.js');
const profiles = await import('../payout-profile.js');
const paypal = await import('../paypal-payouts.js');
const sendAs = await import('../paypal-send-as.js');

const T = DEFAULT_TENANT_ID;
const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const CLIENT_ID = 'SendAsClientIdForTests0123456789';
const SECRET = 'SendAsSecretValueNeverSeen0123456789xyz';
/** The fixture feed: 1 EUR = 1.10 USD = 88 INR, so 1 INR = 0.0125 USD. */
const RATE = '0.0125';
/** The next day's feed, with a rate that doesn't come out even. */
const NEXT_DATE = '2026-10-22';
const NEXT_XML = ecbXml(NEXT_DATE, { USD: '1.1612', JPY: '170.11', INR: '97.0995' });
const NEXT_RATE = '0.011958866935';

const admin = {
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${ADMIN_KEY}`),
  post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', `Bearer ${ADMIN_KEY}`).send(body),
};

let fake: FakePaypal;
let ecb: EcbStub;

async function partner(name: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId: T, name, email: `${name.toLowerCase()}-${id.toLowerCase()}@partner.test`, activatedAt: new Date() });
  return id;
}

async function paypalPartner(name: string, amount: string, runId: string, currency = 'INR') {
  const partnerId = await partner(name);
  const parsed = profiles.parsePayoutDetails({ method: 'paypal', email: `${name.toLowerCase()}@pay.test` });
  if (!parsed.ok) throw new Error('bad fixture');
  await profiles.savePayoutProfile(db, T, partnerId, parsed.details, 'partner');
  const payoutId = ulid();
  await db(TABLES.Payout).insert({ id: payoutId, tenantId: T, partnerId, amount, currency, method: 'manual', status: 'pending', metadata: { runId, commissionCount: 1 } });
  return { partnerId, payoutId };
}

async function connect(environment: 'live' | 'sandbox' = 'live') {
  const res = await admin.post('/config/paypal', { environment, clientId: CLIENT_ID, clientSecret: SECRET });
  expect(res.status).toBe(201);
}

async function turnOn() {
  const res = await admin.post('/config/paypal-payouts', { sendUnsupportedAs: 'USD' });
  expect(res.status).toBe(200);
}

async function quote(runId: string) {
  const res = await admin.post(`/payouts/runs/${runId}/paypal-batches/quote`, { currency: 'INR', sendAs: 'USD' });
  expect(res.status).toBe(200);
  return res.body.quote as {
    quoteId: string;
    rate: string;
    rateDate: string;
    quotedAt: string;
    expiresAt: string;
    count: number;
    sourceTotal: string;
    sentTotal: string;
    items: Array<{ payoutId: string; amount: string; sentAmount: string; partnerName: string }>;
    leftOut: Array<{ payoutId: string; sentAmount: string; reason: string }>;
  };
}

const send = (runId: string, quoteId: string) => admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'INR', sendAs: 'USD', quoteId });

async function payoutRow(id: string) {
  return db(TABLES.Payout).where({ id }).first();
}

const stampOf = (row: { metadata: Record<string, unknown> }) => row.metadata.manualExport as Record<string, unknown> | undefined;
const createBodies = () => fake.seen.filter((s) => s.path === '/v1/payments/payouts').map((s) => JSON.parse(s.body!));

async function cleanup(): Promise<void> {
  await db(TABLES.Payout).where({ tenantId: T }).del();
  await db(TABLES.PaypalPayoutBatch).where({ tenantId: T }).del();
  await db(TABLES.PaypalConnection).where({ tenantId: T }).del();
  await db(TABLES.PartnerPayoutProfile).where({ tenantId: T }).del();
  await db(TABLES.Session).where({ tenantId: T, principalKind: 'partner' }).del();
  await db(TABLES.Partner).where({ tenantId: T }).del();
  await db(TABLES.Config).where({ tenantId: T, key: 'paypal_payouts' }).del();
}

beforeAll(() => {
  if (skipIntegration) return;
  __setMailerForTests({ async send() {} });
});

beforeEach(async () => {
  if (skipIntegration) return;
  await cleanup();
  fake = new FakePaypal();
  fake.addApp({ env: 'live', clientId: CLIENT_ID, secret: SECRET });
  fake.addApp({ env: 'sandbox', clientId: CLIENT_ID, secret: SECRET });
  __setPaypalFetchForTests(fake.fetch);
  process.env.PORTAL_URL = 'http://localhost:5673';
  ecb = stubEcbFetch('ok');
});

afterEach(() => {
  ecb?.restore();
});

afterAll(async () => {
  __setMailerForTests(null);
  __setPaypalFetchForTests(null);
  if (!skipIntegration) await cleanup();
  await db.destroy();
});

// ---------------------------------------------------------------------------

describe('conversion arithmetic', () => {
  it('rounds each amount half up to the cent, exactly, from the rate string', () => {
    expect(sendAs.formatRate(1.1 / 88)).toBe(RATE);
    expect(sendAs.formatRate(1.1612 / 97.0995)).toBe(NEXT_RATE);
    expect(sendAs.convertAmount('1500.00', RATE, 'USD')).toBe('18.75');
    expect(sendAs.convertAmount('1.00', RATE, 'USD')).toBe('0.01'); // 1.25¢
    expect(sendAs.convertAmount('2.00', RATE, 'USD')).toBe('0.03'); // 2.5¢, half up
    expect(sendAs.convertAmount('0.39', RATE, 'USD')).toBe('0.00');
    expect(sendAs.convertAmount('1500.00', NEXT_RATE, 'USD')).toBe('17.94');
    expect(sendAs.convertAmount('99999999.99', NEXT_RATE, 'USD')).toBe('1195886.69');
    // Whole units where PayPal takes no decimals.
    expect(sendAs.convertAmount('1000.00', '1.234', 'JPY')).toBe('1234.00');
    expect(sendAs.formatRateDate('2026-10-22')).toBe('22 Oct 2026');
  });
});

describe.skipIf(skipIntegration)('the setting', () => {
  it('is off by default, keeps INR out of PayPal until turned on, and travels in the export', async () => {
    expect((await admin.get('/config/paypal-payouts')).body).toEqual({ sendUnsupportedAs: null });
    const runId = ulid();
    const { payoutId } = await paypalPartner('Ravi', '1500.00', runId);

    const off = await admin.get(`/payouts/runs/${runId}`);
    expect(off.body.ready).toEqual([]);
    expect(off.body.excluded).toEqual([{ reason: 'currency_not_supported', count: 1 }]);

    await turnOn();
    expect((await admin.get('/config/paypal-payouts')).body).toEqual({ sendUnsupportedAs: 'USD' });
    const on = await admin.get(`/payouts/runs/${runId}`);
    expect(on.body.ready).toEqual([{ provider: 'paypal', currency: 'INR', sendAs: 'USD', count: 1, total: '1500.00' }]);
    expect(on.body.excluded).toEqual([]);
    const page = await admin.get(`/payouts/runs/${runId}/payouts`);
    expect(page.body.payouts[0]).toMatchObject({ payoutId, ready: 'paypal', sendAs: 'USD', excluded: null });

    // No file can convert: the PayPal file still won't take INR.
    const file = await admin.post(`/payouts/runs/${runId}/exports`, { provider: 'paypal', currency: 'INR' });
    expect(file.status).toBe(404);
    expect(stampOf(await payoutRow(payoutId))).toBeUndefined();

    const bundle = await admin.get('/export.json');
    const config = (bundle.body.Config ?? bundle.body.tables?.Config) as Array<{ key: string; value: unknown }>;
    expect(config.find((c) => c.key === 'paypal_payouts')?.value).toEqual({ sendUnsupportedAs: 'USD' });

    expect((await admin.post('/config/paypal-payouts', { sendUnsupportedAs: 'EUR' })).status).toBe(400);
    expect((await admin.post('/config/paypal-payouts', {})).body).toEqual({ sendUnsupportedAs: 'USD' });
    expect((await admin.post('/config/paypal-payouts', { sendUnsupportedAs: null })).body).toEqual({ sendUnsupportedAs: null });
    expect((await admin.get(`/payouts/runs/${runId}`)).body.excluded).toEqual([{ reason: 'currency_not_supported', count: 1 }]);
  });
});

describe.skipIf(skipIntegration)('quoting', () => {
  it('quotes the ECB rate, each payout rounded on its own, both totals, signed for 15 minutes; holds nothing', async () => {
    await connect();
    await turnOn();
    const runId = ulid();
    const ones = [];
    for (const n of ['A', 'B', 'C', 'D']) ones.push(await paypalPartner(`One${n}`, '1.00', runId));
    const two = await paypalPartner('Two', '2.00', runId);
    const big = await paypalPartner('Big', '1500.00', runId);

    const res = await admin.post(`/payouts/runs/${runId}/paypal-batches/quote`, { currency: 'INR', sendAs: 'USD' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const q = res.body.quote;
    expect(q).toMatchObject({ runId, currency: 'INR', sendAs: 'USD', rate: RATE, rateSource: 'ecb', rateDate: ECB_DATE, count: 6, sourceTotal: '1506.00', leftOut: [] });
    const sent = new Map(q.items.map((i: { payoutId: string; sentAmount: string }) => [i.payoutId, i.sentAmount]));
    for (const o of ones) expect(sent.get(o.payoutId)).toBe('0.01');
    expect(sent.get(two.payoutId)).toBe('0.03');
    expect(sent.get(big.payoutId)).toBe('18.75');
    // What PayPal sends is the sum of the rounded items, not the rounded
    // total: 1,506 × 0.0125 = 18.825 would be 18.83.
    expect(q.sentTotal).toBe('18.82');
    const bigItem = q.items.find((i: { payoutId: string }) => i.payoutId === big.payoutId);
    expect(bigItem.partnerName).toBe('Big');
    // Where it goes, masked: the quote id itself carries only a digest.
    expect(bigItem.destination).toMatch(/^PayPal b.*@pay\.test$/);
    expect(bigItem.destination).not.toContain('big@');
    expect(Buffer.from(q.quoteId.split('.')[0], 'base64url').toString('utf8')).not.toContain('@');
    expect(Date.parse(q.expiresAt) - Date.parse(q.quotedAt)).toBe(15 * 60 * 1000);

    // Nothing stamped, nothing sent.
    expect(stampOf(await payoutRow(big.payoutId))).toBeUndefined();
    expect(await db(TABLES.PaypalPayoutBatch).where({ tenantId: T })).toHaveLength(0);
    expect(fake.createCalls).toBe(0);
  });

  it('refuses without the setting or PayPal, for a currency PayPal sends, and when the ECB can’t be read', async () => {
    const runId = ulid();
    const { payoutId } = await paypalPartner('Ravi', '1500.00', runId);
    const ask = (body: object = { currency: 'INR', sendAs: 'USD' }) => admin.post(`/payouts/runs/${runId}/paypal-batches/quote`, body);

    expect((await ask()).body.error).toBe('conversion_not_enabled');
    await turnOn();
    expect((await ask()).body.error).toBe('paypal_not_connected');
    await connect();
    const usd = await ask({ currency: 'USD', sendAs: 'USD' });
    expect([usd.status, usd.body.error]).toEqual([422, 'conversion_not_needed']);
    const aed = await ask({ currency: 'AED', sendAs: 'USD' });
    expect([aed.status, aed.body.error]).toEqual([422, 'currency_not_supported']);
    expect((await ask({ currency: 'INR', sendAs: 'EUR' })).status).toBe(400);

    // Fails closed: no rate, no quote.
    ecb.serve('down');
    const down = await ask();
    expect([down.status, down.body.error]).toEqual([503, 'fx_unavailable']);
    ecb.serve('500');
    expect((await ask()).status).toBe(503);
    ecb.serve(ecbXml(NEXT_DATE, { USD: '1.1612' })); // no INR that day
    const noInr = await ask();
    expect([noInr.status, noInr.body.error]).toEqual([503, 'fx_unavailable']);
    expect(stampOf(await payoutRow(payoutId))).toBeUndefined();

    ecb.serve(NEXT_XML);
    expect((await ask()).body.quote.rate).toBe(NEXT_RATE);
    expect((await admin.post(`/payouts/runs/${ulid()}/paypal-batches/quote`, { currency: 'INR', sendAs: 'USD' })).status).toBe(404);
  });

  it('checks PayPal’s per-payment limit on the USD amount, and leaves out what isn’t a cent', async () => {
    await connect();
    await turnOn();
    const runId = ulid();
    const atLimit = await paypalPartner('AtLimit', '4800000.00', runId); // $60,000.00
    const over = await paypalPartner('Over', '4800001.00', runId); // $60,000.01
    const tiny = await paypalPartner('Tiny', '0.39', runId); // $0.0049
    const q = await quote(runId);
    expect(q.items.map((i) => [i.payoutId, i.sentAmount])).toEqual([[atLimit.payoutId, '60000.00']]);
    expect(q.leftOut).toEqual([
      expect.objectContaining({ payoutId: over.payoutId, sentAmount: '60000.01', reason: 'over_paypal_limit' }),
      expect.objectContaining({ payoutId: tiny.payoutId, sentAmount: '0.00', reason: 'below_minimum' }),
    ]);

    const res = await send(runId, q.quoteId);
    expect(res.status).toBe(201);
    expect(res.body.batch).toMatchObject({ itemCount: 1, total: '60000.00', currency: 'USD' });
    expect(stampOf(await payoutRow(over.payoutId))).toBeUndefined();
    expect(stampOf(await payoutRow(tiny.payoutId))).toBeUndefined();

    // When every payout is left out, the 404 says why, with the list.
    const none = await admin.post(`/payouts/runs/${runId}/paypal-batches/quote`, { currency: 'INR', sendAs: 'USD' });
    expect([none.status, none.body.error]).toEqual([404, 'nothing_to_send']);
    expect(none.body.detail).toBe('None of these payouts can go through PayPal at this rate: 1 is over PayPal’s per-payment limit in USD, and 1 is under a cent in USD. Pay them another way.');
    expect(none.body.leftOut.map((l: { payoutId: string; reason: string }) => [l.payoutId, l.reason])).toEqual([
      [over.payoutId, 'over_paypal_limit'],
      [tiny.payoutId, 'below_minimum'],
    ]);
  });
});

describe.skipIf(skipIntegration)('sending at the quoted rate', () => {
  it('freezes the quoted rate into the batch and each payout, whatever the ECB says by then; the ledger stays INR', async () => {
    await connect();
    await turnOn();
    const runId = ulid();
    const ravi = await paypalPartner('Ravi', '1500.00', runId);
    const asha = await paypalPartner('Asha', '1234.56', runId);
    const q = await quote(runId);
    expect(q.sentTotal).toBe('34.18'); // 18.75 + 15.43 (15.432)

    // The next day's rate is out before the brand presses send.
    ecb.serve(NEXT_XML);
    fake.faults.create.push('network_after');
    const res = await send(runId, q.quoteId);
    expect(res.status).toBe(201);
    const batch = res.body.batch;
    expect(batch).toMatchObject({
      currency: 'USD',
      itemCount: 2,
      total: '34.18',
      state: 'posted',
      conversion: { sourceCurrency: 'INR', sourceTotal: '2734.56', rate: RATE, rateSource: 'ecb', rateDate: ECB_DATE, quotedAt: q.quotedAt },
    });
    // Sending never read the ECB: the quote's rate is the rate.
    expect(ecb.calls()).toBe(1);

    const [body] = createBodies();
    const items = new Map(body.items.map((i: { sender_item_id: string }) => [i.sender_item_id, i])) as Map<string, { amount: unknown; note: string }>;
    expect(items.get(ravi.payoutId)!.amount).toEqual({ value: '18.75', currency: 'USD' });
    expect(items.get(asha.payoutId)!.amount).toEqual({ value: '15.43', currency: 'USD' });
    expect(items.get(ravi.payoutId)!.note).toContain('INR 1,500.00, sent as USD 18.75 at the ECB reference rate of 16 Oct 2026');
    expect(items.get(ravi.payoutId)!.note).toContain('PayPal converts it to INR at its own rate');
    // The frozen request is what any re-send sends.
    expect(JSON.parse(decryptSecret((await db(TABLES.PaypalPayoutBatch).where({ id: batch.batchId }).first()).requestEnc))).toEqual(body);

    const row = await payoutRow(ravi.payoutId);
    expect({ amount: row.amount, currency: row.currency, status: row.status }).toEqual({ amount: '1500.00', currency: 'INR', status: 'pending' });
    expect(stampOf(row)).toMatchObject({ exportId: batch.batchId, via: 'api', currency: 'USD' });
    expect(stampOf(row)!.conversion).toEqual({
      sourceAmount: '1500.00',
      sourceCurrency: 'INR',
      sentAmount: '18.75',
      sentCurrency: 'USD',
      rate: RATE,
      rateSource: 'ecb',
      rateDate: ECB_DATE,
    });

    // The timeout's re-send reaches the same batch with the same bytes.
    const later = new Date(Date.now() + 3 * 60 * 1000);
    const out = await paypal.runPaypalPayoutsJob(db, { now: () => later });
    expect(out.submitted).toEqual([batch.batchId]);
    const bodies = fake.seen.filter((s) => s.path === '/v1/payments/payouts').map((s) => s.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(fake.created).toBe(1);
  });

  it('refuses an expired, forged or mismatched quote, one whose payouts changed, and one spent already', async () => {
    await connect();
    await turnOn();
    const runId = ulid();
    await paypalPartner('Ravi', '1500.00', runId);

    // Expired: quoted 16 minutes ago.
    const old = await paypal.quotePaypalConversion(T, runId, 'INR', 'USD', { now: () => new Date(Date.now() - 16 * 60 * 1000) });
    if (!old.ok) throw new Error(old.error);
    const expired = await send(runId, old.quote.quoteId);
    expect([expired.status, expired.body.error]).toEqual([409, 'quote_expired']);

    const q = await quote(runId);
    const [payload, mac] = q.quoteId.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    const forged = `${Buffer.from(JSON.stringify({ ...claims, rate: '0.02' })).toString('base64url')}.${mac}`;
    expect((await send(runId, forged)).body.error).toBe('invalid_quote');
    expect((await send(ulid(), q.quoteId)).body.error).toBe('invalid_quote');
    const noQuote = await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'INR', sendAs: 'USD' });
    expect([noQuote.status, noQuote.body.error]).toEqual([400, 'invalid_quote']);
    expect((await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'INR', quoteId: q.quoteId })).body.error).toBe('invalid_quote');
    expect((await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'INR' })).body.error).toBe('currency_not_supported');
    expect((await admin.post(`/payouts/runs/${runId}/paypal-batches`, { currency: 'USD', sendAs: 'USD', quoteId: q.quoteId })).body.error).toBe('conversion_not_needed');

    // Another payout joined the run since the quote: not what was shown.
    const late = await paypalPartner('Late', '10.00', runId);
    const changed = await send(runId, q.quoteId);
    expect([changed.status, changed.body.error]).toEqual([409, 'quote_changed']);
    expect(await db(TABLES.PaypalPayoutBatch).where({ tenantId: T })).toHaveLength(0);
    await db(TABLES.Payout).where({ id: late.payoutId }).del();

    // The brand turned the setting off in between.
    await admin.post('/config/paypal-payouts', { sendUnsupportedAs: null });
    expect((await send(runId, q.quoteId)).body.error).toBe('conversion_not_enabled');
    await turnOn();

    expect((await send(runId, q.quoteId)).status).toBe(201);
    // Spent: its payouts are in a batch now.
    expect((await send(runId, q.quoteId)).body.error).toBe('quote_changed');
    expect(fake.createCalls).toBe(1);
  });
});

describe.skipIf(skipIntegration)('a quote goes stale', () => {
  it('when a partner changes their PayPal email before the send', async () => {
    await connect();
    await turnOn();
    const runId = ulid();
    const ravi = await paypalPartner('Ravi', '1500.00', runId);
    const q = await quote(runId);
    const moved = profiles.parsePayoutDetails({ method: 'paypal', email: 'ravi-new@pay.test' });
    if (!moved.ok) throw new Error('bad fixture');
    await profiles.savePayoutProfile(db, T, ravi.partnerId, moved.details, 'partner');
    const res = await send(runId, q.quoteId);
    expect([res.status, res.body.error]).toEqual([409, 'quote_changed']);
    expect(stampOf(await payoutRow(ravi.payoutId))).toBeUndefined();
    // A fresh quote shows the new account, and sends to it.
    const fresh = await quote(runId);
    expect(fresh.items[0]!).toMatchObject({ destination: expect.stringMatching(/^PayPal r.*@pay\.test$/) });
    expect((await send(runId, fresh.quoteId)).status).toBe(201);
    expect(createBodies()[0].items[0].receiver).toBe('ravi-new@pay.test');
  });

  it('when PayPal gives a payout back while the send waits on its row: decided by the stamp, not the earlier read', async () => {
    await connect();
    await turnOn();
    const runId = ulid();
    const ravi = await paypalPartner('Ravi', '1500.00', runId);
    const q = await quote(runId);

    // Another worker holds the payout's row: the send reads it (no lock
    // needed), passes the digest, then waits on the row to stamp it.
    const holder = await db.transaction();
    try {
      await holder(TABLES.Payout).where({ id: ravi.payoutId }).forUpdate().first();
      const pending = send(runId, q.quoteId).then((r) => r);
      for (let i = 0; ; i += 1) {
        const { rows } = await db.raw<{ rows: Array<{ n: number }> }>(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike 'update%Payout%'`,
        );
        if (rows[0]!.n > 0) break;
        if (i > 200) throw new Error('the send never waited on the payout row');
        await new Promise((r) => setTimeout(r, 25));
      }
      // Meanwhile that worker's batch was refused and the payout released:
      // unstamped and pending again, one more release on record.
      await holder(TABLES.Payout)
        .where({ id: ravi.payoutId })
        .update({ metadata: db.raw(`metadata || jsonb_build_object('paypalReleases', '[{"batchId":"other","reason":"not_sent"}]'::jsonb)`) });
      await holder.commit();

      const res = await pending;
      expect([res.status, res.body.error]).toEqual([409, 'quote_changed']);
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
    expect(stampOf(await payoutRow(ravi.payoutId))).toBeUndefined();
    expect(await db(TABLES.PaypalPayoutBatch).where({ tenantId: T })).toHaveLength(0);
    expect(fake.createCalls).toBe(0);
  });

  it('when the send outlasts the quote while it waits: checked again before the intent commits', async () => {
    await connect();
    await turnOn();
    const runId = ulid();
    const ravi = await paypalPartner('Ravi', '1500.00', runId);
    const quotedAt = new Date();
    const q = await paypal.quotePaypalConversion(T, runId, 'INR', 'USD', { now: () => quotedAt });
    if (!q.ok) throw new Error(q.error);
    // In time when it starts; 16 minutes on by the time it would commit.
    let calls = 0;
    const clock = () => new Date(quotedAt.getTime() + (calls++ === 0 ? 14 : 16) * 60 * 1000);
    const out = await paypal.sendRunWithPaypal(T, runId, 'INR', 'admin', { sendAs: 'USD', quoteId: q.quote.quoteId, now: clock });
    expect(out).toEqual({ ok: false, error: 'quote_expired' });
    expect(stampOf(await payoutRow(ravi.payoutId))).toBeUndefined();
    expect(await db(TABLES.PaypalPayoutBatch).where({ tenantId: T })).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('the quote is bound to the PayPal app', () => {
  it('a send after another app was made active is refused, so a confirmed sandbox test never goes out live', async () => {
    await connect('sandbox');
    await connect('live'); // connected second: sandbox stays the one that sends
    await turnOn();
    const runId = ulid();
    const { payoutId } = await paypalPartner('Ravi', '1500.00', runId);
    const q = await quote(runId);
    expect((await admin.post(`/payouts/runs/${runId}/paypal-batches/quote`, { currency: 'INR', sendAs: 'USD' })).body.quote.environment).toBe('sandbox');

    // Someone switches to live in another tab before the brand confirms.
    expect((await admin.post('/config/paypal/live/activate')).status).toBe(200);
    const refused = await send(runId, q.quoteId);
    expect([refused.status, refused.body.error]).toEqual([409, 'quote_changed']);
    expect(stampOf(await payoutRow(payoutId))).toBeUndefined();
    expect(fake.createCalls).toBe(0);

    // A fresh quote names live, and sends from it.
    const fresh = await admin.post(`/payouts/runs/${runId}/paypal-batches/quote`, { currency: 'INR', sendAs: 'USD' });
    expect(fresh.body.quote.environment).toBe('live');
    expect((await send(runId, fresh.body.quote.quoteId)).body.batch.environment).toBe('live');
  });
});

describe.skipIf(skipIntegration)('what the partner sees', () => {
  it('payout views show the INR amount and what PayPal sent, pending and paid', async () => {
    await connect();
    await turnOn();
    const runId = ulid();
    const ravi = await paypalPartner('Ravi', '1500.00', runId);
    const usdRun = ulid();
    const plain = await paypalPartner('Plain', '10.00', usdRun, 'USD');
    const batchId = (await send(runId, (await quote(runId)).quoteId)).body.batch.batchId as string;
    const sent = { amount: '18.75', currency: 'USD', rate: RATE, rateSource: 'ecb', rateDate: ECB_DATE };

    const session = await createSession(db, { tenantId: T, principalKind: 'partner', principalId: ravi.partnerId });
    const asPartner = () => request(app).get(`/partners/${ravi.partnerId}/payouts`).set('Cookie', `op_session=${session.plaintext}`);
    const pending = await asPartner();
    expect(pending.status).toBe(200);
    expect(pending.body.payouts[0]).toMatchObject({ id: ravi.payoutId, amount: '1500.00', currency: 'INR', status: 'pending', sent });

    // Paid: still INR on the ledger, still sent in USD.
    fake.setItem(batchId, ravi.payoutId, 'SUCCESS');
    const synced = await admin.post(`/payouts/paypal-batches/${batchId}/sync`);
    expect(synced.body.batch).toMatchObject({ summary: { paid: 1 }, conversion: { rate: RATE } });
    const paid = (await asPartner()).body.payouts[0];
    expect(paid).toMatchObject({ amount: '1500.00', currency: 'INR', status: 'paid', sent });
    expect(stampOf(await payoutRow(ravi.payoutId))!.paypal).toMatchObject({ status: 'SUCCESS', amount: '18.75', currency: 'USD' });

    const list = (await admin.get('/payouts')).body.payouts as Array<{ id: string; sent: unknown }>;
    expect(list.find((p) => p.id === ravi.payoutId)!.sent).toEqual(sent);
    expect(list.find((p) => p.id === plain.payoutId)!.sent).toBeNull();
  });

  it('the run view shows a converted payout’s amounts while its batch is open', async () => {
    await connect();
    await turnOn();
    const runId = ulid();
    const ravi = await paypalPartner('Ravi', '1500.00', runId);
    await send(runId, (await quote(runId)).quoteId);
    const page = await admin.get(`/payouts/runs/${runId}/payouts`);
    expect(page.body.payouts[0]).toMatchObject({
      payoutId: ravi.payoutId,
      amount: '1500.00',
      currency: 'INR',
      sendAs: null,
      export: { via: 'api', conversion: { sentAmount: '18.75', sentCurrency: 'USD', rate: RATE } },
    });
  });
});

describe.skipIf(skipIntegration)('released payouts are re-quoted', () => {
  it('a failed item comes back with its conversion on record; the next send needs a fresh quote and takes the new rate', async () => {
    await connect();
    await turnOn();
    const runId = ulid();
    const ravi = await paypalPartner('Ravi', '1500.00', runId);
    const first = await quote(runId);
    const batchId = (await send(runId, first.quoteId)).body.batch.batchId as string;

    fake.setItem(batchId, ravi.payoutId, 'FAILED', 'RECEIVER_ACCOUNT_LOCKED');
    await admin.post(`/payouts/paypal-batches/${batchId}/sync`);
    const released = await payoutRow(ravi.payoutId);
    expect(released.status).toBe('pending');
    expect(stampOf(released)).toBeUndefined();
    expect(released.metadata.paypalReleases).toEqual([
      expect.objectContaining({ batchId, reason: 'failed', conversion: expect.objectContaining({ sentAmount: '18.75', rate: RATE, rateDate: ECB_DATE }) }),
    ]);
    expect((await admin.get(`/payouts/runs/${runId}`)).body.ready).toEqual([{ provider: 'paypal', currency: 'INR', sendAs: 'USD', count: 1, total: '1500.00' }]);

    // The first quote is still inside its 15 minutes, but it was for the
    // attempt PayPal returned.
    expect((await send(runId, first.quoteId)).body.error).toBe('quote_changed');

    ecb.serve(NEXT_XML);
    const second = await quote(runId);
    expect([second.rate, second.rateDate, second.sentTotal]).toEqual([NEXT_RATE, NEXT_DATE, '17.94']);
    const again = await send(runId, second.quoteId);
    expect(again.status).toBe(201);
    expect(again.body.batch.conversion).toMatchObject({ rate: NEXT_RATE, rateDate: NEXT_DATE });
    expect(stampOf(await payoutRow(ravi.payoutId))!.conversion).toMatchObject({ sentAmount: '17.94', rate: NEXT_RATE });
    expect(createBodies()[1].items[0].amount).toEqual({ value: '17.94', currency: 'USD' });
  });

  it('a sandbox batch is still a rehearsal: converted payouts come back to send, never paid', async () => {
    await connect('sandbox');
    await turnOn();
    const runId = ulid();
    const ravi = await paypalPartner('Ravi', '1500.00', runId);
    const batch = (await send(runId, (await quote(runId)).quoteId)).body.batch;
    expect(batch).toMatchObject({ environment: 'sandbox', currency: 'USD', total: '18.75' });

    fake.setItem(batch.batchId, ravi.payoutId, 'SUCCESS');
    const synced = await admin.post(`/payouts/paypal-batches/${batch.batchId}/sync`);
    expect(synced.body.batch.rehearsal).toEqual({ paid: 1, unclaimed: 0, failed: 0 });
    const row = await payoutRow(ravi.payoutId);
    expect(row.status).toBe('pending');
    expect(stampOf(row)).toBeUndefined();
    expect(row.metadata.paypalReleases).toEqual([expect.objectContaining({ reason: 'sandbox_test', conversion: expect.objectContaining({ sentAmount: '18.75' }) })]);
  });
});
