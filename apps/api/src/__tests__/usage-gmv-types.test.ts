/**
 * Billable-GMV event types (metering leak #3). By default only Stripe-native
 * revenue events count, so a merchant reporting revenue under a CUSTOM type
 * accrues partner commissions but escapes the platform %. The billable set is
 * now explicit + extensible (default + OPENPARTNER_BILLABLE_EVENT_TYPES_EXTRA),
 * and aggregateAttributedGmv accepts the set so a custom type can be counted.
 */

import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const { db } = await import('../db.js');
const { aggregateAttributedGmv } = await import('../usage-billing.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

async function seedAttributedEvent(type: string, value: number): Promise<void> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  const eventId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, name: 'P', email: `p-${partnerId}@x.com` });
  await db(TABLES.Program).insert({
    id: programId, tenantId: DEFAULT_TENANT_ID, name: 'Prog', attributionModel: 'last_click',
    attributionWindowDays: 60, commissionRule: { type: 'percent', value: 20 }, destinationUrl: 'https://x/',
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
  it('excludes a custom revenue type by default (the leak)', async () => {
    await seedAttributedEvent('order_paid', 100);
    const gmv = await aggregateAttributedGmv(db, null, new Date());
    expect(gmv).toBe(0);
  });

  it('counts a custom revenue type when it is in the billable set', async () => {
    await seedAttributedEvent('order_paid', 100);
    await seedAttributedEvent('invoice_paid', 50);
    const gmv = await aggregateAttributedGmv(db, null, new Date(), ['invoice_paid', 'subscription_created', 'order_paid']);
    expect(gmv).toBe(150);
  });
});
