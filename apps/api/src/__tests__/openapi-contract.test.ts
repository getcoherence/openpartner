/**
 * Contract test for the documented API: runs the headless in-app referral
 * flow (docs/headless-referral.md) and the rest of the documented surface
 * against a real database, and checks every exchange against the spec:
 *
 *   - the status code is one the operation documents;
 *   - a success body parses against the zod response schema with unknown
 *     keys rejected at every depth (openapi-strict.ts), so a field the API
 *     started or stopped sending fails here;
 *   - an error body is the documented envelope, with an `error` code the
 *     operation lists for that status;
 *   - and the same exchange validates against the PUBLISHED JSON Schema
 *     (docs/openapi.json, via ajv): the response body, the JSON request
 *     body (a body the route accepted must be valid per the spec, one it
 *     rejected as invalid_body must not be) and the query parameters. That
 *     catches places where the generated schema and zod disagree.
 *
 * It also proves every documented access rule by calling each operation
 * with each kind of credential, receives the webhooks the flow fires on a
 * local endpoint, verifies each signature exactly as the docs tell
 * integrators to, and parses every payload against the webhook catalogue.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
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
const { getDocumentedOperations, getOpenApiDocument } = await import('../openapi/index.js');
const { ErrorResponse, accessExtension } = await import('../openapi/registry.js');
const { WEBHOOK_PAYLOADS, envelopeSchema } = await import('../openapi/webhook-events.js');
const { issueMagicLink } = await import('../auth-sessions.js');
const { __setPaypalFetchForTests } = await import('../paypal-api.js');
const { parsePayoutDetails, savePayoutProfile } = await import('../payout-profile.js');
const { FakePaypal } = await import('./fake-paypal.js');
const { stubEcbFetch } = await import('./ecb-fixture.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const operations = new Map(getDocumentedOperations().map((op) => [op.operationId, op]));
const exercised = new Set<string>();

const TABLES_TO_CLEAN = [
  TABLES.PaypalPayoutBatch,
  TABLES.PaypalConnection,
  TABLES.WebhookDelivery,
  TABLES.WebhookEndpoint,
  TABLES.Commission,
  TABLES.Bonus,
  TABLES.Payout,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.ClickLanding,
  TABLES.Click,
  TABLES.Coupon,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.ApiKey,
  TABLES.ConversionPostbackToken,
  TABLES.PartnerSigninLinkLog,
  TABLES.TrackingIssue,
  TABLES.Session,
  TABLES.MagicLinkToken,
  TABLES.Program,
  TABLES.Partner,
];

// ---------- the published spec, as a JSON Schema validator ----------

interface SpecOperation {
  operationId: string;
  parameters?: Array<{ name: string; in: string; schema: unknown }>;
  requestBody?: { content: Record<string, { schema: unknown }> };
  responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
}
const spec = getOpenApiDocument() as unknown as {
  components: Record<string, unknown>;
  paths: Record<string, Record<string, SpecOperation>>;
};
const specOps = new Map<string, SpecOperation>();
for (const item of Object.values(spec.paths)) for (const op of Object.values(item)) specOps.set(op.operationId, op);

function makeAjv(coerceTypes: boolean) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes });
  addFormats(ajv);
  ajv.addSchema({ $id: 'openapi', components: structuredClone(spec.components) });
  return ajv;
}
const ajvJson = makeAjv(false);
const ajvQuery = makeAjv(true); // query values arrive as strings
const validators = new Map<string, ValidateFunction>();
function validatorFor(key: string, schema: unknown, ajv = ajvJson): ValidateFunction {
  let v = validators.get(key);
  if (!v) {
    // Point the document-relative refs at the components registered above.
    v = ajv.compile(JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"openapi#/components/')));
    validators.set(key, v);
  }
  return v;
}

type Exchange = request.Response & { sentBody?: unknown };

/** Check one exchange against the published JSON Schema. */
function checkAgainstSpec(operationId: string, res: Exchange): void {
  const op = specOps.get(operationId)!;
  const status = String(res.status);
  const fail = (what: string, v: ValidateFunction, value: unknown) => {
    throw new Error(`${operationId} → ${status}: ${what}\n${ajvJson.errorsText(v.errors)}\nvalue: ${JSON.stringify(value)}`);
  };

  const resSchema = op.responses[status]?.content?.['application/json']?.schema;
  if (resSchema && res.type === 'application/json') {
    const v = validatorFor(`${operationId} response ${status}`, resSchema);
    if (!v(res.body)) fail('response body fails the published schema', v, res.body);
  }

  const reqSchema = op.requestBody?.content?.['application/json']?.schema;
  if (reqSchema && res.sentBody !== undefined) {
    const v = validatorFor(`${operationId} request`, reqSchema);
    const valid = v(res.sentBody);
    if (res.status < 300 && !valid) fail('the published schema rejects a body the route accepted', v, res.sentBody);
    if (res.status === 400 && res.body?.error === 'invalid_body' && valid) {
      throw new Error(`${operationId}: the published schema accepts a body the route rejected: ${JSON.stringify(res.sentBody)}`);
    }
  }

  const url = new URL((res as unknown as { request: { url: string } }).request.url);
  const params = (op.parameters ?? []).filter((p) => p.in === 'query' && url.searchParams.has(p.name));
  if (params.length > 0) {
    const results = params.map((p) => {
      const v = validatorFor(`${operationId} query ${p.name}`, { type: 'object', properties: { v: p.schema } }, ajvQuery);
      return v({ v: url.searchParams.get(p.name) });
    });
    if (res.status < 300 && results.includes(false)) {
      throw new Error(`${operationId}: the published schema rejects a query the route accepted: ${url.search}`);
    }
    if (res.status === 400 && res.body?.error === 'invalid_query' && !results.includes(false)) {
      throw new Error(`${operationId}: the published schema accepts a query the route rejected: ${url.search}`);
    }
  }
}

/** Assert `res` is something `operationId` documents, and return its body. */
function check<T = Record<string, unknown>>(operationId: string, res: Exchange): T {
  const op = operations.get(operationId);
  if (!op) throw new Error(`no documented operation ${operationId}`);
  exercised.add(operationId);
  checkAgainstSpec(operationId, res);
  if (String(res.status) in op.responses) {
    const schema = op.responses[res.status];
    if (schema) expectShape(schema, res.body, `${operationId} → ${res.status}`);
    return res.body as T;
  }
  const codes = op.errors[res.status];
  if (!codes) {
    throw new Error(`${operationId} returned undocumented status ${res.status}: ${JSON.stringify(res.body ?? res.text)}`);
  }
  if (op.textErrors) {
    // The code is the whole body (`invalid_parameters` adds `: <names>`).
    expect(res.type, `${operationId} → ${res.status} content type`).toBe('text/plain');
    expect(codes, `${operationId} → ${res.status} error code`).toContain(res.text.split(':')[0]);
    return res.text as T;
  }
  expectShape(ErrorResponse, res.body, `${operationId} → ${res.status}`);
  expect(codes, `${operationId} → ${res.status} error code`).toContain(res.body.error);
  return res.body as T;
}

/** Requests as one credential (null = none). JSON writes remember the body
 *  they sent, so check() can validate it against the spec. */
function as(key: string | null, target = app) {
  const auth = (t: request.Test) => (key ? t.set('Authorization', `Bearer ${key}`) : t);
  const withBody = (t: request.Test, body: object): Promise<Exchange> =>
    t.send(body).then((res) => Object.assign(res, { sentBody: body }));
  return {
    get: (path: string) => auth(request(target).get(path)),
    post: (path: string, body: object = {}) => withBody(auth(request(target).post(path)), body),
    put: (path: string, body: object) => withBody(auth(request(target).put(path)), body),
    patch: (path: string, body: object) => withBody(auth(request(target).patch(path)), body),
    delete: (path: string) => auth(request(target).delete(path)),
  };
}
const admin = as(ADMIN_KEY);
const anon = as(null);

// ---------- webhook receiver ----------

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
}
const received: Received[] = [];
/** Signing secret per receiver path, one per subscribed endpoint. */
const secrets: Record<string, string> = {};
let receiver: Server;
let receiverBase = '';

/** The verification the docs publish: HMAC over `<timestamp>.<raw body>`,
 *  constant-time compare of equal-length buffers, 5-minute window. */
function verify(raw: string, headers: IncomingHttpHeaders, secret: string): boolean {
  const ts = String(headers['x-openpartner-timestamp'] ?? '');
  const sig = String(headers['x-openpartner-signature'] ?? '');
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex'));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
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

let savedTenant: { payoutThresholdCents: unknown; couponIntegrationVerifiedAt: unknown } | undefined;

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  for (const t of TABLES_TO_CLEAN) await db(t).del();
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID }).whereIn('key', ['network_membership', 'partner_access', 'payout_statements', 'partner_referrals']).del();
  savedTenant = await db(TABLES.Tenant)
    .where({ id: DEFAULT_TENANT_ID })
    .first('payoutThresholdCents', 'couponIntegrationVerifiedAt');
  // Payouts of any size, and partner-minted coupons not held behind the
  // brand's "wire up redemption first" gate.
  await db(TABLES.Tenant)
    .where({ id: DEFAULT_TENANT_ID })
    .update({ payoutThresholdCents: 0, couponIntegrationVerifiedAt: new Date() });

  receiver = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, raw });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) await db(t).del();
    await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID }).whereIn('key', ['network_membership', 'partner_access', 'payout_statements', 'partner_referrals']).del();
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({
        payoutThresholdCents: savedTenant?.payoutThresholdCents ?? null,
        couponIntegrationVerifiedAt: savedTenant?.couponIntegrationVerifiedAt ?? null,
      });
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('documented API contract', () => {
  it('serves the headless referral flow exactly as documented', async () => {
    // --- Setup: a webhook endpoint, a private program, a scoped key.
    const hook = check<{ endpoint: { id: string }; secret: string }>(
      'createWebhookEndpoint',
      await admin.post('/webhooks', { url: `${receiverBase}/hook/main`, events: ['*'], label: 'contract' }),
    );
    secrets['/hook/main'] = hook.secret;

    check('getNetworkMembership', await admin.get('/config/network'));
    const membership = check<{ autoEnroll: boolean }>('updateNetworkMembership', await admin.post('/config/network', { autoEnroll: false }));
    expect(membership.autoEnroll).toBe(false);

    // Customers created without an invite can't sign in to the hosted portal.
    check('getPartnerAccessSettings', await admin.get('/config/partner-access'));
    const access = check<{ uninvitedPortalAccess: boolean }>(
      'updatePartnerAccessSettings',
      await admin.post('/config/partner-access', { uninvitedPortalAccess: false }),
    );
    expect(access.uninvitedPortalAccess).toBe(false);
    check('updatePartnerAccessSettings', await admin.post('/config/partner-access', { uninvitedPortalAccess: 'no' }));

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
        scopes: ['partners:create', 'partners:read', 'links:write', 'links:read', 'events:write', 'commissions:read', 'payouts:read'],
      }),
    );
    const integration = as(scoped.plaintext);
    check('listScopedKeys', await admin.get('/api-keys'));

    // --- First visit to the referral page: create the partner + link.
    const partner = check<{ id: string; activatedAt: string | null; invited: boolean; portalAccess: boolean }>(
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
    expect(partner.portalAccess).toBe(false);
    check('createPartner', await integration.post('/partners', { email: 'customer@example.com', name: 'Again', sendInvite: false }));
    // partners:create never sends an invite, even by default.
    const invite = check<{ required?: string }>('createPartner', await integration.post('/partners', { email: 'friend@example.com', name: 'Friend' }));
    expect(invite.required).toBe('partners:write');
    check('createPartner', await admin.post('/partners', { email: 'friend@example.com', name: 'Friend', portalAccess: false }));

    const found = check<{ partners: Array<{ id: string }> }>('listPartners', await integration.get('/partners?email=customer@example.com'));
    expect(found.partners.map((p) => p.id)).toEqual([partner.id]);
    check('listPartners', await integration.get('/partners?q=ada&limit=1'));
    check('listPartners', await integration.get('/partners?cursor=not-a-cursor'));
    check('getPartner', await integration.get(`/partners/${partner.id}`));
    check('invitePartner', await admin.post(`/partners/${partner.id}/invite`));
    check('updatePartner', await admin.patch(`/partners/${partner.id}`, { portalAccess: true }));
    const locked = check<{ portalAccess: boolean }>('updatePartner', await admin.patch(`/partners/${partner.id}`, { portalAccess: false }));
    expect(locked.portalAccess).toBe(false);
    check('updatePartner', await admin.patch(`/partners/${partner.id}`, { name: 'Renamed' }));
    check('updatePartner', await admin.patch('/partners/missing', { portalAccess: true }));

    // --- "Refer & earn" opens the hosted portal instead: the backend mints
    // a sign-in link and redirects the customer to it.
    check('createPartnerSigninLink', await admin.post(`/partners/${partner.id}/signin-link`)); // 409 portal_access_disabled
    check('updatePartner', await admin.patch(`/partners/${partner.id}`, { portalAccess: true }));
    const signinKey = as(
      check<{ plaintext: string }>('createScopedKey', await admin.post('/api-keys/scoped', { label: 'portal sso', scopes: ['partners:signin'] }))
        .plaintext,
    );
    check('createPartnerSigninLink', await signinKey.post(`/partners/${partner.id}/signin-link`, { returnTo: '/links' }));
    check('createPartnerSigninLink', await signinKey.post(`/partners/${partner.id}/signin-link`, { returnTo: 'https://evil.example' }));
    check('createPartnerSigninLink', await signinKey.post('/partners/missing/signin-link'));
    check('createPartnerSigninLink', await integration.post(`/partners/${partner.id}/signin-link`)); // 403 forbidden_scope
    check('lookupPartnerSigninLink', await signinKey.post('/partners/signin-link', { metadata: { appUserId: 'u_123' } }));
    check('lookupPartnerSigninLink', await signinKey.post('/partners/signin-link', { email: 'customer@example.com' }));
    check('lookupPartnerSigninLink', await signinKey.post('/partners/signin-link', {}));
    check('lookupPartnerSigninLink', await signinKey.post('/partners/signin-link', { email: 'nobody@example.com' }));
    check('updatePartner', await admin.patch(`/partners/${partner.id}`, { portalAccess: false }));

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
      fraudFlag: null,
      ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    check('ingestClick', await admin.post('/clicks', click));
    check('ingestClick', await admin.post('/clicks', click));

    // --- The friend signs up: the browser SDK's identify, then server-side events.
    const stitched = check<{ firstStitch: boolean }>('identify', await anon.post('/attribution/identify', { cref: clickId, userId: 'friend_1' }));
    expect(stitched.firstStitch).toBe(true);
    check('identify', await anon.post('/attribution/identify', { cref: 'missing', userId: 'friend_1' }));
    const landed = check<{ firstLanding: boolean }>('reportLanding', await anon.post('/attribution/landing', { cref: clickId }));
    expect(landed.firstLanding).toBe(true);
    check('reportLanding', await anon.post('/attribution/landing', { cref: 'missing' }));

    check('recordEvent', await integration.post('/attribution/events', { userId: 'friend_1', type: 'signup', externalEventId: 'signup:friend_1' }));
    const paid = { userId: 'friend_1', type: 'invoice_paid', value: 300, currency: 'USD', externalEventId: 'inv_1' };
    const first = check<{ attribution: { status: string } }>('recordEvent', await integration.post('/attribution/events', paid));
    expect(first.attribution.status).toBe('attributed');
    const replay = check<{ replayed?: boolean }>('recordEvent', await integration.post('/attribution/events', paid));
    expect(replay.replayed).toBe(true);
    check('recordEvent', await integration.post('/attribution/events', { ...paid, value: 1 }));
    check('recordEvent', await integration.post('/attribution/events', { userId: 'friend_1', type: 'invoice_paid', value: 120, externalEventId: 'inv_2' }));
    // Inputs the route treats specially, which the published schema must describe the same way:
    // a numeric idempotency key is accepted; a timestamp with an offset is not.
    check('recordEvent', await integration.post('/attribution/events', { userId: 'friend_1', type: 'demo_booked', externalEventId: 98765 }));
    const offset = await integration.post('/attribution/events', { userId: 'friend_1', type: 'demo_booked', ts: '2026-10-16T10:00:00+00:00' });
    expect(offset.status).toBe(400);
    check('recordEvent', offset);

    // --- The referral page renders stats + earnings.
    const dash = check<{ clicks: number; attributedEvents: number }>(
      'getPartnerDashboard',
      await integration.get(`/partners/${partner.id}/dashboard?includeLinks=true`),
    );
    expect(dash.clicks).toBe(1);
    check('getPartnerTimeseries', await integration.get(`/partners/${partner.id}/timeseries`));
    const offsetQuery = await integration.get(`/partners/${partner.id}/timeseries?since=2026-01-01T00:00:00%2B00:00`);
    expect(offsetQuery.status).toBe(400);
    check('getPartnerTimeseries', offsetQuery);
    const stats = check<{ programs: Array<{ programId: string; clicks: number }> }>('getProgramStats', await admin.get('/programs/stats'));
    expect(stats.programs.find((p) => p.programId === program.id)?.clicks).toBe(dash.clicks);
    check('getProgramStats', await admin.get('/programs/stats?since=2026-10-01T00:00:00Z&until=2026-09-01T00:00:00Z'));
    check('getProgramStats', await integration.get('/programs/stats'));
    check('listPartnerEvents', await integration.get(`/partners/${partner.id}/events?limit=10`));
    const customers = check<{ customers: Array<{ userId: string | null; referralId: string }> }>(
      'listPartnerCustomers',
      await integration.get(`/partners/${partner.id}/customers`),
    );
    expect(customers.customers[0]).toMatchObject({ userId: 'friend_1' });

    // --- Each referred customer's journey, through the stages the brand shows.
    check('getReferralSettings', await admin.get('/config/referrals'));
    const stagesSet = check<{ stages: Array<{ eventType: string }> }>(
      'updateReferralSettings',
      await admin.post('/config/referrals', {
        stages: [
          { eventType: 'demo_booked', label: 'Demo booked' },
          { eventType: 'invoice_paid', label: 'Paid' },
        ],
      }),
    );
    expect(stagesSet.stages.map((s) => s.eventType)).toEqual(['demo_booked', 'invoice_paid']);
    check('updateReferralSettings', await admin.post('/config/referrals', { stages: [{ eventType: 'refund', label: 'Refunded' }] }));
    check('updateReferralSettings', await admin.post('/config/referrals', { stages: [{ eventType: '', label: 'Empty' }] }));
    const referrals = check<{
      referrals: Array<{ referralId: string; userId?: string; stages: Array<{ eventType: string; count: number }>; commission: number }>;
      total: number;
    }>('listPartnerReferrals', await integration.get(`/partners/${partner.id}/referrals`));
    expect(referrals.total).toBe(1);
    expect(referrals.referrals[0]).toMatchObject({ userId: 'friend_1', referralId: customers.customers[0]!.referralId, commission: 42 });
    expect(referrals.referrals[0]!.stages.map((s) => [s.eventType, s.count])).toEqual([
      ['demo_booked', 1],
      ['invoice_paid', 2],
    ]);
    check('listPartnerReferrals', await integration.get(`/partners/${partner.id}/referrals?cursor=nope`));
    check('listPartnerReferrals', await integration.get('/partners/missing/referrals'));
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
    const accrued = check<{ commissions: Array<{ partnerName: string | null; eventType: string | null }> }>(
      'listCommissions',
      await integration.get('/commissions?status=accrued'),
    );
    expect(accrued.commissions[0]).toMatchObject({ partnerName: 'Ada Customer', eventType: expect.any(String) });

    // --- Admin side: approve, reverse, pay.
    check('approveCommission', await admin.post(`/commissions/${toApprove!.id}/approve`));
    check('approveCommission', await admin.post(`/commissions/${toApprove!.id}/approve`));
    check('reverseCommission', await admin.post(`/commissions/${toReverse!.id}/reverse`));
    const run = check<{ runId: string; payouts: Array<{ payoutId: string; method: string; partnerName: string | null }> }>(
      'runPayouts',
      await admin.post('/payouts/run'),
    );
    expect(run.payouts).toHaveLength(1);
    expect(run.payouts[0]).toMatchObject({ method: 'manual', partnerName: 'Ada Customer' });
    // Compliance holds are a hosted-platform control: a self-host holds no one.
    expect(check<{ holds: unknown[] }>('listPayoutHolds', await admin.get('/payouts/holds')).holds).toEqual([]);
    // The manual rail's batch files: the app saves the referrer's PayPal
    // email, and the brand downloads the run's PayPal file.
    const payoutKey = check<{ plaintext: string }>(
      'createScopedKey',
      await admin.post('/api-keys/scoped', { label: 'payout details', scopes: ['payout_profiles:write'] }),
    );
    const payoutDetails = as(payoutKey.plaintext);
    check('setPartnerPayoutProfile', await payoutDetails.put(`/partners/${partner.id}/payout-profile`, { method: 'paypal' }));
    check('setPartnerPayoutProfile', await payoutDetails.put(`/partners/${partner.id}/payout-profile`, { method: 'paypal', email: 'referrer@pay.example.com' }));
    const saved = check<{ profile: { summary: string }; paidVia: string }>(
      'getPartnerPayoutProfile',
      await payoutDetails.get(`/partners/${partner.id}/payout-profile`),
    );
    expect(saved).toMatchObject({ profile: { summary: 'PayPal r•••@pay.example.com' }, paidVia: 'manual' });
    check('getPartnerPayoutProfile', await admin.get('/partners/missing/payout-profile'));
    const runs = check<{ runs: Array<{ runId: string }> }>('listManualPayoutRuns', await admin.get('/payouts/runs?limit=10'));
    expect(runs.runs.map((r) => r.runId)).toContain(run.runId);
    check('listManualPayoutRuns', await admin.get('/payouts/runs?cursor=bm9wZQ'));
    const manual = check<{ ready: Array<{ provider: string; currency: string }> }>('getManualPayoutRun', await admin.get(`/payouts/runs/${run.runId}`));
    expect(manual.ready).toEqual([expect.objectContaining({ provider: 'paypal', count: 1 })]);
    check('getManualPayoutRun', await admin.get('/payouts/runs/missing'));
    check('listManualPayoutRunPayouts', await admin.get(`/payouts/runs/${run.runId}/payouts?limit=1`));
    check('listManualPayoutRunPayouts', await admin.get(`/payouts/runs/${run.runId}/payouts?cursor=%25`));
    check('listManualPayoutRunPayouts', await admin.get('/payouts/runs/missing/payouts'));
    // A file that never went out is discarded, then made again.
    const fileOf = (runId: string) => admin.post(`/payouts/runs/${runId}/exports`, { provider: 'paypal', currency: manual.ready[0]!.currency });
    const draft = check<{ export: { exportId: string } }>('createManualPayoutFile', await fileOf(run.runId));
    check('discardManualPayoutFile', await admin.post(`/payouts/exports/${draft.export.exportId}/discard`));
    check('discardManualPayoutFile', await admin.post(`/payouts/exports/${draft.export.exportId}/discard`));
    const made = check<{ export: { exportId: string }; csv: string }>('createManualPayoutFile', await fileOf(run.runId));
    expect(made.csv).toMatch(/^referrer@pay\.example\.com,/);
    check('createManualPayoutFile', await admin.post(`/payouts/runs/${run.runId}/exports`, { provider: 'wise', currency: 'USD' }));
    const redownload = await admin.get(`/payouts/exports/${made.export.exportId}.csv`);
    check('downloadManualPayoutFile', redownload);
    expect(redownload.text).toBe(made.csv);
    check('downloadManualPayoutFile', await admin.get('/payouts/exports/missing.csv'));
    // The manual rail: the commission is `paid` while its payout is still `pending` (docs, step 5).
    const planned = check<{ payouts: Array<{ id: string; status: string }> }>('listPartnerPayouts', await integration.get(`/partners/${partner.id}/payouts`));
    expect(planned.payouts[0]!.status).toBe('pending');
    const everyone = check<{ payouts: Array<{ id: string; partnerName: string | null }> }>(
      'listPayouts',
      await integration.get('/payouts?status=pending&limit=1'),
    );
    expect(everyone.payouts).toEqual([expect.objectContaining({ id: run.payouts[0]!.payoutId, partnerName: 'Ada Customer' })]);
    check('listPayouts', await admin.get('/payouts?cursor=bm9wZQ'));
    const afterRun = check<{ commissions: Array<{ id: string; status: string }> }>('listPartnerCommissions', await integration.get(`/partners/${partner.id}/commissions`));
    expect(afterRun.commissions.find((c) => c.id === toApprove!.id)?.status).toBe('paid');
    // A payment reference is one printable line of up to 100 characters;
    // the published schema must refuse what the route refuses.
    check('confirmManualPayout', await admin.post(`/payouts/${run.payouts[0]!.payoutId}/confirm`, { reference: `UTR${'9'.repeat(98)}` }));
    check('confirmManualPayout', await admin.post(`/payouts/${run.payouts[0]!.payoutId}/confirm`, { reference: 'UTR 1\nUTR 2' }));
    const confirmed = check<{ payout: { status: string; metadata: Record<string, unknown> } }>(
      'confirmManualPayout',
      await admin.post(`/payouts/${run.payouts[0]!.payoutId}/confirm`, { reference: 'NEFT UTR HDFCN52026102312345678' }),
    );
    expect(confirmed.payout).toMatchObject({ status: 'paid', metadata: { externalReference: 'NEFT UTR HDFCN52026102312345678' } });
    check('confirmManualPayout', await admin.post(`/payouts/${run.payouts[0]!.payoutId}/confirm`));
    check('confirmManualPayout', await admin.post('/payouts/missing/confirm', { reference: 'UTR123' }));

    // Its statement: a printable page for the brand, its data for the integration.
    check('getPayoutStatementSettings', await admin.get('/config/payout-statements'));
    const statementSettings = check<{ numberPrefix: string | null }>(
      'updatePayoutStatementSettings',
      await admin.post('/config/payout-statements', { legalName: 'Referral Co Pvt Ltd', numberPrefix: 'PS-', footer: '' }),
    );
    expect(statementSettings.numberPrefix).toBe('PS-');
    check('updatePayoutStatementSettings', await admin.post('/config/payout-statements', { numberPrefix: 'no spaces' }));
    const statementPage = await admin.get(`/payouts/${run.payouts[0]!.payoutId}/statement`);
    check('getPayoutStatement', statementPage);
    expect(statementPage.type).toBe('text/html');
    expect(statementPage.text).toContain(`PS-${run.payouts[0]!.payoutId}`);
    const statement = check<{ statement: { payout: { status: string } } }>(
      'getPayoutStatement',
      await integration.get(`/payouts/${run.payouts[0]!.payoutId}/statement?format=json`),
    );
    expect(statement.statement.payout.status).toBe('paid');
    check('getPayoutStatement', await admin.get(`/payouts/${run.payouts[0]!.payoutId}/statement?format=pdf`));
    check('getPayoutStatement', await admin.get('/payouts/missing/statement'));

    // --- A bonus for the referrer: a reward with no sale behind it.
    const bonusKey = check<{ plaintext: string }>(
      'createScopedKey',
      await admin.post('/api-keys/scoped', { label: 'contest bonuses', scopes: ['bonuses:write'] }),
    );
    const contest = as(bonusKey.plaintext);
    const prize = { partnerId: partner.id, programId: program.id, amount: 25, currency: 'USD', note: 'Top referrer in October', externalRef: 'contest-2026-10' };
    const awarded = check<{ bonus: { id: string }; commission: { id: string; status: string } }>('awardBonus', await contest.post('/bonuses', prize));
    expect(awarded.commission.status).toBe('approved');
    const again = check<{ replayed?: boolean; bonus: { id: string } }>('awardBonus', await contest.post('/bonuses', prize));
    expect(again).toMatchObject({ replayed: true, bonus: { id: awarded.bonus.id } });
    check('awardBonus', await contest.post('/bonuses', { ...prize, amount: 30 }));
    check('awardBonus', await contest.post('/bonuses', { partnerId: 'missing', amount: 5, currency: 'USD' }));
    check('awardBonus', await contest.post('/bonuses', { partnerId: partner.id, amount: 1.005, currency: 'USD' }));
    const held = check<{ commission: { id: string } }>(
      'awardBonus',
      await admin.post('/bonuses', { partnerId: partner.id, amount: 5, currency: 'USD', hold: true }),
    );
    check('reverseCommission', await admin.post(`/commissions/${held.commission.id}/reverse`));
    check('listBonuses', await integration.get(`/bonuses?partnerId=${partner.id}&limit=1`));
    check('listBonuses', await admin.get('/bonuses?cursor=not-a-cursor'));
    check('getBonus', await admin.get(`/bonuses/${awarded.bonus.id}`));
    check('getBonus', await admin.get('/bonuses/missing'));
    const withBonus = check<{ commissions: Array<{ id: string; source: string }> }>(
      'listPartnerCommissions',
      await integration.get(`/partners/${partner.id}/commissions`),
    );
    expect(withBonus.commissions.find((c) => c.id === awarded.commission.id)?.source).toBe('bonus');
    const bonusRun = check<{ runId: string; payouts: Array<{ payoutId: string; amount: number }> }>('runPayouts', await admin.post('/payouts/run'));
    expect(bonusRun.payouts.map((p) => p.amount)).toEqual([25]);
    // The brand's PayPal batch went out: confirm exactly what's in the file.
    const bonusFile = check<{ export: { exportId: string; payoutIds: string[] } }>('createManualPayoutFile', await fileOf(bonusRun.runId));
    expect(bonusFile.export.payoutIds).toEqual([bonusRun.payouts[0]!.payoutId]);
    const sent = check<{ confirmed: Array<{ id: string }> }>('confirmManualPayoutFile', await admin.post(`/payouts/exports/${bonusFile.export.exportId}/confirm`));
    expect(sent.confirmed.map((p) => p.id)).toEqual(bonusFile.export.payoutIds);
    check('confirmManualPayoutFile', await admin.post(`/payouts/exports/${bonusFile.export.exportId}/confirm`));
    const bulk = check<{ confirmed: unknown[]; notConfirmable: unknown[] }>(
      'confirmManualPayouts',
      await admin.post('/payouts/confirm', { payoutIds: [bonusRun.payouts[0]!.payoutId, 'missing'] }),
    );
    expect([bulk.confirmed.length, bulk.notConfirmable.length]).toEqual([0, 2]);
    check('confirmManualPayouts', await admin.post('/payouts/confirm', { payoutIds: [] }));
    check('deletePartnerPayoutProfile', await payoutDetails.delete(`/partners/${partner.id}/payout-profile`));
    check('deletePartnerPayoutProfile', await payoutDetails.delete(`/partners/${partner.id}/payout-profile`));
    // Not connected to the Network here.
    check('authorizeNetworkBonuses', await admin.post('/config/network/authorize-bonuses'));

    // --- A Network approval, for partnership.approved.
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
      'bonus.awarded',
      'bonus.approved',
      'bonus.reversed',
      'bonus.paid',
    ]);
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

    // Program grants. Ungranted programs carry grantSource: null.
    const grants = check<{ programs: Array<{ grantSource: string | null }> }>('listPartnerPrograms', await admin.get(`/partners/${other.id}/programs`));
    expect(grants.programs.some((p) => p.grantSource === null)).toBe(true);
    check('grantPartnerPrograms', await admin.post(`/partners/${other.id}/programs`, { programIds: [program.id] }));
    check('revokePartnerProgram', await admin.delete(`/partners/${other.id}/programs/${program.id}`));
    check('revokePartnerProgram', await admin.delete(`/partners/${other.id}/programs/${program.id}`));
    await admin.post(`/partners/${other.id}/programs`, { programIds: [program.id] });

    // Commission override.
    check('getPartnerCommissionOverride', await admin.get(`/partners/${other.id}/commission-snapshot`));
    check('setPartnerCommissionOverride', await admin.put(`/partners/${other.id}/commission-snapshot`, { commissionType: 'percent', commissionValue: 30 }));
    check('getPartnerCommissionOverride', await admin.get(`/partners/${other.id}/commission-snapshot`));
    check('clearPartnerCommissionOverride', await admin.delete(`/partners/${other.id}/commission-snapshot`));
    check('getPartnerProgramCommission', await admin.get(`/partners/${other.id}/programs/${program.id}/commission`));
    check('setPartnerProgramCommission', await admin.put(`/partners/${other.id}/programs/${program.id}/commission`, { commissionType: 'percent', commissionValue: 25 }));
    check('setPartnerProgramCommission', await admin.put(`/partners/${other.id}/programs/nope/commission`, { commissionType: 'percent', commissionValue: 25 }));
    check('getPartnerProgramCommission', await admin.get(`/partners/${other.id}/programs/${program.id}/commission`));
    check('clearPartnerProgramCommission', await admin.delete(`/partners/${other.id}/programs/${program.id}/commission`));

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
    check('getPartner', await anon.get(`/partners/${other.id}`));

    // Coupons.
    const coupon = check<{ id: string; code: string }>('createPartnerCoupon', await admin.post(`/partners/${other.id}/coupons`, { programId: program.id, code: 'OTHER10' }));
    check('createPartnerCoupon', await asPartner.post(`/partners/${other.id}/coupons`, { programId: program.id }));
    const redemption = { code: 'other10', eventType: 'invoice_paid', value: 40, externalEventId: 'order_9', userId: 'buyer_9' };
    check('redeemCoupon', await admin.post('/coupons/redeem', redemption));
    check('redeemCoupon', await admin.post('/coupons/redeem', redemption));
    check('redeemCoupon', await admin.post('/coupons/redeem', { ...redemption, externalEventId: 'order_10', code: 'NOPE-NOPE' }));
    check('listPartnerCoupons', await admin.get(`/partners/${other.id}/coupons`));
    check('deactivatePartnerCoupon', await admin.delete(`/partners/${other.id}/coupons/${coupon.id}`));

    // One-call conversions against a click, with and without the sender's userId.
    const otherLink = check<{ linkKey: string }>(
      'createPartnerLink',
      await admin.post(`/partners/${other.id}/links`, { linkKey: 'other-loans', programId: program.id }),
    );
    const loanClick = ulid();
    check(
      'ingestClick',
      await admin.post('/clicks', { id: loanClick, linkKey: otherLink.linkKey, landingUrl: 'https://app.example.com/signup', fraudFlag: null, ts: new Date().toISOString() }),
    );
    const loan = { clickId: loanClick, type: 'invoice_paid', value: 80, currency: 'USD', externalEventId: 'loan_1' };
    const converted = check<{ eventId: string; attribution: { status: string } }>('recordConversion', await admin.post('/attribution/conversions', loan));
    expect(converted.attribution.status).toBe('attributed');
    const replayedLoan = check<{ replayed?: boolean }>('recordConversion', await admin.post('/attribution/conversions', loan));
    expect(replayedLoan.replayed).toBe(true);
    check('recordConversion', await admin.post('/attribution/conversions', { ...loan, value: 81 }));
    check('recordConversion', await admin.post('/attribution/conversions', { ...loan, clickId: 'nope', externalEventId: 'loan_2' }));
    check('recordConversion', await admin.post('/attribution/conversions', { clickId: loanClick, type: 'signup', externalEventId: 4242, userId: 'borrower_1' }));

    // Refunds of that conversion (a $5 fixed commission on 80.00): part of
    // it, a replay, the misuses, then a chargeback of the rest.
    const part = { conversionExternalEventId: 'loan_1', amount: 20, reason: 'partial refund', externalEventId: 'refund_1' };
    const reduced = check<{ fullRefund: boolean; commissions: Array<{ status: string; keptAmount: string }> }>(
      'recordRefund',
      await admin.post('/attribution/refunds', part),
    );
    expect(reduced.fullRefund).toBe(false);
    expect(reduced.commissions.map((c) => [c.status, c.keptAmount])).toEqual([['reduced', '3.75']]);
    expect(check<{ replayed?: boolean }>('recordRefund', await admin.post('/attribution/refunds', part)).replayed).toBe(true);
    check('recordRefund', await admin.post('/attribution/refunds', { ...part, amount: 21 }));
    check('recordRefund', await admin.post('/attribution/refunds', { ...part, amount: 61, externalEventId: 'refund_2' }));
    check('recordRefund', await admin.post('/attribution/refunds', { conversionExternalEventId: 'nope', externalEventId: 'refund_2' }));
    check('recordRefund', await admin.post('/attribution/refunds', { conversionExternalEventId: 'loan_1', conversionEventId: converted.eventId, externalEventId: 'refund_2' }));
    const rest = check<{ fullRefund: boolean; kind: string }>(
      'recordRefund',
      await admin.post('/attribution/refunds', { conversionEventId: converted.eventId, kind: 'chargeback', externalEventId: 9001 }),
    );
    expect(rest).toMatchObject({ fullRefund: true, kind: 'chargeback' });
    check('recordRefund', await admin.post('/attribution/refunds', { conversionExternalEventId: 'loan_1', externalEventId: 'refund_3' }));
    // The same, as a postback URL: token in the query, plain-text answers.
    check('getConversionPostbackToken', await admin.get('/conversion-postback')); // none yet
    check('updateConversionPostbackAllowlist', await admin.patch('/conversion-postback', { ipAllowlist: [] })); // 404
    const minted = check<{ plaintext: string }>(
      'rotateConversionPostbackToken',
      await admin.post('/conversion-postback/token', { ipAllowlist: ['203.0.113.0/24'] }),
    );
    check('updateConversionPostbackAllowlist', await admin.patch('/conversion-postback', { ipAllowlist: [] }));
    check('getConversionPostbackToken', await admin.get('/conversion-postback'));
    const postback = (query: Record<string, string>) => anon.get('/postback').query(query);
    const pb = { click_id: loanClick, type: 'loan_funded', amount: '120.00', currency: 'USD', txn_id: 'pb_1', token: minted.plaintext };
    const recorded = await postback(pb);
    check('conversionPostback', recorded);
    expect(recorded.text).toBe('ok attributed');
    check('conversionPostback', await postback(pb)); // replay
    const pixel = await postback({ ...pb, txn_id: 'pb_2', pixel: '1', amount: '' });
    check('conversionPostback', pixel);
    expect(pixel.type).toBe('image/gif');
    check('conversionPostback', await postback({ ...pb, amount: '121.00' })); // 409
    check('conversionPostback', await postback({ ...pb, click_id: 'nope', txn_id: 'pb_3' })); // 404
    check('conversionPostback', await postback({ ...pb, txn_id: '', type: '' })); // 400 invalid_parameters
    check('conversionPostback', await postback({ ...pb, token: 'opcp_not_a_token' })); // 401
    const { token: _token, ...noToken } = pb;
    check('conversionPostback', await postback(noToken)); // 401
    check('conversionPostback', await postback({ ...pb, token: ADMIN_KEY })); // an API key is no postback token
    check('listUnmatchedEventTypes', await admin.get('/attribution/unmatched-event-types'));
    check('revokeConversionPostbackToken', await admin.delete('/conversion-postback/token'));
    check('revokeConversionPostbackToken', await admin.delete('/conversion-postback/token')); // nothing live

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

    // Pay with PayPal, against a fake PayPal.
    const fake = new FakePaypal();
    fake.addApp({ env: 'live', clientId: 'ContractClientId0123456789', secret: 'ContractSecret0123456789' });
    __setPaypalFetchForTests(fake.fetch);
    try {
      check('listPaypalConnections', await admin.get('/config/paypal'));
      check('connectPaypal', await admin.post('/config/paypal', { environment: 'live', clientId: 'x' }));
      check('connectPaypal', await admin.post('/config/paypal', { environment: 'live', clientId: 'ContractClientId0123456789', clientSecret: 'WrongSecret0123456789' }));
      check('connectPaypal', await admin.post('/config/paypal', { environment: 'live', clientId: 'ContractClientId0123456789', clientSecret: 'ContractSecret0123456789' }));
      check('verifyPaypalConnection', await admin.post('/config/paypal/live/verify'));
      check('verifyPaypalConnection', await admin.post('/config/paypal/sandbox/verify'));
      check('activatePaypalEnvironment', await admin.post('/config/paypal/live/activate'));
      check('activatePaypalEnvironment', await admin.post('/config/paypal/sandbox/activate'));

      const ppRun = ulid();
      const ppPartner = ulid();
      await db(TABLES.Partner).insert({ id: ppPartner, tenantId: DEFAULT_TENANT_ID, name: 'PayPal partner', email: 'pp@example.com', activatedAt: new Date() });
      const details = parsePayoutDetails({ method: 'paypal', email: 'pp@pay.example.com' });
      if (!details.ok) throw new Error('bad fixture');
      await savePayoutProfile(db, DEFAULT_TENANT_ID, ppPartner, details.details, 'admin');
      const ppPayout = ulid();
      await db(TABLES.Payout).insert({
        id: ppPayout,
        tenantId: DEFAULT_TENANT_ID,
        partnerId: ppPartner,
        amount: '12.00',
        currency: 'USD',
        method: 'manual',
        status: 'pending',
        metadata: { runId: ppRun, commissionCount: 1 },
      });
      check('sendRunWithPaypal', await admin.post(`/payouts/runs/${ppRun}/paypal-batches`, { currency: 'nope' }));
      check('sendRunWithPaypal', await admin.post(`/payouts/runs/${ppRun}/paypal-batches`, { currency: 'INR' }));
      check('sendRunWithPaypal', await admin.post('/payouts/runs/missing/paypal-batches', { currency: 'USD' }));
      const ppSent = check<{ batch: { batchId: string } }>('sendRunWithPaypal', await admin.post(`/payouts/runs/${ppRun}/paypal-batches`, { currency: 'USD' }));
      const ppBatch = ppSent.batch.batchId;
      check('listRunPaypalBatches', await admin.get(`/payouts/runs/${ppRun}/paypal-batches`));
      check('getPaypalBatch', await admin.get(`/payouts/paypal-batches/${ppBatch}`));
      check('getPaypalBatch', await admin.get('/payouts/paypal-batches/missing'));
      check('disconnectPaypal', await admin.delete('/config/paypal/live')); // 409: in flight
      fake.setItem(ppBatch, ppPayout, 'UNCLAIMED', 'RECEIVER_UNREGISTERED');
      check('syncPaypalBatch', await admin.post(`/payouts/paypal-batches/${ppBatch}/sync`));
      check('syncPaypalBatch', await admin.post('/payouts/paypal-batches/missing/sync'));
      check('getManualPayoutRun', await admin.get(`/payouts/runs/${ppRun}`));
      check('listManualPayoutRunPayouts', await admin.get(`/payouts/runs/${ppRun}/payouts`));
      check('resolvePaypalBatch', await admin.post(`/payouts/paypal-batches/${ppBatch}/resolve`, { action: 'release' })); // 409: PayPal has it
      check('resolvePaypalBatch', await admin.post(`/payouts/paypal-batches/${ppBatch}/resolve`, { action: 'nope' }));
      check('resolvePaypalBatch', await admin.post('/payouts/paypal-batches/missing/resolve', { action: 'release' }));
      check('cancelUnclaimedPaypalPayout', await admin.post(`/payouts/${ppPayout}/paypal-cancel`));
      check('cancelUnclaimedPaypalPayout', await admin.post(`/payouts/${ppPayout}/paypal-cancel`));

      // INR through Pay with PayPal in USD, at a quoted ECB rate.
      const ecb = stubEcbFetch('ok');
      const inrRun = ulid();
      const inrPayout = ulid();
      try {
        check('getPaypalPayoutSettings', await admin.get('/config/paypal-payouts'));
        check('updatePaypalPayoutSettings', await admin.post('/config/paypal-payouts', { sendUnsupportedAs: 'EUR' }));
        await db(TABLES.Payout).insert({
          id: inrPayout,
          tenantId: DEFAULT_TENANT_ID,
          partnerId: ppPartner,
          amount: '1500.00',
          currency: 'INR',
          method: 'manual',
          status: 'pending',
          metadata: { runId: inrRun, commissionCount: 1 },
        });
        check('quotePaypalConversion', await admin.post(`/payouts/runs/${inrRun}/paypal-batches/quote`, { currency: 'INR', sendAs: 'USD' })); // 409: off
        check('updatePaypalPayoutSettings', await admin.post('/config/paypal-payouts', { sendUnsupportedAs: 'USD' }));
        check('getManualPayoutRun', await admin.get(`/payouts/runs/${inrRun}`));
        check('listManualPayoutRunPayouts', await admin.get(`/payouts/runs/${inrRun}/payouts`));
        check('quotePaypalConversion', await admin.post(`/payouts/runs/${inrRun}/paypal-batches/quote`, { currency: 'INR' }));
        check('quotePaypalConversion', await admin.post(`/payouts/runs/${inrRun}/paypal-batches/quote`, { currency: 'USD', sendAs: 'USD' }));
        check('quotePaypalConversion', await admin.post(`/payouts/runs/${ulid()}/paypal-batches/quote`, { currency: 'INR', sendAs: 'USD' }));
        const quoted = check<{ quote: { quoteId: string } }>(
          'quotePaypalConversion',
          await admin.post(`/payouts/runs/${inrRun}/paypal-batches/quote`, { currency: 'INR', sendAs: 'USD' }),
        );
        check('sendRunWithPaypal', await admin.post(`/payouts/runs/${inrRun}/paypal-batches`, { currency: 'INR', sendAs: 'USD' }));
        check('sendRunWithPaypal', await admin.post(`/payouts/runs/${inrRun}/paypal-batches`, { currency: 'USD', sendAs: 'USD', quoteId: quoted.quote.quoteId }));
        const inrSent = check<{ batch: { batchId: string } }>(
          'sendRunWithPaypal',
          await admin.post(`/payouts/runs/${inrRun}/paypal-batches`, { currency: 'INR', sendAs: 'USD', quoteId: quoted.quote.quoteId }),
        );
        check('sendRunWithPaypal', await admin.post(`/payouts/runs/${inrRun}/paypal-batches`, { currency: 'INR', sendAs: 'USD', quoteId: quoted.quote.quoteId })); // 409: spent
        check('getPaypalBatch', await admin.get(`/payouts/paypal-batches/${inrSent.batch.batchId}`));
        check('listManualPayoutRunPayouts', await admin.get(`/payouts/runs/${inrRun}/payouts`));
        check('listPartnerPayouts', await admin.get(`/partners/${ppPartner}/payouts`));
        check('listPayouts', await admin.get('/payouts'));
        ecb.serve('down');
        check('quotePaypalConversion', await admin.post(`/payouts/runs/${inrRun}/paypal-batches/quote`, { currency: 'INR', sendAs: 'USD' })); // 503
        check('updatePaypalPayoutSettings', await admin.post('/config/paypal-payouts', { sendUnsupportedAs: null }));
      } finally {
        ecb.restore();
        // The batch is in flight at the fake PayPal; leave nothing pinning the app.
        await db(TABLES.Payout).where({ id: inrPayout }).del();
        await db(TABLES.PaypalPayoutBatch).where({ runId: inrRun }).del();
        await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'paypal_payouts' }).del();
      }
      check('disconnectPaypal', await admin.delete('/config/paypal/live'));
      check('disconnectPaypal', await admin.delete('/config/paypal/live'));
      await db(TABLES.Payout).where({ id: ppPayout }).del();
    } finally {
      __setPaypalFetchForTests(null);
    }

    // Export round trip.
    const bundle = check<Record<string, unknown>>('exportAllJson', await admin.get('/export.json'));
    check('exportTable', await admin.get('/export/Partner.json'));
    check('exportTable', await admin.get('/export/Partner.csv'));
    check('exportTable', await admin.get('/export/Nope.json'));
    check('exportAllSql', await admin.get('/export.sql'));
    check('importBundle', await admin.post('/import', bundle));
    check('importBundle', await admin.post('/import', { ...bundle, schemaVersion: 999 }));
  });

  it("enforces every operation's documented access, credential by credential", async () => {
    // Its own app instance: this sweep makes a few hundred calls and must
    // not spend the per-IP budget of the app the other tests use.
    const target = createApp({ enableLogger: false });
    const adm = as(ADMIN_KEY, target);
    const program = (await adm.post('/programs', {
      name: 'Matrix',
      destinationUrl: 'https://app.example.com/',
      commissionRule: [{ trigger: 'every', type: 'percent', value: 10 }],
      shareOnNetwork: false,
      partnersMayCustomizeCode: true,
    })).body as { id: string };
    const own = (await adm.post('/partners', { email: 'matrix-own@example.com', name: 'Own', sendInvite: false, programIds: [program.id] })).body as { id: string };
    const other = (await adm.post('/partners', { email: 'matrix-other@example.com', name: 'Other', sendInvite: false, programIds: [] })).body as { id: string };
    const ownKey = (await adm.post(`/partners/${own.id}/api-keys`)).body.plaintext as string;
    const allScopes = [...new Set([...operations.values()].flatMap((op) => accessExtension(op.access).scopes))];
    const scopeKey: Record<string, string> = {};
    for (const s of allScopes) scopeKey[s] = (await adm.post('/api-keys/scoped', { scopes: [s] })).body.plaintext;
    const noneKey = (await adm.post('/api-keys/scoped', { scopes: ['none:none'] })).body.plaintext as string;

    const failures: string[] = [];
    type Outcome = { status: number; error?: string };
    const call = async (op: { method: string; path: string }, key: string | null, partnerId: string): Promise<Outcome> => {
      // Unknown ids keep the allowed calls harmless: they stop at a 400 or 404.
      const path = op.path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) =>
        name === 'id' ? partnerId : name === 'table' ? 'Partner' : name === 'format' ? 'json' : 'missing',
      );
      let t = (request(target) as unknown as Record<string, (p: string) => request.Test>)[op.method]!(path);
      if (key) t = t.set('Authorization', `Bearer ${key}`);
      const res = op.method === 'get' || op.method === 'delete' ? await t : await t.send({});
      return { status: res.status, error: res.body?.error };
    };
    const isDenied = (r: Outcome) => r.status === 401 || (r.status === 403 && (r.error === 'forbidden' || r.error === 'forbidden_scope'));
    const want = (label: string, ok: boolean, r: Outcome) => {
      if (!ok) failures.push(`${label}: got ${r.status} ${r.error ?? ''}`);
    };

    for (const op of operations.values()) {
      if (op.access.kind === 'handler') continue; // per-operation cases below
      const name = `${op.method.toUpperCase()} ${op.path}`;
      const ext = accessExtension(op.access);
      const anonymous = await call(op, null, 'missing');
      if (op.access.kind === 'public') {
        want(`${name} without a key`, !isDenied(anonymous), anonymous);
        continue;
      }
      if (op.access.kind === 'postbackToken') {
        // Only the postback token opens it: no API key does, the admin's included.
        want(`${name} without a token`, anonymous.status === 401, anonymous);
        for (const [label, key] of [['the admin key', ADMIN_KEY], ['a scoped key', noneKey], ['a partner key', ownKey]] as const) {
          const r = await call(op, key, own.id);
          want(`${name} with ${label} and no token`, r.status === 401, r);
        }
        continue;
      }
      want(`${name} without a key`, anonymous.status === 401, anonymous);
      const noScope = await call(op, noneKey, 'missing');
      want(`${name} with a scoped key lacking its scope`, noScope.status === 403 && noScope.error === (ext.scopes.length ? 'forbidden_scope' : 'forbidden'), noScope);
      for (const s of ext.scopes) {
        const r = await call(op, scopeKey[s]!, 'missing');
        want(`${name} with a ${s} key`, !isDenied(r), r);
      }
      const asOwn = await call(op, ownKey, own.id);
      if (op.access.kind === 'partnerOrAdmin') {
        want(`${name} with the partner's own key`, !isDenied(asOwn), asOwn);
        const asOther = await call(op, ownKey, other.id);
        want(`${name} with a partner key on another partner`, asOther.status === 403 && asOther.error === 'forbidden', asOther);
      } else {
        want(`${name} with a partner key`, asOwn.status === 403 && asOwn.error === 'forbidden', asOwn);
      }
    }
    expect(failures).toEqual([]);

    // Operations whose handler decides, with every credential they document.
    const writer = as(scopeKey['partners:write']!, target);
    const ownPartner = as(ownKey, target);
    const scopedOnly = as(noneKey, target);
    const status = (opId: string, res: Exchange, expected: number) => {
      check(opId, res);
      expect(res.status, `${opId}`).toBe(expected);
      return res.body;
    };
    status('listMyPrograms', await ownPartner.get('/me/programs'), 200);
    status('listMyPrograms', await scopedOnly.get('/me/programs'), 403);
    status('listMyPrograms', await as(null, target).get('/me/programs'), 401);

    expect(status('introspectKey', await writer.get('/auth/introspect'), 200)).toEqual({ role: 'scoped', scopes: ['partners:write'] });
    expect(status('introspectKey', await ownPartner.get('/auth/introspect'), 200)).toEqual({ role: 'partner', restrictedTo: { partnerId: own.id } });
    expect(status('introspectKey', await adm.get('/auth/introspect'), 200)).toEqual({ role: 'admin', unrestricted: true });
    status('introspectKey', await as(null, target).get('/auth/introspect'), 401);

    // The program lets partners pick codes, so a partners:write key and the partner itself may mint and retire them.
    const viaScope = status('createPartnerCoupon', await writer.post(`/partners/${own.id}/coupons`, { programId: program.id }), 201) as { id: string };
    const viaPartner = status('createPartnerCoupon', await ownPartner.post(`/partners/${own.id}/coupons`, { programId: program.id }), 201) as { id: string };
    status('createPartnerCoupon', await scopedOnly.post(`/partners/${own.id}/coupons`, { programId: program.id }), 403);
    status('createPartnerCoupon', await ownPartner.post(`/partners/${other.id}/coupons`, { programId: program.id }), 403);
    status('deactivatePartnerCoupon', await writer.delete(`/partners/${own.id}/coupons/${viaScope.id}`), 200);
    status('deactivatePartnerCoupon', await ownPartner.delete(`/partners/${own.id}/coupons/${viaPartner.id}`), 200);
    status('deactivatePartnerCoupon', await scopedOnly.delete(`/partners/${own.id}/coupons/${viaPartner.id}`), 403);

    // A payout statement: any payout for an admin or a payouts:read key, a partner's own only.
    const ownPayout = ulid();
    await db(TABLES.Payout).insert({
      id: ownPayout,
      tenantId: DEFAULT_TENANT_ID,
      partnerId: own.id,
      amount: '10.00',
      currency: 'USD',
      method: 'manual',
      status: 'pending',
      metadata: {},
    });
    const statementOf = `/payouts/${ownPayout}/statement?format=json`;
    status('getPayoutStatement', await ownPartner.get(statementOf), 200);
    status('getPayoutStatement', await as(scopeKey['payouts:read']!, target).get(statementOf), 200);
    const otherPartner = as((await adm.post(`/partners/${other.id}/api-keys`)).body.plaintext as string, target);
    status('getPayoutStatement', await otherPartner.get(statementOf), 404);
    status('getPayoutStatement', await scopedOnly.get(statementOf), 403);
    status('getPayoutStatement', await as(null, target).get(statementOf), 401);

    const othersKey = (await adm.post(`/partners/${other.id}/api-keys`)).body as { id: string };
    const ownSpare = (await adm.post(`/partners/${own.id}/api-keys`)).body as { id: string };
    status('revokeKey', await ownPartner.delete(`/api-keys/${othersKey.id}`), 403);
    status('revokeKey', await scopedOnly.delete(`/api-keys/${ownSpare.id}`), 403);
    status('revokeKey', await ownPartner.delete(`/api-keys/${ownSpare.id}`), 200);
  }, 60_000);

  it('delivers every documented webhook, signed and shaped as documented', async () => {
    // A fresh endpoint (the first was unsubscribed above), then an invited
    // partner accepting their magic link, for partner.activated, and a
    // join-page applicant approved automatically, for the join_page shape
    // of both partner events.
    const hook = check<{ endpoint: { id: string }; secret: string }>(
      'createWebhookEndpoint',
      await admin.post('/webhooks', { url: `${receiverBase}/hook/second`, events: ['partner.created', 'partner.activated'] }),
    );
    // Rotate it before anything fires: every delivery below must verify
    // with the new secret, and none with the one creation returned.
    const rotated = check<{ secret: string }>('rotateWebhookSecret', await admin.post(`/webhooks/${hook.endpoint.id}/secret`));
    expect(rotated.secret).not.toBe(hook.secret);
    check('rotateWebhookSecret', await admin.post('/webhooks/missing/secret'));
    secrets['/hook/second'] = rotated.secret;
    const id = ulid();
    await db(TABLES.Partner).insert({ id, tenantId: DEFAULT_TENANT_ID, email: 'invitee@example.com', name: 'Invitee', metadata: {}, activatedAt: null });
    const link = await issueMagicLink(db, {
      tenantId: DEFAULT_TENANT_ID,
      email: 'invitee@example.com',
      purpose: 'partner_invite',
      principalKind: 'partner',
      principalId: id,
    });
    expect((await request(app).post('/auth/magic/verify').send({ token: link.plaintext })).status).toBe(200);
    const joined = await request(app)
      .post('/partner-signup')
      .send({
        email: 'applicant@example.com',
        name: 'Applicant',
        application: {
          websiteUrl: 'https://applicant.example',
          socialUrls: ['https://instagram.com/applicant'],
          audienceSize: '1k_10k',
          pitch: 'I run a weekly newsletter for designers and would feature the product in a deep-dive issue.',
        },
      });
    expect(joined.status).toBe(201);

    await waitForEvents(Object.keys(WEBHOOK_PAYLOADS));
    // Those types already arrived on the first endpoint, so wait for the
    // join-page deliveries themselves.
    const deadline = Date.now() + 8000;
    const joinPage = () =>
      received.filter((r) => r.path === '/hook/second' && (JSON.parse(r.raw) as { data: { source?: string } }).data.source === 'join_page');
    while (joinPage().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(joinPage().map((r) => (JSON.parse(r.raw) as { event: string }).event).sort()).toEqual(['partner.activated', 'partner.created']);
    for (const r of received) {
      const secret = secrets[r.path];
      expect(secret, `delivery to ${r.path}`).toBeDefined();
      expect(verify(r.raw, r.headers, secret!), `${r.path} signature`).toBe(true);
      const envelope = JSON.parse(r.raw) as { id: string; event: keyof typeof WEBHOOK_PAYLOADS; data: Record<string, unknown> };
      expect(r.headers['x-openpartner-event']).toBe(envelope.event);
      expect(r.headers['x-openpartner-delivery']).toBe(envelope.id);
      // Test fires add two markers to the real shape; strip them.
      const { _synthetic, _endpointId, ...data } = envelope.data;
      expectShape(envelopeSchema(envelope.event, WEBHOOK_PAYLOADS[envelope.event]), { ...envelope, data }, `${envelope.event} webhook`);
    }
  }, 30_000);

  it('serves the reference and tenant routing as documented', async () => {
    // /docs/ (trailing slash) would resolve the relative spec URL wrongly.
    const slash = await request(app).get('/docs/');
    expect(slash.status).toBe(301);
    expect(slash.headers.location).toBe('../docs');
    const docs = await request(app).get('/docs');
    expect(docs.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(docs.headers['content-security-policy']).toContain('script-src https://cdn.jsdelivr.net/npm/redoc@');
    const json = await request(app).get('/openapi.json');
    expect(json.headers['access-control-allow-origin']).toBe('*');

    const tenant = { id: 'openapi-contract-tenant', slug: 'openapi-contract', customDomain: 'partners.openapi-contract.test' };
    await db(TABLES.Tenant).insert({ ...tenant, displayName: 'Contract', status: 'active' }).onConflict('id').merge();
    process.env.OPENPARTNER_TENANCY = 'multi';
    try {
      expect((await request(app).get(`/t/${tenant.slug}/docs`)).status).toBe(200);
      expect((await request(app).get(`/api/t/${tenant.slug}/openapi.json`)).status).toBe(200);
      // White-label domains don't show the OpenPartner-branded reference.
      expect((await request(app).get('/docs').set('Host', tenant.customDomain)).status).toBe(404);
      expect((await request(app).get('/openapi.json').set('Host', tenant.customDomain)).status).toBe(404);
      // No /t/<slug>: a 400 that says where the slug goes, even on the unauthenticated identify.
      const slugless = check<{ error: string; detail: string }>('identify', await anon.post('/attribution/identify', { cref: 'x', userId: 'u' }));
      expect(slugless.error).toBe('tenant_slug_missing');
      expect(slugless.detail).toContain('/api/t/<your-slug>/');
    } finally {
      process.env.OPENPARTNER_TENANCY = 'single';
      await db(TABLES.Tenant).where({ id: tenant.id }).del();
    }
  });

  it('exercised every documented operation', () => {
    const missed = [...operations.keys()].filter((id) => !exercised.has(id));
    expect(missed).toEqual([]);
  });
});
