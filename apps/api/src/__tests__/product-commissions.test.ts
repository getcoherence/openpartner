/**
 * Product-specific commissions (docs/product-commissions.md): what a sale
 * was for (Event metadata.products), the share of it a product-limited rule
 * pays on, the rule and event validation, the editor's product suggestions,
 * and the Network-snapshot guard that keeps a product list from being
 * stripped. Stripe's line items through the real webhook are in
 * stripe-webhook.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import {
  DEFAULT_TENANT_ID,
  TABLES,
  eventProducts,
  matchingProducts,
  productShare,
  renderCommissionSummary,
  type EventRow,
} from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { attributeEvent } from '../attribution.js';
import {
  checkoutLine,
  invoiceLine,
  metadataWithProducts,
  productFields,
  subscriptionLine,
} from '../product-commissions.js';

const ADMIN_KEY = 'op_test_product_commissions_0123456789ab';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.PartnerCommission,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) for (const t of TABLES_TO_CLEAN) await db(t).del();
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

const PRO = { id: 'prod_pro', price: 'price_pro_m', amount: 80 };
const SEAT = { id: 'prod_seat', price: 'price_seat', amount: 20 };

describe('the share a product-limited rule pays on', () => {
  it('is the whole value when every item matches', () => {
    expect(productShare(90, [PRO], [PRO])).toBe(90);
    expect(productShare(90, [PRO, SEAT], [PRO, SEAT])).toBe(90);
  });

  it("splits the value in proportion to the items' amounts", () => {
    expect(productShare(90, [PRO, SEAT], [PRO])).toBe(72);
    expect(productShare(100, [PRO, { id: 'b', amount: 70 }, { id: 'c', amount: 50 }], [PRO])).toBe(40);
    // Rounded to the cent: 10 × 1/3.
    expect(productShare(10, [{ id: 'a', amount: 1 }, { id: 'b', amount: 2 }], [{ id: 'a', amount: 1 }])).toBe(3.33);
  });

  it('is zero for a credit, a missing amount, nothing to split, or no value', () => {
    const credit = { id: 'prod_pro', amount: -30 };
    expect(productShare(50, [credit, { id: 'prod_team', amount: 80 }], [credit])).toBe(0);
    expect(productShare(90, [{ id: 'prod_pro' }, SEAT], [{ id: 'prod_pro' }])).toBe(0);
    expect(productShare(90, [{ id: 'a', amount: 0 }, { id: 'b', amount: 0 }], [{ id: 'a', amount: 0 }])).toBe(0);
    expect(productShare(0, [PRO], [PRO])).toBe(0);
  });

  it('matches on product or price id, and reads stored lists tolerantly', () => {
    const items = eventProducts({ products: [PRO, SEAT, 'junk', { amount: 5 }] })!;
    expect(items).toHaveLength(4);
    expect(items[2]).toEqual({});
    expect(matchingProducts([{ id: 'price_seat' }], items)).toEqual([SEAT]);
    expect(matchingProducts([{ id: 'prod_none' }], items)).toEqual([]);
    expect(eventProducts({ products: [] })).toBeNull();
    expect(eventProducts({ products: 'prod_pro' })).toBeNull();
    // An unreadable entry has no amount, so the sale can't be split.
    expect(productShare(95, items, matchingProducts([{ id: 'prod_pro' }], items))).toBe(0);
  });

  it('shows in the commission summary', () => {
    expect(
      renderCommissionSummary([
        { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 30, products: [{ id: 'prod_pro', name: 'Pro' }] },
      ]),
    ).toBe('30% on every invoice (Pro only)');
    expect(
      renderCommissionSummary([
        {
          trigger: 'every',
          eventType: 'invoice_paid',
          type: 'percent',
          value: 20,
          recurring: true,
          recurringMonths: 12,
          products: [{ id: 'a', name: 'Pro' }, { id: 'b', name: 'Team' }, { id: 'c' }, { id: 'd' }],
        },
      ]),
    ).toBe('20% recurring on every invoice (Pro, Team and 2 more only) for 12 months');
    // Present but unreadable pays on nothing (the engine fails closed), and says so.
    expect(renderCommissionSummary([{ trigger: 'every', type: 'percent', value: 30, products: [] }])).toBe('30% (no products)');
  });
});

describe('Stripe line items → products', () => {
  it('reads both invoice line shapes, net of line discounts, naming the product', () => {
    expect(
      invoiceLine({
        amount: 8000,
        discount_amounts: [{ amount: 1000 }],
        description: '1 × Pro (at $80.00 / month)',
        quantity: 1,
        pricing: { price_details: { price: 'price_pro_m', product: 'prod_pro' } },
      }),
    ).toEqual({ id: 'prod_pro', price: 'price_pro_m', name: 'Pro', minor: 7000, quantity: 1 });
    expect(
      invoiceLine({
        amount: -2500,
        description: 'Unused time on Pro after 9 Nov 2026',
        proration: true,
        price: { id: 'price_pro_m', product: 'prod_pro' },
      }),
    ).toEqual({ id: 'prod_pro', price: 'price_pro_m', name: undefined, minor: -2500, quantity: undefined });
    expect(invoiceLine({ amount: 500, description: 'Setup fee' })).toMatchObject({ name: 'Setup fee', minor: 500 });
  });

  // Review finding: a tax-inclusive price's tax stayed in the line's amount,
  // so a taxed product took more than its share.
  it('takes a tax-inclusive price\'s tax out of the line, in both API shapes', () => {
    expect(
      invoiceLine({
        amount: 12000,
        taxes: [
          { amount: 2000, tax_behavior: 'inclusive' },
          { amount: 900, tax_behavior: 'exclusive' },
        ],
        pricing: { price_details: { price: 'price_pro', product: 'prod_pro' } },
      }).minor,
    ).toBe(10000);
    expect(
      invoiceLine({
        amount: 12000,
        amount_excluding_tax: 10000,
        tax_amounts: [{ amount: 2000, inclusive: true }, { amount: 500, inclusive: false }],
        price: { id: 'price_pro', product: 'prod_pro' },
      }).minor,
    ).toBe(10000);
    expect(
      checkoutLine({
        amount_subtotal: 12000,
        amount_discount: 0,
        taxes: [{ amount: 2000, rate: { inclusive: true } }],
        price: { id: 'price_pro', product: 'prod_pro' },
      }).minor,
    ).toBe(10000);
    // Codex's case: Pro $120 with $20 inclusive tax, another product $100;
    // $220 paid. Pro's share is half, so 30% pays $33, not $36.
    const { products } = productFields(
      [
        invoiceLine({ amount: 12000, tax_amounts: [{ amount: 2000, inclusive: true }], price: { id: 'p1', product: 'prod_pro' } }),
        invoiceLine({ amount: 10000, price: { id: 'p2', product: 'prod_other' } }),
      ],
      'usd',
    );
    expect(productShare(220, products!, matchingProducts([{ id: 'prod_pro' }], products!))).toBe(110);
  });

  // Review finding: a credit grant paying for a line still left the line
  // its full amount, so the product took a share of money paid for others.
  it('takes billing credits out of a line, and discounts only once', () => {
    expect(
      invoiceLine({
        amount: 10000,
        discount_amounts: [{ amount: 1000 }],
        pretax_credit_amounts: [
          { type: 'discount', amount: 1000 },
          { type: 'credit_balance_transaction', amount: 9000 },
        ],
        pricing: { price_details: { price: 'price_pro', product: 'prod_pro' } },
      }).minor,
    ).toBe(0);
  });

  it('reads Checkout line items and subscription items', () => {
    expect(
      checkoutLine({
        description: 'Pro lifetime',
        quantity: 2,
        amount_subtotal: 20000,
        amount_discount: 2000,
        price: { id: 'price_life', product: { id: 'prod_pro', object: 'product' } },
      }),
    ).toEqual({ id: 'prod_pro', price: 'price_life', name: 'Pro lifetime', minor: 18000, quantity: 2 });
    expect(subscriptionLine({ quantity: 3, price: { id: 'price_seat', product: 'prod_seat', unit_amount: 1000 } })).toEqual({
      id: 'prod_seat',
      price: 'price_seat',
      minor: 3000,
      quantity: 3,
    });
    expect(subscriptionLine({ quantity: 1, price: { id: 'price_metered', product: 'prod_api', unit_amount: null } }).minor).toBeUndefined();
  });

  it('merges lines for the same product and price, in the currency\'s own minor unit', () => {
    const fields = productFields(
      [
        { id: 'prod_pro', price: 'price_pro_m', name: 'Pro', minor: 8000, quantity: 1 },
        { id: 'prod_pro', price: 'price_pro_m', minor: -2500 },
        { id: 'prod_seat', price: 'price_seat', minor: 2000, quantity: 2 },
      ],
      'usd',
    );
    expect(fields).toEqual({
      products: [
        { id: 'prod_pro', price: 'price_pro_m', name: 'Pro', amount: 55, quantity: 1 },
        { id: 'prod_seat', price: 'price_seat', amount: 20, quantity: 2 },
      ],
    });
    expect(productFields([{ id: 'prod_pro', minor: 5000 }], 'jpy')).toEqual({ products: [{ id: 'prod_pro', amount: 5000 }] });
  });

  it('marks a list it had to cut short, or that Stripe had more of', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ id: `prod_${i}`, minor: 100 }));
    const cut = productFields(many, 'usd');
    expect(cut.products).toHaveLength(100);
    expect(cut.productsIncomplete).toBe(true);
    expect(productFields([{ id: 'prod_pro', minor: 100 }], 'usd', false).productsIncomplete).toBe(true);
    expect(productFields([], 'usd')).toEqual({});
  });

  it("puts an API call's products field in metadata, over one sent inside it", () => {
    expect(metadataWithProducts({ orderId: 'o1', products: ['x'], productsIncomplete: true }, [{ id: 'sku_1', amount: 5 }])).toEqual({
      orderId: 'o1',
      products: [{ id: 'sku_1', amount: 5 }],
    });
    expect(metadataWithProducts({ products: ['x'] }, undefined)).toEqual({ products: ['x'] });
    expect(metadataWithProducts(undefined, undefined)).toEqual({});
  });
});

/** Clicks sit just before the first event in each test. */
const CLICK_TS = new Date('2025-12-31T23:59:00Z');

describe.skipIf(skipIntegration)('the engine', () => {
  it("pays a percent rule on its products' share, and nothing on a sale without them", async () => {
    const { userId } = await setup([
      { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 30, products: [{ id: 'prod_pro', name: 'Pro' }] },
      { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 5 },
    ]);
    await accrue(userId, 'invoice_paid', '90.00', '2026-01-01', { products: [PRO, SEAT] });
    await accrue(userId, 'invoice_paid', '40.00', '2026-01-02', { products: [SEAT] });
    await accrue(userId, 'invoice_paid', '50.00', '2026-01-03');

    const rows = await commissions();
    expect(rows.map((r) => r.amount)).toEqual(['21.60', '4.50', '2.00', '2.50']);
    expect(rows[0]!.metadata).toEqual({ rateType: 'percent', products: { ruleIndex: 0, matched: ['prod_pro'], basis: 72 } });
    expect(rows[1]!.metadata).toEqual({ rateType: 'percent' });
  });

  it('matches a price id, so monthly and annual can pay differently', async () => {
    const { userId } = await setup([
      { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20, products: [{ id: 'price_pro_m' }] },
      { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 40, products: [{ id: 'price_pro_y' }] },
    ]);
    await accrue(userId, 'invoice_paid', '80.00', '2026-01-01', { products: [{ id: 'prod_pro', price: 'price_pro_m', amount: 80 }] });
    await accrue(userId, 'invoice_paid', '800.00', '2026-02-01', { products: [{ id: 'prod_pro', price: 'price_pro_y', amount: 800 }] });
    const rows = await commissions();
    expect(rows.map((r) => r.amount)).toEqual(['16.00', '320.00']);
    // The commission records the rule's id that matched: the price.
    expect(rows[1]!.metadata.products).toEqual({ ruleIndex: 1, matched: ['price_pro_y'], basis: 800 });
  });

  it('pays a fixed amount once per sale that includes the product, whatever its share', async () => {
    const { userId } = await setup([
      { trigger: 'every', eventType: 'invoice_paid', type: 'fixed', value: 25, products: [{ id: 'prod_pro' }] },
    ]);
    await accrue(userId, 'invoice_paid', '90.00', '2026-01-01', { products: [{ id: 'prod_pro', quantity: 3, amount: 10 }, SEAT] });
    await accrue(userId, 'invoice_paid', '90.00', '2026-01-02', { products: [SEAT] });
    expect((await commissions()).map((r) => r.amount)).toEqual(['25.00']);
  });

  it("counts a `first` rule per product: the first Team sale pays after earlier Pro sales", async () => {
    const { userId } = await setup([
      { trigger: 'first', eventType: 'invoice_paid', type: 'fixed', value: 50, products: [{ id: 'prod_team' }] },
    ]);
    await accrue(userId, 'invoice_paid', '80.00', '2026-01-01', { products: [PRO] });
    await accrue(userId, 'invoice_paid', '80.00', '2026-02-01', { products: [PRO] });
    await accrue(userId, 'invoice_paid', '99.00', '2026-03-01', { products: [{ id: 'prod_team', amount: 99 }] });
    await accrue(userId, 'invoice_paid', '99.00', '2026-04-01', { products: [{ id: 'prod_team', amount: 99 }] });
    expect((await commissions()).map((r) => r.amount)).toEqual(['50.00']);
  });

  it('counts a recurring cap from the first sale of the product', async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        recurring: true,
        recurringMonths: 2,
        products: [{ id: 'prod_team' }],
      },
    ]);
    const team = { products: [{ id: 'prod_team', amount: 100 }] };
    await accrue(userId, 'invoice_paid', '80.00', '2026-01-01', { products: [PRO] }); // not Team: starts no clock
    await accrue(userId, 'invoice_paid', '100.00', '2026-05-01', team);
    await accrue(userId, 'invoice_paid', '100.00', '2026-06-01', team);
    await accrue(userId, 'invoice_paid', '100.00', '2026-09-01', team); // past 2 months from May
    expect((await commissions()).map((r) => r.amount)).toEqual(['10.00', '10.00']);
  });

  it("applies value slabs to the product's share", async () => {
    const { userId } = await setup([
      {
        trigger: 'every',
        eventType: 'invoice_paid',
        type: 'percent',
        value: 10,
        products: [{ id: 'prod_pro' }],
        bands: { levels: [{ above: 1000, value: 20 }] },
      },
    ]);
    // $1,500 sale, Pro is $600 of it: the base slab, not the $1,000+ one.
    await accrue(userId, 'invoice_paid', '1500.00', '2026-01-01', {
      products: [{ id: 'prod_pro', amount: 600 }, { id: 'prod_other', amount: 900 }],
    });
    const [row] = await commissions();
    expect(row!.amount).toBe('60.00');
    expect(row!.metadata.slab).toMatchObject({ level: 0, basis: 600 });
  });

  // Review finding: an import doesn't validate rules, and an empty or null
  // list read as "every product".
  // Review finding (round 2): the legacy single-object shape, stored by an
  // import, lost its list when the engine normalized it.
  it.each([
    ['a valid list on the legacy shape', [{ id: 'prod_team' }], true],
    ['null on the legacy shape', null, true],
  ])('a stored rule with %s keeps it', async (_name, products, legacy) => {
    const { userId, program } = await setup([{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 30 }]);
    await db(TABLES.Program)
      .where({ id: program.id })
      .update({ commissionRule: JSON.stringify(legacy ? { type: 'percent', value: 30, products } : []) });
    await accrue(userId, 'invoice_paid', '90.00', '2026-01-01', { products: [PRO, SEAT] });
    expect(await commissions()).toEqual([]);
  });

  it.each([
    ['an empty list', []],
    ['null', null],
    ['an entry without an id', [{ name: 'Pro' }]],
  ])('a stored rule whose product list is %s pays on nothing', async (_name, products) => {
    const { userId, program } = await setup([{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 30 }]);
    await db(TABLES.Program)
      .where({ id: program.id })
      .update({ commissionRule: JSON.stringify([{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 30, products }]) });
    await accrue(userId, 'invoice_paid', '90.00', '2026-01-01', { products: [PRO, SEAT] });
    await accrue(userId, 'invoice_paid', '90.00', '2026-01-02');
    expect(await commissions()).toEqual([]);
  });

  it('pays a percent rule nothing, and a fixed one as usual, on a list cut short', async () => {
    const { userId } = await setup([
      { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 30, products: [{ id: 'prod_pro' }] },
      { trigger: 'every', eventType: 'invoice_paid', type: 'fixed', value: 5, products: [{ id: 'prod_pro' }] },
    ]);
    await accrue(userId, 'invoice_paid', '90.00', '2026-01-01', { products: [PRO], productsIncomplete: true });
    expect((await commissions()).map((r) => r.amount)).toEqual(['5.00']);
  });
});

describe.skipIf(skipIntegration)('the API', () => {
  it('records products sent to /attribution/events and pays on them', async () => {
    const { userId } = await setup([
      { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 30, products: [{ id: 'sku_pro' }] },
    ]);
    const res = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        userId,
        type: 'invoice_paid',
        value: 100,
        currency: 'USD',
        externalEventId: `order_${ulid()}`,
        metadata: { orderId: 'o-1' },
        products: [
          { id: 'sku_pro', name: 'Pro', amount: 60, quantity: 1 },
          { id: 'sku_mug', name: 'Mug', amount: 40 },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const event = await db(TABLES.Event).where({ id: res.body.eventId }).first();
    expect(event!.metadata).toEqual({
      orderId: 'o-1',
      products: [
        { id: 'sku_pro', name: 'Pro', amount: 60, quantity: 1 },
        { id: 'sku_mug', name: 'Mug', amount: 40 },
      ],
    });
    expect((await commissions()).map((r) => r.amount)).toEqual(['18.00']);
  });

  it('refuses more than one product without amounts', async () => {
    const res = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ userId: 'u1', type: 'invoice_paid', value: 100, products: [{ id: 'a', amount: 60 }, { id: 'b' }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('each needs its amount');
  });

  it('records products sent to /attribution/conversions', async () => {
    const { clickId } = await setupClickOnly([
      { trigger: 'every', eventType: 'loan_funded', type: 'fixed', value: 200, products: [{ id: 'mortgage' }] },
    ]);
    const send = (product: string) =>
      request(app)
        .post('/attribution/conversions')
        .set('Authorization', `Bearer ${ADMIN_KEY}`)
        .send({ clickId, type: 'loan_funded', value: 250000, externalEventId: `loan_${ulid()}`, products: [{ id: product }] });
    const mortgage = await send('mortgage');
    expect(mortgage.status, JSON.stringify(mortgage.body)).toBe(200);
    expect(mortgage.body.outcome).toBe('attributed');
    const auto = await send('auto_loan');
    expect(auto.body).toMatchObject({ outcome: 'attributed', reason: 'no_commission' });
    expect((await commissions()).map((r) => r.amount)).toEqual(['200.00']);
    const event = await db(TABLES.Event).where({ id: mortgage.body.eventId }).first();
    expect(event!.metadata.products).toEqual([{ id: 'mortgage' }]);
  });

  it('takes products on program rules and partner overrides, and refuses an empty or repeated list', async () => {
    const ok = await postProgram([
      { trigger: 'every', type: 'percent', value: 30, products: [{ id: ' prod_pro ', name: 'Pro' }] },
    ]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const program = await db(TABLES.Program).where({ id: ok.body.id }).first();
    expect(program!.commissionRule[0].products).toEqual([{ id: 'prod_pro', name: 'Pro' }]);

    expect((await postProgram([{ trigger: 'every', type: 'percent', value: 30, products: [] }])).status).toBe(400);
    // Review finding: the legacy single-object form stripped the list and
    // saved a rule for every product.
    const legacy = await postProgram({ type: 'percent', value: 30, products: [{ id: 'prod_pro' }] });
    expect(legacy.status).toBe(400);
    expect(JSON.stringify(legacy.body)).toContain('products need the array form of commissionRule');
    expect(
      (await postProgram([{ trigger: 'every', type: 'percent', value: 30, products: [{ id: 'a' }, { id: 'a' }] }])).status,
    ).toBe(400);

    const partner = await createPartner();
    const put = await request(app)
      .put(`/partners/${partner.id}/commission-snapshot`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        commissionType: 'percent',
        commissionValue: 10,
        commissionRules: [{ trigger: 'every', type: 'percent', value: 40, products: [{ id: 'prod_pro' }] }],
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.snapshot.commissionRules[0].products).toEqual([{ id: 'prod_pro' }]);
  });

  it('suggests the products and prices on recent sales, newest name first', async () => {
    const userId = `u-${ulid()}`;
    await insertEvent(userId, 'invoice_paid', '80.00', new Date(Date.now() - 2 * 86400_000), {
      products: [{ id: 'prod_pro', price: 'price_pro_m', name: 'Pro (old name)', amount: 80 }],
    });
    await insertEvent(userId, 'invoice_paid', '80.00', new Date(Date.now() - 86400_000), {
      products: [{ id: 'prod_pro', price: 'price_pro_y', name: 'Pro', amount: 80 }, { amount: 5 }, 'junk'],
    });
    await insertEvent(userId, 'invoice_paid', '80.00', new Date(Date.now() - 400 * 86400_000), {
      products: [{ id: 'prod_ancient' }],
    });
    const res = await request(app).get('/programs/products').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(
      (res.body.products as Array<{ id: string; kind: string; name: string | null; productId: string | null; sales: number }>).map(
        (p) => [`${p.kind}:${p.id}`, p],
      ),
    );
    expect(Object.keys(byKey).sort()).toEqual(['price:price_pro_m', 'price:price_pro_y', 'product:prod_pro']);
    expect(byKey['product:prod_pro']).toMatchObject({ name: 'Pro', sales: 2, productId: null });
    expect(byKey['price:price_pro_m']).toMatchObject({ name: 'Pro (old name)', productId: 'prod_pro', sales: 1 });
  });
});

describe.skipIf(skipIntegration)('Network approval snapshots', () => {
  const RULE = { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 30, products: [{ id: 'prod_pro', name: 'Pro' }] };

  it('a snapshot that lost the product list is not stored, so the partner earns on the live rule', async () => {
    const program = await createProgram([RULE]);
    const { products: _dropped, ...stripped } = RULE;
    const res = await federate({ commissionType: 'percent', commissionValue: 30, commissionRules: [stripped] }, [program.id]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await db(TABLES.PartnerCommission).where({ partnerId: res.body.id })).toHaveLength(0);
  });

  it('a snapshot that carries the product list is stored with it', async () => {
    const program = await createProgram([RULE]);
    const res = await federate({ commissionType: 'percent', commissionValue: 30, commissionRules: [RULE] }, [program.id]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [row] = await db(TABLES.PartnerCommission).where({ partnerId: res.body.id });
    expect(row!.commissionRules).toEqual([RULE]);
  });

  it('a snapshot with an unreadable product list is not stored, and the approval still succeeds', async () => {
    const program = await createProgram([RULE]);
    // null included (review finding): it read as "every product", and a
    // snapshot at another rate isn't a stripped copy, so it was stored.
    for (const products of [[], 'prod_pro', [{ name: 'no id' }], null]) {
      const res = await federate(
        { commissionType: 'percent', commissionValue: 20, commissionRules: [{ ...RULE, value: 20, products }] },
        [program.id],
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await db(TABLES.PartnerCommission).where({ partnerId: res.body.id })).toHaveLength(0);
    }
  });

  it('a legacy single-rule snapshot of a product-limited program is not stored', async () => {
    const program = await createProgram([RULE]);
    const res = await federate({ commissionType: 'percent', commissionValue: 30 }, [program.id]);
    expect(res.status).toBe(201);
    expect(await db(TABLES.PartnerCommission).where({ partnerId: res.body.id })).toHaveLength(0);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

interface CommissionWithMeta {
  amount: string;
  metadata: { rateType?: string; slab?: Record<string, unknown>; products?: Record<string, unknown> };
}

async function setup(rules: unknown[]) {
  const partner = await createPartner();
  const program = await createProgram(rules);
  const userId = `u-${ulid()}`;
  await click(partner.id, program.id, userId, CLICK_TS);
  return { partner, program, userId };
}

/** A click with no Identity: what /attribution/conversions stitches. */
async function setupClickOnly(rules: unknown[]) {
  const partner = await createPartner();
  const program = await createProgram(rules);
  const linkId = ulid();
  await db(TABLES.Link).insert({
    id: linkId,
    tenantId: DEFAULT_TENANT_ID,
    linkKey: `k${linkId.toLowerCase()}`,
    partnerId: partner.id,
    programId: program.id,
    destinationUrl: 'https://example.com/',
  });
  const clickId = ulid();
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: DEFAULT_TENANT_ID,
    linkId,
    partnerId: partner.id,
    programId: program.id,
    landingUrl: 'https://example.com/',
    ts: new Date(Date.now() - 60_000),
  });
  return { clickId };
}

async function commissions(): Promise<CommissionWithMeta[]> {
  return (await db(TABLES.Commission).orderBy([{ column: 'accruedAt' }, { column: 'id' }])) as CommissionWithMeta[];
}

async function accrue(userId: string, type: string, value: string | null, ts: string, metadata: Record<string, unknown> = {}) {
  const event = await insertEvent(userId, type, value, new Date(ts), metadata);
  await attributeEvent(db, event);
  return event;
}

async function createPartner() {
  const res = await request(app)
    .post('/partners')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({ email: `p+${ulid()}@example.com`, name: 'Product test', sendInvite: false, programIds: [] });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function federate(commissionSnapshot: Record<string, unknown>, programIds: string[]) {
  return request(app)
    .post('/partners')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({
      email: `p+${ulid()}@example.com`,
      name: 'Network creator',
      sendInvite: false,
      programIds,
      campaignGrantSource: 'offering',
      commissionSnapshot,
    });
}

function postProgram(commissionRule: unknown) {
  return request(app)
    .post('/programs')
    .set('Authorization', `Bearer ${ADMIN_KEY}`)
    .send({
      name: 'Products',
      commissionRule,
      attributionWindowDays: 365,
      destinationUrl: 'https://example.com/signup',
      deepLinkAllowedDomains: 'example.com',
    });
}

async function createProgram(rules: unknown[]) {
  const res = await postProgram(rules);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string };
}

async function click(partnerId: string, programId: string, userId: string, ts: Date): Promise<string> {
  const linkId = ulid();
  await db(TABLES.Link).insert({
    id: linkId,
    tenantId: DEFAULT_TENANT_ID,
    linkKey: `k${linkId.toLowerCase()}`,
    partnerId,
    programId,
    destinationUrl: 'https://example.com/',
  });
  const clickId = ulid();
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: DEFAULT_TENANT_ID,
    linkId,
    partnerId,
    programId,
    landingUrl: 'https://example.com/',
    ts,
  });
  await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });
  return clickId;
}

async function insertEvent(userId: string, type: string, value: string | null, ts: Date, metadata: Record<string, unknown> = {}) {
  const id = ulid();
  await db(TABLES.Event).insert({
    id,
    tenantId: DEFAULT_TENANT_ID,
    userId,
    type,
    value,
    currency: 'USD',
    externalEventId: `evt_${ulid()}`,
    metadata: JSON.stringify(metadata),
    ts,
  });
  return (await db(TABLES.Event).where({ id }).first()) as EventRow;
}
