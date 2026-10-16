/**
 * Contract test for the documented API: runs the headless in-app referral
 * flow (docs/headless-referral.md) and the rest of the documented surface
 * against a real database, and checks every response against what
 * docs/openapi.json says about that operation:
 *
 *   - the status code is one the operation documents;
 *   - a success body parses against the documented schema, with unknown
 *     keys rejected at every depth (openapi-strict.ts), so a field the API
 *     started or stopped sending fails here;
 *   - an error body is the documented envelope, with an `error` code the
 *     operation lists for that status.
 *
 * It also receives the webhooks the flow fires on a local endpoint,
 * verifies each signature exactly as the docs tell integrators to, and
 * parses every payload against the webhook catalogue.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { expectShape } from './openapi-strict.js';

const ADMIN_KEY = 'op_test_admin_key_openapi_contract_0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
// Deliver this file's webhooks to a receiver on loopback.
process.env.OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS = '127.0.0.1/32,::1/128';
// No Stripe: auto-minted coupons would otherwise check codes against it.
// Set (not deleted) so dotenv doesn't fill it back in from a local .env.
process.env.STRIPE_SECRET_KEY = '';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { getDocumentedOperations } = await import('../openapi/index.js');
const { ErrorResponse } = await import('../openapi/registry.js');
const { WEBHOOK_PAYLOADS, envelopeSchema } = await import('../openapi/webhook-events.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const operations = new Map(getDocumentedOperations().map((op) => [op.operationId, op]));
const exercised = new Set<string>();

const TABLES_TO_CLEAN = [
  TABLES.WebhookDelivery,
  TABLES.WebhookEndpoint,
  TABLES.Commission,
  TABLES.Payout,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Coupon,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.ApiKey,
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.Program,
  TABLES.Partner,
];

/** Assert `res` is something `operationId` documents, and return its body. */
function check<T = Record<string, unknown>>(operationId: string, res: request.Response): T {
  const op = operations.get(operationId);
  if (!op) throw new Error(`no documented operation ${operationId}`);
  exercised.add(operationId);
  if (String(res.status) in op.responses) {
    const schema = op.responses[res.status];
    if (schema) expectShape(schema, res.body, `${operationId} → ${res.status}`);
    return res.body as T;
  }
  const codes = op.errors[res.status];
  if (!codes) {
    throw new Error(`${operationId} returned undocumented status ${res.status}: ${JSON.stringify(res.body)}`);
  }
  expectShape(ErrorResponse, res.body, `${operationId} → ${res.status}`);
  expect(codes, `${operationId} → ${res.status} error code`).toContain(res.body.error);
  return res.body as T;
}

const as = (key: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${key}`),
  post: (path: string, body?: object) =>
    request(app).post(path).set('Authorization', `Bearer ${key}`).send(body ?? {}),
  put: (path: string, body: object) => request(app).put(path).set('Authorization', `Bearer ${key}`).send(body),
  patch: (path: string, body: object) => request(app).patch(path).set('Authorization', `Bearer ${key}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${key}`),
});
const admin = as(ADMIN_KEY);

// ---------- webhook receiver ----------

interface Received {
  headers: IncomingHttpHeaders;
  raw: string;
}
const received: Received[] = [];
let receiver: Server;
let receiverUrl = '';

/** The verification the docs publish, verbatim in spirit: HMAC over
 *  `<timestamp>.<raw body>`, constant-time compare, 5-minute window. */
function verify(raw: string, headers: IncomingHttpHeaders, secret: string): boolean {
  const ts = String(headers['x-openpartner-timestamp'] ?? '');
  const sig = String(headers['x-openpartner-signature'] ?? '');
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function waitForEvents(types: string[], timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = new Set(received.map((r) => JSON.parse(r.raw).event as string));
    if (types.every((t) => got.has(t))) return;
    if (Date.now() > deadline) throw new Error(`webhooks not received: ${types.filter((t) => !got.has(t)).join(', ')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

let savedThreshold: unknown;

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  for (const t of TABLES_TO_CLEAN) await db(t).del();
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();
  const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first('payoutThresholdCents');
  savedThreshold = tenant?.payoutThresholdCents;
  await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ payoutThresholdCents: 0 });

  receiver = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      received.push({ headers: req.headers, raw });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) await db(t).del();
    await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ payoutThresholdCents: savedThreshold ?? null });
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('documented API contract', () => {
  it('serves the headless referral flow exactly as documented', async () => {
    // --- Setup: a webhook endpoint, a private program, a scoped key.
    const hook = check<{ endpoint: { id: string }; secret: string }>(
      'createWebhookEndpoint',
      await admin.post('/webhooks', { url: receiverUrl, events: ['*'], label: 'contract' }),
    );

    check('getNetworkMembership', await admin.get('/config/network'));
    const membership = check<{ autoEnroll: boolean }>('updateNetworkMembership', await admin.post('/config/network', { autoEnroll: false }));
    expect(membership.autoEnroll).toBe(false);

    const program = check<{ id: string }>(
      'createProgram',
      await admin.post('/programs', {
        name: 'Refer & earn',
        destinationUrl: 'https://app.example.com/signup',
        commissionRule: [{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 10 }],
        shareOnNetwork: false,
      }),
    );
    check('updateProgram', await admin.patch(`/programs/${program.id}`, { attributionWindowDays: 90 }));
    check('listPrograms', await admin.get('/programs'));

    const scoped = check<{ plaintext: string }>(
      'createScopedKey',
      await admin.post('/api-keys/scoped', {
        label: 'in-app referral',
        scopes: ['partners:write', 'partners:read', 'links:write', 'links:read', 'events:write', 'commissions:read', 'payouts:read'],
      }),
    );
    const integration = as(scoped.plaintext);
    check('listScopedKeys', await admin.get('/api-keys'));

    // --- First visit to the referral page: create the partner + link.
    const partner = check<{ id: string; activatedAt: string | null; invited: boolean }>(
      'createPartner',
      await integration.post('/partners', {
        email: 'customer@example.com',
        name: 'Ada Customer',
        sendInvite: false,
        programIds: [program.id],
        metadata: { appUserId: 'u_123' },
      }),
    );
    expect(partner.activatedAt).not.toBeNull();
    expect(partner.invited).toBe(false);
    check('createPartner', await integration.post('/partners', { email: 'customer@example.com', name: 'Again', sendInvite: false }));

    const found = check<{ partners: Array<{ id: string }> }>('listPartners', await integration.get('/partners?email=customer@example.com'));
    expect(found.partners.map((p) => p.id)).toEqual([partner.id]);
    check('listPartners', await integration.get('/partners?q=ada&limit=1'));
    check('listPartners', await integration.get('/partners?cursor=not-a-cursor'));
    check('getPartner', await integration.get(`/partners/${partner.id}`));
    check('invitePartner', await admin.post(`/partners/${partner.id}/invite`));

    const link = check<{ linkKey: string }>(
      'createPartnerLink',
      await integration.post(`/partners/${partner.id}/links`, { linkKey: 'ada-refers', programId: program.id }),
    );
    check('createPartnerLink', await integration.post(`/partners/${partner.id}/links`, { linkKey: 'ada-refers', programId: program.id }));
    check('listPartnerLinks', await integration.get(`/partners/${partner.id}/links`));

    // --- A friend clicks (recorded here via /clicks; the router does this in production).
    const clickId = ulid();
    const click = {
      id: clickId,
      linkKey: link.linkKey,
      landingUrl: `https://app.example.com/signup?cref=${clickId}`,
      referer: 'https://news.example.com/',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    check('ingestClick', await admin.post('/clicks', click));
    check('ingestClick', await admin.post('/clicks', click));

    // --- The friend signs up: the browser SDK's identify, then server-side events.
    const stitched = check<{ firstStitch: boolean }>(
      'identify',
      await request(app).post('/attribution/identify').send({ cref: clickId, userId: 'friend_1' }),
    );
    expect(stitched.firstStitch).toBe(true);
    check('identify', await request(app).post('/attribution/identify').send({ cref: 'missing', userId: 'friend_1' }));

    check('recordEvent', await integration.post('/attribution/events', { userId: 'friend_1', type: 'signup', externalEventId: 'signup:friend_1' }));
    const paid = { userId: 'friend_1', type: 'invoice_paid', value: 300, currency: 'USD', externalEventId: 'inv_1' };
    const first = check<{ attribution: { status: string } }>('recordEvent', await integration.post('/attribution/events', paid));
    expect(first.attribution.status).toBe('attributed');
    const replay = check<{ replayed?: boolean }>('recordEvent', await integration.post('/attribution/events', paid));
    expect(replay.replayed).toBe(true);
    check('recordEvent', await integration.post('/attribution/events', { ...paid, value: 1 }));
    check('recordEvent', await integration.post('/attribution/events', { userId: 'friend_1', type: 'invoice_paid', value: 120, externalEventId: 'inv_2' }));

    // --- The referral page renders stats + earnings.
    const dash = check<{ clicks: number; attributedEvents: number }>(
      'getPartnerDashboard',
      await integration.get(`/partners/${partner.id}/dashboard?includeLinks=true`),
    );
    expect(dash.clicks).toBe(1);
    check('getPartnerTimeseries', await integration.get(`/partners/${partner.id}/timeseries`));
    check('listPartnerEvents', await integration.get(`/partners/${partner.id}/events?limit=10`));
    check('listPartnerCustomers', await integration.get(`/partners/${partner.id}/customers`));
    check('getPartnerBreakdown', await integration.get(`/partners/${partner.id}/breakdowns?dimension=referer`));
    check('getPartnerBreakdown', await integration.get(`/partners/${partner.id}/breakdowns?dimension=browser`));
    // Funnel has no scope (documented): admin key from the server.
    check('getPartnerFunnel', await integration.get(`/partners/${partner.id}/funnel`));
    const funnel = check<{ stages: { signups: number; paid: number } }>('getPartnerFunnel', await admin.get(`/partners/${partner.id}/funnel`));
    expect(funnel.stages).toMatchObject({ signups: 1, paid: 1 });

    const page = check<{ commissions: Array<{ id: string; amount: string }>; nextCursor: string | null }>(
      'listPartnerCommissions',
      await integration.get(`/partners/${partner.id}/commissions?limit=1`),
    );
    expect(page.nextCursor).not.toBeNull();
    const rest = check<{ commissions: Array<{ id: string; amount: string }> }>(
      'listPartnerCommissions',
      await integration.get(`/partners/${partner.id}/commissions?cursor=${page.nextCursor}`),
    );
    const [toApprove, toReverse] = [...page.commissions, ...rest.commissions];
    expect(toApprove && toReverse).toBeTruthy();
    check('listCommissions', await integration.get('/commissions?status=accrued'));

    // --- Admin side: approve, reverse, pay.
    check('approveCommission', await admin.post(`/commissions/${toApprove!.id}/approve`));
    check('approveCommission', await admin.post(`/commissions/${toApprove!.id}/approve`));
    check('reverseCommission', await admin.post(`/commissions/${toReverse!.id}/reverse`));
    const run = check<{ payouts: Array<{ payoutId: string; method: string }> }>('runPayouts', await admin.post('/payouts/run'));
    expect(run.payouts).toHaveLength(1);
    expect(run.payouts[0]!.method).toBe('manual');
    check('listPartnerPayouts', await integration.get(`/partners/${partner.id}/payouts`));
    check('confirmManualPayout', await admin.post(`/payouts/${run.payouts[0]!.payoutId}/confirm`));
    check('confirmManualPayout', await admin.post(`/payouts/${run.payouts[0]!.payoutId}/confirm`));

    // --- Webhooks the flow fired: delivered, signed as documented, shaped as catalogued.
    await admin.post('/partners', {
      email: 'creator@example.com',
      name: 'Network Creator',
      sendInvite: false,
      programIds: [program.id],
      metadata: { source: 'openpartner_network', networkCreatorId: 'crt_123' },
    });
    await waitForEvents([
      'partner.created',
      'partnership.approved',
      'attribution.created',
      'commission.accrued',
      'commission.approved',
      'commission.reversed',
      'payout.created',
      'commission.paid',
    ]);
    for (const r of received) {
      expect(verify(r.raw, r.headers, hook.secret), 'signature verifies').toBe(true);
      const envelope = JSON.parse(r.raw) as { id: string; event: keyof typeof WEBHOOK_PAYLOADS };
      expect(r.headers['x-openpartner-event']).toBe(envelope.event);
      expect(r.headers['x-openpartner-delivery']).toBe(envelope.id);
      expectShape(envelopeSchema(envelope.event, WEBHOOK_PAYLOADS[envelope.event]), envelope, `${envelope.event} webhook`);
    }
  });

  it('serves the rest of the documented surface as documented', async () => {
    const program = check<{ id: string }>(
      'createProgram',
      await admin.post('/programs', {
        name: 'Second',
        destinationUrl: 'https://app.example.com/',
        commissionRule: { type: 'fixed', value: 5, currency: 'USD' },
        shareOnNetwork: false,
      }),
    );
    check('createProgram', await admin.post('/programs', { name: 'bad' }));
    const other = check<{ id: string }>(
      'createPartner',
      await admin.post('/partners', { email: 'other@example.com', name: 'Other', sendInvite: false, programIds: [] }),
    );

    // Bulk import: a dry run writes nothing, a real run creates, a re-run skips.
    const csv = ['email,name,metadata', 'bulk1@example.com,Bulk One,"{""appUserId"":""u_b1""}"', 'not-an-email,Nobody,', ''].join('\n');
    const dry = check<{ summary: { created: number; invalid: number } }>(
      'importPartnersCsv',
      await request(app).post('/import/partners-csv?dryRun=true').set('Authorization', `Bearer ${ADMIN_KEY}`).set('content-type', 'text/csv').send(csv),
    );
    expect(dry.summary).toMatchObject({ created: 1, invalid: 1 });
    expect(await db(TABLES.Partner).where({ email: 'bulk1@example.com' }).first()).toBeUndefined();
    check('importPartnersCsv', await request(app).post('/import/partners-csv').set('Authorization', `Bearer ${ADMIN_KEY}`).set('content-type', 'text/csv').send(csv));
    const rerun = check<{ summary: { skipped: number } }>('importPartnersCsv', await admin.post('/import/partners-csv', { csv }));
    expect(rerun.summary.skipped).toBe(1);
    check('importPartnersCsv', await request(app).post('/import/partners-csv').set('Authorization', `Bearer ${ADMIN_KEY}`).set('content-type', 'text/csv').send('email,name\n'));

    // Program grants.
    check('listPartnerPrograms', await admin.get(`/partners/${other.id}/programs`));
    check('grantPartnerPrograms', await admin.post(`/partners/${other.id}/programs`, { programIds: [program.id] }));
    check('revokePartnerProgram', await admin.delete(`/partners/${other.id}/programs/${program.id}`));
    check('revokePartnerProgram', await admin.delete(`/partners/${other.id}/programs/${program.id}`));
    await admin.post(`/partners/${other.id}/programs`, { programIds: [program.id] });

    // Commission override.
    check('getPartnerCommissionOverride', await admin.get(`/partners/${other.id}/commission-snapshot`));
    check('setPartnerCommissionOverride', await admin.put(`/partners/${other.id}/commission-snapshot`, { commissionType: 'percent', commissionValue: 30 }));
    check('getPartnerCommissionOverride', await admin.get(`/partners/${other.id}/commission-snapshot`));
    check('clearPartnerCommissionOverride', await admin.delete(`/partners/${other.id}/commission-snapshot`));

    // Partner keys act as that partner only.
    const partnerKey = check<{ id: string; plaintext: string }>('createPartnerKey', await admin.post(`/partners/${other.id}/api-keys`, { label: 'p' }));
    const asPartner = as(partnerKey.plaintext);
    check('listPartnerKeys', await asPartner.get(`/partners/${other.id}/api-keys`));
    check('listMyPrograms', await asPartner.get('/me/programs'));
    check('listMyPrograms', await admin.get('/me/programs'));
    check('getPartnerDashboard', await asPartner.get(`/partners/${other.id}/dashboard`));
    const firstPartner = (await db(TABLES.Partner).where({ email: 'customer@example.com' }).first('id')) as { id: string };
    check('getPartnerDashboard', await asPartner.get(`/partners/${firstPartner.id}/dashboard`));
    check('listPartnerCoupons', await asPartner.get(`/partners/${other.id}/coupons`));

    // A scoped key without the scope.
    const narrow = check<{ plaintext: string }>('createScopedKey', await admin.post('/api-keys/scoped', { scopes: ['links:read'] }));
    const denied = check<{ required?: string }>('createPartner', await as(narrow.plaintext).post('/partners', { email: 'x@example.com', name: 'X' }));
    expect(denied.required).toBe('partners:write');
    check('listPrograms', await as(narrow.plaintext).get('/programs'));
    check('getPartner', await request(app).get(`/partners/${other.id}`));

    // Coupons.
    const coupon = check<{ id: string; code: string }>('createPartnerCoupon', await admin.post(`/partners/${other.id}/coupons`, { programId: program.id, code: 'OTHER10' }));
    check('createPartnerCoupon', await asPartner.post(`/partners/${other.id}/coupons`, { programId: program.id }));
    const redemption = { code: 'other10', eventType: 'invoice_paid', value: 40, externalEventId: 'order_9', userId: 'buyer_9' };
    check('redeemCoupon', await admin.post('/coupons/redeem', redemption));
    check('redeemCoupon', await admin.post('/coupons/redeem', redemption));
    check('redeemCoupon', await admin.post('/coupons/redeem', { ...redemption, externalEventId: 'order_10', code: 'NOPE-NOPE' }));
    check('listPartnerCoupons', await admin.get(`/partners/${other.id}/coupons`));
    check('deactivatePartnerCoupon', await admin.delete(`/partners/${other.id}/coupons/${coupon.id}`));

    // Revoke / reinstate.
    check('revokePartner', await admin.post(`/partners/${other.id}/revoke`, { notify: false }));
    check('revokePartner', await admin.post(`/partners/${other.id}/revoke`, { notify: false }));
    check('reinstatePartner', await admin.post(`/partners/${other.id}/reinstate`));
    check('reinstatePartner', await admin.post(`/partners/${other.id}/reinstate`));

    // Keys.
    const spare = check<{ id: string }>('createAdminKey', await admin.post('/api-keys', { label: 'rotation' }));
    check('revokeKey', await admin.delete(`/api-keys/${spare.id}`));
    check('revokeKey', await admin.delete('/api-keys/missing'));

    // Webhook endpoint management.
    const listed = check<{ endpoints: Array<{ id: string }> }>('listWebhookEndpoints', await admin.get('/webhooks'));
    const hookId = listed.endpoints[0]!.id;
    check('getWebhookEndpoint', await admin.get(`/webhooks/${hookId}`));
    check('getWebhookEndpoint', await admin.get('/webhooks/missing'));
    check('updateWebhookEndpoint', await admin.patch(`/webhooks/${hookId}`, { label: 'renamed' }));
    const tested = check<{ delivery: { id: string } }>('testWebhookEndpoint', await admin.post(`/webhooks/${hookId}/test?event=payout.created`));
    check('testWebhookEndpoint', await admin.post(`/webhooks/${hookId}/test?event=nope`));
    const deliveries = check<{ deliveries: unknown[] }>('listWebhookDeliveries', await admin.get(`/webhooks/${hookId}/deliveries`));
    expect(deliveries.deliveries.length).toBeGreaterThan(0);
    check('retryWebhookDelivery', await admin.post(`/webhooks/${hookId}/deliveries/${tested.delivery.id}/retry`));
    check('deleteWebhookEndpoint', await admin.delete(`/webhooks/${hookId}`));
    check('testWebhookEndpoint', await admin.post(`/webhooks/${hookId}/test`));

    // Export round trip.
    const bundle = check<Record<string, unknown>>('exportAllJson', await admin.get('/export.json'));
    check('exportTable', await admin.get('/export/Partner.json'));
    check('exportTable', await admin.get('/export/Partner.csv'));
    check('exportTable', await admin.get('/export/Nope.json'));
    check('exportAllSql', await admin.get('/export.sql'));
    check('importBundle', await admin.post('/import', bundle));
    check('importBundle', await admin.post('/import', { ...bundle, schemaVersion: 999 }));
  });

  it('exercised every documented operation', () => {
    const missed = [...operations.keys()].filter((id) => !exercised.has(id));
    expect(missed).toEqual([]);
  });
});
