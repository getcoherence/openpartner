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
    // The nonce is the event id: any resolution that read the row before
    // this delivery now fails its fenced CAS and must re-verify.
    expect(meta.duplicateReviewNonce).toBe(event.id);
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
    expect(meta.duplicateReviewNonce).toBe(event.id);
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
    expect(meta.duplicateReviewNonce).toBe(second.id);
  });

  it('finds the payout through transfer_group when metadata was cleared', async () => {
    // metadata is mutable at Stripe; transfer_group is not. A reversal on
    // a cleared-metadata transfer must still reach the review (round 9).
    const payoutId = await seedDuplicateReviewPayout();
    const event = transferEvent(payoutId, 'tr_cleared', { noMetadata: true });
    const res = await postWebhook(event);
    expect(res.status).toBe(200);

    const meta = await reviewMeta(payoutId);
    expect(meta.duplicateReviewNonce).toBe(event.id);
    expect(meta.reversedTransferIds).toEqual(['tr_cleared']);
  });
});
