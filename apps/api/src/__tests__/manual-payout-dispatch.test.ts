/**
 * Manual-rail payout webhooks fire only after the payout run commits.
 *
 * runPayouts runs inside its caller's transaction: the scheduler's
 * per-tenant transaction, or the admin route's planning transaction. It
 * used to dispatch payout.created + commission.paid inline, so a throw
 * later in the same run (e.g. the "concurrent payout run; aborting" claim
 * check for a later partner) rolled the payout back after the brand
 * webhook and the partner postback had already gone out. runPayouts now
 * returns the notifications, and each caller dispatches them after commit.
 *
 * The later failure is simulated by wrapping the real runPayouts so it
 * throws once it has written its manual payouts, which is the same point
 * in the transaction a later partner's abort reaches. dispatchEvent is
 * mocked so the assertions read the exact payloads.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';

const ADMIN_KEY = 'op_test_payout_dispatch_admin_0123456789abcd';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

vi.mock('../webhook-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook-dispatcher.js')>();
  return { ...actual, dispatchEvent: vi.fn() };
});
// Spy on runPayouts so a test can make the run fail after its writes.
// The scheduler and the admin route both import it from here.
vi.mock('../payouts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payouts.js')>();
  return { ...actual, runPayouts: vi.fn(actual.runPayouts) };
});

const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { dispatchEvent } = await import('../webhook-dispatcher.js');
const { runPayouts } = await import('../payouts.js');
const { runPayoutsJob } = await import('../scheduler.js');
const { runPayouts: realRunPayouts } = await vi.importActual<typeof import('../payouts.js')>('../payouts.js');
type PayoutRunResult = Awaited<ReturnType<typeof realRunPayouts>>;

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const TABLES_TO_CLEAN = [
  TABLES.Commission,
  // After Commission (Commission.payoutId), before Partner (Payout.partnerId).
  TABLES.Payout,
  TABLES.Attribution,
  TABLES.Event,
  // Before Click (Identity.clickId) — other files can leave stitched clicks.
  TABLES.Identity,
  TABLES.Click,
  TABLES.Link,
  TABLES.Program,
  TABLES.Partner,
];

const ABORT = 'claimed 0/1 commissions for partner p_later — concurrent payout run; aborting';

interface Seeded {
  partnerId: string;
  commissionIds: string[];
}

/** A partner with no Connect account and `count` approved $20 commissions. */
async function seedManualPartner(count: number): Promise<Seeded> {
  const partnerId = ulid();
  const programId = ulid();
  const linkId = ulid();
  const clickId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: DEFAULT_TENANT_ID, name: 'P', email: `p-${partnerId}@x.com` });
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: DEFAULT_TENANT_ID,
    name: 'Prog',
    attributionModel: 'last_click',
    attributionWindowDays: 60,
    commissionRule: { type: 'percent', value: 20 },
    destinationUrl: 'https://example.com',
  });
  await db(TABLES.Link).insert({
    id: linkId, tenantId: DEFAULT_TENANT_ID, partnerId, programId,
    linkKey: `lk-${linkId}`, destinationUrl: 'https://example.com',
  });
  await db(TABLES.Click).insert({
    id: clickId, tenantId: DEFAULT_TENANT_ID, linkId, partnerId, programId,
    landingUrl: 'https://example.com/l', ipHash: 'h', ts: new Date(),
  });
  const commissionIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const eventId = ulid();
    const attributionId = ulid();
    const commissionId = ulid();
    await db(TABLES.Event).insert({
      id: eventId, tenantId: DEFAULT_TENANT_ID, userId: `u-${eventId}`,
      type: 'invoice_paid', value: '100.00', currency: 'USD', ts: new Date(),
    });
    await db(TABLES.Attribution).insert({
      id: attributionId, tenantId: DEFAULT_TENANT_ID, eventId, partnerId, programId,
      clickId, model: 'last_click', weight: '1', computedAt: new Date(),
    });
    await db(TABLES.Commission).insert({
      id: commissionId, tenantId: DEFAULT_TENANT_ID, attributionId, partnerId,
      amount: '20.00', currency: 'USD', status: 'approved', accruedAt: new Date(),
    });
    commissionIds.push(commissionId);
  }
  return { partnerId, commissionIds };
}

/** Every dispatchEvent payload for `event` (all calls are for the default tenant). */
function dispatched(event: string): Array<Record<string, unknown>> {
  return vi
    .mocked(dispatchEvent)
    .mock.calls.filter((c) => c[1] === event)
    .map((c) => {
      expect(c[0]).toBe(DEFAULT_TENANT_ID);
      return c[2] as Record<string, unknown>;
    });
}

/**
 * What a reader OUTSIDE the run's transaction saw at the moment each
 * payout.created fired. The probe reads on the privileged pool, so it only
 * sees committed rows: a dispatch from inside the transaction would find
 * no Payout row and approved commissions.
 */
let probes: Array<Promise<{ payoutVisible: boolean; commissionStatuses: string[] }>> = [];
function probeCommitStateAtDispatch(): void {
  vi.mocked(dispatchEvent).mockImplementation((_tenantId, event, data) => {
    if (event !== 'payout.created') return;
    const { payoutId, commissionIds } = data as { payoutId: string; commissionIds: string[] };
    probes.push(
      (async () => {
        const payout = await db(TABLES.Payout).where({ id: payoutId }).first();
        const rows = await db(TABLES.Commission).whereIn('id', commissionIds).select('status');
        return { payoutVisible: !!payout, commissionStatuses: rows.map((r: { status: string }) => r.status) };
      })(),
    );
  });
}

/** Make the default tenant's run fail after its writes; capture what it planned. */
function failDefaultTenantRunAfterWrites(): { planned: PayoutRunResult | null } {
  const seen: { planned: PayoutRunResult | null } = { planned: null };
  vi.mocked(runPayouts).mockImplementation(async (trx, tenantId) => {
    const result = await realRunPayouts(trx, tenantId);
    if (tenantId !== DEFAULT_TENANT_ID) return result;
    seen.planned = result;
    throw new Error(ABORT);
  });
  return seen;
}

async function expectRolledBack(s: Seeded): Promise<void> {
  const rows = await db(TABLES.Commission).whereIn('id', s.commissionIds);
  expect(rows.map((r) => [r.status, r.payoutId])).toEqual(s.commissionIds.map(() => ['approved', null]));
  expect(await db(TABLES.Payout).where({ partnerId: s.partnerId })).toHaveLength(0);
}

/** Give any stray async dispatch a chance to land before asserting none did. */
const settle = () => new Promise((r) => setTimeout(r, 50));

let tenantBefore: Record<string, unknown> | undefined;

beforeAll(async () => {
  if (skipIntegration) return;
  tenantBefore = await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
  // Manual rail, no threshold, every tick runs (cadence null = weekly).
  await db(TABLES.Tenant)
    .where({ id: DEFAULT_TENANT_ID })
    .update({ payoutRailPreference: 'manual', payoutThresholdCents: 0, payoutCadence: null });
});

afterAll(async () => {
  if (!skipIntegration) {
    // Restore the tenant first: if a wipe below throws, later payout files
    // must not inherit the manual rail.
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({
      payoutRailPreference: tenantBefore?.payoutRailPreference ?? null,
      payoutThresholdCents: tenantBefore?.payoutThresholdCents ?? null,
      payoutCadence: tenantBefore?.payoutCadence ?? null,
    });
    for (const t of TABLES_TO_CLEAN) await db(t).del();
  }
  await db.destroy();
});

beforeEach(async () => {
  vi.mocked(dispatchEvent).mockReset();
  vi.mocked(runPayouts).mockImplementation(realRunPayouts);
  probes = [];
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) await db(t).del();
});

describe.skipIf(skipIntegration)('manual-rail payout webhooks fire only after the run commits', () => {
  it('admin run: announces each manual payout and its commissions after commit', async () => {
    const a = await seedManualPartner(2);
    const b = await seedManualPartner(1);
    probeCommitStateAtDispatch();

    const res = await request(app).post('/payouts/run').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('pendingNotifications');
    expect(res.body.payouts).toHaveLength(2);
    const payoutIdOf = (partnerId: string) =>
      (res.body.payouts as Array<{ partnerId: string; payoutId: string }>).find((p) => p.partnerId === partnerId)!
        .payoutId;

    const created = dispatched('payout.created');
    expect(created).toHaveLength(2);
    for (const [s, amount] of [[a, '40.00'], [b, '20.00']] as const) {
      const payload = created.find((p) => p.partnerId === s.partnerId)!;
      expect(payload).toEqual({
        payoutId: payoutIdOf(s.partnerId),
        partnerId: s.partnerId,
        amount,
        currency: 'USD',
        method: 'manual',
        commissionIds: expect.arrayContaining(s.commissionIds),
      });
      expect(payload.commissionIds).toHaveLength(s.commissionIds.length);
    }

    await vi.waitFor(() => expect(dispatched('commission.paid')).toHaveLength(3));
    for (const s of [a, b]) {
      for (const commissionId of s.commissionIds) {
        expect(dispatched('commission.paid')).toContainEqual(
          expect.objectContaining({
            commissionId,
            partnerId: s.partnerId,
            amount: '20.00',
            currency: 'USD',
            payoutId: payoutIdOf(s.partnerId),
          }),
        );
      }
    }

    // Both payouts were committed before their webhook fired.
    const atDispatch = await Promise.all(probes);
    expect(atDispatch.map((p) => p.payoutVisible)).toEqual([true, true]);
    expect(atDispatch.flatMap((p) => p.commissionStatuses)).toEqual(['paid', 'paid', 'paid']);
  });

  it('admin run: a run that rolls back after writing a manual payout announces nothing', async () => {
    const a = await seedManualPartner(2);
    const seen = failDefaultTenantRunAfterWrites();

    const res = await request(app).post('/payouts/run').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(500);

    // Not vacuous: the run did write a manual payout and queue its
    // webhooks before the abort.
    expect(seen.planned?.payouts).toEqual([expect.objectContaining({ partnerId: a.partnerId, method: 'manual' })]);
    expect(seen.planned?.pendingNotifications).toHaveLength(1);

    await settle();
    expect(dispatched('payout.created')).toHaveLength(0);
    expect(dispatched('commission.paid')).toHaveLength(0);
    await expectRolledBack(a);
  });

  it('scheduler job: announces a committed run, and its logged result carries no notifications', async () => {
    const a = await seedManualPartner(1);
    probeCommitStateAtDispatch();

    const out = await runPayoutsJob();
    const mine = out.planned.find((t) => t.tenantId === DEFAULT_TENANT_ID);
    expect(mine).toMatchObject({ ok: true, result: { payouts: [expect.objectContaining({ partnerId: a.partnerId })] } });
    expect(mine?.result).not.toHaveProperty('pendingNotifications');

    expect(dispatched('payout.created')).toEqual([expect.objectContaining({ partnerId: a.partnerId, method: 'manual' })]);
    await vi.waitFor(() =>
      expect(dispatched('commission.paid')).toEqual([
        expect.objectContaining({ commissionId: a.commissionIds[0], partnerId: a.partnerId }),
      ]),
    );
    expect(await Promise.all(probes)).toEqual([{ payoutVisible: true, commissionStatuses: ['paid'] }]);
  });

  it('scheduler job: a tenant whose run rolls back after writing a manual payout announces nothing', async () => {
    const a = await seedManualPartner(1);
    const seen = failDefaultTenantRunAfterWrites();

    const out = await runPayoutsJob();
    const mine = out.planned.find((t) => t.tenantId === DEFAULT_TENANT_ID);
    expect(mine).toMatchObject({ ok: false, error: ABORT });

    expect(seen.planned?.payouts).toEqual([expect.objectContaining({ partnerId: a.partnerId, method: 'manual' })]);
    expect(seen.planned?.pendingNotifications).toHaveLength(1);

    await settle();
    expect(dispatched('payout.created')).toHaveLength(0);
    expect(dispatched('commission.paid')).toHaveLength(0);
    await expectRolledBack(a);
  });

  it('scheduler job: announces each tenant as soon as its own run commits, before the next tenant runs', async () => {
    // Holding every tenant's announcements until the loop ended lost them
    // all if the process died mid-tick: those tenants' commissions were
    // already paid, so nothing re-announced them. Two tenants with a
    // manual payout each; whichever runs second must find the first
    // one's payout.created already dispatched. forEachActiveTenant has no
    // ORDER BY, so the test doesn't assume which goes first.
    const a = await seedManualPartner(1);
    const OTHER_TENANT_ID = `t_dispatch_${ulid().toLowerCase()}`;
    await db(TABLES.Tenant).insert({
      id: OTHER_TENANT_ID, slug: OTHER_TENANT_ID, displayName: 'Other', status: 'active',
    });
    const announced = () =>
      vi.mocked(dispatchEvent).mock.calls.filter((c) => c[1] === 'payout.created').map((c) => c[0]);
    const emptyRun = (): PayoutRunResult => ({
      runId: ulid(), mode: 'selfhost', payouts: [], skippedBelowThreshold: [], skippedUnfunded: [],
      pendingNotifications: [],
    });
    const runs: Array<{ tenantId: string; announcedBefore: string[] }> = [];
    vi.mocked(runPayouts).mockImplementation(async (trx, tenantId) => {
      // Any other active tenant left in the DB runs nothing (RLS is
      // bypassed on this connection, so a real run could take ours).
      if (tenantId !== DEFAULT_TENANT_ID && tenantId !== OTHER_TENANT_ID) return emptyRun();
      runs.push({ tenantId, announcedBefore: announced() });
      if (tenantId === DEFAULT_TENANT_ID) return realRunPayouts(trx, tenantId);
      // The other tenant's run is synthetic for the same reason.
      return {
        ...emptyRun(),
        pendingNotifications: [
          {
            payout: {
              payoutId: ulid(), partnerId: 'p_other', amount: '5.00', currency: 'USD',
              method: 'manual', commissionIds: [],
            },
            commissions: [],
          },
        ],
      };
    });

    try {
      const out = await runPayoutsJob();
      for (const tenantId of [DEFAULT_TENANT_ID, OTHER_TENANT_ID]) {
        const t = out.planned.find((p) => p.tenantId === tenantId);
        expect(t).toMatchObject({ ok: true });
        expect(t?.result).not.toHaveProperty('pendingNotifications');
      }

      expect(runs.map((r) => r.tenantId).sort()).toEqual([DEFAULT_TENANT_ID, OTHER_TENANT_ID].sort());
      const [first, second] = runs;
      expect(first!.announcedBefore).toEqual([]);
      // The heart of it: the first tenant was announced before the second
      // tenant's run even started.
      expect(second!.announcedBefore).toEqual([first!.tenantId]);
      expect(announced()).toEqual([first!.tenantId, second!.tenantId]);

      // The default tenant's announcement is its real committed payout.
      const mine = vi
        .mocked(dispatchEvent)
        .mock.calls.find((c) => c[0] === DEFAULT_TENANT_ID && c[1] === 'payout.created');
      expect(mine?.[2]).toMatchObject({ partnerId: a.partnerId, method: 'manual' });
    } finally {
      await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
    }
  });
});
