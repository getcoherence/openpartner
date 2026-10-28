/**
 * OpenPartner's own partner program (house-program.ts), end to end on a
 * hosted multi-tenant deployment:
 *
 *   - Ops picks the program's brand in the console (PlatformSetting).
 *   - A partner click, then a brand signup carrying it (the op_ref cookie
 *     op.js writes on openpartner.dev, or ?cref= on the signup page), then
 *     the brand's card Checkout, then its first invoice paid on
 *     OpenPartner's billing account, delivered over the program brand's
 *     Stripe App connection to that account: the partner is credited for
 *     the signup and earns commission on the invoice.
 *   - The same billing Customer seen on /webhooks/stripe (OpenPartner's own
 *     account) records nothing among the brand's own conversions, and the
 *     brand's subscription is still persisted.
 *   - Nothing is credited without a house click, for another tenant's
 *     click, or while no program brand is set.
 *
 * Stripe is a recorded mock shared by the platform key and the Stripe App
 * token. Requires DATABASE_URL; skipped without it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import Stripe from 'stripe';

const PLATFORM_KEY = 'sk_test_platform_billing_house';
const PLATFORM_WEBHOOK_SECRET = 'whsec_platform_house_program';
const APP_WEBHOOK_SECRET = 'whsec_stripe_app_house_program';
const BILLING_ACCOUNT = 'acct_1OpenPartnerBilling';
const HOUSE_TOKEN = 'at_house_billing_account';

process.env.OPENPARTNER_MODE = 'revshare';
process.env.OPENPARTNER_TENANCY = 'multi';
process.env.PORTAL_URL = 'http://localhost:5673';
process.env.STRIPE_SECRET_KEY = PLATFORM_KEY;
process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_WEBHOOK_SECRET;
process.env.STRIPE_APP_WEBHOOK_SECRET = APP_WEBHOOK_SECRET;
process.env.STRIPE_FLAT_PRICE_ID = 'price_house_flat';
process.env.STRIPE_FLAT_USAGE_PRICE_ID = 'price_house_flat_usage';
process.env.STRIPE_REVSHARE_USAGE_PRICE_ID = 'price_house_rev';
delete process.env.NETWORK_URL;
delete process.env.PLATFORM_OPS_EMAIL;

// Every Stripe call any client makes, with the key it was made with. The
// customers a Checkout creates are kept, so a later read returns them.
const stripeApi = vi.hoisted(() => ({
  calls: [] as Array<{ key: string; method: string; args: unknown[] }>,
  customers: new Map<string, Record<string, unknown>>(),
}));

vi.mock('stripe', async () => {
  const actual = await vi.importActual<typeof import('stripe')>('stripe');
  const Real = actual.default;
  const missing = (what: string) => async () => {
    throw Object.assign(new Error(`No such ${what}`), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
  };
  const impl: Record<string, (...args: unknown[]) => unknown> = {
    'customers.create': async (p: unknown) => {
      const id = `cus_${ulid()}`;
      const customer = { id, object: 'customer', deleted: false, ...(p as object) };
      stripeApi.customers.set(id, customer);
      return customer;
    },
    'customers.retrieve': async (id: unknown) =>
      stripeApi.customers.get(id as string) ?? { id, object: 'customer', metadata: {}, deleted: false },
    'customers.update': async (id: unknown) => ({ id }),
    'checkout.sessions.create': async () => ({ id: `cs_${ulid()}`, url: 'https://checkout.stripe.com/c/house' }),
    'checkout.sessions.list': async () => ({ object: 'list', data: [], has_more: false }),
    'checkout.sessions.retrieve': missing('checkout session'),
    'invoices.retrieve': missing('invoice'),
    'invoicePayments.list': async () => ({ object: 'list', data: [], has_more: false }),
    'subscriptions.retrieve': async (id: unknown) => ({
      id,
      object: 'subscription',
      status: 'active',
      collection_method: 'charge_automatically',
      items: { data: [] },
    }),
    // Pay-by-invoice (invoice-billing.ts startInvoiceSubscription).
    'subscriptions.list': async () => ({ object: 'list', data: [], has_more: false }),
    'subscriptions.create': async (p: unknown) => ({
      id: `sub_${ulid()}`,
      object: 'subscription',
      status: 'active',
      collection_method: 'send_invoice',
      items: { data: (p as { items: Array<{ price: string }> }).items.map((i) => ({ price: { id: i.price } })) },
      latest_invoice: null,
    }),
    'invoices.list': async () => ({ object: 'list', data: [], has_more: false }),
    'promotionCodes.retrieve': missing('promotion code'),
    'promotionCodes.list': async () => ({ object: 'list', data: [] }),
    'coupons.retrieve': missing('coupon'),
  };
  function MockedStripe(this: unknown, key: string, opts?: Stripe.StripeConfig) {
    const instance = new Real(key, opts) as unknown as Record<string, unknown>;
    const call =
      (method: string) =>
      (...args: unknown[]) => {
        stripeApi.calls.push({ key, method, args });
        return impl[method]!(...args);
      };
    instance.customers = { create: call('customers.create'), retrieve: call('customers.retrieve'), update: call('customers.update') };
    instance.checkout = {
      sessions: {
        create: call('checkout.sessions.create'),
        list: call('checkout.sessions.list'),
        retrieve: call('checkout.sessions.retrieve'),
      },
    };
    instance.invoices = { retrieve: call('invoices.retrieve'), list: call('invoices.list') };
    instance.invoicePayments = { list: call('invoicePayments.list') };
    instance.subscriptions = {
      retrieve: call('subscriptions.retrieve'),
      list: call('subscriptions.list'),
      create: call('subscriptions.create'),
    };
    instance.promotionCodes = { retrieve: call('promotionCodes.retrieve'), list: call('promotionCodes.list') };
    instance.coupons = { retrieve: call('coupons.retrieve') };
    return instance;
  }
  (MockedStripe as unknown as { webhooks: unknown }).webhooks = (Real as unknown as { webhooks: unknown }).webhooks;
  return { default: MockedStripe };
});

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});

const { TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { createSession } = await import('../auth-sessions.js');
const { encryptSecret } = await import('../crypto.js');
const { STRIPE_APP_PERMISSIONS_VERSION } = await import('../stripe-app.js');
const { settleBackgroundScreeningsForTesting } = await import('../sanctions-screening.js');
const { createPlatformAdminSession, PLATFORM_ADMIN_SESSION_COOKIE } = await import('../platform-admin-sessions.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const signer = new Stripe('sk_test_signer');

const rnd = () => ulid().slice(-8).toLowerCase();
const slugs: string[] = [];
const operatorIds: string[] = [];

interface House {
  tenantId: string;
  slug: string;
  partnerId: string;
  programId: string;
  clickId: string;
}

/** The program brand: one partner, one program, one click on their link. */
async function seedHouse(): Promise<House> {
  const slug = `house${rnd()}`;
  slugs.push(slug);
  const tenantId = ulid();
  await db(TABLES.Tenant).insert({ id: tenantId, slug, displayName: 'OP Partnerships', status: 'active', approvalStatus: 'approved' });
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId, name: 'House partner', email: `p-${partnerId}@x.test` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId,
    name: 'OpenPartner - Earn 50%',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: JSON.stringify({ type: 'percent', value: 50 }),
    destinationUrl: 'https://openpartner.test',
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId, partnerId, programId, linkKey: `lk-${linkId}`, destinationUrl: 'https://openpartner.test' });
  await db(TABLES.Click).insert({ id: clickId, tenantId, linkId, partnerId, programId, landingUrl: 'https://openpartner.test', ipHash: 'h', ts: new Date() });
  return { tenantId, slug, partnerId, programId, clickId };
}

/** The program brand's Stripe App connection to OpenPartner's billing account. */
async function connectBillingAccount(tenantId: string): Promise<void> {
  await db(TABLES.TenantStripeConnection).insert({
    id: `tsc_${ulid()}`,
    tenantId,
    stripeAccountId: BILLING_ACCOUNT,
    livemode: true,
    keyMode: 'live',
    refreshTokenEnc: encryptSecret('rt_house'),
    accessTokenEnc: encryptSecret(HOUSE_TOKEN),
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    permissionsVersion: STRIPE_APP_PERMISSIONS_VERSION,
  });
}

async function operatorCookie(role: 'admin' | 'support'): Promise<string> {
  const admin = { id: ulid(), email: `ops-${rnd()}@openpartner.test`, name: 'Ops', role, createdAt: new Date(), revokedAt: null };
  await db(TABLES.PlatformAdmin).insert(admin);
  operatorIds.push(admin.id);
  const session = await createPlatformAdminSession(db, admin);
  return `${PLATFORM_ADMIN_SESSION_COOKIE}=${session.plaintext}`;
}

async function setHouse(slug: string | null) {
  return request(app).put('/platform-admin/house-program').set('Cookie', await operatorCookie('admin')).send({ slug });
}

/** POST /signup as the portal's form does, with what the browser carries. */
async function signup(o: { cookie?: string; cref?: string } = {}) {
  const slug = `brand${rnd()}`;
  slugs.push(slug);
  let req = request(app).post('/signup');
  if (o.cookie) req = req.set('Cookie', o.cookie);
  const res = await req.send({
    slug,
    displayName: 'Referred Brand',
    adminEmail: `admin-${rnd()}@example.test`,
    adminName: 'Brand Admin',
    plan: 'flex',
    country: 'US',
    ...(o.cref ? { cref: o.cref } : {}),
  });
  expect([201, 202]).toContain(res.status);
  return { tenantId: res.body.tenant.id as string, slug };
}

async function brandAdminCookie(tenantId: string): Promise<string> {
  const adminId = ulid();
  await db(TABLES.Admin).insert({ id: adminId, tenantId, email: `billing-${adminId}@x.test`, name: 'Billing', activatedAt: new Date() });
  const { plaintext } = await createSession(db, { tenantId, principalKind: 'admin', principalId: adminId });
  return `op_session=${plaintext}`;
}

/** The brand's admin starts card Checkout (or, `byInvoice`, a pay-by-invoice
 *  subscription); returns the Customer it created. */
async function checkout(brand: { tenantId: string; slug: string }, o: { byInvoice?: boolean } = {}) {
  const cookie = await brandAdminCookie(brand.tenantId);
  const res = o.byInvoice
    ? await request(app).post(`/t/${brand.slug}/billing/invoice-subscription`).set('Cookie', cookie).send({})
    : await request(app)
        .post(`/t/${brand.slug}/billing/checkout`)
        .set('Cookie', cookie)
        .send({ successUrl: 'https://app.openpartner.test/ok', cancelUrl: 'https://app.openpartner.test/no' });
  expect(res.status).toBe(200);
  const created = stripeApi.calls.filter((c) => c.method === 'customers.create');
  expect(created).toHaveLength(1);
  expect(created[0]!.key).toBe(PLATFORM_KEY);
  const tenant = await db(TABLES.Tenant).where({ id: brand.tenantId }).first();
  return stripeApi.customers.get(tenant.stripeCustomerId)! as { id: string; metadata: Record<string, string> };
}

function stripeEvent(type: string, object: Record<string, unknown>, account?: string) {
  return {
    id: `evt_${ulid()}`,
    object: 'event',
    type,
    ...(account ? { account } : {}),
    livemode: true,
    created: Math.floor(Date.now() / 1000),
    api_version: '2026-09-30',
    data: { object },
  };
}

function postSigned(path: string, payload: object, secret: string) {
  const body = JSON.stringify(payload);
  const sig = signer.webhooks.generateTestHeaderString({ payload: body, secret });
  return request(app).post(path).set('content-type', 'application/json').set('stripe-signature', sig).send(body);
}
/** OpenPartner's own account, as /webhooks/stripe receives it. */
const postPlatform = (type: string, object: Record<string, unknown>) => postSigned('/webhooks/stripe', stripeEvent(type, object), PLATFORM_WEBHOOK_SECRET);
/** The same account over the Stripe App, as the program brand's connection. */
const postApp = (type: string, object: Record<string, unknown>) =>
  postSigned('/webhooks/stripe-app', stripeEvent(type, object, BILLING_ACCOUNT), APP_WEBHOOK_SECRET);

// In the order they were recorded: a webhook's Event is stamped with the
// Stripe event's whole-second `created`.
const eventsOf = (tenantId: string) => db(TABLES.Event).where({ tenantId }).orderBy('id', 'asc');

/** Every row any test made for these brands, then the brands. */
async function purge(slug: string): Promise<void> {
  const tenant = await db(TABLES.Tenant).where({ slug }).first();
  if (!tenant) return;
  const tables = (await db('information_schema.columns')
    .where({ table_schema: 'public', column_name: 'tenantId' })
    .andWhereNot('table_name', TABLES.Tenant)
    .pluck('table_name')) as string[];
  // Children first: retry tables an FK holds back until a pass deletes nothing new.
  for (let pass = 0; pass < 4; pass += 1) {
    for (const t of tables) {
      try {
        await db(t).where({ tenantId: tenant.id }).del();
      } catch {
        /* an FK still points here; the next pass gets it */
      }
    }
  }
  await db(TABLES.Tenant).where({ id: tenant.id }).del();
}

beforeEach(async () => {
  stripeApi.calls.length = 0;
  stripeApi.customers.clear();
  if (skipIntegration) return;
  await db(TABLES.PlatformSetting).where({ key: 'houseProgram' }).del();
});

afterEach(async () => {
  if (skipIntegration) return;
  await settleBackgroundScreeningsForTesting();
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const s of slugs) await purge(s);
    await db(TABLES.PlatformSetting).where({ key: 'houseProgram' }).del();
    await db(TABLES.PlatformAuditLog).where({ action: 'house_program.settings' }).del();
    await db(TABLES.PlatformAdminSession).whereIn('platformAdminId', operatorIds).del();
    await db(TABLES.PlatformAdmin).whereIn('id', operatorIds).del();
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('OpenPartner’s own program: click → signup → billing over the Stripe App', () => {
  it('credits the partner for the brand’s signup and earns commission on its first invoice', async () => {
    const house = await seedHouse();
    await connectBillingAccount(house.tenantId);
    const set = await setHouse(house.slug);
    expect(set.status).toBe(200);
    expect(set.body.settings).toEqual({ tenantId: house.tenantId });

    // The visitor clicked the partner's link, landed on openpartner.dev
    // (op.js wrote op_ref on the parent domain) and signs up as a brand.
    const brand = await signup({ cookie: `op_ref=${house.clickId}` });

    const [signupEvent] = await eventsOf(house.tenantId);
    expect(signupEvent).toMatchObject({ type: 'signup', userId: brand.tenantId, externalEventId: `brand_signup:${brand.tenantId}` });
    expect(signupEvent.metadata).toMatchObject({ source: 'brand_signup', brandSlug: brand.slug });
    expect(await db(TABLES.Identity).where({ tenantId: house.tenantId, userId: brand.tenantId }).pluck('clickId')).toEqual([house.clickId]);
    expect(await db(TABLES.Attribution).where({ eventId: signupEvent.id }).first()).toMatchObject({ partnerId: house.partnerId });
    // Nothing is recorded in the new brand's own tenant.
    expect(await eventsOf(brand.tenantId)).toEqual([]);

    // Card Checkout: the billing Customer names the brand's house user; the
    // session carries no client_reference_id (handleConnectEvent's marker
    // for "not our subscription").
    const customer = await checkout(brand);
    expect(customer.metadata).toEqual({
      openpartner_role: 'merchant_self_subscription',
      openpartner_tenant_id: brand.tenantId,
      openpartner_user_id: brand.tenantId,
    });
    const [session] = stripeApi.calls.filter((c) => c.method === 'checkout.sessions.create');
    expect(session!.args[0]).not.toHaveProperty('client_reference_id');

    // /webhooks/stripe: OpenPartner's own account. Billing persists as
    // always, and none of it lands among the brand's own conversions.
    const subscriptionId = `sub_${ulid()}`;
    const sub = { id: subscriptionId, object: 'subscription', customer: customer.id, status: 'active', metadata: {}, items: { data: [] } };
    expect((await postPlatform('customer.created', customer)).status).toBe(200);
    const completed = await postPlatform('checkout.session.completed', {
      id: `cs_${ulid()}`,
      object: 'checkout.session',
      mode: 'subscription',
      customer: customer.id,
      subscription: subscriptionId,
      client_reference_id: null,
      metadata: { openpartner_tenant_id: brand.tenantId, openpartner_plan: 'flex' },
    });
    expect(completed.body.connect).toBe('merchant_subscription_persisted');
    expect((await postPlatform('customer.subscription.created', sub)).status).toBe(200);
    expect(await db(TABLES.Tenant).where({ id: brand.tenantId }).first()).toMatchObject({
      stripeCustomerId: customer.id,
      stripeSubscriptionId: subscriptionId,
    });
    expect(await eventsOf(brand.tenantId)).toEqual([]);

    // The same account over the Stripe App, as the program brand's
    // connection: the customer's signup is already on record, the
    // subscription and the first invoice are the brand's.
    expect((await postApp('customer.created', customer)).body).toMatchObject({ skipped: 'customer.created' });
    expect((await postApp('customer.subscription.created', sub)).status).toBe(200);
    const invoiceId = `in_${ulid()}`;
    const paid = await postApp('invoice.paid', {
      id: invoiceId,
      object: 'invoice',
      customer: customer.id,
      subscription: subscriptionId,
      billing_reason: 'subscription_create',
      amount_paid: 4900,
      currency: 'usd',
      discounts: [],
    });
    expect(paid.status).toBe(200);
    expect(paid.body.attribution).toMatchObject({ status: 'attributed' });

    const events = await eventsOf(house.tenantId);
    expect(events.map((e) => [e.type, e.userId])).toEqual([
      ['signup', brand.tenantId],
      ['subscription_created', brand.tenantId],
      ['invoice_paid', brand.tenantId],
    ]);
    const invoice = events.find((e) => e.type === 'invoice_paid')!;
    expect(invoice).toMatchObject({ value: '49.00', currency: 'USD', externalEventId: invoiceId });
    const commissions = await db(TABLES.Commission).where({ tenantId: house.tenantId });
    expect(commissions).toHaveLength(1);
    expect(commissions[0]).toMatchObject({ partnerId: house.partnerId, amount: '24.50', status: 'accrued' });
    expect(await db(TABLES.Attribution).where({ id: commissions[0].attributionId }).first()).toMatchObject({ eventId: invoice.id });
    // Read with the Stripe App token, never the platform key.
    expect(stripeApi.calls.filter((c) => c.key === HOUSE_TOKEN).map((c) => c.method)).toContain('customers.retrieve');
    expect(await eventsOf(brand.tenantId)).toEqual([]);

    const view = await request(app).get('/platform-admin/house-program').set('Cookie', await operatorCookie('support'));
    expect(view.body).toMatchObject({
      tenant: { id: house.tenantId, slug: house.slug },
      stripeConnection: { stripeAccountId: BILLING_ACCOUNT, livemode: true },
      referredBrands: 1,
    });
  });

  it('takes the click from ?cref= on the signup page too, ahead of an older op_ref', async () => {
    const house = await seedHouse();
    await setHouse(house.slug);
    const other = ulid();
    await db(TABLES.Click).insert({
      id: other,
      tenantId: house.tenantId,
      partnerId: house.partnerId,
      programId: house.programId,
      landingUrl: 'https://openpartner.test',
      ipHash: 'h',
      ts: new Date(Date.now() - 86_400_000),
    });
    const brand = await signup({ cookie: `op_ref=${other}`, cref: house.clickId });
    expect(await db(TABLES.Identity).where({ tenantId: house.tenantId, userId: brand.tenantId }).pluck('clickId')).toEqual([house.clickId]);
  });

  it('credits nobody without a house click, for another brand’s click, or with no program brand set', async () => {
    const house = await seedHouse();
    const elsewhere = await seedHouse(); // another brand's partner click

    // No program brand chosen yet.
    const early = await signup({ cookie: `op_ref=${house.clickId}` });
    await setHouse(house.slug);
    // The click is some other tenant's.
    const foreign = await signup({ cookie: `op_ref=${elsewhere.clickId}` });
    // No click at all.
    const direct = await signup();

    expect(await eventsOf(house.tenantId)).toEqual([]);
    expect(await db(TABLES.Identity).where({ tenantId: house.tenantId })).toEqual([]);
    for (const brand of [early, foreign, direct]) {
      stripeApi.calls.length = 0;
      const customer = await checkout(brand);
      expect(customer.metadata).not.toHaveProperty('openpartner_user_id');
    }
  });

  it('names the referred brand on a pay-by-invoice billing Customer too', async () => {
    const house = await seedHouse();
    await setHouse(house.slug);
    const brand = await signup({ cookie: `op_ref=${house.clickId}` });
    await db(TABLES.HostedBillingProfile).insert({ tenantId: brand.tenantId, collectionMethod: 'send_invoice' });
    const customer = await checkout(brand, { byInvoice: true });
    expect(customer.metadata).toEqual({
      openpartner_role: 'merchant_self_subscription',
      openpartner_tenant_id: brand.tenantId,
      openpartner_user_id: brand.tenantId,
    });
  });

  it('records a reclaimed signup once', async () => {
    const house = await seedHouse();
    await setHouse(house.slug);
    const first = await signup({ cookie: `op_ref=${house.clickId}` });
    // The abandoned signup is reclaimed under the same slug.
    const again = await request(app)
      .post('/signup')
      .set('Cookie', `op_ref=${house.clickId}`)
      .send({ slug: first.slug, displayName: 'Referred Brand', adminEmail: `admin-${rnd()}@example.test`, adminName: 'Brand Admin', plan: 'flex', country: 'US' });
    expect(again.body.tenant.id).toBe(first.tenantId);
    expect(await eventsOf(house.tenantId)).toHaveLength(1);
  });
});

describe.skipIf(skipIntegration)('ops console: Own program', () => {
  it('sets and clears the program brand, refuses an unknown slug and a read-only operator, and audits', async () => {
    const since = new Date();
    const house = await seedHouse();
    const admin = await operatorCookie('admin');
    const unknown = await request(app).put('/platform-admin/house-program').set('Cookie', admin).send({ slug: 'no-such-brand' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('tenant_not_found');

    const support = await request(app).put('/platform-admin/house-program').set('Cookie', await operatorCookie('support')).send({ slug: house.slug });
    expect(support.status).toBe(403);

    const set = await request(app).put('/platform-admin/house-program').set('Cookie', admin).send({ slug: house.slug.toUpperCase() });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ settings: { tenantId: house.tenantId }, stripeConnection: null, referredBrands: 0 });

    const cleared = await request(app).put('/platform-admin/house-program').set('Cookie', admin).send({ slug: null });
    expect(cleared.body).toMatchObject({ settings: { tenantId: null }, tenant: null });
    const audit = await db(TABLES.PlatformAuditLog)
      .where({ action: 'house_program.settings' })
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'asc');
    expect(audit.map((a) => a.targetId)).toEqual([house.tenantId, null]);
  });
});
