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

// Mock the Stripe constructor so customer ops are inert. We keep the real
// webhooks helper (used inside the route for signature verification) by
// wrapping a real Stripe instance and overriding only `customers`.
vi.mock('stripe', async () => {
  const actual = await vi.importActual<typeof import('stripe')>('stripe');
  const Real = actual.default;
  function MockedStripe(this: unknown, key: string, opts?: Stripe.StripeConfig) {
    const instance = new Real(key, opts) as Stripe;
    (instance as unknown as { customers: unknown }).customers = {
      update: vi.fn().mockResolvedValue({ id: 'cus_test_mocked' }),
      retrieve: vi.fn().mockResolvedValue({ id: 'cus_test_mocked', metadata: {}, deleted: false }),
    };
    return instance;
  }
  // Preserve the static `webhooks` namespace for any direct imports.
  (MockedStripe as unknown as { webhooks: unknown }).webhooks = (Real as unknown as { webhooks: unknown }).webhooks;
  return { default: MockedStripe };
});

// Imports must follow the env + mock setup so they pick up the right config.
const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');

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
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Program,
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
  await db.destroy();
});

beforeEach(async () => {
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

  it('checkout.session.completed without client_reference_id falls through to merchant-subscription path', async () => {
    // No seeded click — this simulates "the merchant subscribing to us"
    // (which billing.ts persists as a Config row, not as an Identity/Event).
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
    const events = await db(TABLES.Event);
    expect(events).toHaveLength(0);
    const identities = await db(TABLES.Identity);
    expect(identities).toHaveLength(0);
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
    expect((refundEvent!.metadata as { alreadyPaidCommissions?: number }).alreadyPaidCommissions)
      .toBe(stillPaid.length);
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

describe.skipIf(skipIntegration)('stripe webhook — partial refund stopgap', () => {
  it('a PARTIAL charge.refunded does not reverse commissions (records + flags instead)', async () => {
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
    const invoiceAttributions = await db(TABLES.Attribution).where({ eventId: invoicePaidEvent!.id });
    const accruedBefore = await db(TABLES.Commission)
      .whereIn('attributionId', invoiceAttributions.map((a) => a.id))
      .where({ status: 'accrued' });
    expect(accruedBefore.length).toBeGreaterThan(0);

    // $1 refund on a $100 charge — partial.
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
          amount_refunded: 100,
          currency: 'usd',
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.corrective).toBe('refund');

    // Commissions untouched — a partial refund must NOT reverse 100%.
    const after = await db(TABLES.Commission)
      .whereIn('attributionId', invoiceAttributions.map((a) => a.id));
    expect(after.every((c) => c.status === 'accrued')).toBe(true);

    const refundEvent = await db(TABLES.Event).where({ type: 'refund' }).first();
    const md = refundEvent!.metadata as { reversedCommissions?: number; partialRefundReversalSkipped?: boolean; fullRefund?: boolean };
    expect(md.reversedCommissions).toBe(0);
    expect(md.partialRefundReversalSkipped).toBe(true);
    expect(md.fullRefund).toBe(false);
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
});
