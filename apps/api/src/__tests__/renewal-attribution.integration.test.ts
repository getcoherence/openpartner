/**
 * Renewals past the attribution window (Program.renewalsStayWithPartner).
 *
 * The window decides which click wins a customer's first conversion of an
 * event type; repeats of that type keep that conversion's touches however
 * old the click, and the commission rule's own recurring / recurringMonths
 * decide what they pay. Spec: docs/renewal-attribution.md.
 *
 * Every scenario runs on a fixed timeline: the first click is DAY 0
 * (2024-01-01) and the program window is the 60-day default unless a test
 * says otherwise.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type AttributionModel, type EventRow } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { attributeBacklogForUser, attributeEvent } from '../attribution.js';

const ADMIN_KEY = 'op_test_renewal_attribution_0123456789abcdef';
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

const DAY0 = Date.parse('2024-01-01T00:00:00Z');
const day = (n: number) => new Date(DAY0 + n * 24 * 60 * 60 * 1000);

const RECURRING_20 = [{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20, recurring: true }];

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

describe.skipIf(skipIntegration)('renewals past the attribution window', () => {
  it('keeps paying the acquiring partner on renewals at day 400 and day 800', async () => {
    const a = await createPartner();
    const program = await createProgram({ commissionRule: RECURRING_20 });
    const click = await insertClick(a.id, program.id, day(0));
    const userId = await stitchNewUser(click);

    await attribute(userId, 'signup', null, day(10));
    const first = await attribute(userId, 'invoice_paid', '49.00', day(10));
    const at400 = await attribute(userId, 'invoice_paid', '49.00', day(400));
    const at800 = await attribute(userId, 'invoice_paid', '49.00', day(800));

    expect(first.result.status).toBe('attributed');
    for (const renewal of [at400, at800]) {
      expect(renewal.result.status).toBe('attributed');
      expect(renewal.result.model).toBe('last_click');
      expect(renewal.result.touches).toEqual([
        expect.objectContaining({ clickId: click, partnerId: a.id, weight: 1, commissionId: expect.any(String) }),
      ]);
    }
    expect(await commissionAmounts(a.id)).toEqual([9.8, 9.8, 9.8]);

    // Re-running a renewal derives the same touches, so it's a no-op.
    const again = await attributeEvent(db, at800.event);
    expect(again.status).toBe('already_attributed');
    expect(await db(TABLES.Attribution).where({ eventId: at800.event.id })).toHaveLength(1);
  });

  it('pays every monthly invoice for 27 months, with no gap where the window ends', async () => {
    const a = await createPartner();
    const program = await createProgram({ commissionRule: RECURRING_20 });
    const userId = await stitchNewUser(await insertClick(a.id, program.id, day(0)));

    for (let month = 0; month < 27; month += 1) {
      const { result } = await attribute(userId, 'invoice_paid', '100.00', day(10 + 30 * month));
      expect(result.status, `invoice ${month + 1}`).toBe('attributed');
    }
    expect(await commissionAmounts(a.id)).toEqual(new Array(27).fill(20));
  });

  it('still stops at recurringMonths, measured from the first attributed invoice', async () => {
    const a = await createPartner();
    const program = await createProgram({
      commissionRule: [{ ...RECURRING_20[0], recurringMonths: 12 }],
    });
    const userId = await stitchNewUser(await insertClick(a.id, program.id, day(0)));

    await attribute(userId, 'invoice_paid', '100.00', day(10));
    await attribute(userId, 'invoice_paid', '100.00', day(370)); // 360 days in: under the cap
    const capped = await attribute(userId, 'invoice_paid', '100.00', day(400)); // 390 days in: past it

    // The renewal is still attributed (the path is known), it just stops paying.
    expect(capped.result.status).toBe('attributed');
    expect(capped.result.touches?.[0]?.commissionId).toBeUndefined();
    expect(await commissionAmounts(a.id)).toEqual([20, 20]);
  });

  it('pays only recurring rules past the window; a non-recurring rule stays window-bound', async () => {
    const a = await createPartner();
    const program = await createProgram({
      commissionRule: [
        { trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 10 },
        ...RECURRING_20,
      ],
    });
    const userId = await stitchNewUser(await insertClick(a.id, program.id, day(0)));

    await attribute(userId, 'invoice_paid', '100.00', day(10)); // in window: 10 + 20
    await attribute(userId, 'invoice_paid', '100.00', day(40)); // renewal, still in window: 10 + 20
    await attribute(userId, 'invoice_paid', '100.00', day(400)); // past the window: 20 only

    expect(await commissionAmounts(a.id)).toEqual([10, 20, 10, 20, 20]);
  });

  it('keeps renewals with the original partner after another partner is clicked; a new kind of conversion follows the new click', async () => {
    const a = await createPartner();
    const b = await createPartner();
    const program = await createProgram({
      commissionRule: [...RECURRING_20, { trigger: 'every', eventType: 'addon_purchased', type: 'percent', value: 20, recurring: true }],
    });
    const clickA = await insertClick(a.id, program.id, day(0));
    const userId = await stitchNewUser(clickA);
    await attribute(userId, 'invoice_paid', '50.00', day(10));

    // Ten days before the renewal the customer clicks partner B's link.
    const clickB = await insertClick(b.id, program.id, day(390));
    await stitch(clickB, userId);

    const renewal = await attribute(userId, 'invoice_paid', '50.00', day(400));
    expect(renewal.result.touches).toEqual([expect.objectContaining({ clickId: clickA, partnerId: a.id })]);

    // An event type the customer never converted on is an acquisition:
    // the window decides it, and B's click is the latest one in it.
    const addon = await attribute(userId, 'addon_purchased', '30.00', day(400));
    expect(addon.result.touches).toEqual([expect.objectContaining({ clickId: clickB, partnerId: b.id })]);

    const later = await attribute(userId, 'invoice_paid', '50.00', day(430));
    expect(later.result.touches).toEqual([expect.objectContaining({ partnerId: a.id })]);
    expect(await commissionAmounts(a.id)).toEqual([10, 10, 10]);
    expect(await commissionAmounts(b.id)).toEqual([6]);
  });

  it('with renewalsStayWithPartner off, every event is decided by the window alone (the old behaviour)', async () => {
    const a = await createPartner();
    const b = await createPartner();
    const program = await createProgram({ commissionRule: RECURRING_20, renewalsStayWithPartner: false });
    expect(program.renewalsStayWithPartner).toBe(false);
    const userId = await stitchNewUser(await insertClick(a.id, program.id, day(0)));
    await attribute(userId, 'invoice_paid', '50.00', day(10));

    const lapsed = await attribute(userId, 'invoice_paid', '50.00', day(200));
    expect(lapsed.result.status).toBe('outside_window');

    await stitch(await insertClick(b.id, program.id, day(390)), userId);
    const taken = await attribute(userId, 'invoice_paid', '50.00', day(400));
    expect(taken.result.touches).toEqual([expect.objectContaining({ partnerId: b.id })]);
    expect(await commissionAmounts(a.id)).toEqual([10]);
    expect(await commissionAmounts(b.id)).toEqual([10]);
  });

  it('defaults the setting on, and a later window or setting change only decides events from then on', async () => {
    const a = await createPartner();
    const program = await createProgram({ commissionRule: RECURRING_20 });
    expect(program.renewalsStayWithPartner).toBe(true);
    const userId = await stitchNewUser(await insertClick(a.id, program.id, day(0)));
    await attribute(userId, 'invoice_paid', '50.00', day(10));

    // Shrinking the window doesn't touch a customer already won.
    await patchProgram(program.id, { attributionWindowDays: 7 });
    const renewal = await attribute(userId, 'invoice_paid', '50.00', day(400));
    expect(renewal.result.touches).toEqual([expect.objectContaining({ partnerId: a.id })]);

    // Turning the setting off stops later renewals but leaves earlier rows alone.
    const off = await patchProgram(program.id, { renewalsStayWithPartner: false });
    expect(off.renewalsStayWithPartner).toBe(false);
    const after = await attribute(userId, 'invoice_paid', '50.00', day(430));
    expect(after.result.status).toBe('outside_window');
    expect(await commissionAmounts(a.id)).toEqual([10, 10]);
  });

  it('stops a revoked partner earning renewals; the next partner to win the customer in the window keeps them', async () => {
    const a = await createPartner();
    const b = await createPartner();
    const program = await createProgram({ commissionRule: RECURRING_20 });
    const userId = await stitchNewUser(await insertClick(a.id, program.id, day(0)));
    await attribute(userId, 'invoice_paid', '50.00', day(10));

    const revoked = await request(app)
      .post(`/partners/${a.id}/revoke`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ notify: false });
    expect(revoked.status).toBe(200);

    const orphan = await attribute(userId, 'invoice_paid', '50.00', day(400));
    expect(orphan.result.status).toBe('no_click');

    const clickB = await insertClick(b.id, program.id, day(420));
    await stitch(clickB, userId);
    const won = await attribute(userId, 'invoice_paid', '50.00', day(430));
    expect(won.result.touches).toEqual([expect.objectContaining({ clickId: clickB, partnerId: b.id })]);

    // B's click is long out of the window by day 800; B keeps the renewal.
    const kept = await attribute(userId, 'invoice_paid', '50.00', day(800));
    expect(kept.result.touches).toEqual([expect.objectContaining({ clickId: clickB, partnerId: b.id })]);
    expect(await commissionAmounts(a.id)).toEqual([10]);
    expect(await commissionAmounts(b.id)).toEqual([10, 10]);
  });

  // The three-way split is stored as 0.3333: on a 10,000 invoice a
  // renewal paid on the stored weight would earn 666.60, not 666.67.
  it.each<{ model: AttributionModel; split: string; weights: number[]; value: string }>([
    { model: 'linear', split: '50/50', weights: [0.5, 0.5], value: '100.00' },
    { model: 'position', split: '40/20/40', weights: [0.4, 0.2, 0.4], value: '100.00' },
    { model: 'linear', split: 'three ways on 10,000', weights: [1 / 3, 1 / 3, 1 / 3], value: '10000.00' },
  ])('reuses the original $model weights ($split) on renewals, ignoring a later touch', async ({ model, weights, value }) => {
    const program = await createProgram({ commissionRule: RECURRING_20, attributionModel: model });
    const partners = [];
    for (let i = 0; i < weights.length; i += 1) partners.push(await createPartner());
    const clicks = [];
    for (const [i, p] of partners.entries()) clicks.push(await insertClick(p.id, program.id, day(2 * i)));
    const userId = await stitchNewUser(clicks[0]!);
    for (const c of clicks.slice(1)) await stitch(c, userId);

    const first = await attribute(userId, 'invoice_paid', value, day(10));
    expect(touchWeights(first.result.touches)).toEqual(touchWeights(weights.map((weight) => ({ weight }))));

    // A new partner's click shortly before the renewal adds no touch.
    const late = await createPartner();
    await stitch(await insertClick(late.id, program.id, day(395)), userId);
    const renewal = await attribute(userId, 'invoice_paid', value, day(400));
    expect(renewal.result.model).toBe(model);
    expect(renewal.result.touches?.map((t) => t.clickId)).toEqual(clicks);
    expect(renewal.result.touches?.map((t) => t.weight)).toEqual(first.result.touches?.map((t) => t.weight));

    for (const [i, p] of partners.entries()) {
      const share = Number((0.2 * Number(value) * weights[i]!).toFixed(2));
      expect(await commissionAmounts(p.id)).toEqual([share, share]);
    }
    expect(await commissionAmounts(late.id)).toEqual([]);
  });

  it('carries a first-of-its-type conversion past the window to the partner who already won the customer', async () => {
    const a = await createPartner();
    const program = await createProgram({
      commissionRule: [
        { trigger: 'first', eventType: 'subscription_created', type: 'fixed', value: 200 },
        ...RECURRING_20,
      ],
    });
    const userId = await stitchNewUser(await insertClick(a.id, program.id, day(0)));
    await attribute(userId, 'signup', null, day(10));

    // A long trial: the subscription and first invoice land at day 200.
    const sub = await attribute(userId, 'subscription_created', '100.00', day(200));
    const invoice = await attribute(userId, 'invoice_paid', '100.00', day(200));
    expect(sub.result.touches).toEqual([expect.objectContaining({ partnerId: a.id })]);
    expect(invoice.result.touches).toEqual([expect.objectContaining({ partnerId: a.id })]);
    // The one-off bounty is not recurring, so it stays window-bound; the
    // recurring revenue share pays.
    expect(await commissionAmounts(a.id)).toEqual([20]);
  });

  it('never carries a refund to the renewal partner', async () => {
    const a = await createPartner();
    const program = await createProgram({ commissionRule: [{ trigger: 'every', type: 'percent', value: 20, recurring: true }] });
    const userId = await stitchNewUser(await insertClick(a.id, program.id, day(0)));
    await attribute(userId, 'invoice_paid', '50.00', day(10));
    await attribute(userId, 'invoice_paid', '50.00', day(400));

    const refund = await attribute(userId, 'refund', '-50.00', day(401));
    expect(refund.result.status).not.toBe('attributed');
    expect(await db(TABLES.Attribution).where({ eventId: refund.event.id })).toHaveLength(0);
    expect(await commissionAmounts(a.id)).toEqual([10, 10]);
  });

  describe('backlog replay', () => {
    it('attributes renewals recorded before the stitch, in time order', async () => {
      const a = await createPartner();
      const program = await createProgram({ commissionRule: RECURRING_20 });
      const click = await insertClick(a.id, program.id, day(0));
      const userId = `u-${ulid()}`;
      // The payments arrive before the app ever stitches the customer.
      for (const n of [800, 10, 400]) await insertEvent(userId, 'invoice_paid', '49.00', day(n));

      await stitch(click, userId);
      expect(await attributeBacklogForUser(db, userId)).toBe(3);
      expect(await commissionAmounts(a.id)).toEqual([9.8, 9.8, 9.8]);
    });

    it("doesn't move renewals to a partner stitched later", async () => {
      const a = await createPartner();
      const b = await createPartner();
      const program = await createProgram({ commissionRule: RECURRING_20 });
      const clickA = await insertClick(a.id, program.id, day(0));
      const userId = await stitchNewUser(clickA);
      for (const n of [10, 400, 800]) await attribute(userId, 'invoice_paid', '49.00', day(n));

      // The customer logs in on another device carrying B's day-795 click:
      // identify stitches it and replays the user's backlog.
      const clickB = await insertClick(b.id, program.id, day(795));
      const res = await request(app).post('/attribution/identify').send({ cref: clickB, userId });
      expect(res.status).toBe(200);
      expect(res.body.firstStitch).toBe(true);
      expect(res.body.backfilledAttributions).toBe(0);

      const rows = await db(TABLES.Attribution).select('partnerId');
      expect(rows.map((r) => r.partnerId)).toEqual([a.id, a.id, a.id]);

      // And the next renewal, with B's click 35 days old, still goes to A.
      const next = await attribute(userId, 'invoice_paid', '49.00', day(830));
      expect(next.result.touches).toEqual([expect.objectContaining({ clickId: clickA, partnerId: a.id })]);
      expect(await commissionAmounts(b.id)).toEqual([]);
    });
  });

  // -------- helpers --------

  async function createPartner() {
    const res = await request(app)
      .post('/partners')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ email: `p+${ulid()}@example.com`, name: 'Test' });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  async function createProgram(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'Renewals',
        commissionRule: RECURRING_20,
        destinationUrl: 'https://example.com/signup',
        ...overrides,
      });
    expect(res.status).toBe(201);
    return res.body as { id: string; renewalsStayWithPartner: boolean };
  }

  async function patchProgram(id: string, body: Record<string, unknown>) {
    const res = await request(app).patch(`/programs/${id}`).set('Authorization', `Bearer ${ADMIN_KEY}`).send(body);
    expect(res.status).toBe(200);
    return res.body as { renewalsStayWithPartner: boolean };
  }

  async function insertClick(partnerId: string, programId: string, ts: Date): Promise<string> {
    const id = ulid();
    await db(TABLES.Click).insert({
      id,
      tenantId: DEFAULT_TENANT_ID,
      linkId: null,
      partnerId,
      programId,
      landingUrl: 'https://example.com/',
      ts,
    });
    return id;
  }

  async function stitch(clickId: string, userId: string) {
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });
  }

  async function stitchNewUser(clickId: string): Promise<string> {
    const userId = `u-${ulid()}`;
    await stitch(clickId, userId);
    return userId;
  }

  async function insertEvent(userId: string, type: string, value: string | null, ts: Date): Promise<EventRow> {
    const id = ulid();
    await db(TABLES.Event).insert({
      id,
      tenantId: DEFAULT_TENANT_ID,
      userId,
      type,
      value,
      currency: value ? 'USD' : null,
      externalEventId: `evt_${ulid()}`,
      metadata: {},
      ts,
    });
    return (await db(TABLES.Event).where({ id }).first()) as EventRow;
  }

  async function attribute(userId: string, type: string, value: string | null, ts: Date) {
    const event = await insertEvent(userId, type, value, ts);
    return { event, result: await attributeEvent(db, event) };
  }

  /** The partner's commission amounts, oldest event first. */
  async function commissionAmounts(partnerId: string): Promise<number[]> {
    const rows = (await db(TABLES.Commission)
      .join(TABLES.Attribution, `${TABLES.Attribution}.id`, `${TABLES.Commission}.attributionId`)
      .join(TABLES.Event, `${TABLES.Event}.id`, `${TABLES.Attribution}.eventId`)
      .where(`${TABLES.Commission}.partnerId`, partnerId)
      .orderBy([`${TABLES.Event}.ts`, `${TABLES.Commission}.accruedAt`, `${TABLES.Commission}.id`])
      .select(`${TABLES.Commission}.amount`)) as Array<{ amount: string }>;
    return rows.map((r) => Number(r.amount));
  }

  function touchWeights(touches: Array<{ weight: number }> | undefined): number[] {
    return (touches ?? []).map((t) => Number(t.weight.toFixed(4)));
  }
});
