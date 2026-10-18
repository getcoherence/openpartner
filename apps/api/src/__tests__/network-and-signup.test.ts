/**
 * End-to-end tests for partner Network consent and every push path.
 *
 * Spins up a local HTTP receiver in-process to act as the Network. The
 * vendor side calls the receiver via the URL we save into
 * `network_membership` Config. The rule under test (network-consent.ts):
 * a partner's details reach the Network only when the brand offers the
 * Network (`autoEnroll`) AND the partner opted in.
 *
 *   1. Self-signup: pushes only with the join page's opt-in ticked, and
 *      only while the brand offers the Network.
 *   2. Admin POST /partners: never pushes a directly recruited partner —
 *      even sendInvite:false (the headless 30k-customer case). The
 *      Network's own approve federation (its registered key) is consented
 *      as 'network_offering' and syncs back; a forged metadata.source
 *      from an admin key is not.
 *   3. Revoke: mirrored only for a consented partner, with the full
 *      upsert body the Network validates.
 *   4. Re-sync ("backfill"): pushes consented partners only.
 *   5. Outbox: queued pushes are dropped once consent is gone.
 *   6. The partner's own consent endpoints: prompt grant/decline, setting
 *      grant/withdraw, sessions only; withdraw/decline send a PII-free
 *      unlink that is kept queued while the Network lacks the endpoint.
 *   7. Network-access fee: an opted-in direct recruit is never billed.
 *
 * Skipped if DATABASE_URL isn't set, like the rest of the integration
 * suite.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_network_admin_0123456789abcdef0123';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.PORTAL_URL = 'http://localhost:5673';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { drainOutbox } = await import('../network-client.js');
const { encryptSecret } = await import('../crypto.js');
const { aggregateNetworkOriginatedPayouts } = await import('../usage-billing.js');
const { createApiKeyRow } = await import('../auth.js');
const { createSession } = await import('../auth-sessions.js');
const { NETWORK_FEDERATION_SCOPES } = await import('../routes/api-keys.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

// The join-page application every public signup must carry.
const APPLICATION = {
  websiteUrl: 'https://creator.example',
  socialUrls: ['https://youtube.com/@creator', 'https://www.tiktok.com/@creator'],
  audienceSize: '10k_50k',
  pitch: 'Weekly tutorials for indie founders; I would demo the product in a launch video.',
};

// In-process Network receiver. Each test configures `mockResponse` (and
// `unlinkResponse` for /partners/unlink); `received` captures every call.
interface ReceivedCall {
  path: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}
let receiver: Server;
let receiverUrl: string;
let received: ReceivedCall[] = [];
let mockResponse: { status: number; body: unknown } = {
  status: 200,
  body: { networkCreatorId: 'crt_default', alreadyExisted: false, affiliations: [] },
};
let unlinkResponse: { status: number; body: unknown } = { status: 200, body: { removed: true, creatorDeleted: false } };
// Email-keyed store so we can simulate Network-side dedup for the
// re-sync test. When a request comes in with an email we've seen, return
// the same networkCreatorId + alreadyExisted=true.
const networkCreators = new Map<string, string>();

const upserts = () => received.filter((c) => c.path === '/partners/upsert');
const unlinks = () => received.filter((c) => c.path === '/partners/unlink');

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        received.push({
          path: req.url ?? '',
          method: req.method ?? '',
          authorization: req.headers.authorization,
          body,
        });
        if (req.url === '/partners/unlink') {
          res.writeHead(unlinkResponse.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(unlinkResponse.body));
          return;
        }
        const email = (body && typeof body === 'object' && 'email' in body) ? (body as { email: string }).email : null;
        if (email && networkCreators.has(email)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            networkCreatorId: networkCreators.get(email),
            alreadyExisted: true,
            affiliations: [{ vendorId: 'vnd_other', vendorPartnerId: 'pp_other', status: 'active', displayName: 'Other Vendor' }],
          }));
          return;
        }
        res.writeHead(mockResponse.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(mockResponse.body));
      });
    }).listen(0, '127.0.0.1', () => {
      const addr = receiver.address() as AddressInfo;
      receiverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (receiver) await new Promise<void>((r) => receiver.close(() => r()));
  await db.destroy();
});

const CLEANUP = [
  TABLES.NetworkOutbox,
  TABLES.MagicLinkToken,
  TABLES.Session,
  TABLES.ApiKey,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.PartnerProgram,
  TABLES.PartnerCommission,
  TABLES.PartnerNetworkConsent,
  TABLES.Payout,
  TABLES.Program,
  TABLES.Partner,
  TABLES.Config,
];

async function cleanup(): Promise<void> {
  for (const t of CLEANUP) {
    await db(t).whereIn('tenantId', [DEFAULT_TENANT_ID]).del();
  }
}

beforeEach(async () => {
  if (skipIntegration) return;
  received = [];
  networkCreators.clear();
  mockResponse = {
    status: 200,
    body: { networkCreatorId: `crt_${ulid()}`, alreadyExisted: false, affiliations: [] },
  };
  unlinkResponse = { status: 200, body: { removed: true, creatorDeleted: false } };
  await cleanup();
});

afterEach(async () => {
  if (skipIntegration) return;
  await cleanup();
});

async function configureNetwork(opts: {
  enabled: boolean;
  autoEnroll?: boolean;
  url?: string;
  scopedKeyId?: string | null;
}): Promise<void> {
  const value = {
    enabled: opts.enabled,
    networkUrl: opts.url ?? receiverUrl,
    vendorTokenCiphertext: encryptSecret('vntok_test'),
    scopedKeyId: opts.scopedKeyId ?? null,
    autoEnroll: opts.autoEnroll ?? true,
  };
  await db(TABLES.Config)
    .insert({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership', value: value as unknown as never, updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: value as unknown as never, updatedAt: new Date() });
}

/** The scoped key the brand registered with the Network — what its
 *  approve federation authenticates POST /partners with. */
async function federationKey(): Promise<string> {
  const key = await createApiKeyRow(db, {
    tenantId: DEFAULT_TENANT_ID,
    scopes: [...NETWORK_FEDERATION_SCOPES],
    label: 'network_federation',
  });
  await configureNetwork({ enabled: true, scopedKeyId: key.id });
  return key.plaintext;
}

/** The body the Network's partnership-approve federation sends. */
function federatedBody(email: string) {
  return {
    email,
    name: 'Network Creator',
    metadata: { source: 'openpartner_network', networkCreatorId: 'crt_from_network' },
    sendInvite: false,
    campaignGrantSource: 'offering',
  };
}

async function consentOf(partnerId: string) {
  return db(TABLES.PartnerNetworkConsent).where({ partnerId }).first();
}

async function seedPartner(email: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: DEFAULT_TENANT_ID,
    email,
    name: email.split('@')[0],
    activatedAt: new Date(),
    ...extra,
  });
  return id;
}

async function grantConsent(partnerId: string, source = 'portal_setting'): Promise<void> {
  await db(TABLES.PartnerNetworkConsent).insert({
    partnerId,
    tenantId: DEFAULT_TENANT_ID,
    status: 'granted',
    source,
    consentedAt: new Date(),
  });
}

async function partnerCookie(partnerId: string): Promise<string> {
  const session = await createSession(db, { tenantId: DEFAULT_TENANT_ID, principalKind: 'partner', principalId: partnerId });
  return `op_session=${session.plaintext}`;
}

describe.skipIf(skipIntegration)('self-signup', () => {
  it('without Network: creates Partner + magic link, no Network call', async () => {
    const res = await request(app)
      .post('/partner-signup')
      .send({ email: 'creator1@example.test', name: 'Creator One', application: APPLICATION });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');

    const partner = await db(TABLES.Partner).where({ email: 'creator1@example.test' }).first();
    expect(partner).toBeDefined();
    expect(partner!.activatedAt).not.toBeNull();
    expect(received).toHaveLength(0);
  });

  it('Network offered but the opt-in left unticked: no push, no consent recorded', async () => {
    await configureNetwork({ enabled: true });
    const res = await request(app)
      .post('/partner-signup')
      .send({ email: 'quiet@example.test', name: 'Quiet', application: APPLICATION });
    expect(res.status).toBe(201);

    const partner = await db(TABLES.Partner).where({ email: 'quiet@example.test' }).first();
    expect(received).toHaveLength(0);
    // Undecided, not declined: they get the portal prompt.
    expect(await consentOf(partner!.id)).toBeUndefined();
    expect((partner!.metadata as { network?: unknown }).network).toBeUndefined();
  });

  it('opt-in ticked: records join_page consent, pushes /partners/upsert and stamps networkCreatorId', async () => {
    await configureNetwork({ enabled: true });
    const expectedCreatorId = `crt_${ulid()}`;
    mockResponse = { status: 200, body: { networkCreatorId: expectedCreatorId, alreadyExisted: false, affiliations: [] } };

    const res = await request(app)
      .post('/partner-signup')
      .send({ email: 'creator2@example.test', name: 'Creator Two', application: APPLICATION, networkOptIn: true });
    expect(res.status).toBe(201);

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/partners/upsert');
    expect(received[0]!.authorization).toBe('Bearer vntok_test');
    const sent = received[0]!.body as { email: string; metadata?: { source: string }; creatorProfile?: unknown };
    expect(sent.email).toBe('creator2@example.test');
    expect(sent.metadata?.source).toBe('self_signup');
    // The application's profile answers fill blanks on the Network; the
    // pitch was written for this brand and stays here.
    expect(sent.creatorProfile).toEqual({
      websiteUrl: APPLICATION.websiteUrl,
      socialUrls: APPLICATION.socialUrls,
      audienceSize: APPLICATION.audienceSize,
    });
    expect(JSON.stringify(sent)).not.toContain(APPLICATION.pitch);

    const partner = await db(TABLES.Partner).where({ email: 'creator2@example.test' }).first();
    const meta = partner!.metadata as { network?: { creatorId: string; preExisting: boolean } };
    expect(meta.network?.creatorId).toBe(expectedCreatorId);
    expect(meta.network?.preExisting).toBe(false);

    const consent = await consentOf(partner!.id);
    expect(consent).toMatchObject({ status: 'granted', source: 'join_page', withdrawnAt: null });
    expect(consent!.consentedAt).toBeInstanceOf(Date);
  });

  it('opt-in ignored while the brand does not offer the Network', async () => {
    await configureNetwork({ enabled: true, autoEnroll: false });
    const status = await request(app).get('/partner-signup/status');
    expect(status.body.networkOffered).toBe(false);

    const res = await request(app)
      .post('/partner-signup')
      .send({ email: 'forged-optin@example.test', name: 'Forged', application: APPLICATION, networkOptIn: true });
    expect(res.status).toBe(201);
    const partner = await db(TABLES.Partner).where({ email: 'forged-optin@example.test' }).first();
    expect(received).toHaveLength(0);
    expect(await consentOf(partner!.id)).toBeUndefined();
  });

  it('status reports networkOffered only when membership is on and the brand offers it', async () => {
    expect((await request(app).get('/partner-signup/status')).body.networkOffered).toBe(false);
    await configureNetwork({ enabled: false });
    expect((await request(app).get('/partner-signup/status')).body.networkOffered).toBe(false);
    await configureNetwork({ enabled: true });
    expect((await request(app).get('/partner-signup/status')).body.networkOffered).toBe(true);
    // Self-host can hide the Network from partners — then it isn't offered.
    await db(TABLES.Config).insert({
      tenantId: DEFAULT_TENANT_ID,
      key: 'program_settings',
      value: { partnerNetworkVisible: false } as unknown as never,
      updatedAt: new Date(),
    });
    expect((await request(app).get('/partner-signup/status')).body.networkOffered).toBe(false);
  });

  it('a queued opted-in push keeps creatorProfile for the retry', async () => {
    await configureNetwork({ enabled: true });
    mockResponse = { status: 503, body: { error: 'unavailable' } };

    const res = await request(app)
      .post('/partner-signup')
      .send({ email: 'queued@example.test', name: 'Queued', application: APPLICATION, networkOptIn: true });
    expect(res.status).toBe(201);

    const outbox = await db(TABLES.NetworkOutbox).where({ tenantId: DEFAULT_TENANT_ID });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.op).toBe('partner_upsert');
    expect(outbox[0]!.attempts).toBe(1);
    expect(outbox[0]!.status).toBe('pending');
    expect((outbox[0]!.payload as { creatorProfile?: { audienceSize?: string } }).creatorProfile?.audienceSize).toBe('10k_50k');
  });

  it('require_review + opt-in: Partner created with activatedAt=null and pushes status=pending', async () => {
    await configureNetwork({ enabled: true });
    await db(TABLES.Config)
      .insert({
        tenantId: DEFAULT_TENANT_ID,
        key: 'partner_signup',
        value: { policy: 'require_review' } as unknown as never,
        updatedAt: new Date(),
      })
      .onConflict(['tenantId', 'key'])
      .merge({ value: { policy: 'require_review' } as unknown as never, updatedAt: new Date() });

    const res = await request(app)
      .post('/partner-signup')
      .send({ email: 'pending@example.test', name: 'Pending Creator', application: APPLICATION, networkOptIn: true });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_review');

    const partner = await db(TABLES.Partner).where({ email: 'pending@example.test' }).first();
    expect(partner!.activatedAt).toBeNull();
    expect(received).toHaveLength(1);
    expect((received[0]!.body as { status: string }).status).toBe('pending');
  });
});

describe.skipIf(skipIntegration)('outbox drain', () => {
  it('retries queued pushes and deletes them on success', async () => {
    await configureNetwork({ enabled: true });
    mockResponse = { status: 503, body: {} };
    await request(app)
      .post('/partner-signup')
      .send({ email: 'creator4@example.test', name: 'Creator Four', application: APPLICATION, networkOptIn: true });
    expect((await db(TABLES.NetworkOutbox)).length).toBe(1);

    await db(TABLES.NetworkOutbox).update({ nextAttemptAt: new Date(Date.now() - 1000) });
    mockResponse = { status: 200, body: { networkCreatorId: 'crt_recovered', alreadyExisted: false, affiliations: [] } };
    received = [];
    const result = await drainOutbox(db, DEFAULT_TENANT_ID);
    expect(result).toEqual({ drained: 1, succeeded: 1, dead: 0 });
    expect(upserts()).toHaveLength(1);
    expect(await db(TABLES.NetworkOutbox)).toHaveLength(0);
  });

  it('drops a queued push without sending it once the partner is no longer consented', async () => {
    await configureNetwork({ enabled: true });
    mockResponse = { status: 503, body: {} };
    await request(app)
      .post('/partner-signup')
      .send({ email: 'changed-mind@example.test', name: 'Changed Mind', application: APPLICATION, networkOptIn: true });
    const partner = await db(TABLES.Partner).where({ email: 'changed-mind@example.test' }).first();
    // Withdrawn behind the outbox's back (the route also purges; this is
    // the drain's own backstop).
    await db(TABLES.PartnerNetworkConsent)
      .where({ partnerId: partner!.id })
      .update({ status: 'withdrawn', withdrawnAt: new Date() });
    await db(TABLES.NetworkOutbox).update({ nextAttemptAt: new Date(Date.now() - 1000) });

    mockResponse = { status: 200, body: { networkCreatorId: 'crt_x', alreadyExisted: false, affiliations: [] } };
    received = [];
    const result = await drainOutbox(db, DEFAULT_TENANT_ID);
    expect(result.succeeded).toBe(0);
    expect(received).toHaveLength(0);
    expect(await db(TABLES.NetworkOutbox)).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('admin POST /partners', () => {
  it('never pushes a partner the brand recruited directly — even sendInvite:false', async () => {
    await configureNetwork({ enabled: true });
    for (const [email, sendInvite] of [['invited@example.test', true], ['headless@example.test', false]] as const) {
      const res = await request(app)
        .post('/partners')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ email, name: 'Direct', sendInvite, metadata: { customerId: 'cus_42', plan: 'enterprise' } });
      expect(res.status).toBe(201);
      expect(await consentOf(res.body.id)).toBeUndefined();
    }
    expect(received).toHaveLength(0);
  });

  it('the Network approve federation (its registered key) is consented as network_offering and synced back', async () => {
    const key = await federationKey();
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${key}`)
      .send(federatedBody('creator@example.test'));
    expect(res.status).toBe(201);

    const consent = await consentOf(res.body.id);
    expect(consent).toMatchObject({ status: 'granted', source: 'network_offering' });
    expect(upserts()).toHaveLength(1);
    const sent = upserts()[0]!.body as Record<string, unknown>;
    expect(sent.email).toBe('creator@example.test');
    // Brand-side Partner.metadata never rides along as a public profile.
    expect(sent).not.toHaveProperty('profile');
  });

  it('a forged metadata.source from an admin key is not Network consent', async () => {
    await federationKey();
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send(federatedBody('forged@example.test'));
    expect(res.status).toBe(201);
    expect(await consentOf(res.body.id)).toBeUndefined();
    expect(received).toHaveLength(0);
  });

  it('a federation call to a brand that stopped offering the Network records consent but pushes nothing', async () => {
    const key = await createApiKeyRow(db, { tenantId: DEFAULT_TENANT_ID, scopes: [...NETWORK_FEDERATION_SCOPES] });
    await configureNetwork({ enabled: true, autoEnroll: false, scopedKeyId: key.id });
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${key.plaintext}`)
      .send(federatedBody('creator-off@example.test'));
    expect(res.status).toBe(201);
    expect((await consentOf(res.body.id))?.source).toBe('network_offering');
    expect(received).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('revoke', () => {
  it('mirrors a consented partner with the full body the Network validates — even with the offer off', async () => {
    await configureNetwork({ enabled: true, autoEnroll: false });
    const id = await seedPartner('revoke-target@example.test');
    await grantConsent(id, 'grandfathered');

    const revoke = await request(app)
      .post(`/partners/${id}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ reason: 'test', notify: false });
    expect(revoke.status).toBe(200);

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/partners/upsert');
    const body = received[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ vendorPartnerId: id, email: 'revoke-target@example.test', status: 'revoked' });
    // openpartner-network's upsert schema requires these on every call.
    expect(typeof body.name).toBe('string');
    expect(typeof body.joinedVendorAt).toBe('string');
  });

  it('sends nothing for a partner who never opted in', async () => {
    await configureNetwork({ enabled: true });
    const id = await seedPartner('never-on@example.test');
    const revoke = await request(app)
      .post(`/partners/${id}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ notify: false });
    expect(revoke.status).toBe(200);
    expect(received).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('re-sync (POST /config/network/backfill)', () => {
  it('pushes only consented partners; pre-existing Network creators come back with alreadyExisted=true', async () => {
    const p1 = await seedPartner('preexisting@example.test');
    const p2 = await seedPartner('fresh@example.test');
    const p3 = await seedPartner('undecided@example.test');
    const p4 = await seedPartner('withdrawn@example.test');
    await grantConsent(p1, 'grandfathered');
    await grantConsent(p2, 'portal_prompt');
    await db(TABLES.PartnerNetworkConsent).insert({
      partnerId: p4,
      tenantId: DEFAULT_TENANT_ID,
      status: 'withdrawn',
      source: 'join_page',
      consentedAt: new Date(Date.now() - 60_000),
      withdrawnAt: new Date(),
    });
    networkCreators.set('preexisting@example.test', 'crt_preexisting_already');
    await configureNetwork({ enabled: true });

    const res = await request(app)
      .post('/config/network/backfill')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 2, pushed: 2, queued: 0 });
    expect(upserts().map((c) => (c.body as { email: string }).email).sort()).toEqual([
      'fresh@example.test',
      'preexisting@example.test',
    ]);

    const meta = async (id: string) =>
      ((await db(TABLES.Partner).where({ id }).first())!.metadata as { network?: { creatorId: string; preExisting: boolean } }).network;
    expect((await meta(p1))?.creatorId).toBe('crt_preexisting_already');
    expect((await meta(p1))?.preExisting).toBe(true);
    expect((await meta(p2))?.preExisting).toBe(false);
    expect(await meta(p3)).toBeUndefined();
    expect(await meta(p4)).toBeUndefined();
  });

  it('409 network_not_offered while the brand does not offer the Network', async () => {
    await configureNetwork({ enabled: true, autoEnroll: false });
    const id = await seedPartner('consented@example.test');
    await grantConsent(id);
    const res = await request(app)
      .post('/config/network/backfill')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('network_not_offered');
    expect(received).toHaveLength(0);
  });

  it('GET /config/network/partner-consent counts decisions over the live roster', async () => {
    await configureNetwork({ enabled: true });
    const a = await seedPartner('a@example.test');
    const b = await seedPartner('b@example.test');
    await seedPartner('c@example.test');
    const revoked = await seedPartner('d@example.test', { revokedAt: new Date() });
    await grantConsent(a);
    await grantConsent(revoked);
    await db(TABLES.PartnerNetworkConsent).insert({
      partnerId: b,
      tenantId: DEFAULT_TENANT_ID,
      status: 'declined',
      declinedAt: new Date(),
    });
    const res = await request(app).get('/config/network/partner-consent').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ partners: 3, granted: 1, withdrawn: 0, declined: 1 });
  });

  it('GET /config/network never leaks the vendor token', async () => {
    await configureNetwork({ enabled: true });
    const res = await request(app)
      .get('/config/network')
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('vendorToken');
    expect(res.body).not.toHaveProperty('vendorTokenCiphertext');
    expect(res.body.hasVendorToken).toBe(true);
    expect(res.body.networkUrl).toBe(receiverUrl);
  });
});

describe.skipIf(skipIntegration)("the partner's consent endpoints", () => {
  it('first login: offered + undecided; grant via the prompt records portal_prompt and pushes', async () => {
    await configureNetwork({ enabled: true });
    const id = await seedPartner('prompted@example.test');
    const cookie = await partnerCookie(id);

    const before = await request(app).get('/network/me/consent').set('Cookie', cookie);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ offered: true, status: null, source: null });

    const grant = await request(app)
      .post('/network/me/consent')
      .set('Cookie', cookie)
      .send({ decision: 'grant', via: 'prompt' });
    expect(grant.status).toBe(200);
    expect(grant.body).toMatchObject({ offered: true, status: 'granted', source: 'portal_prompt' });
    expect(upserts()).toHaveLength(1);
    expect((upserts()[0]!.body as { metadata: { source: string } }).metadata.source).toBe('admin_invite');
  });

  it('"No thanks" on the prompt records declined, sends a PII-free unlink, and only works once', async () => {
    await configureNetwork({ enabled: true });
    const id = await seedPartner('declines@example.test');
    const cookie = await partnerCookie(id);

    const decline = await request(app)
      .post('/network/me/consent')
      .set('Cookie', cookie)
      .send({ decision: 'decline', via: 'prompt' });
    expect(decline.status).toBe(200);
    expect(decline.body).toMatchObject({ status: 'declined', source: null });
    expect(upserts()).toHaveLength(0);
    expect(unlinks()).toHaveLength(1);
    expect(unlinks()[0]!.body).toEqual({ vendorPartnerId: id, reason: 'consent_declined' });

    const again = await request(app)
      .post('/network/me/consent')
      .set('Cookie', cookie)
      .send({ decision: 'decline', via: 'prompt' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_decided');

    const fromSetting = await request(app)
      .post('/network/me/consent')
      .set('Cookie', cookie)
      .send({ decision: 'decline', via: 'setting' });
    expect(fromSetting.status).toBe(400);
  });

  it('withdraw via the setting: purges queued pushes, sends the unlink, keeps the consent record', async () => {
    await configureNetwork({ enabled: true });
    const id = await seedPartner('leaver@example.test');
    await grantConsent(id, 'join_page');
    const consentedAt = (await consentOf(id))!.consentedAt;
    // A push still waiting in the outbox from before.
    await db(TABLES.NetworkOutbox).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      op: 'partner_upsert',
      payload: { vendorPartnerId: id, email: 'leaver@example.test' } as unknown as never,
      attempts: 1,
      nextAttemptAt: new Date(),
      status: 'pending',
    });
    const cookie = await partnerCookie(id);

    const res = await request(app)
      .post('/network/me/consent')
      .set('Cookie', cookie)
      .send({ decision: 'withdraw', via: 'setting' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'withdrawn', source: 'join_page' });

    const consent = await consentOf(id);
    expect(consent!.consentedAt).toEqual(consentedAt);
    expect(consent!.withdrawnAt).toBeInstanceOf(Date);
    expect(unlinks()).toHaveLength(1);
    expect(JSON.stringify(unlinks()[0]!.body)).not.toContain('leaver@example.test');
    expect(upserts()).toHaveLength(0);
    expect(await db(TABLES.NetworkOutbox)).toHaveLength(0);

    const twice = await request(app)
      .post('/network/me/consent')
      .set('Cookie', cookie)
      .send({ decision: 'withdraw', via: 'setting' });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe('not_opted_in');
  });

  it('a withdrawn partner can opt back in from the setting', async () => {
    await configureNetwork({ enabled: true });
    const id = await seedPartner('returns@example.test');
    const cookie = await partnerCookie(id);
    await request(app).post('/network/me/consent').set('Cookie', cookie).send({ decision: 'grant', via: 'setting' });
    await request(app).post('/network/me/consent').set('Cookie', cookie).send({ decision: 'withdraw', via: 'setting' });
    received = [];
    const back = await request(app)
      .post('/network/me/consent')
      .set('Cookie', cookie)
      .send({ decision: 'grant', via: 'setting' });
    expect(back.body).toMatchObject({ status: 'granted', source: 'portal_setting', withdrawnAt: null });
    expect(upserts()).toHaveLength(1);
  });

  it('grant is refused while the brand does not offer the Network; withdraw still works', async () => {
    await configureNetwork({ enabled: true, autoEnroll: false });
    const fresh = await seedPartner('not-offered@example.test');
    const grant = await request(app)
      .post('/network/me/consent')
      .set('Cookie', await partnerCookie(fresh))
      .send({ decision: 'grant', via: 'setting' });
    expect(grant.status).toBe(409);
    expect(grant.body.error).toBe('network_not_offered');

    const grandfathered = await seedPartner('grandfathered@example.test');
    await grantConsent(grandfathered, 'grandfathered');
    const withdraw = await request(app)
      .post('/network/me/consent')
      .set('Cookie', await partnerCookie(grandfathered))
      .send({ decision: 'withdraw', via: 'setting' });
    expect(withdraw.status).toBe(200);
    expect(unlinks()).toHaveLength(1);
  });

  it('only the partner in a portal session can decide — not a partner API key, not an admin', async () => {
    await configureNetwork({ enabled: true });
    const id = await seedPartner('keyed@example.test');
    const partnerKey = await createApiKeyRow(db, { tenantId: DEFAULT_TENANT_ID, partnerId: id });
    const viaKey = await request(app)
      .post('/network/me/consent')
      .set('Authorization', `Bearer ${partnerKey.plaintext}`)
      .send({ decision: 'grant', via: 'setting' });
    expect(viaKey.status).toBe(403);
    expect(viaKey.body.error).toBe('partner_session_required');

    const viaAdmin = await request(app)
      .post('/network/me/consent')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ decision: 'grant', via: 'setting' });
    expect(viaAdmin.status).toBe(403);
    expect(await consentOf(id)).toBeUndefined();
    expect(received).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('unlink delivery', () => {
  it('a Network without /partners/unlink (404) keeps the unlink queued past the attempt limit', async () => {
    await configureNetwork({ enabled: true });
    unlinkResponse = { status: 404, body: { error: 'not_found' } };
    const id = await seedPartner('early-leaver@example.test');
    await grantConsent(id);
    await request(app)
      .post('/network/me/consent')
      .set('Cookie', await partnerCookie(id))
      .send({ decision: 'withdraw', via: 'setting' });

    for (let i = 0; i < 10; i += 1) {
      await db(TABLES.NetworkOutbox).update({ nextAttemptAt: new Date(Date.now() - 1000) });
      await drainOutbox(db, DEFAULT_TENANT_ID);
    }
    const [row] = await db(TABLES.NetworkOutbox).where({ tenantId: DEFAULT_TENANT_ID });
    expect(row).toMatchObject({ op: 'partner_unlink', status: 'pending' });
    expect(row!.attempts).toBeGreaterThan(8);

    // The Network ships the endpoint: the next drain delivers it.
    unlinkResponse = { status: 200, body: { removed: true, creatorDeleted: true } };
    await db(TABLES.NetworkOutbox).update({ nextAttemptAt: new Date(Date.now() - 1000) });
    expect((await drainOutbox(db, DEFAULT_TENANT_ID)).succeeded).toBe(1);
    expect(await db(TABLES.NetworkOutbox)).toHaveLength(0);
  });

  it('other unlink failures still give up after the normal attempt limit', async () => {
    await configureNetwork({ enabled: true });
    unlinkResponse = { status: 500, body: {} };
    const id = await seedPartner('flaky@example.test');
    await grantConsent(id);
    await request(app)
      .post('/network/me/consent')
      .set('Cookie', await partnerCookie(id))
      .send({ decision: 'withdraw', via: 'setting' });
    for (let i = 0; i < 10; i += 1) {
      await db(TABLES.NetworkOutbox).update({ nextAttemptAt: new Date(Date.now() - 1000) });
      await drainOutbox(db, DEFAULT_TENANT_ID);
    }
    const [row] = await db(TABLES.NetworkOutbox).where({ tenantId: DEFAULT_TENANT_ID });
    expect(row!.status).toBe('dead');
  });

  it('a withdrawal while membership is switched off is held, not lost', async () => {
    await configureNetwork({ enabled: false });
    const id = await seedPartner('paused@example.test');
    await grantConsent(id);
    const res = await request(app)
      .post('/network/me/consent')
      .set('Cookie', await partnerCookie(id))
      .send({ decision: 'withdraw', via: 'setting' });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(0);
    const [row] = await db(TABLES.NetworkOutbox).where({ tenantId: DEFAULT_TENANT_ID });
    expect(row).toMatchObject({ op: 'partner_unlink', status: 'pending' });

    await configureNetwork({ enabled: true });
    await db(TABLES.NetworkOutbox).update({ nextAttemptAt: new Date(Date.now() - 1000) });
    await drainOutbox(db, DEFAULT_TENANT_ID);
    expect(unlinks()).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('Network-access fee scope', () => {
  it('bills only the Network-provisioned partner — never a direct recruit who opted in', async () => {
    const key = await federationKey();

    // Direct recruits who chose to join the Network: one on the join page,
    // one from the portal setting, one grandfathered from auto-enroll.
    const signup = await request(app)
      .post('/partner-signup')
      .send({ email: 'self@example.test', name: 'Self Signup', application: APPLICATION, networkOptIn: true });
    expect(signup.status).toBe(201);
    const invite = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: 'invited@example.test', name: 'Invited' });
    expect(invite.status).toBe(201);
    const optIn = await request(app)
      .post('/network/me/consent')
      .set('Cookie', await partnerCookie(invite.body.id))
      .send({ decision: 'grant', via: 'setting' });
    expect(optIn.status).toBe(200);
    const legacyId = await seedPartner('legacy@example.test');
    await grantConsent(legacyId, 'grandfathered');
    const resync = await request(app)
      .post('/config/network/backfill')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({});
    expect(resync.status).toBe(200);

    // The partner the Network's approve flow provisioned.
    const federated = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${key}`)
      .send(federatedBody('creator@example.test'));
    expect(federated.status).toBe(201);

    const partners = (await db(TABLES.Partner).select('id', 'email', 'metadata')) as Array<{
      id: string;
      email: string;
      metadata: { network?: { creatorId?: string } };
    }>;
    expect(partners).toHaveLength(4);
    // Precondition for the regression: every partner is on the Network
    // with the sync stamp an earlier aggregate billed on.
    for (const p of partners) {
      expect(p.metadata.network?.creatorId).toBeTruthy();
      expect((await consentOf(p.id))?.status).toBe('granted');
    }

    for (const p of partners) {
      await db(TABLES.Payout).insert({
        id: ulid(),
        tenantId: DEFAULT_TENANT_ID,
        partnerId: p.id,
        amount: p.email === 'creator@example.test' ? '40.00' : '1000.00',
        currency: 'USD',
        method: 'manual',
        status: 'paid',
        metadata: {} as unknown as never,
        completedAt: new Date(),
      });
    }

    expect(await aggregateNetworkOriginatedPayouts(db, DEFAULT_TENANT_ID, null, new Date())).toEqual({ USD: 40 });
  });
});

describe.skipIf(skipIntegration)('public signup cannot set server-owned metadata', () => {
  it('drops source / network / stripe / application from the profile, keeps the rest', async () => {
    const res = await request(app)
      .post('/partner-signup')
      .send({
        email: 'forged@example.test',
        name: 'Forged',
        application: APPLICATION,
        profile: {
          bio: 'creator',
          source: 'openpartner_network',
          network: { creatorId: 'crt_forged' },
          stripe: { payoutsEnabled: true },
          application: { websiteUrl: 'https://forged.example', pitch: 'forged', audienceSize: 'over_1m' },
        },
      });
    expect(res.status).toBe(201);

    const partner = await db(TABLES.Partner).where({ email: 'forged@example.test' }).first();
    // Only the validated application survives — the profile's copy is gone.
    expect(partner!.metadata).toEqual({
      bio: 'creator',
      application: { ...APPLICATION, submittedAt: expect.any(String) },
    });
  });
});
