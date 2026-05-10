/**
 * Compound commission rule engine — integration tests against the live
 * attribution path. Validates that a Campaign with multiple sub-rules emits
 * one Commission per matching sub-rule per event, and that the trigger /
 * recurringMonths checks gate correctly.
 *
 * The "first-sale + recurring" pattern motivating the feature is the canonical
 * test case here. Other shapes (eventType filters, recurringMonths cap) get
 * one assertion each.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { attributeEvent } from '../attribution.js';

const ADMIN_KEY = 'op_test_compound_rules_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
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
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) {
    await db(t).del();
  }
});

describe.skipIf(skipIntegration)('compound commission rules', () => {
  it('first-sale bonus + recurring percent: $200 once + 20% on every invoice', async () => {
    const partner = await createPartner();
    const campaign = await createCampaign({
      commissionRule: [
        {
          trigger: 'first',
          eventType: 'subscription_created',
          type: 'fixed',
          value: 200,
        },
        {
          trigger: 'every',
          eventType: 'invoice_paid',
          type: 'percent',
          value: 20,
          recurring: true,
        },
      ],
    });
    const link = await createLink(partner.id, campaign.id, `first-bonus-${Date.now()}`);
    const userId = `u-${Date.now()}`;

    // Click + identify so subsequent events can attribute.
    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: link.id,
      partnerId: partner.id,
      programId: campaign.id,
      landingUrl: 'https://example.com/',
      ts: new Date(),
    });
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });

    // Event 1: subscription_created — fires the first-sale bonus only
    // (eventType doesn't match the every/invoice_paid rule).
    const ev1 = await insertEvent(userId, 'subscription_created', null, new Date('2026-01-01'));
    await attributeEvent(db, ev1);

    // Event 2: first invoice_paid — fires only the recurring rule (the
    // bonus already fired and won't re-fire on a different eventType).
    const ev2 = await insertEvent(userId, 'invoice_paid', '49.00', new Date('2026-01-02'));
    await attributeEvent(db, ev2);

    // Event 3: second invoice_paid — fires the recurring rule again.
    const ev3 = await insertEvent(userId, 'invoice_paid', '49.00', new Date('2026-02-02'));
    await attributeEvent(db, ev3);

    const commissions = (await db(TABLES.Commission).orderBy('accruedAt', 'asc')) as Array<{
      amount: string;
    }>;
    expect(commissions).toHaveLength(3);
    expect(Number(commissions[0]!.amount)).toBe(200); // first-sale bonus
    expect(Number(commissions[1]!.amount)).toBeCloseTo(9.8, 2); // 20% of $49
    expect(Number(commissions[2]!.amount)).toBeCloseTo(9.8, 2); // 20% of $49
  });

  it('first-trigger fires once per (partner, user, eventType)', async () => {
    const partner = await createPartner();
    const campaign = await createCampaign({
      commissionRule: [
        {
          trigger: 'first',
          eventType: 'subscription_created',
          type: 'fixed',
          value: 50,
        },
      ],
    });
    const link = await createLink(partner.id, campaign.id, `firstonly-${Date.now()}`);
    const userId = `u-${Date.now()}`;

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: link.id,
      partnerId: partner.id,
      programId: campaign.id,
      landingUrl: 'https://example.com/',
      ts: new Date(),
    });
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });

    const ev1 = await insertEvent(userId, 'subscription_created', null, new Date('2026-01-01'));
    await attributeEvent(db, ev1);
    const ev2 = await insertEvent(userId, 'subscription_created', null, new Date('2026-02-01'));
    await attributeEvent(db, ev2);

    const commissions = (await db(TABLES.Commission)) as Array<{ amount: string }>;
    expect(commissions).toHaveLength(1);
    expect(Number(commissions[0]!.amount)).toBe(50);
  });

  it('recurringMonths cap stops payouts past the configured horizon', async () => {
    const partner = await createPartner();
    const campaign = await createCampaign({
      commissionRule: [
        {
          trigger: 'every',
          eventType: 'invoice_paid',
          type: 'percent',
          value: 50,
          recurring: true,
          recurringMonths: 3,
        },
      ],
      // Override the default 60-day attribution window so the test can
      // reach events months past the click without first hitting the
      // attribution-window cutoff.
      attributionWindowDays: 365,
    });
    const link = await createLink(partner.id, campaign.id, `cap-${Date.now()}`);
    const userId = `u-${Date.now()}`;

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: link.id,
      partnerId: partner.id,
      programId: campaign.id,
      landingUrl: 'https://example.com/',
      ts: new Date('2026-01-01'),
    });
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });

    // Within 3 months of the first attributed invoice → fires.
    const ev1 = await insertEvent(userId, 'invoice_paid', '100.00', new Date('2026-01-15'));
    await attributeEvent(db, ev1);
    const ev2 = await insertEvent(userId, 'invoice_paid', '100.00', new Date('2026-04-10'));
    await attributeEvent(db, ev2);
    // Past the 3-month cap (~91 days) → skipped.
    const ev3 = await insertEvent(userId, 'invoice_paid', '100.00', new Date('2026-05-01'));
    await attributeEvent(db, ev3);

    const commissions = (await db(TABLES.Commission)) as Array<{ amount: string }>;
    expect(commissions).toHaveLength(2);
    expect(commissions.every((c) => Number(c.amount) === 50)).toBe(true);
  });

  it('first + subsequent on the same eventType: 50% on first invoice, 20% thereafter', async () => {
    const partner = await createPartner();
    const campaign = await createCampaign({
      commissionRule: [
        {
          trigger: 'first',
          eventType: 'invoice_paid',
          type: 'percent',
          value: 50,
        },
        {
          trigger: 'subsequent',
          eventType: 'invoice_paid',
          type: 'percent',
          value: 20,
          recurring: true,
        },
      ],
    });
    const link = await createLink(partner.id, campaign.id, `firstsub-${Date.now()}`);
    const userId = `u-${Date.now()}`;

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: link.id,
      partnerId: partner.id,
      programId: campaign.id,
      landingUrl: 'https://example.com/',
      ts: new Date(),
    });
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });

    // Event 1: first invoice — only the `first` rule fires (50% of $100 = $50).
    const ev1 = await insertEvent(userId, 'invoice_paid', '100.00', new Date('2026-01-01'));
    await attributeEvent(db, ev1);
    // Event 2: second invoice — only the `subsequent` rule fires (20% of $100 = $20).
    const ev2 = await insertEvent(userId, 'invoice_paid', '100.00', new Date('2026-02-01'));
    await attributeEvent(db, ev2);
    // Event 3: third invoice — same as #2 (20%).
    const ev3 = await insertEvent(userId, 'invoice_paid', '100.00', new Date('2026-03-01'));
    await attributeEvent(db, ev3);

    const commissions = (await db(TABLES.Commission).orderBy('accruedAt', 'asc')) as Array<{
      amount: string;
    }>;
    expect(commissions).toHaveLength(3);
    expect(Number(commissions[0]!.amount)).toBe(50);
    expect(Number(commissions[1]!.amount)).toBe(20);
    expect(Number(commissions[2]!.amount)).toBe(20);
  });

  it('eventType-less every rule fires on every event (legacy behavior preserved)', async () => {
    const partner = await createPartner();
    const campaign = await createCampaign({
      commissionRule: [{ trigger: 'every', type: 'percent', value: 10 }],
    });
    const link = await createLink(partner.id, campaign.id, `legacy-${Date.now()}`);
    const userId = `u-${Date.now()}`;

    const clickId = ulid();
    await db(TABLES.Click).insert({
      id: clickId,
      tenantId: DEFAULT_TENANT_ID,
      linkId: link.id,
      partnerId: partner.id,
      programId: campaign.id,
      landingUrl: 'https://example.com/',
      ts: new Date(),
    });
    await db(TABLES.Identity).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, clickId, userId });

    const ev1 = await insertEvent(userId, 'subscription_created', '100.00', new Date('2026-01-01'));
    await attributeEvent(db, ev1);
    const ev2 = await insertEvent(userId, 'invoice_paid', '49.00', new Date('2026-02-01'));
    await attributeEvent(db, ev2);

    const commissions = (await db(TABLES.Commission)) as Array<{ amount: string }>;
    expect(commissions).toHaveLength(2);
    expect(Number(commissions[0]!.amount) + Number(commissions[1]!.amount)).toBeCloseTo(14.9, 2);
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

  async function createCampaign(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post('/programs')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({
        name: 'Compound',
        commissionRule: [{ trigger: 'every', type: 'percent', value: 10 }],
        destinationUrl: 'https://example.com/signup',
        deepLinkAllowedDomains: 'e.com,example.com',
        ...overrides,
      });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  async function createLink(partnerId: string, programId: string, linkKey: string) {
    const res = await request(app)
      .post(`/partners/${partnerId}/links`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ linkKey, programId, destinationUrl: 'https://example.com/' });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  async function insertEvent(userId: string, type: string, value: string | null, ts: Date) {
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
    return (await db(TABLES.Event).where({ id }).first()) as {
      id: string;
      tenantId: string;
      userId: string;
      type: string;
      value: string | null;
      currency: string | null;
      externalEventId: string | null;
      metadata: Record<string, unknown>;
      ts: Date;
    };
  }
});
