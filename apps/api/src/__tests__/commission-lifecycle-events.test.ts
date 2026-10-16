/**
 * Commission lifecycle webhooks: every path that approves, reverses or
 * pays a commission must fire the matching commission.* event, and the
 * payload must carry the commission's origin (clickId / eventId /
 * eventType / programId) so partner postback macros resolve beyond
 * commission.accrued.
 *
 * Regressions covered:
 *   - the holdback auto-approve job approved commissions silently, so
 *     subscribers missed most commission.approved events
 *   - manual approve checked only the program holdback, ignoring the
 *     partner's snapshotted one the queue and the job both honor
 *   - approved / reversed / paid payloads had no click or event fields
 *
 * The Stripe refund path is covered in stripe-webhook.test.ts.
 * dispatchEvent is mocked so the assertions read the exact payloads.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';

const ADMIN_KEY = 'op_test_lifecycle_admin_0123456789abcdef012';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { dispatchEvent } = await import('../webhook-dispatcher.js');
const { dispatchCommissionEvents } = await import('../commission-events.js');
const { runCommissionAutoApproveJob } = await import('../scheduler.js');
const { runPayouts } = await import('../payouts.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const TABLES_TO_CLEAN = [
  TABLES.PartnerCommission,
  TABLES.Commission,
  // After Commission (Commission.payoutId), before Partner (Payout.partnerId).
  TABLES.Payout,
  TABLES.Attribution,
  TABLES.Event,
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Program,
  TABLES.Partner,
];

interface Seeded {
  commissionId: string;
  partnerId: string;
  programId: string;
  clickId: string;
  eventId: string;
  attributionId: string;
}

async function seedCommission(opts: {
  programHoldbackDays?: number | null;
  partnerHoldbackDays?: number | null;
  accruedDaysAgo?: number;
  status?: 'accrued' | 'approved';
  eventType?: string;
}): Promise<Seeded> {
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
    holdbackDays: opts.programHoldbackDays ?? null,
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
    type: opts.eventType ?? 'invoice_paid', value: '100.00', currency: 'USD', ts: new Date(),
  });
  await db(TABLES.Attribution).insert({
    id: attributionId, tenantId: DEFAULT_TENANT_ID, eventId, partnerId, programId,
    clickId, model: 'last_click', weight: '1', computedAt: new Date(),
  });
  if (opts.partnerHoldbackDays !== undefined) {
    await db(TABLES.PartnerCommission).insert({
      partnerId, tenantId: DEFAULT_TENANT_ID, commissionType: 'percent',
      commissionValue: '20', recurring: false, holdbackDays: opts.partnerHoldbackDays,
      source: 'amendment',
    });
  }
  const accruedAt = new Date(Date.now() - (opts.accruedDaysAgo ?? 0) * 24 * 60 * 60 * 1000);
  await db(TABLES.Commission).insert({
    id: commissionId, tenantId: DEFAULT_TENANT_ID, attributionId, partnerId,
    amount: '20.00', currency: 'USD', status: opts.status ?? 'accrued', accruedAt,
  });
  return { commissionId, partnerId, programId, clickId, eventId, attributionId };
}

/** Every dispatchEvent call for `event`, as [tenantId, payload]. */
function dispatched(event: string): Array<[string, Record<string, unknown>]> {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.filter((c) => c[1] === event)
    .map((c) => [c[0], c[2] as Record<string, unknown>]);
}

function expectedPayload(s: Seeded, extra: Record<string, unknown> = {}) {
  return {
    commissionId: s.commissionId,
    partnerId: s.partnerId,
    attributionId: s.attributionId,
    amount: '20.00',
    currency: 'USD',
    clickId: s.clickId,
    eventId: s.eventId,
    eventType: 'invoice_paid',
    programId: s.programId,
    ...extra,
  };
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
  vi.mocked(dispatchEvent).mockClear();
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

describe.skipIf(skipIntegration)('commission lifecycle webhooks', () => {
  it('the holdback auto-approve job fires commission.approved for exactly what it approved', async () => {
    const matured = await seedCommission({ programHoldbackDays: 7, accruedDaysAgo: 10 });
    const pending = await seedCommission({ programHoldbackDays: 30, accruedDaysAgo: 3 });

    const result = await runCommissionAutoApproveJob();
    // Log-sized: counts only, never the approved rows.
    const mine = result.find((r) => r.tenantId === DEFAULT_TENANT_ID);
    expect(mine).toMatchObject({ ok: true, approvedCount: 1 });
    expect(mine).not.toHaveProperty('result');

    expect(await statusOf(matured.commissionId)).toBe('approved');
    expect(await statusOf(pending.commissionId)).toBe('accrued');

    await vi.waitFor(() => expect(dispatched('commission.approved')).toHaveLength(1));
    const [tenantId, payload] = dispatched('commission.approved')[0]!;
    expect(tenantId).toBe(DEFAULT_TENANT_ID);
    expect(payload).toEqual(expectedPayload(matured));
  });

  it('a re-run of the job approves nothing new and fires nothing', async () => {
    await seedCommission({ programHoldbackDays: 7, accruedDaysAgo: 10 });
    await runCommissionAutoApproveJob();
    await vi.waitFor(() => expect(dispatched('commission.approved')).toHaveLength(1));

    vi.mocked(dispatchEvent).mockClear();
    const again = await runCommissionAutoApproveJob();
    expect(again.find((r) => r.tenantId === DEFAULT_TENANT_ID)).toMatchObject({ approvedCount: 0 });
    // Give any stray async dispatch a chance to land before asserting none did.
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatched('commission.approved')).toHaveLength(0);
  });

  it('manual approve refuses while the PARTNER holdback is active, even with no program holdback', async () => {
    const s = await seedCommission({ programHoldbackDays: null, partnerHoldbackDays: 30, accruedDaysAgo: 3 });

    const res = await request(app)
      .post(`/commissions/${s.commissionId}/approve`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('holdback_active');
    expect(res.body.holdbackDays).toBe(30);
    expect(await statusOf(s.commissionId)).toBe('accrued');
    expect(dispatched('commission.approved')).toHaveLength(0);
  });

  it('manual approve agrees with the review queue on the effective holdback', async () => {
    // Partner snapshot 0 overrides a 30-day program holdback (the same
    // COALESCE the queue and the job use), so the queue shows no
    // maturity date and approval must be allowed.
    const s = await seedCommission({ programHoldbackDays: 30, partnerHoldbackDays: 0, accruedDaysAgo: 3 });

    const queue = await request(app).get('/commissions').set('Authorization', `Bearer ${ADMIN_KEY}`);
    const row = queue.body.commissions.find((c: { id: string }) => c.id === s.commissionId);
    expect(row).toMatchObject({ holdbackDays: 0, matureAt: null });

    const res = await request(app)
      .post(`/commissions/${s.commissionId}/approve`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.commission.status).toBe('approved');
    // The approval's webhook is fire-and-forget (it reads the origin
    // first). Let it land here, or on a slow runner it arrives after the
    // next test's mockClear and is counted there.
    await vi.waitFor(() => expect(dispatched('commission.approved')).toHaveLength(1));
  });

  it('manual approve fires commission.approved with the click/event origin', async () => {
    const s = await seedCommission({ programHoldbackDays: 7, accruedDaysAgo: 10 });

    const res = await request(app)
      .post(`/commissions/${s.commissionId}/approve`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);

    const mine = () => dispatched('commission.approved').filter(([, p]) => p.commissionId === s.commissionId);
    await vi.waitFor(() => expect(mine()).toHaveLength(1));
    expect(mine()[0]).toEqual([DEFAULT_TENANT_ID, expectedPayload(s)]);
  });

  it('manual reverse fires commission.reversed with the origin and reason=manual', async () => {
    const s = await seedCommission({ status: 'approved' });

    const res = await request(app)
      .post(`/commissions/${s.commissionId}/reverse`)
      .set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(dispatched('commission.reversed')).toHaveLength(1));
    expect(dispatched('commission.reversed')[0]).toEqual([
      DEFAULT_TENANT_ID,
      expectedPayload(s, { reason: 'manual' }),
    ]);
  });

  it('a manual-rail payout fires commission.paid with the origin and payoutId', async () => {
    const s = await seedCommission({ status: 'approved' });
    const tenant = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
    await db(TABLES.Tenant)
      .where({ id: DEFAULT_TENANT_ID })
      .update({ payoutRailPreference: 'manual', payoutThresholdCents: 0 });
    try {
      const run = await db.transaction((trx) => runPayouts(trx, DEFAULT_TENANT_ID));
      const payout = run.payouts.find((p) => p.partnerId === s.partnerId);
      expect(payout?.method).toBe('manual');
      expect(await statusOf(s.commissionId)).toBe('paid');

      await vi.waitFor(() => expect(dispatched('commission.paid')).toHaveLength(1));
      expect(dispatched('commission.paid')[0]).toEqual([
        DEFAULT_TENANT_ID,
        expectedPayload(s, { payoutId: payout!.payoutId }),
      ]);
    } finally {
      await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({
        payoutRailPreference: tenant?.payoutRailPreference ?? null,
        payoutThresholdCents: tenant?.payoutThresholdCents ?? null,
      });
    }
  });

  it('never reads another tenant\'s origin, and still fires the bare payload without one', async () => {
    const s = await seedCommission({ status: 'approved' });
    const commission = await db(TABLES.Commission).where({ id: s.commissionId }).first();

    // Same rows, wrong tenant: the lookup is tenant-filtered, so no
    // origin fields leak across tenants, but the event still fires.
    await dispatchCommissionEvents('tenant_other', 'commission.approved', [commission]);
    expect(dispatched('commission.approved')).toEqual([
      [
        'tenant_other',
        {
          commissionId: s.commissionId,
          partnerId: s.partnerId,
          attributionId: s.attributionId,
          amount: '20.00',
          currency: 'USD',
        },
      ],
    ]);
  });
});
