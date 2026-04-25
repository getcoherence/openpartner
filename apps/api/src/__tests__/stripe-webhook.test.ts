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
process.env.OPENPARTNER_MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';

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
const { TABLES } = await import('@openpartner/db');
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
  TABLES.Campaign,
  TABLES.Partner,
  TABLES.Config,
];

interface Ids {
  partnerId: string;
  campaignId: string;
  linkId: string;
  clickId: string;
}

async function seedClick(): Promise<Ids> {
  const partnerId = ulid();
  const campaignId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, name: 'Test partner', email: `p-${partnerId}@example.com` });
  await db(TABLES.Campaign).insert({
    id: campaignId,
    name: 'Default',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
  });
  await db(TABLES.Link).insert({
    id: linkId,
    partnerId,
    campaignId,
    linkKey: `lk-${linkId}`,
    destinationUrl: 'https://example.com',
  });
  await db(TABLES.Click).insert({
    id: clickId,
    linkId,
    partnerId,
    campaignId,
    landingUrl: 'https://example.com/landing',
    ipHash: 'h',
    ts: new Date(),
  });
  return { partnerId, campaignId, linkId, clickId };
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
