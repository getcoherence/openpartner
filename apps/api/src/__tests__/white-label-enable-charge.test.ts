/**
 * Hosted white-label enable charges the prorated period immediately.
 *
 * It used to attach the add-on with create_prorations, which parks the
 * partial-month charge on the next renewal invoice: a brand enabling on the
 * 2nd paid for that month on the 1st of the next, together with the next
 * month in advance, and never paid it at all if the subscription ended
 * first. Now the item is added with always_invoice + error_if_incomplete,
 * so a declined card is a 402 that attaches nothing and leaves the flag off.
 *
 * Skipped if DATABASE_URL isn't set.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_wl_enable_charge_admin_0123456789';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
process.env.STRIPE_WHITELABEL_ADD_ON_PRICE_ID = 'price_wl_charge_test';

const SUB_ID = 'sub_wl_charge_test';
const PRICE = 'price_wl_charge_test';

const h = vi.hoisted(() => ({
  items: [] as Array<{ id: string; price: { id: string } }>,
  creates: [] as Array<Record<string, unknown>>,
  failWith: null as { statusCode: number; message: string } | null,
}));

vi.mock('../stripe.js', async () => {
  const actual = await vi.importActual<typeof import('../stripe.js')>('../stripe.js');
  return {
    ...actual,
    requireStripe: () => ({
      subscriptions: {
        retrieve: async (id: string) => ({ id, items: { data: h.items } }),
      },
      subscriptionItems: {
        create: async (args: Record<string, unknown>) => {
          h.creates.push(args);
          if (h.failWith) {
            throw Object.assign(new Error(h.failWith.message), { statusCode: h.failWith.statusCode });
          }
          return { id: 'si_wl_charge_test' };
        },
      },
    }),
  };
});

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });
const auth = { Authorization: `Bearer ${ADMIN_KEY}` };

async function whiteLabelFlag(): Promise<boolean> {
  const row = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first<{ whiteLabel: boolean }>('whiteLabel');
  return !!row?.whiteLabel;
}

beforeEach(async () => {
  h.items = [];
  h.creates = [];
  h.failWith = null;
  if (skipIntegration) return;
  await db(TABLES.Tenant)
    .where({ id: DEFAULT_TENANT_ID })
    .update({ billingPlan: 'revshare', stripeSubscriptionId: SUB_ID, whiteLabel: false });
});

afterAll(async () => {
  if (!skipIntegration) {
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ billingPlan: null, stripeSubscriptionId: null, whiteLabel: false });
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('hosted white-label enable', () => {
  it('charges the rest of the period now instead of parking it on the next renewal', async () => {
    const res = await request(app).post('/billing/white-label').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, provisioned: true, billedVia: 'subscription_item_added' });

    expect(h.creates).toEqual([
      {
        subscription: SUB_ID,
        price: PRICE,
        quantity: 1,
        proration_behavior: 'always_invoice',
        payment_behavior: 'error_if_incomplete',
      },
    ]);
    expect(await whiteLabelFlag()).toBe(true);
  });

  it('a declined charge is a 402 and leaves white-label off', async () => {
    h.failWith = { statusCode: 402, message: 'Your card was declined.' };

    const res = await request(app).post('/billing/white-label').set(auth);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('payment_failed');
    expect(res.body.detail).toContain('Your card was declined.');
    expect(await whiteLabelFlag()).toBe(false);
  });

  it('any other Stripe failure still surfaces as an error, not a payment message', async () => {
    h.failWith = { statusCode: 400, message: 'No such price' };

    const res = await request(app).post('/billing/white-label').set(auth);
    expect(res.status).toBe(500);
    expect(res.body.error).not.toBe('payment_failed');
    expect(await whiteLabelFlag()).toBe(false);
  });

  it('does not charge again when the add-on is already on the subscription', async () => {
    h.items = [{ id: 'si_existing', price: { id: PRICE } }];

    const res = await request(app).post('/billing/white-label').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.billedVia).toBe('already_on_subscription');
    expect(h.creates).toEqual([]);
    expect(await whiteLabelFlag()).toBe(true);
  });
});
