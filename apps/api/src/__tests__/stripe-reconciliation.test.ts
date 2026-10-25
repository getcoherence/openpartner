/**
 * Stripe reconciliation (stripe-reconciliation.ts): the brand's Stripe
 * payments next to what OpenPartner recorded and credited.
 *
 *   - each paid invoice and one-time Checkout payment in the window is
 *     credited, recorded, missed (not recorded despite a partner signal
 *     that would have credited), notCreditable (a signal that wouldn't
 *     have: outside the window, a deactivated code, only excluded clicks)
 *     or unreferred, with totals per currency (zero-decimal ones too)
 *   - a renewal carried by an earlier credited conversion is missed even
 *     with the click past its window, unless the program lets renewals go
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
      expand: ['data.customer', 'data.discounts', 'data.total_discount_amounts.discount'],
    });
    expect(calls.find((c) => c.what === 'sessions')!.params).toMatchObject({
      status: 'complete',
      expand: ['data.customer', 'data.total_details.breakdown'],
    });
    expect(r.counts).toEqual({ payments: 11, credited: 2, recorded: 1, missed: 4, notCreditable: 0, unreferred: 4 });
    expect(r.notCreditableReasons).toEqual({ outside_window: 0, inactive_code: 0, excluded: 0 });
    // The default currency (USD) first, then by code.
    expect(r.totals).toEqual([
      { currency: 'USD', stripe: 232, recorded: 69, credited: 49, missed: 55, notCreditable: 0, unreferred: 108 },
      { currency: 'EUR', stripe: 47, recorded: 25, credited: 25, missed: 15, notCreditable: 0, unreferred: 7 },
      { currency: 'JPY', stripe: 5000, recorded: 0, credited: 0, missed: 0, notCreditable: 0, unreferred: 5000 },
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

  it("ignores refunds, matches what the brand forwarded, and needs the partner click before the payment", async () => {
    await seedProgram();
    // A refund names the invoice but records no revenue.
    const refund = ulid();
    await db(TABLES.Event).insert({
      id: refund,
      tenantId: T,
      userId: 'u_refund',
      type: 'refund',
      value: '-30.00',
      currency: 'USD',
      ts: new Date(NOW.getTime() - DAY),
      metadata: { stripeInvoiceId: 'in_refunded' },
    });
    // The brand reported this one itself, keyed on the invoice id.
    await db(TABLES.Event).insert({
      id: ulid(),
      tenantId: T,
      userId: 'u_fwd',
      type: 'invoice_paid',
      value: '12.00',
      currency: 'USD',
      externalEventId: 'in_forwarded',
      ts: new Date(NOW.getTime() - DAY),
    });
    // Linked to a click made after this payment: the partner didn't bring it.
    const lateClick = ulid();
    const link = await db(TABLES.Link).where({ tenantId: T }).first('id', 'partnerId', 'programId');
    await db(TABLES.Click).insert({
      id: lateClick,
      tenantId: T,
      linkId: link.id,
      partnerId: link.partnerId,
      programId: link.programId,
      landingUrl: 'https://brand.example/',
      ts: new Date(NOW.getTime() - DAY),
    });
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: T, clickId: lateClick, userId: 'cus_in_paid_first' });

    const { client } = fakeStripe(
      [invoice('in_refunded', 4, 3000), invoice('in_forwarded', 4, 1200), invoice('in_paid_first', 5, 900)],
      [],
    );
    const r = await reconcileStripe(db, T, client, { days: 30, livemode: true, now: NOW });
    expect(r.counts).toEqual({ payments: 3, credited: 0, recorded: 1, missed: 0, notCreditable: 0, unreferred: 2 });
    expect(r.missed).toEqual([]);
  });

  it("gives an invoiced Checkout's click to its invoice, and finds partner coupons on line items", async () => {
    const seeded = await seedProgram();
    await db(TABLES.Coupon).where({ tenantId: T }).update({ stripeCouponId: 'coupon_partner' });
    const { client } = fakeStripe(
      [
        invoice('in_from_checkout', 3, 4000),
        // A line-item discount, its coupon named directly and (API 2025-03-31+) under source.
        invoice('in_line_item', 3, 2500, {
          discounts: [],
          total_discount_amounts: [{ amount: 500, discount: { id: 'di_li', promotion_code: null, coupon: { id: 'coupon_partner' } } }],
        }),
        invoice('in_line_item_source', 3, 2600, {
          total_discount_amounts: [{ amount: 500, discount: { id: 'di_src', source: { coupon: 'coupon_partner' } } }],
        }),
      ],
      // The Checkout that made in_from_checkout: counted once, as the invoice.
      [session('cs_made_invoice', 3, 4000, { invoice: 'in_from_checkout', client_reference_id: seeded.clickId })],
    );
    const r = await reconcileStripe(db, T, client, { days: 30, livemode: true, now: NOW });
    expect(r.counts).toEqual({ payments: 3, credited: 0, recorded: 0, missed: 3, notCreditable: 0, unreferred: 0 });
    expect(Object.fromEntries(r.missed.map((m) => [m.id, m.signals]))).toEqual({
      in_from_checkout: ['partner_click'],
      in_line_item: ['partner_code'],
      in_line_item_source: ['partner_code'],
    });
    expect(r.totals).toEqual([{ currency: 'USD', stripe: 91, recorded: 0, credited: 0, missed: 91, notCreditable: 0, unreferred: 0 }]);
  });

  it("splits a partner signal that wouldn't have credited anyone from a miss, and says why", async () => {
    const seeded = await seedProgram();
    // A second program with a 7-day window, for clicks past it.
    const shortProgram = ulid();
    await db(TABLES.Program).insert({
      id: shortProgram,
      tenantId: T,
      name: 'Short window',
      attributionModel: 'last_click',
      attributionWindowDays: 7,
      commissionRule: { type: 'percent', value: 20 },
      destinationUrl: 'https://brand.example/',
    });
    const noRenewals = ulid();
    await db(TABLES.Program).insert({
      id: noRenewals,
      tenantId: T,
      name: 'Renewals go',
      attributionModel: 'last_click',
      attributionWindowDays: 7,
      renewalsStayWithPartner: false,
      commissionRule: { type: 'percent', value: 20 },
      destinationUrl: 'https://brand.example/',
    });
    const click = async (userId: string, programId: string, daysAgo: number, fields: Record<string, unknown> = {}) => {
      const id = ulid();
      await db(TABLES.Click).insert({
        id,
        tenantId: T,
        linkId: null,
        partnerId: seeded.partnerId,
        programId,
        landingUrl: 'https://brand.example/',
        ts: new Date(NOW.getTime() - daysAgo * DAY),
        ...fields,
      });
      await db(TABLES.Identity).insert({ id: ulid(), tenantId: T, clickId: id, userId });
      return id;
    };
    // A click 20 days before a payment, in a program with a 7-day window.
    await click('cus_in_old', shortProgram, 23);
    // A flagged click inside the window.
    await click('cus_in_flagged', seeded.programId, 5, { fraudFlag: 'manual' });
    // An old click, but the customer's first payment was credited to it:
    // a renewal keeps that partner, unless the program lets renewals go.
    for (const [userId, programId] of [['cus_in_renewal', shortProgram], ['cus_in_renewal_off', noRenewals]] as const) {
      const old = await click(userId, programId, 40);
      const first = ulid();
      await db(TABLES.Event).insert({ id: first, tenantId: T, userId, type: 'invoice_paid', value: '30.00', currency: 'USD', ts: new Date(NOW.getTime() - 38 * DAY) });
      await db(TABLES.Attribution).insert({ id: ulid(), tenantId: T, eventId: first, partnerId: seeded.partnerId, programId, clickId: old, model: 'last_click', weight: '1.0000' });
    }
    // Codes: a revoked partner's, one deactivated before the payment, one after.
    const revoked = ulid();
    await db(TABLES.Partner).insert({ id: revoked, tenantId: T, name: 'Gone', email: `g-${revoked}@example.com`, revokedAt: new Date(NOW.getTime() - 30 * DAY) });
    await db(TABLES.Coupon).insert([
      { id: `cpn_${ulid()}`, tenantId: T, partnerId: revoked, programId: seeded.programId, code: 'GONE10', stripePromotionCodeId: 'promo_revoked' },
      { id: `cpn_${ulid()}`, tenantId: T, partnerId: seeded.partnerId, programId: seeded.programId, code: 'OLD10', stripePromotionCodeId: 'promo_old', deactivatedAt: new Date(NOW.getTime() - 10 * DAY) },
      { id: `cpn_${ulid()}`, tenantId: T, partnerId: seeded.partnerId, programId: seeded.programId, code: 'LATE10', stripePromotionCodeId: 'promo_late', deactivatedAt: new Date(NOW.getTime() - DAY) },
    ]);
    const promo = (id: string) => ({ discounts: [{ id: `di_${id}`, promotion_code: id }] });
    // The partner's own code, used by a customer who clicked that partner
    // 40 days ago: the redemption reuses the old click, so it's past the window.
    await click('cus_in_code_reuses_old', shortProgram, 40);
    // An invoice created before the click and paid after it.
    await click('cus_in_paid_later', seeded.programId, 5);
    // A click linked to the cus_ id, but the pipeline keys this customer on
    // the brand's own id, which has none.
    await click('cus_meta', seeded.programId, 5);

    const { client } = fakeStripe(
      [
        invoice('in_old', 3, 1000),
        invoice('in_flagged', 3, 1100),
        invoice('in_renewal', 3, 1200),
        invoice('in_renewal_off', 3, 1300),
        invoice('in_revoked_code', 3, 1400, promo('promo_revoked')),
        invoice('in_old_code', 3, 1500, promo('promo_old')),
        invoice('in_late_code', 3, 1600, promo('promo_late')),
        invoice('in_code_reuses_old', 3, 1700, promo('promo_partner')),
        invoice('in_paid_later', 10, 1800, { status_transitions: { paid_at: sec(3) } }),
        invoice('in_metadata_user', 3, 1900, { customer: { id: 'cus_meta', metadata: { openpartner_user_id: 'user_meta' } } }),
      ],
      [],
    );
    const r = await reconcileStripe(db, T, client, { days: 30, livemode: true, now: NOW });
    expect(r.counts).toEqual({ payments: 10, credited: 0, recorded: 0, missed: 3, notCreditable: 6, unreferred: 1 });
    expect(r.notCreditableReasons).toEqual({ outside_window: 3, inactive_code: 1, excluded: 2 });
    expect(r.missed.map((m) => m.id).sort()).toEqual(['in_late_code', 'in_paid_later', 'in_renewal']);
    expect(r.totals).toEqual([{ currency: 'USD', stripe: 145, recorded: 0, credited: 0, missed: 46, notCreditable: 80, unreferred: 19 }]);
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
