/**
 * Regression: commission-auto-approve was shipping a query that referenced
 * the UPDATE target table `c` inside a FROM-clause LEFT JOIN, which Postgres
 * rejects ("invalid reference to FROM-clause entry for table c"). The job
 * failed for every tenant nightly, so matured commissions never advanced
 * from 'accrued' to 'approved' and never reached payout. These tests run
 * the real query against Postgres so the SQL shape is exercised.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const { db } = await import('../db.js');
const { autoApproveMatureCommissions } = await import('../commission-auto-approve.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const TABLES_TO_CLEAN = [
  TABLES.PartnerCommission,
  TABLES.Commission,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Program,
  TABLES.Partner,
];

async function seedAccruedCommission(opts: {
  programHoldbackDays: number | null;
  accruedDaysAgo: number;
  partnerHoldbackDays?: number | null;
}): Promise<string> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  const eventId = ulid();
  const attributionId = ulid();
  const commissionId = ulid();

  await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, name: 'P', email: `p-${partnerId}@x.com` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Prog',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    destinationUrl: 'https://example.com',
    holdbackDays: opts.programHoldbackDays,
  });
  await db(TABLES.Link).insert({
    id: linkId, tenantId: DEFAULT_TENANT_ID, partnerId, programId,
    linkKey: `lk-${linkId}`, destinationUrl: 'https://example.com',
  });
  await db(TABLES.Click).insert({
    id: clickId, tenantId: DEFAULT_TENANT_ID, linkId, partnerId, programId,
    landingUrl: 'https://example.com/l', ipHash: 'h', ts: new Date(),
  });
  await db(TABLES.Event).insert({
    id: eventId, tenantId: DEFAULT_TENANT_ID, userId: `u-${eventId}`,
    type: 'invoice_paid', value: '100.00', currency: 'USD', ts: new Date(),
  });
  await db(TABLES.Attribution).insert({
    id: attributionId, tenantId: DEFAULT_TENANT_ID, eventId, partnerId, programId,
    clickId, model: 'last_click', weight: '1', computedAt: new Date(),
  });
  if (opts.partnerHoldbackDays !== undefined) {
    await db(TABLES.PartnerCommission).insert({
      partnerId, tenantId: DEFAULT_TENANT_ID, commissionType: 'percent',
      commissionValue: '20', recurring: false, holdbackDays: opts.partnerHoldbackDays,
      source: 'admin',
    });
  }
  const accruedAt = new Date(Date.now() - opts.accruedDaysAgo * 24 * 60 * 60 * 1000);
  await db(TABLES.Commission).insert({
    id: commissionId, tenantId: DEFAULT_TENANT_ID, attributionId, partnerId,
    amount: '20.00', currency: 'USD', status: 'accrued', accruedAt,
  });
  return commissionId;
}

async function statusOf(id: string): Promise<string | undefined> {
  const row = await db(TABLES.Commission).where({ id }).first();
  return row?.status as string | undefined;
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  if (!skipIntegration) {
    for (const t of TABLES_TO_CLEAN) await db(t).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

describe.skipIf(skipIntegration)('autoApproveMatureCommissions', () => {
  it('runs the UPDATE...FROM without a FROM-clause reference error', async () => {
    // The pre-fix query threw "invalid reference to FROM-clause entry for
    // table c". Just executing against Postgres is the core regression guard.
    await expect(autoApproveMatureCommissions(db)).resolves.toBeTruthy();
  });

  it('approves an accrued commission whose program holdback has elapsed', async () => {
    const id = await seedAccruedCommission({ programHoldbackDays: 7, accruedDaysAgo: 10 });
    const res = await autoApproveMatureCommissions(db);
    expect(res.approvedCount).toBe(1);
    expect(await statusOf(id)).toBe('approved');
  });

  it('leaves an accrued commission whose holdback has NOT elapsed', async () => {
    const id = await seedAccruedCommission({ programHoldbackDays: 30, accruedDaysAgo: 3 });
    const res = await autoApproveMatureCommissions(db);
    expect(res.approvedCount).toBe(0);
    expect(await statusOf(id)).toBe('accrued');
  });

  it('prefers the partner-snapshotted holdback over the program value', async () => {
    // Program holdback (30) would NOT have elapsed at 10 days, but the
    // partner snapshot (7) has — the COALESCE must pick the partner value,
    // exercising the PartnerCommission join keyed on a."partnerId".
    const id = await seedAccruedCommission({
      programHoldbackDays: 30, partnerHoldbackDays: 7, accruedDaysAgo: 10,
    });
    const res = await autoApproveMatureCommissions(db);
    expect(res.approvedCount).toBe(1);
    expect(await statusOf(id)).toBe('approved');
  });

  it('does not approve when holdback is null/0 (manual-approval programs)', async () => {
    const id = await seedAccruedCommission({ programHoldbackDays: null, accruedDaysAgo: 100 });
    const res = await autoApproveMatureCommissions(db);
    expect(res.approvedCount).toBe(0);
    expect(await statusOf(id)).toBe('accrued');
  });
});
