/**
 * Pay-by-invoice billing end to end against the DB (docs/invoice-billing.md):
 * the brand's subscribe and tax-details routes, the Checkout guards, the
 * overdue grace in the partner-onboarding gate, never losing a created
 * subscription, and ops moving a live subscription between card and
 * invoice. Stripe is a recording fake; the real behaviour it stands in for
 * was checked in Stripe test mode (see the doc).
 *
 * Skipped if DATABASE_URL isn't set.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_invoice_billing_admin_0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.STRIPE_FLAT_PRICE_ID = 'price_inv_flat';
process.env.STRIPE_FLAT_USAGE_PRICE_ID = 'price_inv_flat_usage';
process.env.STRIPE_REVSHARE_USAGE_PRICE_ID = 'price_inv_rev';
process.env.STRIPE_WHITELABEL_ADD_ON_PRICE_ID = 'price_inv_wl';

const GSTIN = '27AAPFU0939F1ZV';
const DAY = 86_400_000;

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  taxIds: [] as Array<{ id: string; type: string; value: string }>,
  defaultPaymentMethod: null as string | null,
  live: { collection_method: 'charge_automatically', days_until_due: null as number | null, status: 'active' },
  existingSubs: [] as Array<Record<string, unknown>>,
  promotionCodes: {} as Record<string, string>,
  failWhiteLabel: false,
}));

function fakeStripe() {
  return {
    customers: {
      create: async (args: Record<string, unknown>) => {
        h.calls.push(['customers.create', args]);
        return { id: 'cus_inv_test' };
      },
      update: async (id: string, args: Record<string, unknown>) => {
        h.calls.push(['customers.update', args]);
        return { id };
      },
      retrieve: async (id: string) => ({ id, deleted: false, address: null }),
      listTaxIds: async () => ({ data: [...h.taxIds] }),
      createTaxId: async (_id: string, args: { type: string; value: string }) => {
        h.calls.push(['customers.createTaxId', args]);
        const t = { id: `txi_${h.taxIds.length + 1}`, ...args };
        h.taxIds.push(t);
        return t;
      },
      deleteTaxId: async (_id: string, taxId: string) => {
        h.calls.push(['customers.deleteTaxId', taxId]);
        h.taxIds = h.taxIds.filter((t) => t.id !== taxId);
        return { id: taxId, deleted: true };
      },
    },
    subscriptions: {
      list: async () => ({ data: h.existingSubs }),
      create: async (args: { items: Array<{ price: string }>; collection_method: string }) => {
        h.calls.push(['subscriptions.create', args]);
        return {
          id: 'sub_inv_test',
          status: 'active',
          collection_method: args.collection_method,
          items: { data: args.items.map((i) => ({ price: { id: i.price } })) },
          latest_invoice: { id: 'in_inv_test', status: 'draft', amount_due: 4900, hosted_invoice_url: null },
        };
      },
      cancel: async (id: string) => {
        h.calls.push(['subscriptions.cancel', id]);
        return { id, status: 'canceled' };
      },
      retrieve: async (id: string) => ({
        id,
        ...h.live,
        items: { data: [] },
        trial_end: null,
        default_payment_method: null,
        customer: {
          id: 'cus_inv_test',
          deleted: false,
          invoice_settings: { default_payment_method: h.defaultPaymentMethod },
          default_source: null,
        },
      }),
      update: async (id: string, args: { collection_method: string; days_until_due?: number }) => {
        h.calls.push(['subscriptions.update', args]);
        h.live = { ...h.live, collection_method: args.collection_method, days_until_due: args.days_until_due ?? null };
        return { id, ...h.live };
      },
    },
    invoices: {
      finalizeInvoice: async (id: string, args: Record<string, unknown>) => {
        h.calls.push(['invoices.finalizeInvoice', args]);
        return {
          id,
          number: 'OP-0001',
          status: 'open',
          amount_due: 4900,
          amount_paid: 0,
          amount_remaining: 4900,
          currency: 'usd',
          created: 1_800_000_000,
          due_date: Math.floor((Date.now() + 15 * DAY) / 1000),
          collection_method: 'send_invoice',
          hosted_invoice_url: 'https://invoice.stripe.com/i/test_inv',
          invoice_pdf: null,
        };
      },
      update: async (id: string, args: Record<string, unknown>) => {
        h.calls.push(['invoices.update', args]);
        return { id };
      },
      voidInvoice: async (id: string) => {
        h.calls.push(['invoices.voidInvoice', id]);
        return { id, status: 'void' };
      },
      // The first invoice is open once finalized to be sent (auto_advance).
      list: async (params: { status?: string }) =>
        params.status === 'open'
          ? {
              data: h.calls.some(([n, a]) => n === 'invoices.finalizeInvoice' && (a as { auto_advance?: boolean }).auto_advance)
                ? [{ id: 'in_inv_test', amount_remaining: 4900, due_date: Math.floor((Date.now() + 15 * DAY) / 1000) }]
                : [],
            }
          : { data: [] },
    },
    promotionCodes: {
      list: async (params: { code: string }) => ({
        data: h.promotionCodes[params.code] ? [{ id: h.promotionCodes[params.code] }] : [],
      }),
    },
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          h.calls.push(['checkout.sessions.create', args]);
          return { url: 'https://checkout.stripe.com/test' };
        },
      },
    },
  };
}

vi.mock('../stripe.js', async () => {
  const actual = await vi.importActual<typeof import('../stripe.js')>('../stripe.js');
  return { ...actual, requireStripe: () => fakeStripe() };
});

// A failure after the subscription exists in Stripe, before the pointer
// commits: the white-label step is the last write in that transaction.
vi.mock('../white-label-billing.js', async () => {
  const actual = await vi.importActual<typeof import('../white-label-billing.js')>('../white-label-billing.js');
  return {
    ...actual,
    applyWhiteLabelFromSubscription: async (...args: Parameters<typeof actual.applyWhiteLabelFromSubscription>) => {
      if (h.failWhiteLabel) throw new Error('white-label write failed');
      return actual.applyWhiteLabelFromSubscription(...args);
    },
  };
});

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { setTenantCollection, OpsCollectionError, listInvoiceBillingTenants } = await import('../invoice-billing.js');
const { setInvoiceBillingSettings } = await import('../platform-settings.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const auth = { Authorization: `Bearer ${ADMIN_KEY}` };
const noAudit = async () => undefined;

async function declare(country: string): Promise<void> {
  await db(TABLES.LocationDeclaration).where({ subjectKind: 'tenant', subjectId: DEFAULT_TENANT_ID }).del();
  await db(TABLES.LocationDeclaration).insert({
    id: ulid(),
    subjectKind: 'tenant',
    subjectId: DEFAULT_TENANT_ID,
    tenantId: DEFAULT_TENANT_ID,
    country,
    source: 'signup',
  });
}

async function wipe(): Promise<void> {
  await db(TABLES.HostedBillingProfile).where({ tenantId: DEFAULT_TENANT_ID }).del();
  await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).del();
  await db(TABLES.LocationDeclaration).where({ subjectKind: 'tenant', subjectId: DEFAULT_TENANT_ID }).del();
  await db(TABLES.PlatformSetting).where({ key: 'invoiceBilling' }).del();
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID }).del();
}

function called(name: string): unknown[] {
  return h.calls.filter(([n]) => n === name).map(([, a]) => a);
}

async function tenantRow() {
  return (await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first())!;
}

beforeEach(async () => {
  h.calls = [];
  h.taxIds = [];
  h.defaultPaymentMethod = null;
  h.live = { collection_method: 'charge_automatically', days_until_due: null, status: 'active' };
  h.existingSubs = [];
  h.promotionCodes = {};
  h.failWhiteLabel = false;
  if (skipIntegration) return;
  await wipe();
  await db(TABLES.Tenant)
    .where({ id: DEFAULT_TENANT_ID })
    .update({ billingPlan: 'flex', stripeCustomerId: null, stripeSubscriptionId: null, whiteLabel: false });
});

afterAll(async () => {
  if (!skipIntegration) {
    await wipe();
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ billingPlan: null, stripeCustomerId: null, stripeSubscriptionId: null, whiteLabel: false });
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('brand subscribes by invoice', () => {
  it('an Indian brand defaults to invoices: Checkout is refused, the status says why', async () => {
    await declare('IN');
    const checkout = await request(app)
      .post('/billing/checkout')
      .set(auth)
      .send({ successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no' });
    expect(checkout.status).toBe(409);
    expect(checkout.body.error).toBe('invoice_billing');

    const status = await request(app).get('/billing/status').set(auth);
    expect(status.status).toBe(200);
    expect(status.body.collection).toEqual({
      method: 'send_invoice',
      source: 'country',
      daysUntilDue: 15,
      country: 'IN',
      gstin: null,
      gstinRequired: true,
    });
  });

  it('refuses an Indian brand without a valid GSTIN, before touching Stripe', async () => {
    await declare('IN');
    const missing = await request(app).post('/billing/invoice-subscription').set(auth).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('gstin_required');

    const typo = await request(app).post('/billing/invoice-subscription').set(auth).send({ gstin: '27AAPFU0939F1ZW' });
    expect(typo.status).toBe(400);
    expect(typo.body.error).toBe('invalid_gstin');
    expect(h.calls).toEqual([]);
    expect((await tenantRow()).stripeSubscriptionId).toBeNull();
  });

  it('creates a send_invoice subscription with the GSTIN, reverse-charge footer, card + bank transfer', async () => {
    await declare('IN');
    const res = await request(app)
      .post('/billing/invoice-subscription')
      .set(auth)
      .send({ gstin: '27aapfu0939f1zv', legalName: 'Probe Industries Pvt Ltd', billingEmail: 'ap@probe.test' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      subscriptionId: 'sub_inv_test',
      status: 'active',
      adopted: false,
      invoice: { id: 'in_inv_test', status: 'open', hostedInvoiceUrl: 'https://invoice.stripe.com/i/test_inv', amountRemaining: 4900 },
    });

    expect(called('customers.create')).toEqual([
      {
        email: 'ap@probe.test',
        name: 'Probe Industries Pvt Ltd',
        metadata: { openpartner_role: 'merchant_self_subscription', openpartner_tenant_id: DEFAULT_TENANT_ID },
      },
    ]);
    expect(called('customers.createTaxId')).toEqual([{ type: 'in_gst', value: GSTIN }]);
    expect(called('customers.update')).toContainEqual({
      invoice_settings: { footer: 'Reverse charge applicable' },
      address: { country: 'IN' },
    });
    // Tax details go on the customer BEFORE the subscription: the first
    // invoice copies them when it's finalized.
    const order = h.calls.map(([n]) => n);
    expect(order.lastIndexOf('customers.update')).toBeLessThan(order.indexOf('subscriptions.create'));
    expect(called('subscriptions.create')).toEqual([
      {
        customer: 'cus_inv_test',
        items: [{ price: 'price_inv_flat', quantity: 1 }, { price: 'price_inv_flat_usage' }],
        collection_method: 'send_invoice',
        days_until_due: 15,
        payment_settings: {
          payment_method_types: ['card', 'customer_balance'],
          payment_method_options: {
            customer_balance: { funding_type: 'bank_transfer', bank_transfer: { type: 'us_bank_transfer' } },
          },
        },
        metadata: { openpartner_tenant_id: DEFAULT_TENANT_ID, openpartner_plan: 'flex', openpartner_collection: 'send_invoice' },
        expand: ['latest_invoice'],
      },
    ]);
    expect(called('invoices.finalizeInvoice')).toEqual([{ auto_advance: true }]);

    expect(await tenantRow()).toMatchObject({ stripeCustomerId: 'cus_inv_test', stripeSubscriptionId: 'sub_inv_test' });
    const mirror = await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).first();
    // The first invoice is tracked, not overdue; nothing has been paid yet.
    expect(mirror).toMatchObject({ subscriptionStatus: 'active', collectionMethod: 'send_invoice', oldestOpenInvoiceId: 'in_inv_test', invoicePaidAt: null });
    const profile = await db(TABLES.HostedBillingProfile).where({ tenantId: DEFAULT_TENANT_ID }).first();
    expect(profile).toMatchObject({ gstin: GSTIN, collectionMethod: null, updatedByEmail: null });

    // Partner onboarding is open: the plan is active.
    const partner = await request(app).post('/partners').set(auth).send({});
    expect(partner.status).not.toBe(402);

    const again = await request(app).post('/billing/invoice-subscription').set(auth).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_subscribed');
  });

  it('a failure after Stripe created the subscription cancels it, so nothing invoices unseen and a retry is clean', async () => {
    await declare('IN');
    h.failWhiteLabel = true;
    const failed = await request(app).post('/billing/invoice-subscription').set(auth).send({ gstin: GSTIN, whiteLabel: true });
    expect(failed.status).toBe(500);
    expect(called('subscriptions.create')).toHaveLength(1);
    expect(called('subscriptions.cancel')).toEqual(['sub_inv_test']);
    // Its draft first invoice is finalized WITHOUT sending, then voided.
    expect(called('invoices.update')).toEqual([{ auto_advance: false }]);
    expect(called('invoices.finalizeInvoice')).toEqual([{ auto_advance: false }]);
    expect(called('invoices.voidInvoice')).toEqual(['in_inv_test']);
    const after = await tenantRow();
    expect(after.stripeSubscriptionId).toBeNull();
    // The customer and GSTIN committed on their own, so the retry reuses them.
    expect(after.stripeCustomerId).toBe('cus_inv_test');

    h.failWhiteLabel = false;
    h.calls = [];
    const retry = await request(app).post('/billing/invoice-subscription').set(auth).send({ whiteLabel: true });
    expect(retry.status).toBe(200);
    expect(called('customers.create')).toEqual([]);
    expect(called('subscriptions.create')).toHaveLength(1);
    expect(await tenantRow()).toMatchObject({ stripeSubscriptionId: 'sub_inv_test', whiteLabel: true });
  });

  it('a retry adopts a live subscription this tenant already started instead of starting a second', async () => {
    await declare('IN');
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ stripeCustomerId: 'cus_inv_test' });
    await db(TABLES.HostedBillingProfile).insert({ tenantId: DEFAULT_TENANT_ID, gstin: GSTIN });
    h.existingSubs = [
      // Someone else's metadata, or a cancelled one, is never adopted.
      { id: 'sub_cancelled', status: 'canceled', metadata: { openpartner_tenant_id: DEFAULT_TENANT_ID, openpartner_collection: 'send_invoice' }, items: { data: [] } },
      {
        id: 'sub_lost_response',
        status: 'active',
        collection_method: 'send_invoice',
        metadata: { openpartner_tenant_id: DEFAULT_TENANT_ID, openpartner_collection: 'send_invoice' },
        items: { data: [{ price: { id: 'price_inv_flat' } }] },
        latest_invoice: { id: 'in_lost', status: 'open', amount_due: 4900 },
      },
    ];
    const res = await request(app).post('/billing/invoice-subscription').set(auth).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subscriptionId: 'sub_lost_response', adopted: true });
    expect(called('subscriptions.create')).toEqual([]);
    expect((await tenantRow()).stripeSubscriptionId).toBe('sub_lost_response');
  });

  it('applies a sales-issued promotion code, and refuses an unknown one', async () => {
    await declare('US');
    await db(TABLES.HostedBillingProfile).insert({ tenantId: DEFAULT_TENANT_ID, collectionMethod: 'send_invoice' });
    const bad = await request(app).post('/billing/invoice-subscription').set(auth).send({ promotionCode: 'NOPE' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_promotion_code');
    expect(called('subscriptions.create')).toEqual([]);

    h.promotionCodes = { WLFIRST: 'promo_wl_first' };
    const ok = await request(app).post('/billing/invoice-subscription').set(auth).send({ promotionCode: 'WLFIRST' });
    expect(ok.status).toBe(200);
    expect(called('subscriptions.create')[0]).toMatchObject({ discounts: [{ promotion_code: 'promo_wl_first' }] });
  });

  it('a brand ops put on invoices needs no GSTIN outside India; a card brand is sent to Checkout', async () => {
    await declare('US');
    const card = await request(app).post('/billing/invoice-subscription').set(auth).send({});
    expect(card.status).toBe(409);
    expect(card.body.error).toBe('card_billing');

    await db(TABLES.HostedBillingProfile).insert({ tenantId: DEFAULT_TENANT_ID, collectionMethod: 'send_invoice', daysUntilDue: 30 });
    const res = await request(app).post('/billing/invoice-subscription').set(auth).send({});
    expect(res.status).toBe(200);
    expect(called('customers.createTaxId')).toEqual([]);
    expect(called('subscriptions.create')[0]).toMatchObject({ collection_method: 'send_invoice', days_until_due: 30 });
  });

  it('an Indian brand paying by card needs a GSTIN too, and gets it on its invoices', async () => {
    await declare('IN');
    await db(TABLES.HostedBillingProfile).insert({ tenantId: DEFAULT_TENANT_ID, collectionMethod: 'charge_automatically' });
    const body = { successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no' };
    const refused = await request(app).post('/billing/checkout').set(auth).send(body);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('gstin_required');
    expect(called('checkout.sessions.create')).toEqual([]);

    await db(TABLES.HostedBillingProfile).where({ tenantId: DEFAULT_TENANT_ID }).update({ gstin: GSTIN });
    const ok = await request(app).post('/billing/checkout').set(auth).send(body);
    expect(ok.status).toBe(200);
    expect(called('customers.createTaxId')).toEqual([{ type: 'in_gst', value: GSTIN }]);
    const order = h.calls.map(([n]) => n);
    expect(order.indexOf('customers.createTaxId')).toBeLessThan(order.indexOf('checkout.sessions.create'));
  });

  it('an overdue invoice pauses onboarding after the grace, or at once for a brand that has never paid', async () => {
    await declare('IN');
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ stripeSubscriptionId: 'sub_inv_test' });
    await db(TABLES.HostedBillingState).insert({
      tenantId: DEFAULT_TENANT_ID,
      // Stripe says active: the latest invoice is paid. January isn't.
      subscriptionStatus: 'active',
      collectionMethod: 'send_invoice',
      oldestOpenInvoiceId: 'in_jan',
      oldestOpenInvoiceDueAt: new Date(Date.now() - 10 * DAY),
      invoicePaidAt: new Date(Date.now() - 60 * DAY),
    });

    // A paying brand inside the 30-day grace: still onboarding.
    expect((await request(app).post('/partners').set(auth).send({})).status).not.toBe(402);
    const status = await request(app).get('/billing/status').set(auth);
    expect(status.body.invoiceOverdue).toMatchObject({ graceExpired: false, neverPaid: false });

    await db(TABLES.HostedBillingState)
      .where({ tenantId: DEFAULT_TENANT_ID })
      .update({ oldestOpenInvoiceDueAt: new Date(Date.now() - 31 * DAY) });
    const blocked = await request(app).post('/partners').set(auth).send({});
    expect(blocked.status).toBe(402);
    expect(blocked.body).toMatchObject({ error: 'plan_required', reason: 'invoice_overdue' });
    expect(blocked.body.detail).toContain('overdue');

    // Never paid anything: no grace, one day overdue is enough.
    await db(TABLES.HostedBillingState)
      .where({ tenantId: DEFAULT_TENANT_ID })
      .update({ oldestOpenInvoiceDueAt: new Date(Date.now() - DAY), invoicePaidAt: null });
    expect((await request(app).post('/partners').set(auth).send({})).status).toBe(402);
  });
});

describe.skipIf(skipIntegration)('brand tax details', () => {
  it('stores a GSTIN for an Indian brand and puts it on its Stripe customer, without claiming the ops terms', async () => {
    await declare('IN');
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ stripeCustomerId: 'cus_inv_test' });
    await db(TABLES.HostedBillingProfile).insert({ tenantId: DEFAULT_TENANT_ID, collectionMethod: 'send_invoice', updatedByEmail: 'ops@x.test' });
    h.taxIds = [{ id: 'txi_old', type: 'in_gst', value: '29AAGCB7383J1Z4' }];

    const res = await request(app).put('/billing/tax-details').set(auth).send({ gstin: GSTIN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gstin: GSTIN });
    expect(called('customers.createTaxId')).toEqual([{ type: 'in_gst', value: GSTIN }]);
    // The corrected GSTIN replaces the old one rather than printing both.
    expect(called('customers.deleteTaxId')).toEqual(['txi_old']);
    const profile = await db(TABLES.HostedBillingProfile).where({ tenantId: DEFAULT_TENANT_ID }).first();
    expect(profile).toMatchObject({ gstin: GSTIN, updatedByEmail: 'ops@x.test' });
    expect(profile!.gstinUpdatedAt).toBeInstanceOf(Date);
  });

  it('refuses a GSTIN for a brand outside India, and a malformed one', async () => {
    await declare('US');
    const us = await request(app).put('/billing/tax-details').set(auth).send({ gstin: GSTIN });
    expect(us.status).toBe(400);
    expect(us.body.error).toBe('gstin_not_applicable');
    await declare('IN');
    const bad = await request(app).put('/billing/tax-details').set(auth).send({ gstin: 'NOTAGSTIN' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_gstin');
  });
});

describe.skipIf(skipIntegration)('ops switches how a brand pays', () => {
  it('moves a live card subscription to invoices, with the GSTIN on the customer first', async () => {
    await declare('IN');
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ stripeCustomerId: 'cus_inv_test', stripeSubscriptionId: 'sub_live' });
    // The country default alone doesn't move a live subscription, and the
    // missing GSTIN is flagged.
    const listed = await listInvoiceBillingTenants(db, { defaultCountries: ['IN'] });
    expect(listed.find((t) => t.tenantId === DEFAULT_TENANT_ID)).toMatchObject({
      terms: { method: 'send_invoice', source: 'country', gstinRequired: true, gstin: null },
      subscription: { live: true },
    });

    // No GSTIN on file: refused, nothing saved, nothing moved.
    await expect(
      setTenantCollection(db, fakeStripe() as never, DEFAULT_TENANT_ID, { collectionMethod: 'send_invoice' }, 'ops@x.test', noAudit),
    ).rejects.toMatchObject({ code: 'gstin_required' });
    expect(called('subscriptions.update')).toEqual([]);
    expect(await db(TABLES.HostedBillingProfile).where({ tenantId: DEFAULT_TENANT_ID }).first()).toBeUndefined();

    await db(TABLES.HostedBillingProfile).insert({ tenantId: DEFAULT_TENANT_ID, gstin: GSTIN });
    const slug = (await tenantRow()).slug as string;
    const audited: unknown[] = [];
    const result = await setTenantCollection(
      db,
      fakeStripe() as never,
      slug,
      { collectionMethod: 'send_invoice', daysUntilDue: 20 },
      'ops@x.test',
      async (_trx, r) => void audited.push(r.moved),
    );
    expect(result).toMatchObject({ tenantId: DEFAULT_TENANT_ID, moved: 'send_invoice' });
    expect(audited).toEqual(['send_invoice']);
    expect(called('customers.createTaxId')).toEqual([{ type: 'in_gst', value: GSTIN }]);
    expect(called('subscriptions.update')).toEqual([
      expect.objectContaining({ collection_method: 'send_invoice', days_until_due: 20 }),
    ]);
    expect(await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).first()).toMatchObject({
      collectionMethod: 'send_invoice',
    });
    expect(await db(TABLES.HostedBillingProfile).where({ tenantId: DEFAULT_TENANT_ID }).first()).toMatchObject({
      collectionMethod: 'send_invoice',
      daysUntilDue: 20,
      gstin: GSTIN,
      updatedByEmail: 'ops@x.test',
    });

    // Same terms again: nothing to move.
    h.calls = [];
    const same = await setTenantCollection(db, fakeStripe() as never, DEFAULT_TENANT_ID, { graceDays: 45 }, 'ops@x.test', noAudit);
    expect(same.moved).toBeNull();
    expect(called('subscriptions.update')).toEqual([]);
  });

  it('when the save or audit fails after Stripe moved, the subscription is moved back and nothing is saved', async () => {
    await declare('US');
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ stripeCustomerId: 'cus_inv_test', stripeSubscriptionId: 'sub_live' });
    h.defaultPaymentMethod = 'pm_card';
    await expect(
      setTenantCollection(db, fakeStripe() as never, DEFAULT_TENANT_ID, { collectionMethod: 'send_invoice' }, 'ops@x.test', async () => {
        throw new Error('audit write failed');
      }),
    ).rejects.toThrow('audit write failed');
    // Moved to invoices, then back to the card it was on.
    expect(called('subscriptions.update').map((u) => (u as { collection_method: string }).collection_method)).toEqual([
      'send_invoice',
      'charge_automatically',
    ]);
    expect(h.live.collection_method).toBe('charge_automatically');
    expect(await db(TABLES.HostedBillingProfile).where({ tenantId: DEFAULT_TENANT_ID }).first()).toBeUndefined();
    expect(await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).first()).toBeUndefined();
  });

  it('moving back to a card needs a card on file', async () => {
    await declare('US');
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ stripeCustomerId: 'cus_inv_test', stripeSubscriptionId: 'sub_live' });
    h.live = { collection_method: 'send_invoice', days_until_due: 15, status: 'active' };

    const err = await setTenantCollection(
      db,
      fakeStripe() as never,
      DEFAULT_TENANT_ID,
      { collectionMethod: 'charge_automatically' },
      'ops@x.test',
      noAudit,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpsCollectionError);
    expect((err as InstanceType<typeof OpsCollectionError>).code).toBe('no_payment_method');
    expect(called('subscriptions.update')).toEqual([]);

    h.defaultPaymentMethod = 'pm_card';
    const ok = await setTenantCollection(
      db,
      fakeStripe() as never,
      DEFAULT_TENANT_ID,
      { collectionMethod: 'charge_automatically' },
      'ops@x.test',
      noAudit,
    );
    expect(ok.moved).toBe('charge_automatically');
    expect(called('subscriptions.update')).toEqual([
      {
        collection_method: 'charge_automatically',
        payment_settings: { payment_method_types: '', payment_method_options: { customer_balance: '' } },
      },
    ]);
  });

  it('the country list is an ops setting', async () => {
    await declare('BR');
    await setInvoiceBillingSettings(db, { defaultCountries: ['br', 'IN'] }, 'ops@x.test');
    const listed = await listInvoiceBillingTenants(db, { defaultCountries: ['BR', 'IN'] });
    expect(listed.find((t) => t.tenantId === DEFAULT_TENANT_ID)?.terms).toMatchObject({
      method: 'send_invoice',
      source: 'country',
      gstinRequired: false,
    });
    const status = await request(app).get('/billing/status').set(auth);
    expect(status.body.collection).toMatchObject({ method: 'send_invoice', country: 'BR', gstinRequired: false });
  });
});
