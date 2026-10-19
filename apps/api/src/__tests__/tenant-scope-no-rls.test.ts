/**
 * Tenant-scoped queries when RLS is NOT enforced: the follow-up sweep.
 *
 * Sibling of tenant-isolation-no-rls.test.ts, same setup: multi-tenant
 * mode with DATABASE_URL_APP unset, so the app pool runs as the privileged
 * role and Postgres row-level security never applies. The boot guard
 * refuses that configuration; these tests cover the defence in depth
 * behind it. Every path here used to lean on RLS alone, and each test
 * fails against the unscoped query it covers:
 *
 *   - money: the payout planner, the attribution walk (identity by userId,
 *     the identify backlog), fraud review's unflag, Stripe refunds
 *   - outbound: the Network outbox drain, heartbeat, re-sync and consent
 *     counts
 *   - admin routes: programs, admins (the last-active-admin guard),
 *     commissions, webhooks, API keys, portal domains, coupons, billing,
 *     onboarding
 *   - routes keyed on a partner ID in the URL, which requirePartnerOrAdmin
 *     lets any admin name: manual payout confirmation and payout history,
 *     Stripe Connect onboarding and status, partner postbacks
 *   - per-tenant-unique keys: coupon codes, link keys, sign-in emails and
 *     magic links, the public signup
 *
 * Tenant A plays the victim, tenant B the tenant making the requests.
 * The precondition test asserts the pool really bypasses RLS, so nothing
 * here can pass vacuously on an app-role setup.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import Stripe from 'stripe';
import { TABLES } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'multi';
// The configuration under test: no app role, so appDb = DATABASE_URL.
delete process.env.DATABASE_URL_APP;
delete process.env.ADMIN_API_KEY; // env admin keys are valid on every tenant
delete process.env.NETWORK_URL;
// Dummy Stripe credentials: the refund test signs its own webhook, and no
// path here may reach a real Stripe account.
const STRIPE_SECRET = 'sk_test_dummy_tenant_scope_no_rls';
const WEBHOOK_SECRET = 'whsec_test_tenant_scope_no_rls';
process.env.STRIPE_SECRET_KEY = STRIPE_SECRET;
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
delete process.env.STRIPE_WEBHOOK_SECRET_PLATFORM;
delete process.env.STRIPE_WEBHOOK_SECRET_CONNECT;

const { db, appDb } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createApiKeyRow } = await import('../auth.js');
const { issueMagicLink } = await import('../auth-sessions.js');
const { inspectAppRole, rlsProblem } = await import('../tenant-isolation-guard.js');
const { runPayouts } = await import('../payouts.js');
const { attributeEvent } = await import('../attribution.js');
const { drainOutbox } = await import('../network-client.js');
const { encryptSecret } = await import('../crypto.js');
const { __setMailerForTests } = await import('../mailer.js');
const { stripe } = await import('../stripe.js');
type Message = import('../mailer.js').Message;

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const A = { id: `01SCOPEA${ulid().slice(8)}`, slug: `scope-a-${ulid().slice(-6).toLowerCase()}` };
const B = { id: `01SCOPEB${ulid().slice(8)}`, slug: `scope-b-${ulid().slice(-6).toLowerCase()}` };
const TENANTS = [A.id, B.id];

const tag = () => ulid().slice(-6).toLowerCase();
const A_EMAIL = `ada-${tag()}@tenant-a.test`;
const A_ADMIN_EMAIL = `owner-${tag()}@tenant-a.test`;
const A_PROGRAM_NAME = `Alpha Private Program ${tag()}`;

// ---------- capture: mail + a stand-in Network ----------

const sentMail: Message[] = [];
__setMailerForTests({
  async send(_ctx, msg) {
    sentMail.push(msg);
  },
});

interface NetworkRequest {
  method: string;
  url: string;
  body: string;
}
const networkRequests: NetworkRequest[] = [];
let network: Server;
let networkUrl = '';

// ---------- seeding ----------

/** Delete every row of both tenants, children first. Tables are found by
 *  their tenantId column, so rows a route wrote are caught too; a delete
 *  blocked by a foreign key is retried after the rest. */
async function wipe(): Promise<void> {
  const tables = (await db('information_schema.columns')
    .where({ table_schema: 'public', column_name: 'tenantId' })
    .pluck('table_name')) as string[];
  let pending = tables.filter((t) => t !== TABLES.Tenant);
  for (let pass = 0; pass < 8 && pending.length > 0; pass += 1) {
    const blocked: string[] = [];
    for (const t of pending) {
      try {
        await db(t).whereIn('tenantId', TENANTS).del();
      } catch {
        blocked.push(t);
      }
    }
    pending = blocked;
  }
  if (pending.length > 0) throw new Error(`wipe: could not clear ${pending.join(', ')}`);
}

async function seedProgram(tenantId: string, name = `Program ${tag()}`): Promise<string> {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId,
    name,
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    destinationUrl: 'https://example.test/',
  });
  return id;
}

async function seedPartner(tenantId: string, email: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId, email, name: `Partner ${tag()}`, metadata: {}, activatedAt: new Date() });
  return id;
}

async function seedAdmin(tenantId: string, email: string): Promise<string> {
  const id = ulid();
  await db(TABLES.Admin).insert({ id, tenantId, email, name: `Admin ${tag()}`, activatedAt: new Date() });
  return id;
}

async function seedClick(
  tenantId: string,
  partnerId: string,
  programId: string,
  opts: { fraudFlag?: string; ts?: Date } = {},
): Promise<string> {
  const id = ulid();
  await db(TABLES.Click).insert({
    id,
    tenantId,
    linkId: null,
    partnerId,
    programId,
    landingUrl: 'https://example.test/',
    ipHash: 'h',
    fraudFlag: opts.fraudFlag ?? null,
    ts: opts.ts ?? new Date(Date.now() - 60_000),
  });
  return id;
}

async function seedIdentity(tenantId: string, clickId: string, userId: string): Promise<void> {
  await db(TABLES.Identity).insert({ id: ulid(), tenantId, clickId, userId });
}

async function seedEvent(
  tenantId: string,
  userId: string,
  opts: { type?: string; value?: string; metadata?: Record<string, unknown> } = {},
): Promise<string> {
  const id = ulid();
  await db(TABLES.Event).insert({
    id,
    tenantId,
    userId,
    type: opts.type ?? 'invoice_paid',
    value: opts.value ?? '100.00',
    currency: 'USD',
    metadata: opts.metadata ?? {},
    ts: new Date(),
  });
  return id;
}

/** Attribution + one Commission for an existing event and click. */
async function seedCommission(
  tenantId: string,
  ids: { eventId: string; clickId: string; partnerId: string; programId: string },
  status: 'accrued' | 'approved' | 'paid',
): Promise<{ attributionId: string; commissionId: string }> {
  const attributionId = ulid();
  const commissionId = ulid();
  await db(TABLES.Attribution).insert({
    id: attributionId,
    tenantId,
    eventId: ids.eventId,
    partnerId: ids.partnerId,
    programId: ids.programId,
    clickId: ids.clickId,
    model: 'last_click',
    weight: '1',
  });
  await db(TABLES.Commission).insert({
    id: commissionId,
    tenantId,
    attributionId,
    partnerId: ids.partnerId,
    amount: '20.00',
    currency: 'USD',
    status,
    metadata: {},
  });
  return { attributionId, commissionId };
}

/** A whole conversion: click, identity, event, attribution, commission. */
async function seedConversion(
  tenantId: string,
  partnerId: string,
  programId: string,
  status: 'accrued' | 'approved' | 'paid',
  userId = `u-${ulid()}`,
): Promise<{ clickId: string; eventId: string; attributionId: string; commissionId: string }> {
  const clickId = await seedClick(tenantId, partnerId, programId);
  await seedIdentity(tenantId, clickId, userId);
  const eventId = await seedEvent(tenantId, userId);
  return { clickId, eventId, ...(await seedCommission(tenantId, { eventId, clickId, partnerId, programId }, status)) };
}

async function configureNetwork(tenantId: string): Promise<void> {
  const value = {
    enabled: true,
    networkUrl,
    vendorTokenCiphertext: encryptSecret(`vntok_${tenantId}`),
    scopedKeyId: null,
    autoEnroll: true,
  };
  await db(TABLES.Config).insert({ tenantId, key: 'network_membership', value: value as unknown as never, updatedAt: new Date() });
}

async function grantConsent(tenantId: string, partnerId: string): Promise<void> {
  await db(TABLES.PartnerNetworkConsent).insert({
    partnerId,
    tenantId,
    status: 'granted',
    source: 'portal_setting',
    consentedAt: new Date(),
  });
}

let aProgramId = '';
let bProgramId = '';
let aPartnerId = '';
let bPartnerId = '';
let aAdminId = '';
let bAdminId = '';
let bKey = '';
const asB = () => ({ Authorization: `Bearer ${bKey}` });

beforeAll(async () => {
  network = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      networkRequests.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ networkCreatorId: 'nc_test', alreadyExisted: false, affiliations: [] }));
    });
  });
  await new Promise<void>((resolve) => network.listen(0, '127.0.0.1', resolve));
  networkUrl = `http://127.0.0.1:${(network.address() as AddressInfo).port}`;

  if (skipIntegration) return;
  await wipe();
  await db(TABLES.Tenant).whereIn('id', TENANTS).del();
  await db(TABLES.Tenant).insert([
    { id: A.id, slug: A.slug, displayName: 'Tenant A', status: 'active', approvalStatus: 'approved' },
    { id: B.id, slug: B.slug, displayName: 'Tenant B', status: 'active', approvalStatus: 'approved' },
  ]);
});

beforeEach(async () => {
  sentMail.length = 0;
  networkRequests.length = 0;
  if (skipIntegration) return;
  await wipe();
  await db(TABLES.Tenant).whereIn('id', TENANTS).update({ billingPlan: null });
  aProgramId = await seedProgram(A.id, A_PROGRAM_NAME);
  bProgramId = await seedProgram(B.id);
  aPartnerId = await seedPartner(A.id, A_EMAIL);
  bPartnerId = await seedPartner(B.id, `bob-${tag()}@tenant-b.test`);
  aAdminId = await seedAdmin(A.id, A_ADMIN_EMAIL);
  bAdminId = await seedAdmin(B.id, `boss-${tag()}@tenant-b.test`);
  // An admin key (no partner, no scopes) for tenant B.
  bKey = (await createApiKeyRow(db, { tenantId: B.id, label: 'B admin' })).plaintext;
});

afterAll(async () => {
  __setMailerForTests(null);
  await new Promise<void>((resolve) => network.close(() => resolve()));
  if (!skipIntegration) {
    await wipe();
    await db(TABLES.Tenant).whereIn('id', TENANTS).del();
  }
  await db.destroy();
  await appDb.destroy();
});

describe.skipIf(skipIntegration)('precondition', () => {
  it('runs on a pool that really bypasses RLS', async () => {
    expect(rlsProblem(await inspectAppRole(appDb))).not.toBeNull();
  });
});

// ---------- money ----------

describe.skipIf(skipIntegration)('payouts and attribution without RLS', () => {
  it("runPayouts plans only the tenant's own approved commissions", async () => {
    const a = await seedConversion(A.id, aPartnerId, aProgramId, 'approved');
    await seedConversion(B.id, bPartnerId, bProgramId, 'approved');

    const result = await appDb.transaction((trx) => runPayouts(trx, B.id));

    expect(result.payouts.map((p) => p.partnerId)).toEqual([bPartnerId]);
    expect(await db(TABLES.Commission).where({ id: a.commissionId }).first()).toMatchObject({
      status: 'approved',
      payoutId: null,
    });
    expect(await db(TABLES.Payout).where({ partnerId: aPartnerId })).toEqual([]);
  });

  it("attributeEvent doesn't credit another tenant's partner for the same userId", async () => {
    // userId is the brand's own user ID, so two brands can both have "42".
    const userId = `shared-${ulid()}`;
    await seedIdentity(A.id, await seedClick(A.id, aPartnerId, aProgramId), userId);
    const eventId = await seedEvent(B.id, userId);
    const event = await db(TABLES.Event).where({ id: eventId }).first();

    const result = await attributeEvent(appDb, event);

    expect(result.status).toBe('no_identity');
    expect(await db(TABLES.Attribution).where({ eventId })).toEqual([]);
    expect(await db(TABLES.Commission).where({ partnerId: aPartnerId })).toEqual([]);
  });

  it("attributeEvent ignores an identity that names another tenant's click", async () => {
    // The stitch the unscoped identify allowed: an Identity in B pointing
    // at tenant A's click.
    const userId = `u-${ulid()}`;
    await seedIdentity(B.id, await seedClick(A.id, aPartnerId, aProgramId), userId);
    const eventId = await seedEvent(B.id, userId);
    const event = await db(TABLES.Event).where({ id: eventId }).first();

    const result = await attributeEvent(appDb, event);

    expect(result.status).toBe('no_click');
    expect(await db(TABLES.Attribution).where({ eventId })).toEqual([]);
  });

  it("POST /attribution/identify doesn't stitch another tenant's click", async () => {
    const aClickId = await seedClick(A.id, aPartnerId, aProgramId);
    const res = await request(app)
      .post(`/t/${B.slug}/attribution/identify`)
      .send({ cref: aClickId, userId: `u-${ulid()}` });
    expect(res.status).toBe(404);
    expect(await db(TABLES.Identity).where({ clickId: aClickId })).toEqual([]);
  });

  it("the identify backlog doesn't attribute another tenant's events", async () => {
    // Tenant A has an unattributed event for this userId, and a click the
    // user stitched to there. B's identify must neither credit B's partner
    // with A's event nor run A's attribution (and report it to B).
    const userId = `shared-${ulid()}`;
    await seedIdentity(A.id, await seedClick(A.id, aPartnerId, aProgramId), userId);
    const aEventId = await seedEvent(A.id, userId);
    const bClickId = await seedClick(B.id, bPartnerId, bProgramId);

    const res = await request(app).post(`/t/${B.slug}/attribution/identify`).send({ cref: bClickId, userId });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ firstStitch: true, backfilledAttributions: 0 });
    expect(await db(TABLES.Attribution).where({ eventId: aEventId })).toEqual([]);
  });

  it("fraud review lists and unflags only the tenant's own clicks", async () => {
    const aClickId = await seedClick(A.id, aPartnerId, aProgramId, { fraudFlag: 'manual' });
    const bClickId = await seedClick(B.id, bPartnerId, bProgramId, { fraudFlag: 'manual' });

    const list = await request(app).get(`/t/${B.slug}/admin/clicks/flagged`).set(asB());
    expect(list.status).toBe(200);
    expect(list.body.clicks.map((c: { id: string }) => c.id)).toEqual([bClickId]);

    const unflag = await request(app).post(`/t/${B.slug}/clicks/${aClickId}/unflag`).set(asB());
    expect(unflag.status).toBe(404);
    const flag = await request(app).post(`/t/${B.slug}/clicks/${aClickId}/flag`).set(asB());
    expect(flag.status).toBe(404);
    expect(await db(TABLES.Click).where({ id: aClickId }).first()).toMatchObject({ fraudFlag: 'manual' });
  });

  it("unflagging keeps another tenant's accrued commissions for the same userId", async () => {
    const userId = `shared-${ulid()}`;
    // Tenant A: an accrued commission for this userId.
    const a = await seedConversion(A.id, aPartnerId, aProgramId, 'accrued', userId);
    // Tenant B: a flagged click the same userId stitched to.
    const bClickId = await seedClick(B.id, bPartnerId, bProgramId, { fraudFlag: 'manual' });
    await seedIdentity(B.id, bClickId, userId);

    const res = await request(app).post(`/t/${B.slug}/clicks/${bClickId}/unflag`).set(asB());

    expect(res.status).toBe(200);
    expect(await db(TABLES.Commission).where({ id: a.commissionId }).first()).toMatchObject({ status: 'accrued' });
    expect(await db(TABLES.Attribution).where({ id: a.attributionId })).toHaveLength(1);
  });

  it("a Stripe refund doesn't reverse another tenant's commission on the same PaymentIntent", async () => {
    // Both tenants recorded revenue under this PaymentIntent id. Stripe ids
    // are unique per Stripe account, not per tenant (a multi-tenant
    // self-host shares one key).
    const paymentIntentId = `pi_${ulid()}`;
    const metadata = { stripePaymentIntentId: paymentIntentId };
    const aUser = `guest-${tag()}@shopper.test`;
    const aClick = await seedClick(A.id, aPartnerId, aProgramId);
    const aEvent = await seedEvent(A.id, aUser, { metadata });
    const a = await seedCommission(A.id, { eventId: aEvent, clickId: aClick, partnerId: aPartnerId, programId: aProgramId }, 'accrued');
    const bUser = `guest-${tag()}@shopper.test`;
    const bClick = await seedClick(B.id, bPartnerId, bProgramId);
    const bEvent = await seedEvent(B.id, bUser, { metadata });
    const b = await seedCommission(B.id, { eventId: bEvent, clickId: bClick, partnerId: bPartnerId, programId: bProgramId }, 'accrued');

    // A full refund of that PaymentIntent, resolved to tenant B.
    const payload = JSON.stringify({
      id: `evt_${ulid()}`,
      object: 'event',
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_${ulid()}`,
          object: 'charge',
          customer: null,
          payment_intent: paymentIntentId,
          amount: 10000,
          amount_captured: 10000,
          amount_refunded: 10000,
          currency: 'usd',
          metadata: { openpartner_tenant_id: B.id },
        },
      },
    });
    const sig = new Stripe(STRIPE_SECRET).webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', sig)
      .send(payload);

    expect(res.status).toBe(200);
    // B's own commission is reversed and its refund recorded for B's user.
    expect(await db(TABLES.Commission).where({ id: b.commissionId }).first()).toMatchObject({ status: 'reversed' });
    expect(await db(TABLES.Event).where({ tenantId: B.id, type: 'refund' }).pluck('userId')).toEqual([bUser]);
    // A's is untouched.
    expect(await db(TABLES.Commission).where({ id: a.commissionId }).first()).toMatchObject({ status: 'accrued' });
    expect(await db(TABLES.Event).where({ tenantId: A.id, type: 'refund' })).toEqual([]);
  });
});

// ---------- the Network ----------

describe.skipIf(skipIntegration)('Network pushes without RLS', () => {
  const sent = () => networkRequests.map((r) => r.body).join('\n');

  it("drainOutbox sends only the tenant's own queued pushes", async () => {
    await configureNetwork(B.id);
    await grantConsent(A.id, aPartnerId);
    const rowId = ulid();
    await db(TABLES.NetworkOutbox).insert({
      id: rowId,
      tenantId: A.id,
      op: 'partner_upsert',
      payload: { vendorPartnerId: aPartnerId, email: A_EMAIL, name: 'Ada' },
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 60_000),
      status: 'pending',
    });

    await drainOutbox(appDb, B.id);

    expect(sent()).not.toContain(A_EMAIL);
    expect(await db(TABLES.NetworkOutbox).where({ id: rowId }).first()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('the heartbeat reports only the tenant’s own partners and events', async () => {
    await configureNetwork(B.id);
    await seedEvent(A.id, `u-${ulid()}`);

    const res = await request(app).post(`/t/${B.slug}/admin/network/heartbeat`).set(asB());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: true, partnerCount: 1 });
    const beat = networkRequests.find((r) => r.url.endsWith('/vendors/me/heartbeat'));
    expect(JSON.parse(beat!.body)).toMatchObject({ partnerCount: 1 });
    expect(JSON.parse(beat!.body)).not.toHaveProperty('lastEventAt');
  });

  it("GET /admin/network/me counts only the tenant's own partners", async () => {
    await configureNetwork(B.id);
    const res = await request(app).get(`/t/${B.slug}/admin/network/me`).set(asB());
    expect(res.status).toBe(200);
    expect(res.body.partnerCount).toBe(1);
  });

  it("consent counts and the re-sync cover only the tenant's own partners", async () => {
    await configureNetwork(B.id);
    await grantConsent(A.id, aPartnerId);
    await grantConsent(B.id, bPartnerId);

    const summary = await request(app).get(`/t/${B.slug}/config/network/partner-consent`).set(asB());
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({ partners: 1, granted: 1, withdrawn: 0, declined: 0 });

    const resync = await request(app).post(`/t/${B.slug}/config/network/backfill`).set(asB());
    expect(resync.status).toBe(200);
    expect(resync.body.total).toBe(1);
    expect(sent()).toContain(bPartnerId);
    expect(sent()).not.toContain(aPartnerId);
  });
});

// ---------- admin routes ----------

describe.skipIf(skipIntegration)('admin routes without RLS', () => {
  it("program lists, grant-to-all and edits stay inside the tenant", async () => {
    const list = await request(app).get(`/t/${B.slug}/programs`).set(asB());
    expect(list.status).toBe(200);
    expect(list.body.programs.map((p: { id: string }) => p.id)).toEqual([bProgramId]);

    const mine = await request(app).get(`/t/${B.slug}/me/programs`).set(asB());
    expect(mine.status).toBe(200);
    expect(mine.body.programs.map((p: { id: string }) => p.id)).toEqual([bProgramId]);

    const created = await request(app)
      .post(`/t/${B.slug}/programs`)
      .set(asB())
      .send({
        name: 'B launch',
        commissionRule: { type: 'percent', value: 10 },
        destinationUrl: 'https://b.example.test/',
        shareOnNetwork: false,
        grantToAllPartners: true,
      });
    expect(created.status).toBe(201);
    const grants = await db(TABLES.PartnerProgram).where({ programId: created.body.id }).pluck('partnerId');
    expect(grants).toEqual([bPartnerId]);

    const patch = await request(app).patch(`/t/${B.slug}/programs/${aProgramId}`).set(asB()).send({ name: 'Renamed' });
    expect(patch.status).toBe(404);
    expect(await db(TABLES.Program).where({ id: aProgramId }).first()).toMatchObject({ name: A_PROGRAM_NAME });
  });

  it("GET /partners/:id/programs lists only the tenant's programs", async () => {
    const res = await request(app).get(`/t/${B.slug}/partners/${bPartnerId}/programs`).set(asB());
    expect(res.status).toBe(200);
    expect(res.body.programs.map((p: { id: string }) => p.id)).toEqual([bProgramId]);
    const other = await request(app).get(`/t/${B.slug}/partners/${aPartnerId}/programs`).set(asB());
    expect(other.status).toBe(404);

    // Granting another tenant's program, or revoking another tenant's grant.
    const grant = await request(app)
      .post(`/t/${B.slug}/partners/${bPartnerId}/programs`)
      .set(asB())
      .send({ programIds: [aProgramId] });
    expect(grant.status).toBe(404);
    await db(TABLES.PartnerProgram).insert({ id: `pc_${ulid()}`, tenantId: A.id, partnerId: aPartnerId, programId: aProgramId, source: 'admin' });
    const revoke = await request(app).delete(`/t/${B.slug}/partners/${aPartnerId}/programs/${aProgramId}`).set(asB());
    expect(revoke.status).toBe(404);
    expect(await db(TABLES.PartnerProgram).where({ programId: aProgramId }).pluck('partnerId')).toEqual([aPartnerId]);
  });

  it('the last-active-admin guard counts only the tenant’s admins', async () => {
    // B has one active admin; tenant A's active admin must not count.
    const res = await request(app).post(`/t/${B.slug}/admins/${bAdminId}/revoke`).set(asB()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_revoke_last_active_admin');
    expect(await db(TABLES.Admin).where({ id: bAdminId }).first()).toMatchObject({ revokedAt: null });
  });

  it("admins: list, invite and revoke stay inside the tenant", async () => {
    const list = await request(app).get(`/t/${B.slug}/admins`).set(asB());
    expect(list.status).toBe(200);
    expect(list.body.admins.map((a: { id: string }) => a.id)).toEqual([bAdminId]);

    // Email is unique per tenant: tenant A using it doesn't make it taken.
    const invite = await request(app).post(`/t/${B.slug}/admins`).set(asB()).send({ email: A_ADMIN_EMAIL, name: 'Same person' });
    expect(invite.status).toBe(201);
    expect(invite.body.tenantId).toBe(B.id);

    const revoke = await request(app).post(`/t/${B.slug}/admins/${aAdminId}/revoke`).set(asB()).send({});
    expect(revoke.status).toBe(404);
    const reinstate = await request(app).post(`/t/${B.slug}/admins/${aAdminId}/reinstate`).set(asB()).send({});
    expect(reinstate.status).toBe(404);
    expect(await db(TABLES.Admin).where({ id: aAdminId }).first()).toMatchObject({ revokedAt: null });
  });

  it("an admin invite never carries another tenant's program name", async () => {
    await db(TABLES.Config).insert({
      tenantId: A.id,
      key: 'program_settings',
      value: { programName: A_PROGRAM_NAME } as unknown as never,
      updatedAt: new Date(),
    });
    const res = await request(app).post(`/t/${B.slug}/admins`).set(asB()).send({ email: `new-${tag()}@tenant-b.test`, name: 'New' });
    expect(res.status).toBe(201);
    expect(sentMail).toHaveLength(1);
    expect(JSON.stringify(sentMail[0])).not.toContain(A_PROGRAM_NAME);
  });

  it("GET /commissions lists only the tenant's commissions; approve/reverse 404 on others", async () => {
    const a = await seedConversion(A.id, aPartnerId, aProgramId, 'accrued');
    const b = await seedConversion(B.id, bPartnerId, bProgramId, 'accrued');

    const list = await request(app).get(`/t/${B.slug}/commissions`).set(asB());
    expect(list.status).toBe(200);
    expect(list.body.commissions.map((c: { id: string }) => c.id)).toEqual([b.commissionId]);

    expect((await request(app).post(`/t/${B.slug}/commissions/${a.commissionId}/approve`).set(asB())).status).toBe(404);
    const reverse = await request(app).post(`/t/${B.slug}/commissions/${a.commissionId}/reverse`).set(asB());
    expect(reverse.status).toBe(409);
    expect(await db(TABLES.Commission).where({ id: a.commissionId }).first()).toMatchObject({ status: 'accrued' });
  });

  it("webhook endpoints and their deliveries stay inside the tenant", async () => {
    const aEndpoint = ulid();
    await db(TABLES.WebhookEndpoint).insert({
      id: aEndpoint,
      tenantId: A.id,
      url: 'https://hooks.tenant-a.test/op',
      secretPrefix: 'whsec_a',
      secret: 'whsec_a_secret',
      events: JSON.stringify(['payout.created']) as unknown as never,
      active: false,
    });
    const list = await request(app).get(`/t/${B.slug}/webhooks`).set(asB());
    expect(list.status).toBe(200);
    expect(list.body.endpoints).toEqual([]);
    expect((await request(app).get(`/t/${B.slug}/webhooks/${aEndpoint}`).set(asB())).status).toBe(404);
    expect((await request(app).patch(`/t/${B.slug}/webhooks/${aEndpoint}`).set(asB()).send({ active: true })).status).toBe(404);
    await request(app).delete(`/t/${B.slug}/webhooks/${aEndpoint}`).query({ hard: '1' }).set(asB());
    expect(await db(TABLES.WebhookEndpoint).where({ id: aEndpoint })).toHaveLength(1);
  });

  it("API keys: the scoped list, partner keys and revoke stay inside the tenant", async () => {
    const aScoped = await createApiKeyRow(db, { tenantId: A.id, scopes: ['partners:read'], label: 'A scoped' });
    await createApiKeyRow(db, { tenantId: B.id, scopes: ['partners:read'], label: 'B scoped' });

    const list = await request(app).get(`/t/${B.slug}/api-keys`).set(asB());
    expect(list.status).toBe(200);
    expect(list.body.apiKeys.map((k: { label: string }) => k.label)).toEqual(['B scoped']);

    // A key for another tenant's partner would sign in as that partner here.
    const mint = await request(app).post(`/t/${B.slug}/partners/${aPartnerId}/api-keys`).set(asB()).send({});
    expect(mint.status).toBe(404);

    expect((await request(app).delete(`/t/${B.slug}/api-keys/${aScoped.id}`).set(asB())).status).toBe(404);
    expect(await db(TABLES.ApiKey).where({ id: aScoped.id }).first()).toMatchObject({ revokedAt: null });
  });

  it("portal domains stay inside the tenant", async () => {
    const aDomainId = ulid();
    await db(TABLES.PortalCustomDomain).insert({
      id: aDomainId,
      tenantId: A.id,
      domain: `partners.${tag()}.tenant-a.test`,
      verificationToken: 'tok',
      status: 'verified',
      edgeKind: 'droplet',
    });
    const list = await request(app).get(`/t/${B.slug}/config/domain`).set(asB());
    expect(list.status).toBe(200);
    expect(list.body.domains).toEqual([]);
    expect((await request(app).delete(`/t/${B.slug}/config/domain/${aDomainId}`).set(asB())).status).toBe(404);
    expect(await db(TABLES.PortalCustomDomain).where({ id: aDomainId })).toHaveLength(1);
  });

  it("the coupon verification gate counts only the tenant's coupons", async () => {
    // Tenant A has 5 codes and no verified integration; tenant B has none.
    for (let i = 0; i < 5; i += 1) {
      await db(TABLES.Coupon).insert({ id: `cpn_${ulid()}`, tenantId: A.id, partnerId: aPartnerId, programId: aProgramId, code: `ALPHA${i}${tag()}` });
    }
    const res = await request(app)
      .post(`/t/${B.slug}/partners/${bPartnerId}/coupons`)
      .set(asB())
      .send({ programId: bProgramId, code: `BRAVO${tag()}`.toUpperCase() });
    expect(res.status).toBe(201);

    // And another tenant's partner or program is not this tenant's.
    const foreign = await request(app)
      .post(`/t/${B.slug}/partners/${bPartnerId}/coupons`)
      .set(asB())
      .send({ programId: aProgramId, code: `BRAVO${tag()}`.toUpperCase() });
    expect(foreign.status).toBe(404);

    // Nor can it retire another tenant's code.
    const aCoupon = (await db(TABLES.Coupon).where({ tenantId: A.id }).first('id')) as { id: string };
    const retire = await request(app).delete(`/t/${B.slug}/partners/${aPartnerId}/coupons/${aCoupon.id}`).set(asB());
    expect(retire.status).toBe(404);
    expect(await db(TABLES.Coupon).where({ id: aCoupon.id }).first()).toMatchObject({ deactivatedAt: null });
  });

  it("billing status sums only the tenant's platform fees", async () => {
    await db(TABLES.Tenant).where({ id: B.id }).update({ billingPlan: 'revshare' });
    await db(TABLES.Payout).insert({
      id: ulid(),
      tenantId: A.id,
      partnerId: aPartnerId,
      amount: '1000.00',
      currency: 'USD',
      method: 'manual',
      status: 'paid',
      metadata: { platformFee: 30 },
      completedAt: new Date(),
    });
    const res = await request(app).get(`/t/${B.slug}/billing/status`).set(asB());
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('revshare');
    expect(res.body.accruedPlatformFees).toEqual({});
  });

  it("onboarding status counts only the tenant's programs and partners", async () => {
    await seedProgram(A.id);
    await seedPartner(A.id, `extra-${tag()}@tenant-a.test`);
    const res = await request(app).get(`/t/${B.slug}/admin/onboarding-status`).set(asB());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ campaignCount: 1, partnerCount: 1 });
  });
});

// ---------- routes keyed on a partner ID ----------
//
// requirePartnerOrAdmin('id') passes any admin straight through, whatever
// partner ID the URL names, so tenant B's admin can name tenant A's
// partner (or payout) here.

describe.skipIf(skipIntegration)('partner-keyed routes without RLS', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedPayout(tenantId: string, partnerId: string, status: 'pending' | 'paid'): Promise<string> {
    const id = ulid();
    await db(TABLES.Payout).insert({
      id,
      tenantId,
      partnerId,
      amount: '20.00',
      currency: 'USD',
      method: 'manual',
      status,
      metadata: {},
      completedAt: status === 'paid' ? new Date() : null,
    });
    return id;
  }

  async function seedPostback(tenantId: string, partnerId: string): Promise<{ id: string; url: string }> {
    const id = ulid();
    const url = `https://tracker.tenant-a.test/pb/${tag()}?cid={click_id}`;
    await db(TABLES.PartnerPostback).insert({
      id,
      tenantId,
      partnerId,
      url,
      events: JSON.stringify(['commission.accrued']) as unknown as never,
    });
    return { id, url };
  }

  it("POST /payouts/:id/confirm doesn't mark another tenant's manual payout paid", async () => {
    const payoutId = await seedPayout(A.id, aPartnerId, 'pending');

    const res = await request(app).post(`/t/${B.slug}/payouts/${payoutId}/confirm`).set(asB());

    // Not found, rather than 409 with the payout's method and status.
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'payout_not_found' });
    expect(await db(TABLES.Payout).where({ id: payoutId }).first()).toMatchObject({ status: 'pending', completedAt: null });
  });

  it("GET /partners/:id/payouts doesn't list another tenant's partner's payouts", async () => {
    await seedPayout(A.id, aPartnerId, 'paid');
    const res = await request(app).get(`/t/${B.slug}/partners/${aPartnerId}/payouts`).set(asB());
    expect(res.status).toBe(200);
    expect(res.body.payouts).toEqual([]);
  });

  it("Connect onboarding doesn't start for another tenant's partner", async () => {
    const createAccount = vi.spyOn(stripe!.accounts, 'create').mockResolvedValue({ id: 'acct_scope_test' } as never);
    const createLink = vi
      .spyOn(stripe!.accountLinks, 'create')
      .mockResolvedValue({ url: 'https://connect.stripe.test/setup', expires_at: 0 } as never);

    const res = await request(app)
      .post(`/t/${B.slug}/partners/${aPartnerId}/connect/start`)
      .set(asB())
      .send({ returnUrl: 'https://b.example.test/done', refreshUrl: 'https://b.example.test/retry' });

    expect(res.status).toBe(404);
    expect(createAccount).not.toHaveBeenCalled();
    expect(createLink).not.toHaveBeenCalled();
    expect(await db(TABLES.Partner).where({ id: aPartnerId }).first()).toMatchObject({ stripeConnectAccountId: null });
  });

  it("Connect status doesn't read another tenant's partner's account", async () => {
    await db(TABLES.Partner).where({ id: aPartnerId }).update({ stripeConnectAccountId: 'acct_tenant_a' });
    const retrieve = vi.spyOn(stripe!.accounts, 'retrieve').mockResolvedValue({
      id: 'acct_tenant_a',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    } as never);

    const res = await request(app).get(`/t/${B.slug}/partners/${aPartnerId}/connect/status`).set(asB());

    expect(res.status).toBe(404);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("GET /partners/:id/postbacks doesn't list another tenant's partner's postbacks", async () => {
    await seedPostback(A.id, aPartnerId);
    const res = await request(app).get(`/t/${B.slug}/partners/${aPartnerId}/postbacks`).set(asB());
    expect(res.status).toBe(200);
    expect(res.body.postbacks).toEqual([]);
  });

  it("POST /partners/:id/postbacks doesn't add a postback to another tenant's partner", async () => {
    const res = await request(app)
      .post(`/t/${B.slug}/partners/${aPartnerId}/postbacks`)
      .set(asB())
      .send({ url: 'https://tracker.tenant-b.test/pb?cid={click_id}', events: ['commission.accrued'] });
    expect(res.status).toBe(404);
    expect(await db(TABLES.PartnerPostback).where({ partnerId: aPartnerId })).toEqual([]);
  });

  it("PATCH /partners/:id/postbacks/:postbackId doesn't edit another tenant's postback", async () => {
    const postback = await seedPostback(A.id, aPartnerId);
    const res = await request(app)
      .patch(`/t/${B.slug}/partners/${aPartnerId}/postbacks/${postback.id}`)
      .set(asB())
      .send({ url: 'https://tracker.tenant-b.test/pb?cid={click_id}' });
    expect(res.status).toBe(404);
    expect(await db(TABLES.PartnerPostback).where({ id: postback.id }).first()).toMatchObject({ url: postback.url });
  });

  it("DELETE /partners/:id/postbacks/:postbackId doesn't delete another tenant's postback", async () => {
    const postback = await seedPostback(A.id, aPartnerId);
    const res = await request(app).delete(`/t/${B.slug}/partners/${aPartnerId}/postbacks/${postback.id}`).set(asB());
    expect(res.status).toBe(404);
    expect(await db(TABLES.PartnerPostback).where({ id: postback.id })).toHaveLength(1);
  });
});

// ---------- keys unique per tenant ----------

describe.skipIf(skipIntegration)('per-tenant keys without RLS', () => {
  it("coupon redemption doesn't match another tenant's code", async () => {
    const code = `SHARED${tag()}`.toUpperCase();
    await db(TABLES.Coupon).insert({ id: `cpn_${ulid()}`, tenantId: A.id, partnerId: aPartnerId, programId: aProgramId, code });
    const res = await request(app)
      .post(`/t/${B.slug}/coupons/redeem`)
      .set(asB())
      .send({ code, eventType: 'signup', externalEventId: `ord_${ulid()}`, userId: `u-${ulid()}` });
    expect(res.status).toBe(404);
    expect(await db(TABLES.Click).where({ partnerId: aPartnerId })).toEqual([]);
  });

  it("POST /clicks doesn't resolve another tenant's link key", async () => {
    const linkKey = `lk${tag()}`;
    await db(TABLES.Link).insert({ id: ulid(), tenantId: A.id, partnerId: aPartnerId, programId: aProgramId, linkKey, destinationUrl: 'https://x/' });
    const res = await request(app)
      .post(`/t/${B.slug}/clicks`)
      .set(asB())
      .send({ id: ulid(), linkKey, landingUrl: 'https://example.test/', ts: new Date().toISOString() });
    expect(res.status).toBe(404);
    expect(await db(TABLES.Click).where({ partnerId: aPartnerId })).toEqual([]);
  });

  it("partner links: another tenant's partner or program is not found", async () => {
    const forPartner = await request(app)
      .post(`/t/${B.slug}/partners/${aPartnerId}/links`)
      .set(asB())
      .send({ linkKey: `lk${tag()}`, programId: aProgramId });
    expect(forPartner.status).toBe(404);
    const forProgram = await request(app)
      .post(`/t/${B.slug}/partners/${bPartnerId}/links`)
      .set(asB())
      .send({ linkKey: `lk${tag()}`, programId: aProgramId });
    expect(forProgram.status).toBe(404);
  });

  it("sign-in doesn't mail a link for another tenant's admin or partner", async () => {
    for (const email of [A_ADMIN_EMAIL, A_EMAIL]) {
      const res = await request(app).post(`/t/${B.slug}/auth/signin`).send({ email });
      expect(res.status).toBe(200);
    }
    expect(sentMail).toEqual([]);
    expect(await db(TABLES.MagicLinkToken).where({ tenantId: B.id })).toEqual([]);
  });

  it("another tenant's magic link doesn't open a session here", async () => {
    const issued = await issueMagicLink(db, {
      tenantId: A.id,
      email: A_ADMIN_EMAIL,
      purpose: 'admin_signin',
      principalKind: 'admin',
      principalId: aAdminId,
    });
    const res = await request(app).post(`/t/${B.slug}/auth/magic/verify`).send({ token: issued.plaintext });
    expect(res.status).toBe(400);
    expect(await db(TABLES.Session).where({ tenantId: B.id })).toEqual([]);
  });

  it("the public signup isn't swallowed by another tenant's partner with the same email", async () => {
    const res = await request(app)
      .post(`/t/${B.slug}/partner-signup`)
      .send({
        email: A_EMAIL,
        name: 'Ada, applying to B',
        // The hosted join page asks where the applicant is based.
        country: 'GB',
        application: {
          websiteUrl: 'https://creator.example',
          socialUrls: ['https://youtube.com/@creator'],
          audienceSize: '10k_50k',
          pitch: 'Weekly tutorials for indie founders; I would demo the product in a launch video.',
        },
      });
    expect(res.status).toBeLessThan(300);
    expect(res.body.status).not.toBe('already_registered');
    expect(await db(TABLES.Partner).where({ tenantId: B.id, email: A_EMAIL })).toHaveLength(1);
  });
});
