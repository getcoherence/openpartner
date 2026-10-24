/**
 * Stripe reconciliation (stripe-reconciliation.ts): the brand's Stripe
 * payments next to what OpenPartner recorded and credited.
 *
 *   - each paid invoice and one-time Checkout payment in the window is
 *     credited, recorded, missed (not recorded despite a partner signal) or
 *     unreferred, with totals per currency (zero-decimal ones too)
 *   - the signals: a customer linked to a click (by cus_ id or the brand's
 *     openpartner_user_id), the program's click in client_reference_id, a
 *     partner's promotion code
 *   - the same payments the pipeline records: subscription-mode sessions,
 *     sessions that made an invoice and zero amounts are left out
 *   - GET /admin/tracking-health/stripe: admin-only, a bounded window, and
 *     `available: false` with the reason when there's no Stripe to read
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import type Stripe from 'stripe';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

const ADMIN_KEY = 'op_test_stripe_reconciliation_0123456789ab';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { reconcileStripe } = await import('../stripe-reconciliation.js');
const { __clearReconcileCache } = await import('../routes/tracking-health.js');
const { encryptSecret } = await import('../crypto.js');

const T = DEFAULT_TENANT_ID;
const NOW = new Date();
const DAY = 86_400_000;
const sec = (daysAgo: number) => Math.floor((NOW.getTime() - daysAgo * DAY) / 1000);

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Coupon,
  TABLES.Program,
  TABLES.Partner,
  TABLES.TenantStripeConnection,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

type Obj = Record<string, unknown> & { id: string; created: number };

/** invoices.list and checkout.sessions.list over fixed lists, honouring
 *  created.gte, status, limit and starting_after, newest first. */
function fakeStripe(invoices: Obj[], sessions: Obj[]) {
  const calls: Array<{ what: string; params: Record<string, unknown> }> = [];
  const lister = (what: string, all: Obj[]) => async (params: Record<string, unknown>) => {
    calls.push({ what, params });
    const gte = (params.created as { gte: number }).gte;
    const rows = all
      .filter((o) => o.created >= gte && (params.status == null || o.status === params.status))
      .sort((a, b) => b.created - a.created);
    const start = params.starting_after ? rows.findIndex((o) => o.id === params.starting_after) + 1 : 0;
    const limit = params.limit as number;
    return { object: 'list', data: rows.slice(start, start + limit), has_more: start + limit < rows.length };
  };
  const client = {
    invoices: { list: lister('invoices', invoices) },
    checkout: { sessions: { list: lister('sessions', sessions) } },
  } as unknown as Stripe;
  return { client, calls };
}

const invoice = (id: string, daysAgo: number, amount: number, fields: Record<string, unknown> = {}): Obj => ({
  id,
  object: 'invoice',
  status: 'paid',
  created: sec(daysAgo),
  amount_paid: amount,
  currency: 'usd',
  customer: `cus_${id}`,
  discounts: [],
  ...fields,
});

const session = (id: string, daysAgo: number, amount: number, fields: Record<string, unknown> = {}): Obj => ({
  id,
  object: 'checkout.session',
  status: 'complete',
  mode: 'payment',
  payment_status: 'paid',
  invoice: null,
  created: sec(daysAgo),
  amount_total: amount,
  currency: 'eur',
  customer: null,
  client_reference_id: null,
  payment_intent: `pi_${id}`,
  discounts: [],
  ...fields,
});

async function seedProgram(): Promise<{ partnerId: string; programId: string; clickId: string }> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: T, name: 'P', email: `p-${partnerId}@example.com` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: T,
    name: 'Program',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    destinationUrl: 'https://brand.example/',
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId: T, partnerId, programId, linkKey: `lk-${linkId}` });
  await db(TABLES.Click).insert({ id: clickId, tenantId: T, linkId, partnerId, programId, landingUrl: 'https://brand.example/', ts: new Date(NOW.getTime() - 9 * DAY) });
  await db(TABLES.Coupon).insert({
    id: `cpn_${ulid()}`,
    tenantId: T,
    partnerId,
    programId,
    code: 'PARTNER10',
    stripePromotionCodeId: 'promo_partner',
  });
  return { partnerId, programId, clickId };
}

async function recordEvent(
  metadata: Record<string, unknown>,
  value: string,
  currency: string,
  credit?: { partnerId: string; programId: string; clickId: string },
) {
  const id = ulid();
  await db(TABLES.Event).insert({ id, tenantId: T, userId: `u_${id}`, type: 'invoice_paid', value, currency, ts: new Date(NOW.getTime() - 2 * DAY), metadata });
  if (credit) {
    await db(TABLES.Attribution).insert({ id: ulid(), tenantId: T, eventId: id, partnerId: credit.partnerId, programId: credit.programId, clickId: credit.clickId, model: 'last_click', weight: '1.0000' });
  }
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
  process.env.OPENPARTNER_MODE = 'selfhost';
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  process.env.OPENPARTNER_MODE = 'selfhost';
  __clearReconcileCache();
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
});

describe.skipIf(skipIntegration)('reconcileStripe', () => {
  it('classifies every payment and totals it per currency', async () => {
    const seeded = await seedProgram();
    // Recorded and credited; recorded and not credited.
    await recordEvent({ stripeInvoiceId: 'in_credited', stripeEventId: 'evt_1' }, '49.00', 'USD', seeded);
    await recordEvent({ stripeInvoiceId: 'in_recorded', stripeEventId: 'evt_2' }, '20.00', 'USD');
    // Customers linked to the program's click: by cus_ id, and by the brand's own user id.
    await db(TABLES.Identity).insert([
      { id: ulid(), tenantId: T, clickId: seeded.clickId, userId: 'cus_in_linked' },
      { id: ulid(), tenantId: T, clickId: seeded.clickId, userId: 'user_m' },
    ]);

    const { client, calls } = fakeStripe(
      [
        invoice('in_credited', 3, 4900),
        invoice('in_recorded', 4, 2000),
        invoice('in_linked', 5, 3000),
        invoice('in_merchant', 6, 1500, { customer: { id: 'cus_m', metadata: { openpartner_user_id: 'user_m' } } }),
        invoice('in_code', 7, 1000, { discounts: [{ id: 'di_1', promotion_code: 'promo_partner' }] }),
        invoice('in_brand_promo', 7, 800, { discounts: [{ id: 'di_2', promotion_code: 'promo_brand_own' }] }),
        invoice('in_organic', 8, 10000),
        invoice('in_jpy', 8, 5000, { currency: 'jpy' }),
        invoice('in_zero', 8, 0),
        invoice('in_old', 45, 9900),
      ],
      [
        session('cs_click', 2, 1500, { client_reference_id: seeded.clickId }),
        session('cs_order_ref', 2, 700, { client_reference_id: 'order-991' }),
        session('cs_recorded', 2, 2500),
        session('cs_sub', 2, 1500, { mode: 'subscription' }),
        session('cs_invoiced', 2, 1500, { invoice: 'in_from_cs' }),
        session('cs_unpaid', 2, 1500, { payment_status: 'unpaid' }),
      ],
    );
    await recordEvent({ stripeCheckoutSessionId: 'cs_recorded', stripeEventId: 'evt_3' }, '25.00', 'EUR', seeded);

    const r = await reconcileStripe(db, T, client, { days: 30, livemode: false, now: NOW });
    expect(calls.find((c) => c.what === 'invoices')!.params).toMatchObject({
      status: 'paid',
      created: { gte: Math.floor((NOW.getTime() - 30 * DAY) / 1000) },
      expand: ['data.customer', 'data.discounts'],
    });
    expect(r.counts).toEqual({ payments: 11, credited: 2, recorded: 1, missed: 4, unreferred: 4 });
    // The default currency (USD) first, then by code.
    expect(r.totals).toEqual([
      { currency: 'USD', stripe: 232, recorded: 69, credited: 49, missed: 55, unreferred: 108 },
      { currency: 'EUR', stripe: 47, recorded: 25, credited: 25, missed: 15, unreferred: 7 },
      { currency: 'JPY', stripe: 5000, recorded: 0, credited: 0, missed: 0, unreferred: 5000 },
    ]);
    expect(r.missed.map((m) => [m.id, m.signals])).toEqual([
      ['cs_click', ['partner_click']],
      ['in_linked', ['linked_customer']],
      ['in_merchant', ['linked_customer']],
      ['in_code', ['partner_code']],
    ]);
    expect(r.missed[0]!.dashboardUrl).toBe('https://dashboard.stripe.com/test/payments/pi_cs_click');
    expect(r.missed[1]!.dashboardUrl).toBe('https://dashboard.stripe.com/test/invoices/in_linked');
    expect(r).toMatchObject({ available: true, livemode: false, truncated: false, window: { days: 30 } });
  });

  it('pages through Stripe, and clamps the window to 90 days', async () => {
    await seedProgram();
    const many = Array.from({ length: 230 }, (_, i) => invoice(`in_${i}`, 1 + (i % 20), 100));
    const { client, calls } = fakeStripe(many, []);
    const r = await reconcileStripe(db, T, client, { days: 365, livemode: true, now: NOW });
    expect(calls.filter((c) => c.what === 'invoices')).toHaveLength(3);
    expect(r.counts.payments).toBe(230);
    expect(r.window.days).toBe(90);
  });
});

describe.skipIf(skipIntegration)('GET /admin/tracking-health/stripe', () => {
  const admin = { Authorization: `Bearer ${ADMIN_KEY}` };

  it('is admin-only and bounds the window', async () => {
    expect((await request(app).get('/admin/tracking-health/stripe')).status).toBe(401);
    expect((await request(app).get('/admin/tracking-health/stripe?days=200').set(admin)).status).toBe(400);
  });

  it('says why when there is no Stripe of the brand to read', async () => {
    process.env.OPENPARTNER_MODE = 'flat';
    const none = await request(app).get('/admin/tracking-health/stripe').set(admin);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ available: false, reason: 'not_connected' });

    // An install that didn't grant the reads.
    await db(TABLES.TenantStripeConnection).insert({
      id: `tsc_${ulid()}`,
      tenantId: T,
      stripeAccountId: `acct_${ulid()}`,
      livemode: true,
      keyMode: 'live',
      refreshTokenEnc: encryptSecret('rt'),
      accessTokenEnc: encryptSecret('at'),
      accessTokenExpiresAt: new Date(NOW.getTime() + DAY),
      permissionsVersion: 1,
      permissionsGranted: JSON.stringify(['event_read', 'charge_read']),
    });
    const perms = await request(app).get('/admin/tracking-health/stripe?refresh=1').set(admin);
    expect(perms.body).toEqual({ available: false, reason: 'missing_permissions' });

    // Waiting for a reconnect.
    await db(TABLES.TenantStripeConnection).where({ tenantId: T }).update({ refreshFailedAt: new Date() });
    const reconnect = await request(app).get('/admin/tracking-health/stripe?refresh=1').set(admin);
    expect(reconnect.body).toEqual({ available: false, reason: 'reconnect_needed' });
  });
});
