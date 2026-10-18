/**
 * Billable-GMV event types (metering leak #3). Only Stripe-native revenue
 * events count by default, so a merchant reporting revenue under a CUSTOM
 * type accrued partner commissions but escaped the platform %. A program
 * now declares its own revenue types (Program.revenueEventTypes), which
 * replaced the platform-wide OPENPARTNER_BILLABLE_EVENT_TYPES_EXTRA env var.
 * (On the commission-floor rule a percent commission makes any type revenue;
 * see usage-fee-rule.test.ts.)
 */

import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const { db } = await import('../db.js');
const { aggregateAttributedGmv } = await import('../usage-billing.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

async function seedAttributedEvent(type: string, value: number, revenueEventTypes: string[] = []): Promise<void> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  const eventId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, name: 'P', email: `p-${partnerId}@x.com` });
  await db(TABLES.Program).insert({
    id: programId, tenantId: DEFAULT_TENANT_ID, name: 'Prog', attributionModel: 'last_click',
    attributionWindowDays: 60, commissionRule: { type: 'percent', value: 20 }, destinationUrl: 'https://x/',
    revenueEventTypes,
  });
  await db(TABLES.Link).insert({ id: linkId, tenantId: DEFAULT_TENANT_ID, partnerId, programId, linkKey: `lk-${linkId}`, destinationUrl: 'https://x/' });
  await db(TABLES.Click).insert({ id: clickId, tenantId: DEFAULT_TENANT_ID, linkId, partnerId, programId, landingUrl: 'https://x/', ipHash: 'h', ts: new Date() });
  await db(TABLES.Event).insert({ id: eventId, tenantId: DEFAULT_TENANT_ID, userId: `u-${eventId}`, type, value: value.toFixed(2), currency: 'USD', ts: new Date() });
  await db(TABLES.Attribution).insert({ id: ulid(), tenantId: DEFAULT_TENANT_ID, eventId, partnerId, programId, clickId, model: 'last_click', weight: '1', computedAt: new Date() });
}

const CLEAN = [TABLES.Attribution, TABLES.Event, TABLES.Click, TABLES.Link, TABLES.Program, TABLES.Partner];

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});
afterAll(async () => {
  if (!skipIntegration) for (const t of CLEAN) await db(t).del();
  await db.destroy();
});
beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of CLEAN) await db(t).del();
});

describe.skipIf(skipIntegration)('aggregateAttributedGmv billable types', () => {
  it('excludes a custom revenue type its program has not declared (the leak)', async () => {
    await seedAttributedEvent('order_paid', 100);
    const gmv = await aggregateAttributedGmv(db, DEFAULT_TENANT_ID, null, new Date());
    expect(gmv).toEqual({});
  });

  it('counts a custom revenue type its program declares', async () => {
    await seedAttributedEvent('order_paid', 100, ['order_paid']);
    await seedAttributedEvent('invoice_paid', 50);
    // Declared on one program only: another program's order_paid isn't revenue.
    await seedAttributedEvent('order_paid', 70);
    const gmv = await aggregateAttributedGmv(db, DEFAULT_TENANT_ID, null, new Date());
    expect(gmv).toEqual({ USD: 150 });
  });
});
