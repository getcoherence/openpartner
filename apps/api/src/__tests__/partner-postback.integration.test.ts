/**
 * Partner postback end-to-end integration test.
 *
 * Spins up a local capturing HTTP server to act as the partner's
 * tracker, wires a PartnerPostback row pointing at it with macro
 * placeholders in the URL, runs the full click → identify → event
 * pipeline, and asserts:
 *   - the tracker received a GET with the substituted macros
 *   - the PartnerPostback row's audit counters bumped
 *
 * Skipped when DATABASE_URL isn't set (matches the rest of the
 * integration suite).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type PartnerPostbackRow } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_postback_admin_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';
process.env.OPENPARTNER_MODE = 'selfhost';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

// The capturing receiver binds 127.0.0.1. Partner postbacks use the HARDENED
// policy (no private-CIDR escape hatch — even the self-host env var doesn't
// apply to them), so a localhost receiver would be blocked. Force a
// permissive policy for this delivery-mechanics test; the security split
// itself is covered in outbound-guard.test.ts.
const { __setOutboundPolicyForTests } = await import('../outbound-guard.js');
const ipaddrForTests = (await import('ipaddr.js')).default;

interface CapturedCall {
  url: string;
  method: string;
}

let receiver: Server;
let receiverUrl: string;
const calls: CapturedCall[] = [];

const TABLES_TO_CLEAN = [
  TABLES.PartnerPostback,
  TABLES.Commission,
  TABLES.Bonus,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.Payout,
  TABLES.Program,
  TABLES.ApiKey,
  TABLES.Partner,
  TABLES.Config,
];

beforeAll(async () => {
  if (skipIntegration) return;
  __setOutboundPolicyForTests({ allowedPorts: null, privateCidrs: [ipaddrForTests.parseCIDR('127.0.0.1/32')] });
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    receiver = createServer((req, res) => {
      calls.push({ method: req.method ?? '', url: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }).listen(0, '127.0.0.1', () => {
      const addr = receiver.address() as AddressInfo;
      receiverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  __setOutboundPolicyForTests(null);
  if (receiver) await new Promise<void>((r) => receiver.close(() => r()));
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) await db(t).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
  calls.length = 0;
});

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timeout');
}

describe.skipIf(skipIntegration)('partner postback', () => {
  it('fires a substituted GET when commission.accrued lands', async () => {
    // 1. Set up a brand-side partner + campaign + link via the API so
    //    Campaign / PartnerCampaign / Link rows are realistic.
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'pb-test@example.com', name: 'Postback Test' });
    expect(partnerRes.status).toBe(201);
    const partnerId = partnerRes.body.id;

    const campaignRes = await request(app)
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'PB',
        commissionRule: { type: 'percent', value: 20 },
        destinationUrl: 'https://example.com/signup',
      });
    expect(campaignRes.status).toBe(201);
    const programId = campaignRes.body.id;

    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `pb_${Date.now()}`, programId });
    expect(linkRes.status).toBe(201);

    // 2. Register a partner postback against the local capturing server.
    await db<PartnerPostbackRow>(TABLES.PartnerPostback).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      url: `${receiverUrl}/cb?cid={click_id}&amt={commission_amount}&cur={currency}&tx={transaction_id}&sub={sub_id}&st={status}&rev={sale_amount}`,
      events: JSON.stringify(['commission.accrued']) as never,
      enabled: true,
    });

    // 3. Drive the full pipeline. Insert a click directly (the router
    //    would normally do this), stitch identity, fire a server-side
    //    revenue event.
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: linkRes.body.id,
      partnerId,
      programId,
      landingUrl: 'https://example.com/signup',
      ipHash: 'test-hash',
      userAgent: 'test',
      referer: null,
      // What the router stores off ?sub_id= on the partner link.
      subId: 'wct click/42',
      fraudFlag: null,
    });

    const userId = `u_${Date.now()}`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });
    const eventRes = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 100, currency: 'USD' });
    expect(eventRes.status).toBe(200);

    // 4. Postback fires asynchronously via dispatchEvent — wait for it.
    await waitFor(async () => (calls.length > 0 ? calls[0] : null));

    expect(calls).toHaveLength(1);
    const captured = calls[0]!;
    expect(captured.method).toBe('GET');
    // URL-encoded substitution: macros replaced, structure preserved.
    expect(captured.url).toMatch(/^\/cb\?/);
    expect(captured.url).toContain(`cid=${clickId}`);
    expect(captured.url).toContain('amt=20.00');
    expect(captured.url).toContain('cur=USD');
    // transaction_id is the alias for event_id — verify the alias path
    // resolves to a non-empty string (the actual event id is generated
    // server-side so we just check it's there).
    expect(captured.url).toMatch(/tx=[A-Z0-9]/);
    // The publisher's sub-ID comes back URL-encoded, with the status the
    // event announces and the sale's value.
    expect(captured.url).toContain('sub=wct%20click%2F42');
    expect(captured.url).toContain('st=pending');
    expect(captured.url).toContain('rev=100.00');

    // 5. Audit counters bumped on the row.
    const row = await waitFor(async () =>
      db<PartnerPostbackRow>(TABLES.PartnerPostback)
        .where({ partnerId })
        .first()
        .then((r) => (r && r.successCount > 0 ? r : null)),
    );
    expect(row.successCount).toBe(1);
    expect(row.failureCount).toBe(0);
    expect(row.lastStatus).toBe(200);
    expect(row.lastFiredAt).not.toBeNull();
  });

  it('skips disabled postbacks and postbacks subscribed to other events', async () => {
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'pb-skip@example.com', name: 'Skip' });
    const partnerId = partnerRes.body.id;

    const campaignRes = await request(app)
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'Skip',
        commissionRule: { type: 'percent', value: 10 },
        destinationUrl: 'https://example.com/',
      });
    const programId = campaignRes.body.id;
    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `skip_${Date.now()}`, programId });

    // Disabled postback — should be ignored.
    await db<PartnerPostbackRow>(TABLES.PartnerPostback).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      url: `${receiverUrl}/disabled`,
      events: JSON.stringify(['commission.accrued']) as never,
      enabled: false,
    });
    // Wrong-event postback — should be ignored on commission.accrued.
    await db<PartnerPostbackRow>(TABLES.PartnerPostback).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      url: `${receiverUrl}/paid-only`,
      events: JSON.stringify(['commission.paid']) as never,
      enabled: true,
    });

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: linkRes.body.id,
      partnerId,
      programId,
      landingUrl: 'https://example.com/',
      ipHash: 'h',
      userAgent: 't',
      referer: null,
      fraudFlag: null,
    });
    const userId = `u_${Date.now()}_skip`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });
    await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 50, currency: 'USD' });

    // Give the dispatcher a chance to run; nothing should land.
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(0);
  });

  it('fills {click_id} / {event_id} / {event_type} / {sub_id} / {sale_amount} on commission.approved and commission.reversed', async () => {
    // These macros used to resolve on commission.accrued only, so a
    // tracker got approvals and reversals it couldn't match to a click.
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'pb-lifecycle@example.com', name: 'Lifecycle' });
    const partnerId = partnerRes.body.id;
    const campaignRes = await request(app)
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'Lifecycle',
        commissionRule: { type: 'percent', value: 20 },
        destinationUrl: 'https://example.com/',
      });
    const programId = campaignRes.body.id;
    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `life_${Date.now()}`, programId });

    for (const event of ['commission.approved', 'commission.reversed']) {
      await db<PartnerPostbackRow>(TABLES.PartnerPostback).insert({
        id: ulid(),
        tenantId: DEFAULT_TENANT_ID,
        partnerId,
        url: `${receiverUrl}/${event}?cid={click_id}&tx={event_id}&et={event_type}&prog={program_id}&sub={sub_id}&st={status}&rev={sale_amount}`,
        events: JSON.stringify([event]) as never,
        enabled: true,
      });
    }

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: linkRes.body.id,
      partnerId,
      programId,
      landingUrl: 'https://example.com/',
      ipHash: 'h',
      userAgent: 't',
      referer: null,
      subId: 'wct-life-7',
      fraudFlag: null,
    });
    const userId = `u_${Date.now()}_life`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });
    await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'invoice_paid', value: 100, currency: 'USD' });
    const commission = await waitFor(async () => db(TABLES.Commission).where({ partnerId }).first());
    const sourceEvent = await db(TABLES.Event).where({ userId, type: 'invoice_paid' }).first();

    const approve = await request(app)
      .post(`/commissions/${commission.id}/approve`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(approve.status).toBe(200);
    const approved = await waitFor(async () => calls.find((c) => c.url.startsWith('/commission.approved')));

    const reverse = await request(app)
      .post(`/commissions/${commission.id}/reverse`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(reverse.status).toBe(200);
    const reversed = await waitFor(async () => calls.find((c) => c.url.startsWith('/commission.reversed')));

    for (const call of [approved, reversed]) {
      expect(call.url).toContain(`cid=${clickId}`);
      expect(call.url).toContain(`tx=${sourceEvent!.id}`);
      expect(call.url).toContain('et=invoice_paid');
      expect(call.url).toContain(`prog=${programId}`);
      expect(call.url).toContain('sub=wct-life-7');
      expect(call.url).toContain('rev=100.00');
    }
    // One URL could take both events and still tell them apart.
    expect(approved.url).toContain('st=approved');
    expect(reversed.url).toContain('st=reversed');
  });

  it('fires bonus.awarded with the bonus macros; a bonus has no click to fill', async () => {
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'pb-bonus@example.com', name: 'Bonus' });
    const partnerId = partnerRes.body.id;
    await db<PartnerPostbackRow>(TABLES.PartnerPostback).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      url: `${receiverUrl}/bonus?b={bonus_id}&amt={bonus_amount}&cur={currency}&bounty={bounty_id}&cid={click_id}&sub={sub_id}&st={status}`,
      events: JSON.stringify(['bonus.awarded']) as never,
      enabled: true,
    });
    // And one on commission.approved, which a bonus must never fire.
    await db<PartnerPostbackRow>(TABLES.PartnerPostback).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      url: `${receiverUrl}/commission.approved`,
      events: JSON.stringify(['commission.approved']) as never,
      enabled: true,
    });

    const res = await request(app)
      .post('/bonuses')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ partnerId, amount: 12.5, currency: 'EUR' });
    expect(res.status).toBe(201);
    const call = await waitFor(async () => calls.find((c) => c.url.startsWith('/bonus?')));
    expect(call.url).toContain(`b=${res.body.bonus.id}`);
    expect(call.url).toContain('amt=12.50');
    expect(call.url).toContain('cur=EUR');
    // No bounty and no click: unknown values stay literal, as for any macro.
    expect(call.url).toContain('bounty={bounty_id}');
    expect(call.url).toContain('cid={click_id}');
    expect(call.url).toContain('sub={sub_id}');
    // Awarded without a hold: straight to the next payout run.
    expect(call.url).toContain('st=approved');
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.filter((c) => c.url.startsWith('/commission.approved'))).toHaveLength(0);
  });

  it('fills {sub_id} and {sale_amount} empty for a link without a sub-ID and a valueless event', async () => {
    const partnerRes = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'pb-empty@example.com', name: 'Empty' });
    const partnerId = partnerRes.body.id;
    const campaignRes = await request(app)
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'Leads',
        commissionRule: { type: 'fixed', value: 5, eventType: 'signup' },
        destinationUrl: 'https://example.com/',
      });
    expect(campaignRes.status).toBe(201);
    const programId = campaignRes.body.id;
    const linkRes = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey: `empty_${Date.now()}`, programId });
    await db<PartnerPostbackRow>(TABLES.PartnerPostback).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      url: `${receiverUrl}/lead?sub={sub_id}&rev={sale_amount}&amt={commission_amount}&st={status}`,
      events: JSON.stringify(['commission.accrued']) as never,
      enabled: true,
    });

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: linkRes.body.id,
      partnerId,
      programId,
      landingUrl: 'https://example.com/',
      ipHash: 'h',
      userAgent: 't',
      referer: null,
      fraudFlag: null,
    });
    const userId = `u_${Date.now()}_empty`;
    await request(app).post('/attribution/identify').send({ cref: clickId, userId });
    const eventRes = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId, type: 'signup' });
    expect(eventRes.status).toBe(200);

    const call = await waitFor(async () => calls.find((c) => c.url.startsWith('/lead?')));
    // Known to be empty, so empty: not left literal like a macro with no value.
    expect(call.url).toBe('/lead?sub=&rev=&amt=5.00&st=pending');
  });
});
