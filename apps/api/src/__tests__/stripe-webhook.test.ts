/**
 * Stripe webhook tests covering the merchant-side billing flow:
 * checkout.session.completed with client_reference_id stitches an Identity,
 * and downstream invoice.paid resolves through that Identity.
 *
 * Signature verification uses the real Stripe SDK against a test secret;
 * stripe.customers.update / retrieve are mocked so tests don't hit the API.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import Stripe from 'stripe';

const STRIPE_SECRET = 'sk_test_dummy_for_webhook_tests';
const WEBHOOK_SECRET = 'whsec_test_secret_for_webhook_tests';

process.env.STRIPE_SECRET_KEY = STRIPE_SECRET;
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
// Force selfhost so tests don't pick up whatever's in .env (vitest auto-loads
// it). The merchant-subscription persistence path runs in any mode anyway.
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

// Shared spies so a test can say what Stripe returns when the webhook reads
// an object back. Defaults (reset in beforeEach): a customer with no
// metadata and no Checkout Sessions; every other read fails loudly, so a
// test that doesn't expect one notices.
const stripeApi = vi.hoisted(() => ({
  customersRetrieve: vi.fn(),
  customersUpdate: vi.fn(),
  checkoutSessionsList: vi.fn(),
  invoicesRetrieve: vi.fn(),
  invoicesList: vi.fn(),
  checkoutSessionsRetrieve: vi.fn(),
  promotionCodesRetrieve: vi.fn(),
  chargesRetrieve: vi.fn(),
  invoicePaymentsList: vi.fn(),
}));

function resetStripeApi() {
  stripeApi.customersRetrieve.mockReset().mockResolvedValue({ id: 'cus_test_mocked', metadata: {}, deleted: false });
  stripeApi.customersUpdate.mockReset().mockResolvedValue({ id: 'cus_test_mocked' });
  stripeApi.checkoutSessionsList.mockReset().mockResolvedValue({ object: 'list', data: [], has_more: false });
  stripeApi.invoicesRetrieve.mockReset().mockRejectedValue(new Error('unexpected invoices.retrieve'));
  stripeApi.invoicesList.mockReset().mockRejectedValue(new Error('unexpected invoices.list'));
  stripeApi.checkoutSessionsRetrieve.mockReset().mockRejectedValue(new Error('unexpected checkout.sessions.retrieve'));
  stripeApi.promotionCodesRetrieve.mockReset().mockRejectedValue(new Error('unexpected promotionCodes.retrieve'));
  stripeApi.chargesRetrieve.mockReset().mockRejectedValue(new Error('unexpected charges.retrieve'));
  stripeApi.invoicePaymentsList.mockReset().mockRejectedValue(new Error('unexpected invoicePayments.list'));
}
resetStripeApi();

// Mock the Stripe constructor so API reads are inert. We keep the real
// webhooks helper (used inside the route for signature verification) by
// wrapping a real Stripe instance and overriding only the resources the
// webhook reads.
vi.mock('stripe', async () => {
  const actual = await vi.importActual<typeof import('stripe')>('stripe');
  const Real = actual.default;
  function MockedStripe(this: unknown, key: string, opts?: Stripe.StripeConfig) {
    const instance = new Real(key, opts) as Stripe;
    (instance as unknown as { customers: unknown }).customers = {
      update: stripeApi.customersUpdate,
      retrieve: stripeApi.customersRetrieve,
    };
    (instance as unknown as { invoices: unknown }).invoices = {
      retrieve: stripeApi.invoicesRetrieve,
      list: stripeApi.invoicesList,
    };
    (instance as unknown as { checkout: unknown }).checkout = {
      sessions: { list: stripeApi.checkoutSessionsList, retrieve: stripeApi.checkoutSessionsRetrieve },
    };
    (instance as unknown as { promotionCodes: unknown }).promotionCodes = {
      retrieve: stripeApi.promotionCodesRetrieve,
    };
    (instance as unknown as { charges: unknown }).charges = { retrieve: stripeApi.chargesRetrieve };
    (instance as unknown as { invoicePayments: unknown }).invoicePayments = { list: stripeApi.invoicePaymentsList };
    return instance;
  }
  // Preserve the static `webhooks` namespace for any direct imports.
  (MockedStripe as unknown as { webhooks: unknown }).webhooks = (Real as unknown as { webhooks: unknown }).webhooks;
  return { default: MockedStripe };
});

// Capture outbound commission.* events; everything else in the
// dispatcher module stays real.
vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});

// Imports must follow the env + mock setup so they pick up the right config.
const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { dispatchEvent } = await import('../webhook-dispatcher.js');

/** Payloads of every dispatchEvent call for `event`. */
function dispatched(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.filter((c) => c[1] === event)
    .map((c) => c[2] as Record<string, unknown>);
}

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

// Real Stripe instance for signing test webhook payloads. The mock above
// overrides `customers`, but `webhooks.generateTestHeaderString` is a static
// method on the class and remains real.
const stripeForSigning = new Stripe(STRIPE_SECRET);

function postWebhook(eventPayload: object) {
  const body = JSON.stringify(eventPayload);
  const sig = stripeForSigning.webhooks.generateTestHeaderString({
    payload: body,
    secret: WEBHOOK_SECRET,
  });
  return request(app)
    .post('/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('stripe-signature', sig)
    .send(body);
}

const TABLES_TO_CLEAN = [
  // Before Commission — a refund of a paid commission records a clawback.
  TABLES.CommissionAdjustment,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  // Before Partner + Program — Coupon references both.
  TABLES.Coupon,
  TABLES.Program,
  // Before Partner — a funded transfer intent references its partner.
  TABLES.HostedFundingTransfer,
  TABLES.HostedFundingBatch,
  TABLES.StripeWebhookInbox,
  // Before Partner — Payout.partnerId is an FK. Commission is already
  // deleted above, which is what frees Payout.
  TABLES.Payout,
  TABLES.Partner,
  TABLES.Config,
];

interface Ids {
  partnerId: string;
  programId: string;
  linkId: string;
  clickId: string;
}

async function seedClick(): Promise<Ids> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, name: 'Test partner', email: `p-${partnerId}@example.com` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Default',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    destinationUrl: 'https://example.com/signup',
  });
  await db(TABLES.Link).insert({
    id: linkId,
    tenantId: DEFAULT_TENANT_ID,
    partnerId,
    programId,
    linkKey: `lk-${linkId}`,
    destinationUrl: 'https://example.com',
  });
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: DEFAULT_TENANT_ID,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://example.com/landing',
    ipHash: 'h',
    ts: new Date(),
  });
  return { partnerId, programId, linkId, clickId };
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  // The last test's Identity → Click → Link chain would otherwise block a
  // later file's narrower Click / Partner wipe on its FKs.
  if (!skipIntegration) for (const t of TABLES_TO_CLEAN) await db(t).del();
  await db.destroy();
});

beforeEach(async () => {
  resetStripeApi();
  vi.mocked(dispatchEvent).mockClear();
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

describe.skipIf(skipIntegration)('stripe webhook — merchant billing flow', () => {
  it('checkout.session.completed with valid client_reference_id stitches Identity + emits signup', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${ulid()}`,
          mode: 'subscription',
          client_reference_id: clickId,
          customer: customerId,
          subscription: `sub_${ulid()}`,
        },
      },
    });

    expect(res.status).toBe(200);
    const identity = await db(TABLES.Identity).where({ clickId, userId: customerId }).first();
    expect(identity).toBeTruthy();

    const event = await db(TABLES.Event).where({ userId: customerId, type: 'signup' }).first();
    expect(event).toBeTruthy();
  });

  it('checkout.session.completed with unknown client_reference_id is silently dropped', async () => {
    const customerId = `cus_${ulid()}`;
    const bogusCref = ulid(); // not in Click table

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${ulid()}`,
          mode: 'subscription',
          client_reference_id: bogusCref,
          customer: customerId,
          subscription: `sub_${ulid()}`,
        },
      },
    });

    expect(res.status).toBe(200);
    const identity = await db(TABLES.Identity).where({ userId: customerId }).first();
    expect(identity).toBeFalsy();
    const event = await db(TABLES.Event).where({ userId: customerId }).first();
    expect(event).toBeFalsy();
  });

  it('redelivery of the same Stripe event is idempotent', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const eventId = `evt_${ulid()}`;
    const payload = {
      id: eventId,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${ulid()}`,
          mode: 'subscription',
          client_reference_id: clickId,
          customer: customerId,
          subscription: `sub_${ulid()}`,
        },
      },
    };

    await postWebhook(payload);
    await postWebhook(payload);

    const events = await db(TABLES.Event).where({ userId: customerId, type: 'signup' });
    expect(events).toHaveLength(1);
  });

  it('invoice.paid resolves userId via the Identity stitched at checkout', async () => {
    const { clickId, partnerId } = await seedClick();
    const customerId = `cus_${ulid()}`;

    // 1. Checkout stitches the Identity.
    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${ulid()}`,
          mode: 'subscription',
          client_reference_id: clickId,
          customer: customerId,
          subscription: `sub_${ulid()}`,
        },
      },
    });

    // 2. invoice.paid arrives with customer as a Stripe Customer object so the
    //    real-API retrieve path isn't exercised. The metadata has no
    //    openpartner_user_id, forcing the Identity-fallback resolution.
    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `in_${ulid()}`,
          customer: { id: customerId, metadata: {}, object: 'customer' },
          amount_paid: 4900,
          currency: 'usd',
        },
      },
    });

    expect(res.status).toBe(200);
    const event = await db(TABLES.Event).where({ userId: customerId, type: 'invoice_paid' }).first();
    expect(event).toBeTruthy();
    expect(Number(event!.value)).toBe(49);

    // Attribution should have credited the seeded partner.
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution).toBeTruthy();
    expect(attribution!.partnerId).toBe(partnerId);
  });

  it("checkout.session.completed without client_reference_id on a self-host is an end-customer's, never the tenant subscribing", async () => {
    // On a single-tenant self-host every Checkout Session in the brand's
    // Stripe account is one of its end-customers' (billing.ts refuses
    // OpenPartner billing in selfhost). One without a cref or a partner
    // code records nothing and must not be persisted as the tenant's own
    // OpenPartner subscription.
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ stripeCustomerId: null, stripeSubscriptionId: null });

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${ulid()}`,
          mode: 'subscription',
          customer: `cus_${ulid()}`,
          subscription: `sub_${ulid()}`,
          // no client_reference_id
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.connect).toBeUndefined();
    const events = await db(TABLES.Event);
    expect(events).toHaveLength(0);
    const identities = await db(TABLES.Identity);
    expect(identities).toHaveLength(0);
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    expect(tenant!.stripeCustomerId).toBeNull();
    expect(tenant!.stripeSubscriptionId).toBeNull();
  });

  it('on hosted, a metadata-stamped checkout without client_reference_id still persists the tenant subscription', async () => {
    const customerId = `cus_${ulid()}`;
    const subscriptionId = `sub_${ulid()}`;
    process.env.OPENPARTNER_MODE = 'flat';
    try {
      const res = await postWebhook({
        id: `evt_${ulid()}`,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `cs_${ulid()}`,
            mode: 'subscription',
            customer: customerId,
            subscription: subscriptionId,
            metadata: { openpartner_tenant_id: DEFAULT_TENANT_ID },
          },
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.connect).toBe('merchant_subscription_persisted');
      const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
      expect(tenant!.stripeCustomerId).toBe(customerId);
      expect(tenant!.stripeSubscriptionId).toBe(subscriptionId);
    } finally {
      process.env.OPENPARTNER_MODE = 'selfhost';
      await db(TABLES.Tenant)
        .where({ id: DEFAULT_TENANT_ID })
        .update({ stripeCustomerId: null, stripeSubscriptionId: null });
    }
  });
});

// Every deployment but a single-tenant self-host. There the Stripe account
// is OpenPartner's billing account (hosted) or shared by many brands
// (multi-tenant self-host): its checkouts, invoices and charges aren't the
// brand's end-customers'.
const deployments = [
  ['flat', 'multi'],
  ['revshare', 'multi'],
  ['flat', 'single'],
  ['selfhost', 'multi'],
] as const;

async function inDeployment(mode: string, tenancy: string, fn: () => Promise<void>) {
  process.env.OPENPARTNER_MODE = mode;
  process.env.OPENPARTNER_TENANCY = tenancy;
  try {
    await fn();
  } finally {
    process.env.OPENPARTNER_MODE = 'selfhost';
    process.env.OPENPARTNER_TENANCY = 'single';
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ stripeCustomerId: null, stripeSubscriptionId: null });
  }
}

describe.skipIf(skipIntegration)('stripe webhook — coupon auto-redemption (single-tenant self-host)', () => {
  // A customer who typed a partner's code at checkout without ever clicking
  // a partner link: no client_reference_id, so nothing but the code ties
  // them to the partner.

  async function seedCoupon(stripePromotionCodeId: string | null = null): Promise<{ partnerId: string; code: string }> {
    const { partnerId, programId } = await seedClick();
    const code = `CREATOR${ulid().slice(-6)}`;
    await db(TABLES.Coupon).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      programId,
      code,
      stripePromotionCodeId,
    });
    return { partnerId, code };
  }

  function couponCheckout(customerId: string, session: Record<string, unknown>) {
    return {
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${ulid()}`,
          object: 'checkout.session',
          mode: 'subscription',
          client_reference_id: null,
          customer: customerId,
          subscription: `sub_${ulid()}`,
          ...session,
        },
      },
    };
  }

  /** invoice.paid as Stripe delivers it: discounts are bare di_ ids. */
  function discountedInvoicePaid(customerId: string, discountId: string, amountPaid = 4900) {
    return {
      id: `evt_${ulid()}`,
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `in_${ulid()}`,
          object: 'invoice',
          customer: customerId,
          amount_paid: amountPaid,
          currency: 'usd',
          discounts: [discountId],
          total_discount_amounts: [{ amount: 1000, discount: discountId }],
        },
      },
    };
  }

  beforeEach(async () => {
    if (skipIntegration) return;
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ stripeCustomerId: null, stripeSubscriptionId: null, couponIntegrationVerifiedAt: null });
  });

  afterAll(async () => {
    if (skipIntegration) return;
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ couponIntegrationVerifiedAt: null });
  });

  it('checkout.session.completed with a partner code and no client_reference_id redeems the coupon', async () => {
    const { partnerId, code } = await seedCoupon();
    const customerId = `cus_${ulid()}`;

    const res = await postWebhook(
      couponCheckout(customerId, {
        discounts: [{ coupon: null, promotion_code: { id: `promo_${ulid()}`, code: code.toLowerCase() } }],
      }),
    );

    expect(res.status).toBe(200);
    const click = await db(TABLES.Click).where({ partnerId, landingUrl: `coupon://${code}` }).first();
    expect(click).toBeTruthy();
    const identity = await db(TABLES.Identity).where({ clickId: click!.id, userId: customerId }).first();
    expect(identity).toBeTruthy();
    const event = await db(TABLES.Event).where({ userId: customerId, type: 'signup' }).first();
    expect(event).toBeTruthy();
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);

    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    // The test redemption the coupon mint gate asks for.
    expect(tenant!.couponIntegrationVerifiedAt).not.toBeNull();
    // A subscription-mode session with no cref is the brand's customer, not
    // the brand subscribing to OpenPartner.
    expect(tenant!.stripeCustomerId).toBeNull();
    expect(tenant!.stripeSubscriptionId).toBeNull();
  });

  it('reads the code behind a promotion_code id, and a redelivery adds nothing', async () => {
    const { partnerId, code } = await seedCoupon();
    const customerId = `cus_${ulid()}`;
    const promoId = `promo_${ulid()}`;
    stripeApi.promotionCodesRetrieve.mockResolvedValue({ id: promoId, object: 'promotion_code', code });
    // Webhook payloads carry the session's discounts with ids, not objects.
    const payload = couponCheckout(customerId, { discounts: [{ coupon: `co_${ulid()}`, promotion_code: promoId }] });

    await postWebhook(payload);
    await postWebhook(payload);

    expect(stripeApi.promotionCodesRetrieve).toHaveBeenCalledWith(promoId);
    expect(await db(TABLES.Click).where({ partnerId, landingUrl: `coupon://${code}` })).toHaveLength(1);
    expect(await db(TABLES.Event).where({ userId: customerId, type: 'signup' })).toHaveLength(1);
  });

  it('reads total_details.breakdown when the session discounted but listed no discounts', async () => {
    const { partnerId, code } = await seedCoupon();
    const customerId = `cus_${ulid()}`;
    const promoId = `promo_${ulid()}`;
    const payload = couponCheckout(customerId, {
      discounts: [],
      total_details: { amount_discount: 1000, amount_shipping: 0, amount_tax: 0 },
    });
    const sessionId = (payload.data.object as { id: string }).id;
    stripeApi.checkoutSessionsRetrieve.mockResolvedValue({
      ...payload.data.object,
      total_details: {
        amount_discount: 1000,
        amount_shipping: 0,
        amount_tax: 0,
        breakdown: {
          discounts: [
            {
              amount: 1000,
              discount: {
                id: `di_${ulid()}`,
                object: 'discount',
                promotion_code: promoId,
                source: { coupon: `co_${ulid()}`, type: 'coupon' },
              },
            },
          ],
          taxes: [],
        },
      },
    });
    stripeApi.promotionCodesRetrieve.mockResolvedValue({ id: promoId, object: 'promotion_code', code });

    const res = await postWebhook(payload);

    expect(res.status).toBe(200);
    expect(stripeApi.checkoutSessionsRetrieve).toHaveBeenCalledWith(sessionId, { expand: ['total_details.breakdown'] });
    const event = await db(TABLES.Event).where({ userId: customerId, type: 'signup' }).first();
    expect(event).toBeTruthy();
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
  });

  it("a code that isn't an OpenPartner coupon records nothing and doesn't unlock the mint gate", async () => {
    await seedCoupon();
    const customerId = `cus_${ulid()}`;

    const res = await postWebhook(
      couponCheckout(customerId, {
        discounts: [{ coupon: null, promotion_code: { id: `promo_${ulid()}`, code: 'BLACKFRIDAY' } }],
      }),
    );

    expect(res.status).toBe(200);
    expect(await db(TABLES.Identity).where({ userId: customerId })).toHaveLength(0);
    expect(await db(TABLES.Event).where({ userId: customerId })).toHaveLength(0);
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    expect(tenant!.couponIntegrationVerifiedAt).toBeNull();
  });

  it('invoice.paid arriving BEFORE checkout.session.completed reads its discounts and credits the revenue', async () => {
    const { partnerId, code } = await seedCoupon();
    const customerId = `cus_${ulid()}`;
    const discountId = `di_${ulid()}`;
    const promoId = `promo_${ulid()}`;
    const payload = discountedInvoicePaid(customerId, discountId);
    const invoiceId = (payload.data.object as { id: string }).id;
    // As the read-back returns it: each discount's PromotionCode expanded.
    const discount = {
      id: discountId,
      object: 'discount',
      promotion_code: { id: promoId, object: 'promotion_code', code },
      source: { coupon: `co_${ulid()}`, type: 'coupon' },
    };
    stripeApi.invoicesRetrieve.mockResolvedValue({
      ...payload.data.object,
      discounts: [discount],
      total_discount_amounts: [{ amount: 1000, discount }],
    });

    const res = await postWebhook(payload);

    expect(res.status).toBe(200);
    expect(stripeApi.invoicesRetrieve).toHaveBeenCalledWith(invoiceId, {
      expand: ['discounts.promotion_code', 'total_discount_amounts.discount.promotion_code'],
    });
    // The expanded PromotionCode needs no further read.
    expect(stripeApi.promotionCodesRetrieve).not.toHaveBeenCalled();
    // The same discount listed twice (invoice + amounts) redeems once.
    expect(await db(TABLES.Click).where({ partnerId, landingUrl: `coupon://${code}` })).toHaveLength(1);
    const event = await db(TABLES.Event).where({ userId: customerId, type: 'invoice_paid' }).first();
    expect(event).toBeTruthy();
    expect(Number(event!.value)).toBe(49);
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);

    // The checkout event that follows reuses the coupon's click.
    await postWebhook(
      couponCheckout(customerId, { discounts: [{ coupon: null, promotion_code: { id: promoId, code } }] }),
    );
    expect(await db(TABLES.Click).where({ partnerId, landingUrl: `coupon://${code}` })).toHaveLength(1);
    expect(await db(TABLES.Event).where({ userId: customerId, type: 'signup' })).toHaveLength(1);
  });

  it("keys the coupon to the customer's openpartner_user_id, which later revenue resolves to", async () => {
    const { partnerId, code } = await seedCoupon();
    const customerId = `cus_${ulid()}`;
    const userId = `user_${ulid()}`;
    stripeApi.customersRetrieve.mockResolvedValue({
      id: customerId,
      object: 'customer',
      metadata: { openpartner_user_id: userId },
    });
    const discount = { id: `di_${ulid()}`, object: 'discount', promotion_code: null, source: { coupon: code, type: 'coupon' } };
    const payload = discountedInvoicePaid(customerId, discount.id);
    stripeApi.invoicesRetrieve.mockResolvedValue({ ...payload.data.object, discounts: [discount] });

    const res = await postWebhook(payload);

    expect(res.status).toBe(200);
    expect(await db(TABLES.Identity).where({ userId: customerId })).toHaveLength(0);
    const event = await db(TABLES.Event).where({ userId, type: 'invoice_paid' }).first();
    expect(event).toBeTruthy();
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
  });

  describe("a customer carrying the merchant's openpartner_user_id", () => {
    async function seedMerchantCouponCustomer() {
      const { partnerId, code } = await seedCoupon();
      const customerId = `cus_${ulid()}`;
      const merchantUserId = `user_${ulid()}`;
      stripeApi.customersRetrieve.mockResolvedValue({
        id: customerId,
        object: 'customer',
        metadata: { openpartner_user_id: merchantUserId },
      });
      const customerCreated = {
        id: `evt_${ulid()}`,
        type: 'customer.created',
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: customerId, object: 'customer', metadata: { openpartner_user_id: merchantUserId } } },
      };
      const checkout = couponCheckout(customerId, {
        discounts: [{ coupon: null, promotion_code: { id: `promo_${ulid()}`, code } }],
      });
      return { partnerId, code, customerId, merchantUserId, customerCreated, checkout };
    }

    async function expectOneCreditedSignup(s: Awaited<ReturnType<typeof seedMerchantCouponCustomer>>) {
      const signups = await db(TABLES.Event).where({ type: 'signup' });
      expect(signups).toHaveLength(1);
      expect(signups[0].userId).toBe(s.merchantUserId);
      const attribution = await db(TABLES.Attribution).where({ eventId: signups[0].id }).first();
      expect(attribution?.partnerId).toBe(s.partnerId);
      expect(await db(TABLES.Identity).where({ userId: s.customerId })).toHaveLength(0);
      expect(await db(TABLES.Click).where({ landingUrl: `coupon://${s.code}` })).toHaveLength(1);
    }

    it.each([
      ['customer.created', 'checkout.session.completed'],
      ['checkout.session.completed', 'customer.created'],
    ])('%s then a no-cref coupon %s records one signup, credited to the coupon', async (first) => {
      const s = await seedMerchantCouponCustomer();
      const [a, b] = first === 'customer.created' ? [s.customerCreated, s.checkout] : [s.checkout, s.customerCreated];

      expect((await postWebhook(a)).status).toBe(200);
      const second = await postWebhook(b);
      expect(second.status).toBe(200);
      expect(second.body.skipped).toBe(b.type);
      await expectOneCreditedSignup(s);
    });

    it('records one signup when customer.created and the coupon checkout arrive at once', async () => {
      const s = await seedMerchantCouponCustomer();
      const [r1, r2] = await Promise.all([postWebhook(s.customerCreated), postWebhook(s.checkout)]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      await expectOneCreditedSignup(s);
    });

    it("a later undiscounted invoice still resolves and credits the coupon's partner", async () => {
      // The coupon Identity holds the merchant's userId, not the cus_ id, so
      // the Identity join in resolveTenantForEvent can't find this customer:
      // the single-tenant fallback resolves it, and the metadata bridge
      // finds the user.
      const s = await seedMerchantCouponCustomer();
      expect((await postWebhook(s.checkout)).status).toBe(200);

      const renewal = invoicePaid(s.customerId, { billing_reason: 'subscription_cycle', discounts: [] });
      const res = await postWebhook(renewal);

      expect(res.status).toBe(200);
      expect(stripeApi.invoicesRetrieve).not.toHaveBeenCalled();
      const invoice = await db(TABLES.Event).where({ type: 'invoice_paid' }).first();
      expect(invoice?.userId).toBe(s.merchantUserId);
      const attribution = await db(TABLES.Attribution).where({ eventId: invoice!.id }).first();
      expect(attribution?.partnerId).toBe(s.partnerId);
    });

    it('a cref checkout that also redeems a code keys both clicks to the merchant userId', async () => {
      const s = await seedMerchantCouponCustomer();
      const { clickId } = await seedClick();
      const checkout = couponCheckout(s.customerId, {
        client_reference_id: clickId,
        discounts: [{ coupon: null, promotion_code: { id: `promo_${ulid()}`, code: s.code } }],
      });

      expect((await postWebhook(checkout)).status).toBe(200);

      const identities = await db(TABLES.Identity).where({ userId: s.merchantUserId });
      expect(identities).toHaveLength(2);
      expect(identities.map((i) => i.clickId)).toContain(clickId);
      expect(await db(TABLES.Identity).where({ userId: s.customerId })).toHaveLength(0);
      expect(await db(TABLES.Event).where({ type: 'signup', userId: s.merchantUserId })).toHaveLength(1);
    });
  });

  it('matches a promotion_code id to the coupon it was minted with, without reading Stripe', async () => {
    const promoId = `promo_${ulid()}`;
    const { partnerId } = await seedCoupon(promoId);
    const customerId = `cus_${ulid()}`;
    // Partner coupons' Stripe Coupon ids are auto-generated, so only the
    // PromotionCode id can match here. promotionCodes.retrieve rejects by
    // default: a read would fail the delivery.
    const res = await postWebhook(couponCheckout(customerId, { discounts: [{ coupon: `co_${ulid()}`, promotion_code: promoId }] }));

    expect(res.status).toBe(200);
    expect(stripeApi.promotionCodesRetrieve).not.toHaveBeenCalled();
    const event = await db(TABLES.Event).where({ userId: customerId, type: 'signup' }).first();
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
  });

  it('a transient promotion code read failure is a 500, so Stripe redelivers', async () => {
    const { partnerId, code } = await seedCoupon();
    const customerId = `cus_${ulid()}`;
    const promoId = `promo_${ulid()}`;
    stripeApi.promotionCodesRetrieve.mockRejectedValue(stripeError('StripeConnectionError'));
    const payload = couponCheckout(customerId, { discounts: [{ coupon: `co_${ulid()}`, promotion_code: promoId }] });

    expect((await postWebhook(payload)).status).toBe(500);
    expect(await db(TABLES.Click).where({ partnerId, landingUrl: `coupon://${code}` })).toHaveLength(0);
    expect(await db(TABLES.Event)).toHaveLength(0);

    // The redelivery redeems.
    stripeApi.promotionCodesRetrieve.mockResolvedValue({ id: promoId, object: 'promotion_code', code });
    expect((await postWebhook(payload)).status).toBe(200);
    const event = await db(TABLES.Event).where({ userId: customerId, type: 'signup' }).first();
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
  });

  it('a permanent promotion code read failure is acknowledged and redeems nothing', async () => {
    await seedCoupon();
    const customerId = `cus_${ulid()}`;
    stripeApi.promotionCodesRetrieve.mockRejectedValue(stripeError('StripeInvalidRequestError', 'resource_missing'));

    const res = await postWebhook(
      couponCheckout(customerId, { discounts: [{ coupon: `co_${ulid()}`, promotion_code: `promo_${ulid()}` }] }),
    );

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('checkout.session.completed');
    expect(await db(TABLES.Identity)).toHaveLength(0);
  });

  it("a permanent invoice read-back failure still records a linked customer's revenue", async () => {
    const { clickId, partnerId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId: customerId });
    stripeApi.invoicesRetrieve.mockRejectedValue(stripeError('StripePermissionError'));

    const res = await postWebhook(discountedInvoicePaid(customerId, `di_${ulid()}`));

    expect(res.status).toBe(200);
    expect(stripeApi.invoicesRetrieve).toHaveBeenCalled();
    const event = await db(TABLES.Event).where({ userId: customerId, type: 'invoice_paid' }).first();
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
  });

  describe('anywhere but a single-tenant self-host', () => {
    it.each(deployments)(
      "%s/%s: the brand's own plan invoice, paid with a partner's code, credits no partner",
      (mode, tenancy) =>
        inDeployment(mode, tenancy, async () => {
          // A promotion code on the brand's OpenPartner plan Checkout that
          // equals one of its partner coupon codes.
          const promoId = `promo_${ulid()}`;
          const { code } = await seedCoupon(promoId);
          const billingCustomerId = `cus_${ulid()}`;
          await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ stripeCustomerId: billingCustomerId });
          const payload = discountedInvoicePaid(billingCustomerId, `di_${ulid()}`);
          const discount = {
            id: `di_${ulid()}`,
            object: 'discount',
            promotion_code: { id: promoId, object: 'promotion_code', code },
          };
          stripeApi.invoicesRetrieve.mockResolvedValue({ ...payload.data.object, discounts: [discount] });
          stripeApi.promotionCodesRetrieve.mockResolvedValue({ id: promoId, object: 'promotion_code', code });

          const res = await postWebhook(payload);

          expect(res.status).toBe(200);
          expect(stripeApi.invoicesRetrieve).not.toHaveBeenCalled();
          expect(stripeApi.promotionCodesRetrieve).not.toHaveBeenCalled();
          expect(await db(TABLES.Click).where({ landingUrl: `coupon://${code}` })).toHaveLength(0);
          expect(await db(TABLES.Identity)).toHaveLength(0);
          expect(await db(TABLES.Event)).toHaveLength(0);
          const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
          expect(tenant!.couponIntegrationVerifiedAt).toBeNull();
        }),
    );

    it.each(deployments)('%s/%s: a no-cref checkout with a partner code stays unresolved', (mode, tenancy) =>
      inDeployment(mode, tenancy, async () => {
        const { code } = await seedCoupon();
        const res = await postWebhook(
          couponCheckout(`cus_${ulid()}`, {
            discounts: [{ coupon: null, promotion_code: { id: `promo_${ulid()}`, code } }],
          }),
        );

        expect(res.status).toBe(200);
        expect(res.body.reason).toBe('unresolved_tenant');
        expect(await db(TABLES.Identity)).toHaveLength(0);
        expect(await db(TABLES.Event)).toHaveLength(0);
      }),
    );
  });

  it("an undiscounted invoice for a customer nobody referred isn't read back from Stripe", async () => {
    const customerId = `cus_${ulid()}`;

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: { id: `in_${ulid()}`, object: 'invoice', customer: customerId, amount_paid: 4900, currency: 'usd', discounts: [] },
      },
    });

    expect(res.status).toBe(200);
    expect(stripeApi.invoicesRetrieve).not.toHaveBeenCalled();
    expect(await db(TABLES.Event).where({ userId: customerId })).toHaveLength(0);
  });
});

/** A paid invoice as Stripe delivers it: `customer` is a bare id. */
function invoicePaid(customerId: string, fields: Record<string, unknown> = {}) {
  return {
    id: `evt_${ulid()}`,
    type: 'invoice.paid',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: { id: `in_${ulid()}`, object: 'invoice', customer: customerId, amount_paid: 4900, currency: 'usd', ...fields },
    },
  };
}

function completedCheckout(customerId: string, clientReferenceId: string | null) {
  return {
    id: `cs_${ulid()}`,
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    client_reference_id: clientReferenceId,
    customer: customerId,
    subscription: `sub_${ulid()}`,
  };
}

describe.skipIf(skipIntegration)('stripe webhook — out-of-order delivery (client_reference_id flow)', () => {
  // Stripe doesn't order events. invoice.paid / customer.subscription.created
  // for a Checkout customer can land before checkout.session.completed has
  // stitched that customer to the click.

  it('invoice.paid arriving BEFORE checkout.session.completed still records + attributes the revenue', async () => {
    const { clickId, partnerId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const session = completedCheckout(customerId, clickId);
    stripeApi.checkoutSessionsList.mockResolvedValue({ object: 'list', data: [session], has_more: false });

    const res = await postWebhook(invoicePaid(customerId));

    expect(res.status).toBe(200);
    expect(stripeApi.checkoutSessionsList).toHaveBeenCalledWith(
      expect.objectContaining({ customer: customerId, status: 'complete' }),
    );
    const event = await db(TABLES.Event).where({ userId: customerId, type: 'invoice_paid' }).first();
    expect(event).toBeTruthy();
    expect(Number(event!.value)).toBe(49);
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);

    // The late checkout.session.completed then lands cleanly: one Identity,
    // and its signup event is recorded as usual.
    const late = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: session },
    });
    expect(late.status).toBe(200);
    expect(await db(TABLES.Identity).where({ clickId, userId: customerId })).toHaveLength(1);
    expect(await db(TABLES.Event).where({ userId: customerId, type: 'signup' })).toHaveLength(1);
  });

  it('customer.subscription.created arriving before checkout.session.completed is recorded', async () => {
    const { clickId, partnerId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    stripeApi.checkoutSessionsList.mockResolvedValue({
      object: 'list',
      data: [completedCheckout(customerId, clickId)],
      has_more: false,
    });

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'customer.subscription.created',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: `sub_${ulid()}`, object: 'subscription', customer: customerId, metadata: {} } },
    });

    expect(res.status).toBe(200);
    const event = await db(TABLES.Event).where({ userId: customerId, type: 'subscription_created' }).first();
    expect(event).toBeTruthy();
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
  });

  it('revenue from a customer no partner referred is acknowledged 2xx and records nothing', async () => {
    // Most of a self-hosted brand's invoices are this case. A non-2xx here
    // would make Stripe retry every one of them.
    const customerId = `cus_${ulid()}`;
    stripeApi.checkoutSessionsList.mockResolvedValue({
      object: 'list',
      data: [completedCheckout(customerId, null), completedCheckout(customerId, ulid())],
      has_more: false,
    });

    const res = await postWebhook(invoicePaid(customerId));

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('invoice.paid');
    expect(await db(TABLES.Event)).toHaveLength(0);
    expect(await db(TABLES.Identity)).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('stripe webhook — openpartner_user_id customer-metadata bridge', () => {
  // The merchant calls identify(cref, theirUserId) from their app, and
  // stamps the same id on the Stripe Customer as metadata.openpartner_user_id.
  // Identity.userId is then the merchant's id, never the cus_ id.

  it('invoice.paid resolves through customer metadata to an identify()-stitched user', async () => {
    const { clickId, partnerId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const merchantUserId = `user_${ulid()}`;
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId: merchantUserId });
    stripeApi.customersRetrieve.mockResolvedValue({
      id: customerId,
      object: 'customer',
      metadata: { openpartner_user_id: merchantUserId },
    });

    const res = await postWebhook(invoicePaid(customerId));

    expect(res.status).toBe(200);
    const event = await db(TABLES.Event).where({ userId: merchantUserId, type: 'invoice_paid' }).first();
    expect(event).toBeTruthy();
    expect(Number(event!.value)).toBe(49);
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
    // The metadata bridge answered; no Checkout lookup was needed.
    expect(stripeApi.checkoutSessionsList).not.toHaveBeenCalled();
  });

  it('customer.created with openpartner_user_id records a signup for that user', async () => {
    const { clickId } = await seedClick();
    const merchantUserId = `user_${ulid()}`;
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId: merchantUserId });

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'customer.created',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: `cus_${ulid()}`, object: 'customer', metadata: { openpartner_user_id: merchantUserId } } },
    });

    expect(res.status).toBe(200);
    expect(await db(TABLES.Event).where({ userId: merchantUserId, type: 'signup' })).toHaveLength(1);
  });

  it.each([
    ['flat', 'single'],
    ['selfhost', 'multi'],
  ])('stays unresolved on a %s/%s deployment, where the Stripe account is not the brand\'s', async (mode, tenancy) => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const merchantUserId = `user_${ulid()}`;
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId: merchantUserId });
    stripeApi.customersRetrieve.mockResolvedValue({
      id: customerId,
      object: 'customer',
      metadata: { openpartner_user_id: merchantUserId },
    });

    process.env.OPENPARTNER_MODE = mode;
    process.env.OPENPARTNER_TENANCY = tenancy;
    try {
      const res = await postWebhook(invoicePaid(customerId));
      expect(res.status).toBe(200);
      expect(res.body.reason).toBe('unresolved_tenant');
      expect(await db(TABLES.Event)).toHaveLength(0);
    } finally {
      process.env.OPENPARTNER_MODE = 'selfhost';
      process.env.OPENPARTNER_TENANCY = 'single';
    }
  });
});

describe.skipIf(skipIntegration)('stripe webhook — both linking methods at once', () => {
  // The merchant stamps openpartner_user_id on the Customer AND passes the
  // cref as client_reference_id. customer.created and
  // checkout.session.completed both report the signup. Checkout used to key
  // the user to the cus_ id and overwrite the metadata with it, so the
  // signup bounty paid twice and the user's invoices split across two ids.

  async function seedBothMethods() {
    const { clickId, partnerId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const merchantUserId = `user_${ulid()}`;
    stripeApi.customersRetrieve.mockResolvedValue({
      id: customerId,
      object: 'customer',
      metadata: { openpartner_user_id: merchantUserId },
    });
    const customerCreated = {
      id: `evt_${ulid()}`,
      type: 'customer.created',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: customerId, object: 'customer', metadata: { openpartner_user_id: merchantUserId } } },
    };
    const checkout = {
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: completedCheckout(customerId, clickId) },
    };
    return { clickId, partnerId, customerId, merchantUserId, customerCreated, checkout };
  }

  async function expectOneSignupFor(s: Awaited<ReturnType<typeof seedBothMethods>>) {
    const signups = await db(TABLES.Event).where({ type: 'signup' });
    expect(signups).toHaveLength(1);
    expect(signups[0].userId).toBe(s.merchantUserId);
    // Credited to the partner whichever event recorded it.
    const attribution = await db(TABLES.Attribution).where({ eventId: signups[0].id }).first();
    expect(attribution?.partnerId).toBe(s.partnerId);
    expect(await db(TABLES.Identity).where({ clickId: s.clickId, userId: s.merchantUserId })).toHaveLength(1);
    expect(await db(TABLES.Identity).where({ userId: s.customerId })).toHaveLength(0);
    expect(stripeApi.customersUpdate).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ metadata: expect.objectContaining({ openpartner_user_id: expect.anything() }) }),
    );
  }

  it.each([
    ['customer.created', 'checkout.session.completed'],
    ['checkout.session.completed', 'customer.created'],
  ])('%s then %s records one signup under the merchant userId', async (first) => {
    const s = await seedBothMethods();
    const [a, b] = first === 'customer.created' ? [s.customerCreated, s.checkout] : [s.checkout, s.customerCreated];

    expect((await postWebhook(a)).status).toBe(200);
    const second = await postWebhook(b);
    expect(second.status).toBe(200);
    expect(second.body.skipped).toBe(b.type);
    await expectOneSignupFor(s);

    // Revenue lands under the same user, not under the cus_ id.
    const res = await postWebhook(invoicePaid(s.customerId, { billing_reason: 'subscription_create' }));
    expect(res.status).toBe(200);
    const invoice = await db(TABLES.Event).where({ type: 'invoice_paid' }).first();
    expect(invoice?.userId).toBe(s.merchantUserId);
    const attribution = await db(TABLES.Attribution).where({ eventId: invoice!.id }).first();
    expect(attribution?.partnerId).toBe(s.partnerId);
    expect(await db(TABLES.Event).where({ userId: s.customerId })).toHaveLength(0);
  });

  it('records one signup when both deliveries arrive at once', async () => {
    const s = await seedBothMethods();
    const [r1, r2] = await Promise.all([postWebhook(s.customerCreated), postWebhook(s.checkout)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    await expectOneSignupFor(s);
  });

  it('an invoice that beat the checkout is credited once the checkout stitches', async () => {
    const s = await seedBothMethods();
    expect((await postWebhook(invoicePaid(s.customerId, { billing_reason: 'subscription_create' }))).status).toBe(200);
    const invoice = await db(TABLES.Event).where({ type: 'invoice_paid' }).first();
    expect(invoice?.userId).toBe(s.merchantUserId);
    expect(await db(TABLES.Attribution).where({ eventId: invoice!.id })).toHaveLength(0);

    expect((await postWebhook(s.checkout)).status).toBe(200);
    const attribution = await db(TABLES.Attribution).where({ eventId: invoice!.id }).first();
    expect(attribution?.partnerId).toBe(s.partnerId);
    expect(await db(TABLES.Event).where({ type: 'signup', userId: s.merchantUserId })).toHaveLength(1);
  });

  it('a plain cref checkout (no merchant metadata) keys the user to the cus_ id, as before', async () => {
    const { clickId, partnerId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    stripeApi.customersRetrieve.mockResolvedValue({ id: customerId, object: 'customer', metadata: {} });

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: completedCheckout(customerId, clickId) },
    });

    expect(res.status).toBe(200);
    const signup = await db(TABLES.Event).where({ userId: customerId, type: 'signup' }).first();
    expect(signup).toBeTruthy();
    const attribution = await db(TABLES.Attribution).where({ eventId: signup!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
    expect(await db(TABLES.Identity).where({ clickId, userId: customerId })).toHaveLength(1);
    expect(stripeApi.customersUpdate).toHaveBeenCalledWith(customerId, {
      metadata: { openpartner_user_id: customerId, openpartner_tenant_id: DEFAULT_TENANT_ID },
    });
  });

  it("a returning cus_ customer's second checkout still records its signup (no dedupe)", async () => {
    // openpartner_user_id = the cus_ id is our own backfill, not the
    // merchant's: the dedupe is for merchant-set ids only.
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    stripeApi.customersRetrieve.mockResolvedValue({
      id: customerId,
      object: 'customer',
      metadata: { openpartner_user_id: customerId },
    });
    for (let i = 0; i < 2; i += 1) {
      const res = await postWebhook({
        id: `evt_${ulid()}`,
        type: 'checkout.session.completed',
        created: Math.floor(Date.now() / 1000),
        data: { object: completedCheckout(customerId, clickId) },
      });
      expect(res.status).toBe(200);
    }
    expect(await db(TABLES.Event).where({ userId: customerId, type: 'signup' })).toHaveLength(2);
  });
});

/** An error shaped like the Stripe SDK's: `type` is the error class name. */
function stripeError(type: string, code?: string) {
  return Object.assign(new Error(`${type} (test)`), { type, ...(code ? { code } : {}) });
}

describe.skipIf(skipIntegration)('stripe webhook — Stripe read failures', () => {
  it.each([
    ['resource_missing', 'StripeInvalidRequestError', 'resource_missing'],
    ['a restricted key', 'StripePermissionError', undefined],
  ])('%s is permanent: the event is acknowledged 2xx and skipped', async (_label, type, code) => {
    const customerId = `cus_${ulid()}`;
    stripeApi.customersRetrieve.mockRejectedValue(stripeError(type, code));
    stripeApi.checkoutSessionsList.mockRejectedValue(stripeError(type, code));

    const res = await postWebhook(invoicePaid(customerId));

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('invoice.paid');
    expect(stripeApi.checkoutSessionsList).toHaveBeenCalled();
    expect(await db(TABLES.Event)).toHaveLength(0);
  });

  it.each([
    ['StripeConnectionError', undefined],
    ['StripeAPIError', undefined],
    ['StripeRateLimitError', undefined],
    // A revoked key breaks every Stripe call; redelivery keeps the events
    // until the operator fixes the key.
    ['StripeAuthenticationError', undefined],
    ['StripeInvalidRequestError', 'parameter_invalid_integer'],
  ])('%s %s is not permanent: 500, so Stripe redelivers', async (type, code) => {
    const customerId = `cus_${ulid()}`;
    stripeApi.checkoutSessionsList.mockRejectedValue(stripeError(type, code));

    const res = await postWebhook(invoicePaid(customerId));

    expect(res.status).toBe(500);
    expect(await db(TABLES.Event)).toHaveLength(0);
  });

  it('a checkout whose customer read fails permanently keys the user to the cus_ id', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    stripeApi.customersRetrieve.mockRejectedValue(stripeError('StripeInvalidRequestError', 'resource_missing'));

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: completedCheckout(customerId, clickId) },
    });

    expect(res.status).toBe(200);
    expect(await db(TABLES.Event).where({ userId: customerId, type: 'signup' })).toHaveLength(1);
  });

  it("a connected account's customer event stays unresolved (no single-tenant fallback)", async () => {
    // event.account set: a Connect event on the legacy combined secret.
    // Its customers belong to that account, not the brand.
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const merchantUserId = `user_${ulid()}`;
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId: merchantUserId });
    stripeApi.customersRetrieve.mockResolvedValue({
      id: customerId,
      object: 'customer',
      metadata: { openpartner_user_id: merchantUserId },
    });

    const res = await postWebhook({ ...invoicePaid(customerId), account: 'acct_connected_test' });

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('unresolved_tenant');
    expect(await db(TABLES.Event)).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('stripe webhook — renewal invoices skip the Checkout lookup', () => {
  it.each(['subscription_cycle', 'subscription_update', 'subscription_threshold'])(
    'a %s invoice for an unlinked customer makes no checkout.sessions.list call',
    async (billingReason) => {
      const customerId = `cus_${ulid()}`;

      const res = await postWebhook(invoicePaid(customerId, { billing_reason: billingReason }));

      expect(res.status).toBe(200);
      expect(res.body.skipped).toBe('invoice.paid');
      expect(stripeApi.checkoutSessionsList).not.toHaveBeenCalled();
    },
  );

  it('a subscription_create invoice still recovers from the Checkout Sessions', async () => {
    const { clickId, partnerId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    stripeApi.checkoutSessionsList.mockResolvedValue({
      object: 'list',
      data: [completedCheckout(customerId, clickId)],
      has_more: false,
    });

    const res = await postWebhook(invoicePaid(customerId, { billing_reason: 'subscription_create' }));

    expect(res.status).toBe(200);
    const event = await db(TABLES.Event).where({ userId: customerId, type: 'invoice_paid' }).first();
    const attribution = await db(TABLES.Attribution).where({ eventId: event!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
  });
});

describe.skipIf(skipIntegration)('stripe webhook — refund + reversal flow', () => {
  it('charge.refunded reverses non-paid Commissions linked to the original invoice', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const stripeInvoiceId = `in_${ulid()}`;
    const stripeChargeId = `ch_${ulid()}`;

    // 1. Stitch the Identity via checkout, then drive an invoice.paid
    //    (with the Stripe customer as an embedded object so no API retrieve
    //    happens). The mapper records stripeInvoiceId in metadata.
    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${ulid()}`,
          mode: 'subscription',
          client_reference_id: clickId,
          customer: customerId,
          subscription: `sub_${ulid()}`,
        },
      },
    });

    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: stripeInvoiceId,
          customer: { id: customerId, metadata: {}, object: 'customer' },
          amount_paid: 4900,
          currency: 'usd',
          charge: stripeChargeId,
        },
      },
    });

    // Pre-condition: a Commission was accrued for the invoice_paid event.
    // (Note: the signup Event also runs through attribution and produces a
    // $0 commission, but we only care about the invoice-derived ones here.)
    const invoicePaidEvent = await db(TABLES.Event).where({ type: 'invoice_paid' }).first();
    expect(invoicePaidEvent).toBeTruthy();
    const invoiceAttributions = await db(TABLES.Attribution).where({ eventId: invoicePaidEvent!.id });
    const invoiceAttributionIds = invoiceAttributions.map((a) => a.id);
    const accruedBefore = await db(TABLES.Commission)
      .whereIn('attributionId', invoiceAttributionIds)
      .where({ status: 'accrued' });
    expect(accruedBefore.length).toBeGreaterThan(0);

    // 2. The refund: charge.refunded with .invoice pointing at our stored
    //    stripeInvoiceId. Customer is embedded so no real API call.
    const refundStripeEvent = {
      id: `evt_${ulid()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: stripeChargeId,
          customer: { id: customerId, metadata: {}, object: 'customer' },
          invoice: stripeInvoiceId,
          amount: 4900,
          amount_refunded: 4900,
          currency: 'usd',
        },
      },
    };
    const refundRes = await postWebhook(refundStripeEvent);

    expect(refundRes.status).toBe(200);

    // commission.reversed fires once per reversed commission (reason
    // 'refund'), carrying the click + conversion event it came from so
    // partner postbacks can match it to the original conversion.
    await vi.waitFor(() => expect(dispatched('commission.reversed')).toHaveLength(accruedBefore.length));
    for (const c of accruedBefore) {
      const attribution = invoiceAttributions.find((a) => a.id === c.attributionId)!;
      expect(dispatched('commission.reversed')).toContainEqual({
        commissionId: c.id,
        partnerId: c.partnerId,
        attributionId: c.attributionId,
        amount: c.amount,
        currency: c.currency,
        clickId: attribution.clickId,
        eventId: invoicePaidEvent!.id,
        eventType: 'invoice_paid',
        programId: attribution.programId,
        eventValue: invoicePaidEvent!.value,
        subId: null,
        reason: 'refund',
        refundEventId: expect.any(String),
      });
    }
    // Stripe redelivering the same event reverses nothing new and must
    // not announce the reversal twice.
    const redelivery = await postWebhook(refundStripeEvent);
    expect(redelivery.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatched('commission.reversed')).toHaveLength(accruedBefore.length);

    // Post-condition: invoice-derived Commissions are now reversed; other
    // commissions (e.g. the signup $0) are untouched.
    const invoiceCommissionsAfter = await db(TABLES.Commission)
      .whereIn('attributionId', invoiceAttributionIds);
    expect(invoiceCommissionsAfter.every((c) => c.status === 'reversed')).toBe(true);
    expect(invoiceCommissionsAfter.length).toBe(accruedBefore.length);

    // The corrective Event was inserted and its metadata records the
    // reversal count for downstream observability.
    const refundEvent = await db(TABLES.Event).where({ type: 'refund' }).first();
    expect(refundEvent).toBeTruthy();
    expect((refundEvent!.metadata as { reversedCommissions?: number }).reversedCommissions)
      .toBe(accruedBefore.length);
  });

  it('charge.refunded leaves already-paid Commissions paid and surfaces the count', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const stripeInvoiceId = `in_${ulid()}`;
    const stripeChargeId = `ch_${ulid()}`;

    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${ulid()}`,
          mode: 'subscription',
          client_reference_id: clickId,
          customer: customerId,
          subscription: `sub_${ulid()}`,
        },
      },
    });

    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: stripeInvoiceId,
          customer: { id: customerId, metadata: {}, object: 'customer' },
          amount_paid: 4900,
          currency: 'usd',
          charge: stripeChargeId,
        },
      },
    });

    // Simulate the partner having already been paid by flipping the
    // invoice-derived commissions to 'paid'.
    const invoicePaidEvent = await db(TABLES.Event).where({ type: 'invoice_paid' }).first();
    const invoiceAttributions = await db(TABLES.Attribution).where({ eventId: invoicePaidEvent!.id });
    const invoiceAttributionIds = invoiceAttributions.map((a) => a.id);
    await db(TABLES.Commission)
      .whereIn('attributionId', invoiceAttributionIds)
      .update({ status: 'paid', paidAt: new Date() });

    const refundRes = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: stripeChargeId,
          customer: { id: customerId, metadata: {}, object: 'customer' },
          invoice: stripeInvoiceId,
          amount: 4900,
          amount_refunded: 4900,
          currency: 'usd',
        },
      },
    });

    expect(refundRes.status).toBe(200);

    // No invoice-derived commissions were flipped — partner already has the money.
    const stillPaid = await db(TABLES.Commission)
      .whereIn('attributionId', invoiceAttributionIds)
      .where({ status: 'paid' });
    expect(stillPaid.length).toBeGreaterThan(0);
    const reversedFromInvoice = await db(TABLES.Commission)
      .whereIn('attributionId', invoiceAttributionIds)
      .where({ status: 'reversed' });
    expect(reversedFromInvoice).toHaveLength(0);

    // The refund Event's metadata flags the count for admin attention.
    const refundEvent = await db(TABLES.Event).where({ type: 'refund' }).first();
    expect(refundEvent!.metadata).toMatchObject({
      alreadyPaidCommissions: stillPaid.length,
      clawbackCommissions: stillPaid.length,
    });
    // Each paid commission carries a clawback for all of it, naming the refund.
    const adjustments = await db(TABLES.CommissionAdjustment).orderBy('commissionId');
    expect(adjustments.map((a) => [a.commissionId, a.amount, a.reason])).toEqual(
      [...stillPaid]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => [c.id, (-Number(c.amount)).toFixed(2), 'refund_clawback']),
    );
    expect(adjustments.every((a) => (a.metadata as { refundEventId?: string }).refundEventId === refundEvent!.id)).toBe(true);
  });

  it('charge.refunded does not run attribution on the corrective Event', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const stripeInvoiceId = `in_${ulid()}`;

    // Set up an Identity for the customer so attribution would normally fire.
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId: customerId });

    const refundRes = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_${ulid()}`,
          customer: { id: customerId, metadata: {}, object: 'customer' },
          invoice: stripeInvoiceId,
          amount: 1900,
          amount_refunded: 1900,
          currency: 'usd',
        },
      },
    });

    expect(refundRes.status).toBe(200);
    expect(refundRes.body.corrective).toBe('refund');

    // No Attribution rows for the refund Event — corrective events skip
    // attribution to avoid creating phantom negative commissions.
    const refundEvent = await db(TABLES.Event).where({ type: 'refund' }).first();
    expect(refundEvent).toBeTruthy();
    const attributions = await db(TABLES.Attribution).where({ eventId: refundEvent!.id });
    expect(attributions).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('stripe webhook — partial refunds', () => {
  it('a PARTIAL charge.refunded reduces commissions to the share the customer kept, cumulatively', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const stripeInvoiceId = `in_${ulid()}`;
    const stripeChargeId = `ch_${ulid()}`;

    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_${ulid()}`,
          mode: 'subscription',
          client_reference_id: clickId,
          customer: customerId,
          subscription: `sub_${ulid()}`,
        },
      },
    });

    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: stripeInvoiceId,
          customer: { id: customerId, metadata: {}, object: 'customer' },
          amount_paid: 10000,
          currency: 'usd',
          charge: stripeChargeId,
        },
      },
    });

    const invoicePaidEvent = await db(TABLES.Event).where({ type: 'invoice_paid' }).first();
    const attributionIds = (await db(TABLES.Attribution).where({ eventId: invoicePaidEvent!.id })).map((a) => a.id);
    const [original, ...others] = await db(TABLES.Commission).whereIn('attributionId', attributionIds);
    expect(others).toHaveLength(0);
    expect(original).toMatchObject({ status: 'accrued', amount: '20.00' });

    const refundCharge = (amountRefunded: number) =>
      postWebhook({
        id: `evt_${ulid()}`,
        type: 'charge.refunded',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: stripeChargeId,
            customer: { id: customerId, metadata: {}, object: 'customer' },
            invoice: stripeInvoiceId,
            amount: 10000,
            amount_refunded: amountRefunded,
            currency: 'usd',
          },
        },
      });

    // $1 of a $100 charge: the partner keeps 99%.
    const res = await refundCharge(100);
    expect(res.status).toBe(200);
    expect(res.body.corrective).toBe('refund');

    const firstRefund = await db(TABLES.Event).where({ type: 'refund' }).first();
    expect(firstRefund!.metadata).toMatchObject({ fullRefund: false, reversedCommissions: 0, reducedCommissions: 1 });
    expect(firstRefund!.metadata).not.toHaveProperty('partialRefundReversalSkipped');

    // The original is reversed, never rewritten, and a replacement for the
    // kept amount takes its place with the same status and accrual time.
    const afterFirst = await db(TABLES.Commission).whereIn('attributionId', attributionIds).orderBy('id');
    expect(afterFirst.map((c) => [c.id === original!.id, c.status, c.amount])).toEqual([
      [true, 'reversed', '20.00'],
      [false, 'accrued', '19.80'],
    ]);
    const replacement = afterFirst[1]!;
    expect(new Date(replacement.accruedAt).getTime()).toBe(new Date(original!.accruedAt).getTime());
    expect((replacement.metadata as { refund?: unknown }).refund).toEqual({
      rootCommissionId: original!.id,
      replacesCommissionId: original!.id,
      refundEventId: firstRefund!.id,
    });
    await vi.waitFor(() => expect(dispatched('commission.accrued')).toHaveLength(2));
    expect(dispatched('commission.reversed')).toEqual([
      expect.objectContaining({
        commissionId: original!.id,
        reason: 'refund',
        refundEventId: firstRefund!.id,
        replacementCommissionId: replacement.id,
      }),
    ]);
    expect(dispatched('commission.accrued')[1]).toMatchObject({
      commissionId: replacement.id,
      amount: '19.80',
      eventId: invoicePaidEvent!.id,
      replacesCommissionId: original!.id,
    });

    // Stripe reports amount_refunded cumulatively: $50 in all leaves 50% of
    // the ORIGINAL, not 50% of what the first refund left.
    await refundCharge(5000);
    const live = await db(TABLES.Commission).whereIn('attributionId', attributionIds).whereNot({ status: 'reversed' });
    expect(live.map((c) => c.amount)).toEqual(['10.00']);

    // The rest of the charge: a full refund reverses the live replacement.
    await refundCharge(10000);
    const final = await db(TABLES.Commission).whereIn('attributionId', attributionIds);
    expect(final).toHaveLength(3);
    expect(final.every((c) => c.status === 'reversed')).toBe(true);
  });

  it('fully refunding a partially-CAPTURED charge reverses commissions (measured vs amount_captured)', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const stripeInvoiceId = `in_${ulid()}`;
    const stripeChargeId = `ch_${ulid()}`;

    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: `cs_${ulid()}`, mode: 'subscription', client_reference_id: clickId, customer: customerId, subscription: `sub_${ulid()}` } },
    });
    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: stripeInvoiceId, customer: { id: customerId, metadata: {}, object: 'customer' }, amount_paid: 6000, currency: 'usd', charge: stripeChargeId } },
    });

    const invoicePaidEvent = await db(TABLES.Event).where({ type: 'invoice_paid' }).first();
    const invoiceAttributions = await db(TABLES.Attribution).where({ eventId: invoicePaidEvent!.id });

    // $100 authorized, only $60 captured, then the full $60 refunded.
    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: stripeChargeId,
          customer: { id: customerId, metadata: {}, object: 'customer' },
          invoice: stripeInvoiceId,
          amount: 10000,
          amount_captured: 6000,
          amount_refunded: 6000,
          currency: 'usd',
        },
      },
    });

    expect(res.status).toBe(200);
    const after = await db(TABLES.Commission).whereIn('attributionId', invoiceAttributions.map((a) => a.id));
    expect(after.every((c) => c.status === 'reversed')).toBe(true);
    const refundEvent = await db(TABLES.Event).where({ type: 'refund' }).first();
    expect((refundEvent!.metadata as { fullRefund?: boolean }).fullRefund).toBe(true);
  });
});

// From API version 2025-03-31.basil, Invoice has no `charge` or
// `payment_intent` and Charge has no `invoice`: the link is an InvoicePayment.
// These payloads leave the keys out entirely, as Stripe does.
describe.skipIf(skipIntegration)('stripe webhook — API 2025-03-31.basil payloads', () => {
  const now = () => Math.floor(Date.now() / 1000);

  /** A referred customer with one paid basil-shaped invoice. */
  async function seedBasilInvoice(amountPaid: number) {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const invoiceId = `in_${ulid()}`;
    const paymentIntentId = `pi_${ulid()}`;
    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: now(),
      data: { object: { id: `cs_${ulid()}`, mode: 'subscription', client_reference_id: clickId, customer: customerId, subscription: `sub_${ulid()}` } },
    });
    const paid = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'invoice.paid',
      created: now(),
      data: {
        object: {
          id: invoiceId,
          object: 'invoice',
          customer: { id: customerId, metadata: {}, object: 'customer' },
          amount_paid: amountPaid,
          currency: 'usd',
          billing_reason: 'subscription_create',
        },
      },
    });
    expect(paid.status).toBe(200);
    const conversion = (await db(TABLES.Event).where({ type: 'invoice_paid' }).first())!;
    const attributionIds = (await db(TABLES.Attribution).where({ eventId: conversion.id })).map((a) => a.id);
    return { customerId, invoiceId, paymentIntentId, conversion, attributionIds };
  }

  function chargeRefunded(o: { customerId: string; paymentIntentId: string; amount: number; refunded: number; chargeId?: string }) {
    return {
      id: `evt_${ulid()}`,
      type: 'charge.refunded',
      created: now(),
      data: {
        object: {
          id: o.chargeId ?? `ch_${ulid()}`,
          object: 'charge',
          customer: { id: o.customerId, metadata: {}, object: 'customer' },
          payment_intent: o.paymentIntentId,
          amount: o.amount,
          amount_captured: o.amount,
          amount_refunded: o.refunded,
          currency: 'usd',
        },
      },
    };
  }

  function invoicePayment(invoiceId: string, paymentIntentId: string, amountPaid: number) {
    return {
      id: `inpay_${ulid()}`,
      object: 'invoice_payment',
      amount_paid: amountPaid,
      amount_requested: amountPaid,
      currency: 'usd',
      invoice: invoiceId,
      is_default: true,
      livemode: false,
      payment: { type: 'payment_intent', payment_intent: paymentIntentId },
      status: 'paid',
    };
  }

  const listOf = (...data: object[]) => ({ object: 'list', data, has_more: false, url: '/v1/invoice_payments' });

  it('a full refund finds its invoice through the InvoicePayment and reverses the commission', async () => {
    const { customerId, invoiceId, paymentIntentId, conversion, attributionIds } = await seedBasilInvoice(4900);
    // invoice.paid had nothing to record but the invoice id, and read nothing extra.
    expect(conversion.metadata).toMatchObject({ stripeInvoiceId: invoiceId });
    expect(conversion.metadata).not.toHaveProperty('stripeChargeId');
    expect(conversion.metadata).not.toHaveProperty('stripePaymentIntentId');
    expect(stripeApi.invoicePaymentsList).not.toHaveBeenCalled();
    const accrued = await db(TABLES.Commission).whereIn('attributionId', attributionIds);
    expect(accrued.map((c) => [c.status, c.amount])).toEqual([['accrued', '9.80']]);

    stripeApi.invoicePaymentsList.mockResolvedValue(listOf(invoicePayment(invoiceId, paymentIntentId, 4900)));
    const refund = chargeRefunded({ customerId, paymentIntentId, amount: 4900, refunded: 4900 });
    const res = await postWebhook(refund);

    expect(res.status).toBe(200);
    expect(res.body.corrective).toBe('refund');
    expect(stripeApi.invoicePaymentsList).toHaveBeenCalledWith(
      expect.objectContaining({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, status: 'paid' }),
    );
    const after = await db(TABLES.Commission).whereIn('attributionId', attributionIds);
    expect(after.map((c) => c.status)).toEqual(['reversed']);
    await vi.waitFor(() =>
      expect(dispatched('commission.reversed')).toEqual([
        expect.objectContaining({ commissionId: accrued[0]!.id, eventId: conversion.id, reason: 'refund' }),
      ]),
    );

    // The refund Event names the invoice, which is how the usage ledger and a
    // later replay match it to the conversion.
    const [refundEvent] = await db(TABLES.Event).where({ type: 'refund' });
    expect(refundEvent!.metadata).toMatchObject({
      stripeInvoiceId: invoiceId,
      stripePaymentIntentId: paymentIntentId,
      fullRefund: true,
      reversedCommissions: 1,
    });
    expect(refundEvent!.metadata).not.toHaveProperty('splitPaymentReversalSkipped');

    // A redelivery records nothing new and announces nothing twice.
    const again = await postWebhook(refund);
    expect(again.status).toBe(200);
    expect(again.body.idempotent).toBe(true);
    expect(await db(TABLES.Event).where({ type: 'refund' })).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatched('commission.reversed')).toHaveLength(1);
  });

  it('partial refunds prorate cumulatively, and billable GMV keeps the kept share', async () => {
    const { customerId, invoiceId, paymentIntentId, attributionIds } = await seedBasilInvoice(10000);
    stripeApi.invoicePaymentsList.mockResolvedValue(listOf(invoicePayment(invoiceId, paymentIntentId, 10000)));
    const chargeId = `ch_${ulid()}`;

    await postWebhook(chargeRefunded({ chargeId, customerId, paymentIntentId, amount: 10000, refunded: 2500 }));
    let live = await db(TABLES.Commission).whereIn('attributionId', attributionIds).whereNot({ status: 'reversed' });
    expect(live.map((c) => c.amount)).toEqual(['15.00']);

    // The usage ledger matches the refund to the conversion by invoice id:
    // without that it would still bill the whole $100.
    const { aggregateAttributedGmv } = await import('../usage-billing.js');
    expect(await aggregateAttributedGmv(db, DEFAULT_TENANT_ID, null, new Date(Date.now() + 60_000))).toEqual({ USD: 75 });

    // amount_refunded is cumulative: $60 in all leaves 40% of the original.
    await postWebhook(chargeRefunded({ chargeId, customerId, paymentIntentId, amount: 10000, refunded: 6000 }));
    live = await db(TABLES.Commission).whereIn('attributionId', attributionIds).whereNot({ status: 'reversed' });
    expect(live.map((c) => c.amount)).toEqual(['8.00']);
  });

  it('a payment that paid only part of the invoice records the refund and reverses nothing', async () => {
    const { customerId, invoiceId, paymentIntentId, attributionIds } = await seedBasilInvoice(10000);
    // $60 of the $100 invoice came from this payment; the rest from another.
    stripeApi.invoicePaymentsList.mockResolvedValue(listOf(invoicePayment(invoiceId, paymentIntentId, 6000)));

    const res = await postWebhook(chargeRefunded({ customerId, paymentIntentId, amount: 6000, refunded: 6000 }));

    expect(res.status).toBe(200);
    expect(res.body.corrective).toBe('refund');
    const commissions = await db(TABLES.Commission).whereIn('attributionId', attributionIds);
    expect(commissions.map((c) => c.status)).toEqual(['accrued']);
    const [refundEvent] = await db(TABLES.Event).where({ type: 'refund' });
    expect(refundEvent!.metadata).toMatchObject({
      stripeSplitInvoiceIds: [invoiceId],
      splitPaymentReversalSkipped: true,
      fullRefund: true,
      reversedCommissions: 0,
    });
    // Not linked by invoice id, so neither the usage ledger nor a replay
    // takes this charge's 100% as the invoice's.
    expect(refundEvent!.metadata).not.toHaveProperty('stripeInvoiceId');
    const { aggregateAttributedGmv } = await import('../usage-billing.js');
    expect(await aggregateAttributedGmv(db, DEFAULT_TENANT_ID, null, new Date(Date.now() + 60_000))).toEqual({ USD: 100 });
  });

  it('a payment spread across several invoices reverses nothing either', async () => {
    const { customerId, invoiceId, paymentIntentId, attributionIds } = await seedBasilInvoice(4900);
    const otherInvoiceId = `in_${ulid()}`;
    stripeApi.invoicePaymentsList.mockResolvedValue(
      listOf(invoicePayment(invoiceId, paymentIntentId, 4900), invoicePayment(otherInvoiceId, paymentIntentId, 5100)),
    );

    await postWebhook(chargeRefunded({ customerId, paymentIntentId, amount: 10000, refunded: 10000 }));

    expect((await db(TABLES.Commission).whereIn('attributionId', attributionIds)).map((c) => c.status)).toEqual(['accrued']);
    const [refundEvent] = await db(TABLES.Event).where({ type: 'refund' });
    expect(refundEvent!.metadata).toMatchObject({ stripeSplitInvoiceIds: [invoiceId, otherInvoiceId], splitPaymentReversalSkipped: true });
  });

  it('a key that cannot read invoice payments records the refund without failing the webhook', async () => {
    const { customerId, paymentIntentId, attributionIds } = await seedBasilInvoice(4900);
    stripeApi.invoicePaymentsList.mockRejectedValue(stripeError('StripePermissionError'));

    const res = await postWebhook(chargeRefunded({ customerId, paymentIntentId, amount: 4900, refunded: 4900 }));

    expect(res.status).toBe(200);
    expect((await db(TABLES.Commission).whereIn('attributionId', attributionIds)).map((c) => c.status)).toEqual(['accrued']);
    expect(await db(TABLES.Event).where({ type: 'refund' })).toHaveLength(1);
  });

  it('a transient Stripe failure answers 500 so Stripe redelivers', async () => {
    const { customerId, paymentIntentId } = await seedBasilInvoice(4900);
    stripeApi.invoicePaymentsList.mockRejectedValue(stripeError('StripeConnectionError'));

    const res = await postWebhook(chargeRefunded({ customerId, paymentIntentId, amount: 4900, refunded: 4900 }));

    expect(res.status).toBe(500);
    expect(await db(TABLES.Event).where({ type: 'refund' })).toHaveLength(0);
  });

  it('an acacia charge that says it has no invoice (null) is not looked up', async () => {
    const { customerId, attributionIds } = await seedBasilInvoice(4900);
    const refund = chargeRefunded({ customerId, paymentIntentId: `pi_${ulid()}`, amount: 4900, refunded: 4900 });
    (refund.data.object as Record<string, unknown>).invoice = null;

    const res = await postWebhook(refund);

    expect(res.status).toBe(200);
    expect(stripeApi.invoicePaymentsList).not.toHaveBeenCalled();
    expect((await db(TABLES.Commission).whereIn('attributionId', attributionIds)).map((c) => c.status)).toEqual(['accrued']);
  });
});

describe.skipIf(skipIntegration)('stripe webhook — disputes', () => {
  // A Dispute names its charge and PaymentIntent, never a customer.
  function disputeCreated(chargeId: string, paymentIntentId: string) {
    return {
      id: `evt_${ulid()}`,
      type: 'charge.dispute.created',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `dp_${ulid()}`,
          object: 'dispute',
          charge: chargeId,
          payment_intent: paymentIntentId,
          amount: 4900,
          currency: 'usd',
          reason: 'fraudulent',
          status: 'needs_response',
          metadata: {},
        },
      },
    };
  }

  /** A guest one-time purchase as its revenue Event records it: invoice_paid
   *  naming the PaymentIntent, under a user no Stripe Customer carries. */
  async function seedGuestPurchase(paymentIntentId: string): Promise<string> {
    const { clickId } = await seedClick();
    const userId = `click:${clickId}`;
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });
    await db(TABLES.Event).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      userId,
      type: 'invoice_paid',
      value: '49.00',
      currency: 'USD',
      externalEventId: `cs_${ulid()}`,
      metadata: { checkoutMode: 'payment', stripePaymentIntentId: paymentIntentId },
      ts: new Date(),
    });
    return userId;
  }

  it("a dispute on a stitched customer's charge records dispute_created and reverses nothing", async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const chargeId = `ch_${ulid()}`;
    const paymentIntentId = `pi_${ulid()}`;
    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: { object: completedCheckout(customerId, clickId) },
    });
    await postWebhook(invoicePaid(customerId, { charge: chargeId }));
    const invoicePaidEvent = await db(TABLES.Event).where({ type: 'invoice_paid' }).first();
    const attributionIds = (await db(TABLES.Attribution).where({ eventId: invoicePaidEvent!.id })).map((a) => a.id);
    const accrued = await db(TABLES.Commission).whereIn('attributionId', attributionIds).where({ status: 'accrued' });
    expect(accrued.length).toBeGreaterThan(0);
    stripeApi.chargesRetrieve.mockResolvedValue({
      id: chargeId,
      object: 'charge',
      customer: customerId,
      payment_intent: paymentIntentId,
    });

    const dispute = disputeCreated(chargeId, paymentIntentId);
    const res = await postWebhook(dispute);

    expect(res.status).toBe(200);
    expect(res.body.corrective).toBe('dispute_created');
    expect(stripeApi.chargesRetrieve).toHaveBeenCalledWith(chargeId);
    const disputeEvents = await db(TABLES.Event).where({ type: 'dispute_created' });
    expect(disputeEvents).toHaveLength(1);
    expect(disputeEvents[0]).toMatchObject({ userId: customerId, currency: 'USD', externalEventId: dispute.id });
    expect(Number(disputeEvents[0].value)).toBe(-49);
    expect(disputeEvents[0].metadata).toMatchObject({
      stripeDisputeId: dispute.data.object.id,
      stripeChargeId: chargeId,
      stripePaymentIntentId: paymentIntentId,
      reason: 'fraudulent',
      status: 'needs_response',
    });

    // Recorded for review, never acted on: disputes can be won. No
    // attribution of the corrective Event, no commission touched.
    expect(await db(TABLES.Attribution).where({ eventId: disputeEvents[0].id })).toHaveLength(0);
    const after = await db(TABLES.Commission).whereIn('attributionId', attributionIds);
    expect(after.map((c) => c.status)).toEqual(accrued.map(() => 'accrued'));
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatched('commission.reversed')).toHaveLength(0);

    // A redelivery records nothing new.
    const redelivery = await postWebhook(dispute);
    expect(redelivery.status).toBe(200);
    expect(redelivery.body.idempotent).toBe(true);
    expect(await db(TABLES.Event).where({ type: 'dispute_created' })).toHaveLength(1);
  });

  it.each([
    ['its charge has no customer', () => ({ object: 'charge', customer: null })],
    ['its charge is gone (resource_missing)', () => stripeError('StripeInvalidRequestError', 'resource_missing')],
  ])('a dispute of a guest one-time purchase resolves via its PaymentIntent when %s', async (_label, charge) => {
    const paymentIntentId = `pi_${ulid()}`;
    const guestUserId = await seedGuestPurchase(paymentIntentId);
    const read = charge();
    if (read instanceof Error) stripeApi.chargesRetrieve.mockRejectedValue(read);
    else stripeApi.chargesRetrieve.mockResolvedValue(read);

    const res = await postWebhook(disputeCreated(`ch_${ulid()}`, paymentIntentId));

    expect(res.status).toBe(200);
    expect(res.body.corrective).toBe('dispute_created');
    expect(stripeApi.customersRetrieve).not.toHaveBeenCalled();
    const disputeEvents = await db(TABLES.Event).where({ type: 'dispute_created' });
    expect(disputeEvents).toHaveLength(1);
    expect(disputeEvents[0].userId).toBe(guestUserId);
    expect(disputeEvents[0].metadata).toMatchObject({ stripePaymentIntentId: paymentIntentId });
  });

  it('a dispute no partner referred is acknowledged 2xx and records nothing', async () => {
    const chargeId = `ch_${ulid()}`;
    const paymentIntentId = `pi_${ulid()}`;
    stripeApi.chargesRetrieve.mockResolvedValue({
      id: chargeId,
      object: 'charge',
      customer: `cus_${ulid()}`,
      payment_intent: paymentIntentId,
    });

    const res = await postWebhook(disputeCreated(chargeId, paymentIntentId));

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('charge.dispute.created');
    expect(await db(TABLES.Event)).toHaveLength(0);
  });

  it('a transient charge read failure is a 500, so Stripe redelivers', async () => {
    const paymentIntentId = `pi_${ulid()}`;
    await seedGuestPurchase(paymentIntentId);
    stripeApi.chargesRetrieve.mockRejectedValue(stripeError('StripeConnectionError'));

    const res = await postWebhook(disputeCreated(`ch_${ulid()}`, paymentIntentId));

    expect(res.status).toBe(500);
    expect(await db(TABLES.Event).where({ type: 'dispute_created' })).toHaveLength(0);
  });

  it("a connected account's dispute stays unresolved", async () => {
    const paymentIntentId = `pi_${ulid()}`;
    await seedGuestPurchase(paymentIntentId);

    const res = await postWebhook({ ...disputeCreated(`ch_${ulid()}`, paymentIntentId), account: 'acct_connected_test' });

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('unresolved_tenant');
    expect(stripeApi.chargesRetrieve).not.toHaveBeenCalled();
    expect(await db(TABLES.Event).where({ type: 'dispute_created' })).toHaveLength(0);
  });

  it.each(deployments)('%s/%s: a dispute stays unresolved, with no Stripe read', (mode, tenancy) =>
    inDeployment(mode, tenancy, async () => {
      const paymentIntentId = `pi_${ulid()}`;
      await seedGuestPurchase(paymentIntentId);

      const res = await postWebhook(disputeCreated(`ch_${ulid()}`, paymentIntentId));

      expect(res.status).toBe(200);
      expect(res.body.reason).toBe('unresolved_tenant');
      expect(stripeApi.chargesRetrieve).not.toHaveBeenCalled();
      expect(await db(TABLES.Event).where({ type: 'dispute_created' })).toHaveLength(0);
    }),
  );
});

// --------------------------------------------------------------------------
// Tenant billing lifecycle: the brand's OWN subscription to OpenPartner.
// Guards + ops notifications added after the Jul 2026 missed-cancellation
// incident (prod webhook wasn't subscribed to subscription.updated/deleted,
// and even the handlers never alerted anyone).
// --------------------------------------------------------------------------

const { __setMailerForTests } = await import('../mailer.js');

describe.skipIf(skipIntegration)('stripe webhook — tenant billing lifecycle', () => {
  const TENANT_CUS = 'cus_tenant_lifecycle_test';
  const TENANT_SUB = 'sub_tenant_lifecycle_test';
  const sentMail: Array<{ to: string; subject: string; tag?: string }> = [];

  beforeEach(async () => {
    if (skipIntegration) return;
    process.env.PLATFORM_OPS_EMAIL = 'ops@openpartner.test';
    sentMail.length = 0;
    __setMailerForTests({
      send: async (_ctx, msg) => {
        sentMail.push({ to: msg.to, subject: msg.subject, tag: msg.tag });
      },
    });
    await db(TABLES.HostedBillingState).del();
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({
      stripeCustomerId: TENANT_CUS,
      stripeSubscriptionId: TENANT_SUB,
      whiteLabel: true,
    });
  });

  afterAll(async () => {
    __setMailerForTests(null);
    delete process.env.PLATFORM_OPS_EMAIL;
    if (skipIntegration) return;
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      whiteLabel: false,
    });
  });

  it('subscription.updated flipping cancel_at_period_end on notifies ops and stamps the dedupe marker', async () => {
    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: TENANT_SUB,
          object: 'subscription',
          customer: TENANT_CUS,
          status: 'active',
          cancel_at_period_end: true,
          cancel_at: Math.floor(Date.now() / 1000) + 14 * 86400,
          cancellation_details: { comment: 'switching tools' },
          items: { data: [{ price: { id: 'price_unknown_plan' } }] },
        },
        previous_attributes: { cancel_at_period_end: false, cancel_at: null },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.connect).toContain('cancel_scheduled');
    expect(sentMail.some((m) => m.tag === 'ops_tenant_cancellation_scheduled')).toBe(true);
    const marker = await db(TABLES.Config)
      .where({ tenantId: DEFAULT_TENANT_ID, key: 'billing_cancel_scheduled_notice' })
      .first();
    expect(marker).toBeTruthy();
    expect((marker!.value as { subscriptionId?: string }).subscriptionId).toBe(TENANT_SUB);
  });

  // Pay-by-invoice (docs/invoice-billing.md): overdue follows the open
  // invoices, not the subscription status, which Stripe derives from the
  // LATEST invoice only.
  function payByInvoiceStripe(open: Array<{ id: string; dueDaysAgo: number; amount?: number }>, paidBefore: boolean) {
    const now = Math.floor(Date.now() / 1000);
    stripeApi.invoicesList.mockImplementation(async (params: { status?: string; collection_method?: string }) => {
      if (params.status === 'open') {
        expect(params.collection_method).toBe('send_invoice');
        return {
          object: 'list',
          has_more: false,
          data: open.map((i) => ({ id: i.id, amount_remaining: i.amount ?? 4900, due_date: now - i.dueDaysAgo * 86400 })),
        };
      }
      return { object: 'list', has_more: false, data: paidBefore ? [{ id: 'in_paid', amount_paid: 4900 }] : [] };
    });
  }
  const subUpdated = (status: string) => ({
    id: `evt_${ulid()}`,
    type: 'customer.subscription.updated',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: TENANT_SUB,
        object: 'subscription',
        customer: TENANT_CUS,
        status,
        collection_method: 'send_invoice',
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_unknown_plan' } }] },
      },
      previous_attributes: { latest_invoice: 'in_x' },
    },
  });

  it('pay-by-invoice: an overdue invoice is mirrored from the open invoices and ops is told once', async () => {
    // January is 10 days overdue; February was just paid, so Stripe says
    // the subscription is ACTIVE. The open invoice still counts.
    payByInvoiceStripe([{ id: 'in_jan', dueDaysAgo: 10 }], true);
    const res = await postWebhook(subUpdated('active'));
    expect(res.status).toBe(200);
    expect(res.body.connect).toContain('invoice_overdue');
    const mirror = await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).first();
    expect(mirror).toMatchObject({ subscriptionStatus: 'active', collectionMethod: 'send_invoice', oldestOpenInvoiceId: 'in_jan' });
    expect(mirror!.oldestOpenInvoiceDueAt).toBeInstanceOf(Date);
    expect(mirror!.invoicePaidAt).toBeInstanceOf(Date);
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_invoice_overdue')).toHaveLength(1);

    // The same overdue invoice seen again: no second email.
    await postWebhook(subUpdated('past_due'));
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_invoice_overdue')).toHaveLength(1);

    // January paid: the brand's own invoice.paid re-reads and clears it.
    payByInvoiceStripe([], true);
    const paid = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'invoice.paid',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'in_jan', object: 'invoice', customer: TENANT_CUS, collection_method: 'send_invoice', amount_paid: 4900, currency: 'usd' } },
    });
    expect(paid.body.connect).toBe('tenant_invoice_paid');
    const cleared = await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).first();
    expect(cleared).toMatchObject({ oldestOpenInvoiceId: null, oldestOpenInvoiceDueAt: null });
    // Our own invoice is never a conversion.
    expect(await db(TABLES.Event).where({ type: 'invoice_paid' })).toHaveLength(0);
  });

  it('pay-by-invoice: an invoice not yet due is tracked but not overdue', async () => {
    payByInvoiceStripe([{ id: 'in_feb', dueDaysAgo: -5 }], false);
    const res = await postWebhook(subUpdated('active'));
    expect(res.body.connect).not.toContain('invoice_overdue');
    const mirror = await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).first();
    expect(mirror).toMatchObject({ oldestOpenInvoiceId: 'in_feb', invoicePaidAt: null });
    expect(sentMail).toHaveLength(0);
  });

  it('a card subscription going past_due reads no invoices and sends no overdue notice', async () => {
    const res = await postWebhook({
      ...subUpdated('past_due'),
      data: { ...subUpdated('past_due').data, object: { ...subUpdated('past_due').data.object, collection_method: 'charge_automatically' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.connect).not.toContain('invoice_overdue');
    expect(stripeApi.invoicesList).not.toHaveBeenCalled();
    expect(sentMail).toHaveLength(0);
  });

  it('customer.subscription.created adopts an invoice subscription whose request never recorded it', async () => {
    await inDeployment('flat', 'single', async () => {
      await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({ stripeCustomerId: TENANT_CUS, stripeSubscriptionId: null });
      const created = (id: string) => ({
        id: `evt_${ulid()}`,
        type: 'customer.subscription.created',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id,
            object: 'subscription',
            customer: TENANT_CUS,
            status: 'active',
            collection_method: 'send_invoice',
            metadata: { openpartner_tenant_id: DEFAULT_TENANT_ID, openpartner_collection: 'send_invoice', openpartner_plan: 'flex' },
            items: { data: [{ price: { id: 'price_unknown_plan' } }] },
          },
        },
      });
      const res = await postWebhook(created('sub_orphan'));
      expect(res.status).toBe(200);
      expect(res.body.connect).toBe('invoice_subscription_adopted');
      expect((await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first())!.stripeSubscriptionId).toBe('sub_orphan');
      expect(await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).first()).toMatchObject({
        subscriptionStatus: 'active',
        collectionMethod: 'send_invoice',
      });

      // The same event again: already linked. A second one: a conflict for
      // ops, never a silent overwrite.
      expect((await postWebhook(created('sub_orphan'))).body.connect).toBe('invoice_subscription_already_linked');
      expect((await postWebhook(created('sub_second'))).body.connect).toBe('invoice_subscription_conflict');
      expect((await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first())!.stripeSubscriptionId).toBe('sub_orphan');
    });
  });

  it('subscription.updated without a cancel_at_period_end change stays quiet', async () => {
    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: TENANT_SUB,
          object: 'subscription',
          customer: TENANT_CUS,
          status: 'active',
          cancel_at_period_end: false,
          items: { data: [{ price: { id: 'price_unknown_plan' } }] },
        },
        previous_attributes: { default_payment_method: 'pm_old' },
      },
    });

    expect(res.status).toBe(200);
    expect(sentMail).toHaveLength(0);
  });

  it('subscription.deleted for the tenant billing customer clears state, revokes white-label, notifies ops', async () => {
    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'customer.subscription.deleted',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: TENANT_SUB,
          object: 'subscription',
          customer: TENANT_CUS,
          status: 'canceled',
          items: { data: [] },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.connect).toContain('subscription_deleted_canceled');
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    expect(tenant!.stripeSubscriptionId).toBeNull();
    expect(tenant!.whiteLabel).toBe(false);
    const mirror = await db(TABLES.HostedBillingState).where({ tenantId: DEFAULT_TENANT_ID }).first();
    expect(mirror!.subscriptionStatus).toBe('canceled');
    expect(sentMail.some((m) => m.tag === 'ops_tenant_subscription_ended')).toBe(true);
  });

  it("subscription.deleted for a merchant END-customer's sub must NOT touch tenant billing state", async () => {
    const { clickId } = await seedClick();
    const endCustomer = `cus_end_${ulid()}`;
    await db(TABLES.Identity).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      clickId,
      userId: endCustomer,
    });

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'customer.subscription.deleted',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `sub_end_${ulid()}`,
          object: 'subscription',
          customer: endCustomer,
          status: 'canceled',
          items: { data: [] },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('customer.subscription.deleted');
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    expect(tenant!.stripeSubscriptionId).toBe(TENANT_SUB);
    expect(tenant!.whiteLabel).toBe(true);
    expect(sentMail).toHaveLength(0);
  });

  it("invoice.payment_failed on the tenant's own invoice alerts ops and skips attribution", async () => {
    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'invoice.payment_failed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `in_${ulid()}`,
          object: 'invoice',
          customer: TENANT_CUS,
          amount_due: 4106,
          currency: 'usd',
          attempt_count: 3,
          hosted_invoice_url: 'https://invoice.stripe.com/i/test',
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.connect).toBe('tenant_invoice_payment_failed_notified');
    const failMail = sentMail.find((m) => m.tag === 'ops_tenant_invoice_payment_failed');
    expect(failMail).toBeTruthy();
    expect(failMail!.subject).toContain('41.06');
    const events = await db(TABLES.Event);
    expect(events).toHaveLength(0);
  });

  it('invoice.payment_failed redelivery of the same attempt stays silent; a new attempt notifies', async () => {
    const invoiceId = `in_${ulid()}`;
    const payload = (attemptCount: number) => ({
      id: `evt_${ulid()}`,
      type: 'invoice.payment_failed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: invoiceId,
          object: 'invoice',
          customer: TENANT_CUS,
          amount_due: 4106,
          currency: 'usd',
          attempt_count: attemptCount,
          hosted_invoice_url: 'https://invoice.stripe.com/i/test',
        },
      },
    });

    await postWebhook(payload(1));
    const retry = await postWebhook(payload(1));
    expect(retry.body.connect).toBe('tenant_invoice_payment_failed_duplicate');
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_invoice_payment_failed')).toHaveLength(1);

    const nextAttempt = await postWebhook(payload(2));
    expect(nextAttempt.body.connect).toBe('tenant_invoice_payment_failed_notified');
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_invoice_payment_failed')).toHaveLength(2);
  });

  it('a stale subscription.updated for a since-replaced sub cannot overwrite billing state', async () => {
    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'sub_old_replaced',
          object: 'subscription',
          customer: TENANT_CUS,
          status: 'active',
          cancel_at_period_end: true,
          items: { data: [{ price: { id: 'price_unknown_plan' } }] },
        },
        previous_attributes: { cancel_at_period_end: false },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.connect).toBe('subscription_updated_stale_ignored');
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    expect(tenant!.stripeSubscriptionId).toBe(TENANT_SUB);
    expect(sentMail).toHaveLength(0);
  });

  it('a late ACTIVE subscription.updated arriving after deletion (null pointer) does not resurrect the sub', async () => {
    // Post-deletion state: pointer cleared, white-label revoked. Stripe
    // guarantees no ordering, so an older active update for the now-gone
    // sub can still land. It must not re-establish the pointer or re-enable
    // white-label — only checkout.session.completed may set a new pointer.
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({
      stripeSubscriptionId: null,
      whiteLabel: false,
    });

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: TENANT_SUB,
          object: 'subscription',
          customer: TENANT_CUS,
          status: 'active',
          cancel_at_period_end: false,
          items: { data: [{ price: { id: 'price_unknown_plan' } }] },
        },
        previous_attributes: { default_payment_method: 'pm_x' },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.connect).toBe('subscription_updated_no_pointer_ignored');
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    expect(tenant!.stripeSubscriptionId).toBeNull();
    expect(tenant!.whiteLabel).toBe(false);
    expect(sentMail).toHaveLength(0);
  });

  it('a stale subscription.deleted for a since-replaced sub cannot cancel the current one', async () => {
    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'customer.subscription.deleted',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'sub_old_replaced',
          object: 'subscription',
          customer: TENANT_CUS,
          status: 'canceled',
          items: { data: [] },
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.connect).toBe('subscription_deleted_stale_ignored');
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    expect(tenant!.stripeSubscriptionId).toBe(TENANT_SUB);
    expect(tenant!.whiteLabel).toBe(true);
    expect(sentMail).toHaveLength(0);
  });

  it('a redelivered subscription.deleted does not double-clear or double-mail', async () => {
    const payload = {
      id: `evt_${ulid()}`,
      type: 'customer.subscription.deleted',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: TENANT_SUB,
          object: 'subscription',
          customer: TENANT_CUS,
          status: 'canceled',
          items: { data: [] },
        },
      },
    };

    const first = await postWebhook(payload);
    expect(first.body.connect).toContain('subscription_deleted_canceled');
    const retry = await postWebhook({ ...payload, id: `evt_${ulid()}` });
    expect(retry.body.connect).toBe('subscription_deleted_stale_ignored');
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_subscription_ended')).toHaveLength(1);
  });

  it('a redelivered cancel-scheduled update does not double-mail (Config marker dedupe)', async () => {
    const payload = () => ({
      id: `evt_${ulid()}`,
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: TENANT_SUB,
          object: 'subscription',
          customer: TENANT_CUS,
          status: 'active',
          cancel_at_period_end: true,
          cancel_at: Math.floor(Date.now() / 1000) + 14 * 86400,
          items: { data: [{ price: { id: 'price_unknown_plan' } }] },
        },
        previous_attributes: { cancel_at_period_end: false, cancel_at: null },
      },
    });

    await postWebhook(payload());
    await postWebhook(payload());
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_cancellation_scheduled')).toHaveLength(1);
  });

  it('a cancellation scheduled via bare cancel_at (no cancel_at_period_end) also notifies', async () => {
    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: TENANT_SUB,
          object: 'subscription',
          customer: TENANT_CUS,
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: Math.floor(Date.now() / 1000) + 30 * 86400,
          items: { data: [{ price: { id: 'price_unknown_plan' } }] },
        },
        previous_attributes: { cancel_at: null },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.connect).toContain('cancel_scheduled');
    expect(sentMail.filter((m) => m.tag === 'ops_tenant_cancellation_scheduled')).toHaveLength(1);
  });

  it('invoice.payment_failed for a merchant END-customer still records the audit Event, no ops mail', async () => {
    const { clickId } = await seedClick();
    const endCustomer = `cus_end_${ulid()}`;
    await db(TABLES.Identity).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      clickId,
      userId: endCustomer,
    });

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'invoice.payment_failed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `in_${ulid()}`,
          object: 'invoice',
          customer: { id: endCustomer, metadata: {}, object: 'customer' },
          amount_due: 1900,
          currency: 'usd',
          attempt_count: 1,
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.corrective).toBe('invoice_payment_failed');
    const event = await db(TABLES.Event).where({ type: 'invoice_payment_failed' }).first();
    expect(event).toBeTruthy();
    expect(sentMail).toHaveLength(0);
  });
});

describe.skipIf(skipIntegration)('round-6: a reversal that beats finalization', () => {
  // The executor posts a transfer and only writes `stripeTransferId` when
  // it finalizes. A reversal landing in that gap used to match nothing,
  // get logged "unmatched" and ACKNOWLEDGED — so the only reversal event
  // was consumed, and the executor then wrote `paid` from a create
  // response that still said reversed:false. Money back, ledger says paid.
  //
  // Driven through the real HTTP route, not the handler, so a regression
  // in routing or acknowledgement is caught too.
  async function seedPostedPayout(generation = 0) {
    const partnerId = ulid();
    await db(TABLES.Partner).insert({
      id: partnerId,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Reversal partner',
      email: `rev-${partnerId}@example.com`,
      stripeConnectAccountId: `acct_${partnerId.slice(0, 10)}`,
    });
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      amount: '50.00',
      currency: 'USD',
      status: 'pending',
      method: 'stripe_connect',
      metadata: {
        transferState: 'posted',
        postedAt: new Date().toISOString(),
        keyGeneration: generation,
        attempts: 1,
      },
    });
    return { partnerId, payoutId };
  }

  function reversalEvent(payoutId: string, transferId: string, generation = '0') {
    return {
      id: `evt_${ulid()}`,
      type: 'transfer.reversed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: transferId,
          object: 'transfer',
          amount: 5000,
          currency: 'usd',
          reversed: true,
          transfer_group: payoutId,
          metadata: {
            openpartner_payout_id: payoutId,
            openpartner_key_generation: generation,
          },
        },
      },
    };
  }

  it('is recorded against the payout even though stripeTransferId is not stamped yet', async () => {
    const { payoutId } = await seedPostedPayout(0);
    const res = await postWebhook(reversalEvent(payoutId, 'tr_reversed_early', '0'));
    expect(res.status).toBe(200);

    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    expect(payout!.status).toBe('failed');
    expect(payout!.stripeTransferId).toBe('tr_reversed_early');
    expect((payout!.metadata as { transferState?: string }).transferState).toBe('confirmed');
    expect((payout!.metadata as { lastError?: string }).lastError).toContain('reversed_before_finalize');
  });

  it('does not touch a payout on a DIFFERENT key generation', async () => {
    // A reversal of a superseded attempt must not fail the live one.
    const { payoutId } = await seedPostedPayout(1);
    const res = await postWebhook(reversalEvent(payoutId, 'tr_from_gen0', '0'));
    expect(res.status).toBe(200);

    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    expect(payout!.status).toBe('pending');
    expect(payout!.stripeTransferId).toBeNull();
    expect((payout!.metadata as { transferState?: string }).transferState).toBe('posted');
  });

  it('leaves an already-finalized payout to the normal stripeTransferId path', async () => {
    const { payoutId } = await seedPostedPayout(0);
    await db(TABLES.Payout).where({ id: payoutId }).update({
      stripeTransferId: 'tr_already_known',
      status: 'paid',
    });
    const res = await postWebhook(reversalEvent(payoutId, 'tr_already_known', '0'));
    expect(res.status).toBe(200);

    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    expect(payout!.status).toBe('failed');
    expect(payout!.stripeTransferId).toBe('tr_already_known');
  });
});

describe.skipIf(skipIntegration)('round-9: reversal activity on a duplicate_review payout', () => {
  // duplicate_review is parked for a HUMAN, and round 9 found the webhook
  // dropped reversals landing there as "unmatched" — consumed and gone.
  // The operator resolving the review had validated against a pre-reversal
  // listing, so the reversed transfer got recorded as the kept one, paid.
  // The webhook now RECORDS the reversal on the review (without claiming
  // or terminalizing anything — other transfers may still hold money) and
  // moves duplicateReviewNonce so an in-flight resolution loses its fenced
  // CAS. Revert the recording branch and every test here sees the event
  // fall through to "unmatched" with the metadata untouched.

  async function seedDuplicateReviewPayout(generation = 0) {
    const partnerId = ulid();
    await db(TABLES.Partner).insert({
      id: partnerId,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Dup partner',
      email: `dup-${partnerId}@example.com`,
      stripeConnectAccountId: `acct_${partnerId.slice(0, 10)}`,
    });
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      amount: '50.00',
      currency: 'USD',
      status: 'failed',
      method: 'stripe_connect',
      metadata: {
        transferState: 'duplicate_review',
        keyGeneration: generation,
        lastError: 'duplicate_transfers:tr_a, tr_b',
      },
    });
    return payoutId;
  }

  function transferEvent(
    payoutId: string,
    transferId: string,
    opts: { type?: string; reversed?: boolean; amountReversed?: number; generation?: string; noMetadata?: boolean } = {},
  ) {
    return {
      id: `evt_${ulid()}`,
      type: opts.type ?? 'transfer.reversed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: transferId,
          object: 'transfer',
          amount: 5000,
          amount_reversed: opts.amountReversed ?? 5000,
          currency: 'usd',
          reversed: opts.reversed ?? true,
          transfer_group: payoutId,
          metadata: opts.noMetadata
            ? {}
            : {
                openpartner_payout_id: payoutId,
                openpartner_key_generation: opts.generation ?? '0',
              },
        },
      },
    };
  }

  async function reviewMeta(payoutId: string) {
    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    return payout!.metadata as {
      transferState?: string;
      duplicateReviewNonce?: string;
      reversedTransferIds?: string[];
    };
  }

  it('a full reversal is RECORDED on the review, not dropped as unmatched', async () => {
    const payoutId = await seedDuplicateReviewPayout();
    const event = transferEvent(payoutId, 'tr_a');
    const res = await postWebhook(event);
    expect(res.status).toBe(200);

    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    // Still parked, still failed, nothing claimed or terminalized —
    // other transfers in the group may still hold money.
    expect(payout!.status).toBe('failed');
    expect(payout!.stripeTransferId).toBeNull();
    const meta = await reviewMeta(payoutId);
    expect(meta.transferState).toBe('duplicate_review');
    // The nonce is a FRESH value (never the event id — see the ABA test
    // below): any resolution that read the row before this delivery now
    // fails its fenced CAS and must re-verify.
    expect(typeof meta.duplicateReviewNonce).toBe('string');
    expect(meta.duplicateReviewNonce).not.toBe(event.id);
    expect(meta.reversedTransferIds).toEqual(['tr_a']);
  });

  it('a PARTIAL reversal (transfer.updated, reversed:false) is recorded too', async () => {
    // Partials arrive as transfer.updated with `reversed` still false. A
    // partially-reversed transfer can no longer be the kept one, so the
    // review must move for it just the same.
    const payoutId = await seedDuplicateReviewPayout();
    const event = transferEvent(payoutId, 'tr_b', {
      type: 'transfer.updated',
      reversed: false,
      amountReversed: 1000,
    });
    const res = await postWebhook(event);
    expect(res.status).toBe(200);

    const meta = await reviewMeta(payoutId);
    expect(meta.transferState).toBe('duplicate_review');
    expect(typeof meta.duplicateReviewNonce).toBe('string');
    expect(meta.reversedTransferIds).toEqual(['tr_b']);
  });

  it('records regardless of key generation, and accumulates ids without duplicates', async () => {
    // A duplicate group spans generations by construction — the fallback's
    // generation fence deliberately does not apply here.
    const payoutId = await seedDuplicateReviewPayout(1);
    const first = transferEvent(payoutId, 'tr_gen0', { generation: '0' });
    expect((await postWebhook(first)).status).toBe(200);
    // Redelivery of the same transfer id must not duplicate the entry.
    expect((await postWebhook(transferEvent(payoutId, 'tr_gen0', { generation: '0' }))).status).toBe(200);
    const second = transferEvent(payoutId, 'tr_gen1', { generation: '1' });
    expect((await postWebhook(second)).status).toBe(200);

    const meta = await reviewMeta(payoutId);
    expect(meta.reversedTransferIds).toEqual(['tr_gen0', 'tr_gen1']);
  });

  it('REDELIVERY of an old event can never restore an old nonce (ABA)', async () => {
    // Connect events return before the event-id dedupe, so Stripe CAN
    // redeliver an already-recorded event after a newer one. When the
    // nonce was the event id, that redelivery wrote the OLD id back — and
    // a resolution fenced on it then committed against a listing that
    // predates the newer reversal, recording a reversed transfer as kept
    // and paid (round 10). The nonce is a fresh ulid per write now, so no
    // observed value can ever come back.
    const payoutId = await seedDuplicateReviewPayout();
    const e1 = transferEvent(payoutId, 'tr_a');
    expect((await postWebhook(e1)).status).toBe(200);
    const nonceAfterE1 = (await reviewMeta(payoutId)).duplicateReviewNonce;
    expect(typeof nonceAfterE1).toBe('string');

    const e2 = transferEvent(payoutId, 'tr_b');
    expect((await postWebhook(e2)).status).toBe(200);
    const nonceAfterE2 = (await reviewMeta(payoutId)).duplicateReviewNonce;
    expect(nonceAfterE2).not.toBe(nonceAfterE1);

    // The EXACT same first event again — same event id, same payload.
    expect((await postWebhook(e1)).status).toBe(200);
    const nonceAfterReplay = (await reviewMeta(payoutId)).duplicateReviewNonce;
    // Whatever it is now, it is NOT the value a stale resolution observed.
    expect(nonceAfterReplay).not.toBe(nonceAfterE1);
    // And the id ledger did not grow a duplicate.
    expect((await reviewMeta(payoutId)).reversedTransferIds).toEqual(['tr_a', 'tr_b']);
  });

  it('finds the payout through transfer_group when metadata was cleared', async () => {
    // metadata is mutable at Stripe; transfer_group is not. A reversal on
    // a cleared-metadata transfer must still reach the review (round 9).
    const payoutId = await seedDuplicateReviewPayout();
    const event = transferEvent(payoutId, 'tr_cleared', { noMetadata: true });
    const res = await postWebhook(event);
    expect(res.status).toBe(200);

    const meta = await reviewMeta(payoutId);
    expect(typeof meta.duplicateReviewNonce).toBe('string');
    expect(meta.reversedTransferIds).toEqual(['tr_cleared']);
  });

  it('a FORGED payout-id stamp cannot redirect a reversal away from its group', async () => {
    // Round 10: identity resolution preferred the mutable metadata stamp
    // over the immutable transfer_group, so pointing
    // openpartner_payout_id at a bogus id sent the event to "unresolved
    // tenant", acknowledged 2xx and lost. transfer_group wins now.
    const payoutId = await seedDuplicateReviewPayout();
    const event = transferEvent(payoutId, 'tr_forged_stamp');
    (event.data.object.metadata as Record<string, string>).openpartner_payout_id =
      '01BOGUSBOGUSBOGUSBOGUSBOGU';
    const res = await postWebhook(event);
    expect(res.status).toBe(200);

    const meta = await reviewMeta(payoutId);
    expect(meta.reversedTransferIds).toEqual(['tr_forged_stamp']);
  });

  it('a PARTIAL reversal on the recorded transfer never rewrites status', async () => {
    // transfer.updated arrives with reversed:false and amount_reversed>0.
    // The exact-id write used to run `status: 'paid'` on it — flipping
    // even a FAILED payout back to paid on a $10 clawback (round 10).
    // Partials have no ledger representation on this rail yet, so the
    // rule is: never overwrite status on one.
    const partnerId = ulid();
    await db(TABLES.Partner).insert({
      id: partnerId,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Partial partner',
      email: `part-${partnerId}@example.com`,
      stripeConnectAccountId: `acct_${partnerId.slice(0, 10)}`,
    });
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      amount: '50.00',
      currency: 'USD',
      status: 'failed', // a reversal was already recorded
      method: 'stripe_connect',
      stripeTransferId: 'tr_partially_clawed',
      metadata: { transferState: 'confirmed', keyGeneration: 0 },
    });

    const event = transferEvent(payoutId, 'tr_partially_clawed', {
      type: 'transfer.updated',
      reversed: false,
      amountReversed: 1000,
    });
    const res = await postWebhook(event);
    expect(res.status).toBe(200);

    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    expect(payout!.status).toBe('failed'); // NOT flipped back to paid
  });

  it('transfer.created for a payout no longer expecting one raises the orphan alert', async () => {
    // The detector behind the prove-absence limit: an operator disposed a
    // held intent on an empty listing, and the unbounded in-flight POST
    // then landed. Stripe tells us via transfer.created — the ledger says
    // canceled, so this transfer is money moved outside it. No state is
    // written; the alert is the point.
    const partnerId = ulid();
    await db(TABLES.Partner).insert({
      id: partnerId,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Orphan partner',
      email: `orph-${partnerId}@example.com`,
      stripeConnectAccountId: `acct_${partnerId.slice(0, 10)}`,
    });
    const payoutId = ulid();
    await db(TABLES.Payout).insert({
      id: payoutId,
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      amount: '50.00',
      currency: 'USD',
      status: 'failed',
      method: 'stripe_connect',
      metadata: { transferState: 'canceled', lastError: 'operator_dispose:keith:oops' },
    });

    const event = {
      id: `evt_${ulid()}`,
      type: 'transfer.created',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'tr_late_landing',
          object: 'transfer',
          amount: 5000,
          amount_reversed: 0,
          currency: 'usd',
          reversed: false,
          transfer_group: payoutId,
          metadata: {},
        },
      },
    };
    const res = await postWebhook(event);
    expect(res.status).toBe(200);
    expect(res.body.connect).toBe('transfer_created_orphan');

    // Detector only — nothing was mutated.
    const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
    expect(payout!.status).toBe('failed');
    expect((payout!.metadata as { transferState?: string }).transferState).toBe('canceled');

    // An expected creation (posted intent, nothing stamped) stays quiet.
    const postedId = ulid();
    await db(TABLES.Payout).insert({
      id: postedId,
      tenantId: DEFAULT_TENANT_ID,
      partnerId,
      amount: '50.00',
      currency: 'USD',
      status: 'pending',
      method: 'stripe_connect',
      metadata: { transferState: 'posted', keyGeneration: 0 },
    });
    const benign = { ...event, id: `evt_${ulid()}` };
    benign.data = {
      object: { ...event.data.object, id: 'tr_expected', transfer_group: postedId },
    };
    const res2 = await postWebhook(benign);
    expect(res2.status).toBe(200);
    expect(res2.body.connect).toBe('transfer_created_observed');
  });

  it('a hosted funded transfer.created goes to the funding detector, not the payout lookup', async () => {
    // Its transfer_group is the funding batch id, which names no Payout:
    // the direct-rail detector above found nothing and acknowledged it
    // unread. The funding inbox takes it first now.
    const partnerId = ulid();
    const account = `acct_${partnerId.slice(0, 10)}`;
    await db(TABLES.Partner).insert({
      id: partnerId,
      tenantId: DEFAULT_TENANT_ID,
      name: 'Funded partner',
      email: `fund-${partnerId}@example.com`,
      stripeConnectAccountId: account,
    });
    const batchId = ulid();
    await db(TABLES.HostedFundingBatch).insert({
      id: batchId,
      tenantId: DEFAULT_TENANT_ID,
      currency: 'usd',
      principalMinor: 5000,
      grossChargeMinor: 5000,
      status: 'settled',
    });
    const intentId = ulid();
    await db(TABLES.HostedFundingTransfer).insert({
      id: intentId,
      tenantId: DEFAULT_TENANT_ID,
      batchId,
      partnerId,
      currency: 'usd',
      amountMinor: 5000,
      destinationAccountId: account,
      idempotencyKey: `fbt:${intentId}:g1`,
      state: 'confirmed',
      stripeTransferId: 'tr_rearmed_g1',
    });

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The generation 0 POST an operator abandoned, landing late.
      const res = await postWebhook({
        id: `evt_${ulid()}`,
        type: 'transfer.created',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: 'tr_abandoned_g0',
            object: 'transfer',
            amount: 5000,
            amount_reversed: 0,
            currency: 'usd',
            reversed: false,
            destination: account,
            transfer_group: batchId,
            metadata: {
              openpartner_transfer_intent_id: intentId,
              openpartner_funding_batch_id: batchId,
              openpartner_tenant_id: DEFAULT_TENANT_ID,
              openpartner_partner_id: partnerId,
              openpartner_key_generation: '0',
            },
          },
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.funding).toBe(`transfer_created_orphan:${intentId}`);
      expect(errors.mock.calls.some((c) => String(c[0]).includes('ALERT: transfer tr_abandoned_g0'))).toBe(true);
    } finally {
      errors.mockRestore();
    }
    const intent = await db(TABLES.HostedFundingTransfer).where({ id: intentId }).first();
    expect(intent.state).toBe('confirmed');
    expect(intent.stripeTransferId).toBe('tr_rearmed_g1');
  });
});

describe.skipIf(skipIntegration)('stripe webhook — one-time (mode=payment) Checkout revenue', () => {
  // A Stripe Payment Link (or any mode=payment Checkout) sends no invoice.paid
  // unless invoice creation is on, so the session's amount_total is the only
  // record of the money. Before this, a self-host recorded a value-less
  // signup for it and never the revenue, and a guest checkout (no Customer,
  // the Payment Link default) recorded nothing at all.

  const ADMIN = 'op_test_stripe_payment_mode_0123456789abcd';
  let previousAdminKey: string | undefined;
  beforeAll(() => {
    previousAdminKey = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN;
  });
  afterAll(() => {
    if (previousAdminKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = previousAdminKey;
  });

  function paymentSession(fields: Record<string, unknown> = {}) {
    return {
      id: `cs_${ulid()}`,
      object: 'checkout.session',
      mode: 'payment',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 12900,
      currency: 'eur',
      customer: null,
      payment_intent: `pi_${ulid()}`,
      invoice: null,
      ...fields,
    };
  }

  function checkoutEvent(session: Record<string, unknown>, type = 'checkout.session.completed') {
    return { id: `evt_${ulid()}`, type, created: Math.floor(Date.now() / 1000), data: { object: session } };
  }

  async function eventsOfType(type: string) {
    return db(TABLES.Event).where({ type }).orderBy('id');
  }

  async function commissionAmounts(eventId: string): Promise<string[]> {
    const attributionIds = await db(TABLES.Attribution).where({ eventId }).pluck('id');
    return db(TABLES.Commission).whereIn('attributionId', attributionIds).pluck('amount');
  }

  it('a guest Payment Link purchase stitches the click and records its signup and revenue', async () => {
    const { clickId, partnerId } = await seedClick();
    const session = paymentSession({ client_reference_id: clickId });

    const res = await postWebhook(checkoutEvent(session));

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    const userId = `click:${clickId}`;
    expect(await db(TABLES.Identity).where({ clickId, userId })).toHaveLength(1);

    const [signup] = await eventsOfType('signup');
    expect(signup).toMatchObject({ userId, value: null });
    const [revenue] = await eventsOfType('invoice_paid');
    expect(revenue).toMatchObject({
      userId,
      value: '129.00',
      currency: 'EUR',
      externalEventId: session.id,
      metadata: {
        stripeType: 'checkout.session.completed',
        stripeCheckoutSessionId: session.id,
        checkoutMode: 'payment',
        stripePaymentIntentId: session.payment_intent,
      },
    });
    const attribution = await db(TABLES.Attribution).where({ eventId: revenue!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
    // seedClick's program pays 20% of value.
    expect(await commissionAmounts(revenue!.id)).toEqual(['25.80']);
    // No Customer, so nothing to backfill.
    expect(stripeApi.customersUpdate).not.toHaveBeenCalled();
  });

  it('a purchase with a Customer records both under the cus_ id', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;

    await postWebhook(checkoutEvent(paymentSession({ client_reference_id: clickId, customer: customerId })));

    expect((await eventsOfType('signup')).map((e) => e.userId)).toEqual([customerId]);
    const [revenue] = await eventsOfType('invoice_paid');
    expect(revenue).toMatchObject({ userId: customerId, value: '129.00' });
    expect(await commissionAmounts(revenue!.id)).toEqual(['25.80']);
  });

  it('a redelivery records nothing new', async () => {
    const { clickId } = await seedClick();
    const payload = checkoutEvent(paymentSession({ client_reference_id: clickId }));

    await postWebhook(payload);
    const again = await postWebhook(payload);

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ idempotent: true });
    expect(await eventsOfType('signup')).toHaveLength(1);
    expect(await eventsOfType('invoice_paid')).toHaveLength(1);
    expect(await db(TABLES.Commission)).toHaveLength(1);
  });

  it('a subscription checkout takes no revenue from the session (invoice.paid carries it)', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;

    await postWebhook(
      checkoutEvent({
        ...completedCheckout(customerId, clickId),
        payment_status: 'paid',
        amount_total: 4900,
        currency: 'usd',
      }),
    );
    await postWebhook(invoicePaid(customerId));

    const revenue = await eventsOfType('invoice_paid');
    expect(revenue).toHaveLength(1);
    expect(revenue[0]!.metadata).toMatchObject({ stripeType: 'invoice.paid' });
  });

  it('a session with invoice creation on leaves the revenue to its invoice.paid', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;

    await postWebhook(
      checkoutEvent(paymentSession({ client_reference_id: clickId, customer: customerId, invoice: `in_${ulid()}` })),
    );

    expect(await eventsOfType('signup')).toHaveLength(1);
    expect(await eventsOfType('invoice_paid')).toHaveLength(0);
  });

  it('nothing charged (a 100% discount) records the signup only', async () => {
    const { clickId } = await seedClick();
    await postWebhook(
      checkoutEvent(
        paymentSession({ client_reference_id: clickId, amount_total: 0, payment_status: 'no_payment_required' }),
      ),
    );
    expect(await eventsOfType('signup')).toHaveLength(1);
    expect(await eventsOfType('invoice_paid')).toHaveLength(0);
  });

  it('a delayed payment method records the revenue when async_payment_succeeded arrives, once', async () => {
    const { clickId } = await seedClick();
    const session = paymentSession({ client_reference_id: clickId, payment_status: 'unpaid' });

    await postWebhook(checkoutEvent(session));
    expect(await eventsOfType('signup')).toHaveLength(1);
    expect(await eventsOfType('invoice_paid')).toHaveLength(0);

    const cleared = checkoutEvent({ ...session, payment_status: 'paid' }, 'checkout.session.async_payment_succeeded');
    const res = await postWebhook(cleared);
    expect(res.status).toBe(200);
    expect(await eventsOfType('signup')).toHaveLength(1);
    const [revenue] = await eventsOfType('invoice_paid');
    expect(revenue).toMatchObject({
      userId: `click:${clickId}`,
      value: '129.00',
      externalEventId: session.id,
      metadata: { stripeType: 'checkout.session.async_payment_succeeded' },
    });

    // Redelivered, or reported again under a different event id: still one.
    await postWebhook(cleared);
    await postWebhook({ ...cleared, id: `evt_${ulid()}` });
    expect(await eventsOfType('invoice_paid')).toHaveLength(1);
    expect(await db(TABLES.Commission)).toHaveLength(1);
  });

  it('a returning customer buying again without a partner link is credited, with no second signup', async () => {
    const { clickId, partnerId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    await postWebhook(checkoutEvent(paymentSession({ client_reference_id: clickId, customer: customerId })));

    const res = await postWebhook(
      checkoutEvent(paymentSession({ client_reference_id: null, customer: customerId, amount_total: 5000 })),
    );

    expect(res.status).toBe(200);
    expect(await eventsOfType('signup')).toHaveLength(1);
    const revenue = await eventsOfType('invoice_paid');
    expect(revenue.map((e) => e.value)).toEqual(['129.00', '50.00']);
    const attribution = await db(TABLES.Attribution).where({ eventId: revenue[1]!.id }).first();
    expect(attribution?.partnerId).toBe(partnerId);
  });

  it('a purchase no partner referred is acknowledged and records nothing', async () => {
    const res = await postWebhook(checkoutEvent(paymentSession({ client_reference_id: null, customer: `cus_${ulid()}` })));
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('checkout.session.completed');
    expect(await db(TABLES.Event)).toHaveLength(0);

    // A cref that names no click.
    const guest = await postWebhook(checkoutEvent(paymentSession({ client_reference_id: ulid() })));
    expect(guest.status).toBe(200);
    expect(await db(TABLES.Event)).toHaveLength(0);
    expect(await db(TABLES.Identity)).toHaveLength(0);
  });

  it('a full refund of a guest purchase reverses its commission', async () => {
    const { clickId } = await seedClick();
    const session = paymentSession({ client_reference_id: clickId });
    await postWebhook(checkoutEvent(session));
    const [revenue] = await eventsOfType('invoice_paid');
    const [commission] = await db(TABLES.Commission);
    expect(commission!.status).toBe('accrued');

    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_${ulid()}`,
          object: 'charge',
          customer: null,
          payment_intent: session.payment_intent,
          invoice: null,
          amount: 12900,
          amount_captured: 12900,
          amount_refunded: 12900,
          currency: 'eur',
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.corrective).toBe('refund');
    expect((await db(TABLES.Commission).where({ id: commission!.id }).first())!.status).toBe('reversed');
    const [refund] = await eventsOfType('refund');
    expect(refund).toMatchObject({ userId: `click:${clickId}`, value: '-129.00' });
    expect(refund!.metadata).toMatchObject({ reversedCommissions: 1, fullRefund: true });
    await vi.waitFor(() =>
      expect(dispatched('commission.reversed')).toContainEqual(
        expect.objectContaining({ commissionId: commission!.id, eventId: revenue!.id, reason: 'refund' }),
      ),
    );
  });

  it('a partial refund of a one-time purchase keeps the share the customer kept', async () => {
    const { clickId } = await seedClick();
    const customerId = `cus_${ulid()}`;
    const session = paymentSession({ client_reference_id: clickId, customer: customerId });
    await postWebhook(checkoutEvent(session));

    await postWebhook({
      id: `evt_${ulid()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_${ulid()}`,
          customer: { id: customerId, metadata: {}, object: 'customer' },
          payment_intent: session.payment_intent,
          amount: 12900,
          amount_captured: 12900,
          amount_refunded: 2900,
          currency: 'eur',
        },
      },
    });

    // 20% of 129.00 is 25.80; the customer kept 100 of 129.
    expect((await db(TABLES.Commission).orderBy('id')).map((c) => [c.status, c.amount])).toEqual([
      ['reversed', '25.80'],
      ['accrued', '20.00'],
    ]);
    const [refund] = await eventsOfType('refund');
    expect(refund!.metadata).toMatchObject({ fullRefund: false, reversedCommissions: 0, reducedCommissions: 1 });
  });

  it('a guest refund of a purchase no partner referred is skipped', async () => {
    const res = await postWebhook({
      id: `evt_${ulid()}`,
      type: 'charge.refunded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `ch_${ulid()}`,
          customer: null,
          payment_intent: `pi_${ulid()}`,
          amount: 500,
          amount_refunded: 500,
          currency: 'usd',
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe('charge.refunded');
    expect(await db(TABLES.Event)).toHaveLength(0);
  });

  it('counts as paid in the partner funnel and as billable GMV', async () => {
    const { clickId, partnerId } = await seedClick();
    await postWebhook(checkoutEvent(paymentSession({ client_reference_id: clickId })));

    const funnel = await request(app).get(`/partners/${partnerId}/funnel`).set('Authorization', `Bearer ${ADMIN}`);
    expect(funnel.status).toBe(200);
    expect(funnel.body.stages).toMatchObject({ signups: 1, paid: 1 });
    expect(funnel.body.revenue).toBe(129);

    const { aggregateAttributedGmv } = await import('../usage-billing.js');
    // The session is in EUR: it is EUR GMV, not 129 dollars.
    expect(await aggregateAttributedGmv(db, DEFAULT_TENANT_ID, null, new Date(Date.now() + 60_000))).toEqual({ EUR: 129 });
  });
});
