/**
 * Funding reservation + release — the DB-side state machine (spec §5/§7).
 * Integration tier: needs the migrated local Postgres; Stripe never enters
 * (reservation is deliberately Stripe-free, and release is tested up to
 * the PI boundary with a null client on batches that never got one).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';
import { db } from '../db.js';
import { reserveFundingBatch } from '../funding/reserve.js';
import { releaseBatch } from '../funding/release.js';
import { confirmFundingFromPaymentIntent } from '../funding/confirm.js';
import { casBatch, tryTenantPayoutLock, toMinor } from '../funding/state.js';
import type { HostedFundingBatchRow } from '@openpartner/db';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;

async function seedCommissions(n: number, amount = '40.00'): Promise<{ partnerId: string; ids: string[] }> {
  const partnerId = ulid();
  await db(TABLES.Partner).insert({ id: partnerId, tenantId: TENANT, email: `p${partnerId}@x.test`, name: 'P' });
  const programId = ulid();
  await db(TABLES.Program).insert({
    id: programId,
    tenantId: TENANT,
    name: 'prog',
    commissionRule: JSON.stringify([{ trigger: 'every', type: 'percent', value: 20 }]),
    destinationUrl: 'https://x.test',
    attributionWindowDays: 60,
    attributionModel: 'last_click',
  });
  // Commission requires a real Attribution → Event → Click chain; one
  // shared attribution is enough (no uniqueness on Commission.attributionId).
  const clickId = ulid();
  await db(TABLES.Click).insert({
    id: clickId,
    tenantId: TENANT,
    partnerId,
    programId,
    landingUrl: 'https://x.test/',
    ts: new Date(),
  });
  const eventId = ulid();
  await db(TABLES.Event).insert({
    id: eventId,
    tenantId: TENANT,
    userId: `u-${clickId}`,
    type: 'invoice_paid',
    value: amount,
    currency: 'USD',
    ts: new Date(),
  });
  const attributionId = ulid();
  await db(TABLES.Attribution).insert({
    id: attributionId,
    tenantId: TENANT,
    eventId,
    clickId,
    partnerId,
    programId,
    model: 'last_click',
    weight: '1',
    computedAt: new Date(),
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = ulid();
    ids.push(id);
    await db(TABLES.Commission).insert({
      id,
      tenantId: TENANT,
      partnerId,
      attributionId,
      amount,
      currency: 'USD',
      status: 'approved',
    });
  }
  return { partnerId, ids };
}

beforeEach(async () => {
  if (skipIntegration) return;
  // Child tables before parents — earlier test files leave rows behind.
  for (const t of [
    TABLES.HostedFundingTransfer,
    TABLES.HostedFundingAllocation,
    TABLES.HostedFundingBatch,
    TABLES.HostedFundingAuthorization,
    TABLES.Commission,
    TABLES.Attribution,
    TABLES.Event,
    TABLES.Identity,
    TABLES.Click,
    TABLES.Link,
    TABLES.Coupon,
    TABLES.PartnerProgram,
    TABLES.PartnerCommission,
    TABLES.Payout,
    TABLES.Program,
    TABLES.Partner,
  ]) {
    await db(t).del();
  }
});

afterAll(async () => {
  // Leave no funding rows behind: later test files wipe Commission and
  // would trip the HostedFundingAllocation FK on anything we leaked.
  if (!skipIntegration) {
    for (const t of [TABLES.HostedFundingTransfer, TABLES.HostedFundingAllocation, TABLES.HostedFundingBatch, TABLES.HostedFundingAuthorization, TABLES.Commission]) {
      await db(t).del();
    }
  }
  await db.destroy();
});

describe.skipIf(skipIntegration)('funding reservation', () => {
  it('reserves approved commissions into a batch with exact minor-unit principal', async () => {
    const { partnerId, ids } = await seedCommissions(3, '40.00');
    const result = await db.transaction(async (trx) => {
      expect(await tryTenantPayoutLock(trx, TENANT)).toBe(true);
      return reserveFundingBatch(trx, TENANT, 'usd', [
        { partnerId, commissionIds: ids, amountMinor: toMinor('120.00') },
      ]);
    });
    expect(result.skipped).toBeNull();
    expect(result.principalMinor).toBe(12000);
    const batch = await db(TABLES.HostedFundingBatch).where({ id: result.batchId! }).first();
    expect(batch.status).toBe('reserved');
    expect(Number(batch.grossChargeMinor)).toBe(12000);
    const allocs = await db(TABLES.HostedFundingAllocation).where({ batchId: result.batchId! });
    expect(allocs).toHaveLength(3);
    expect(allocs.every((a: { state: string }) => a.state === 'reserved')).toBe(true);
  });

  it('a live allocation excludes the commission from any second batch (blocker-1 index)', async () => {
    const { partnerId, ids } = await seedCommissions(2);
    await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId, commissionIds: ids, amountMinor: 8000 }]),
    );
    // Force-close the open batch WITHOUT releasing allocations (simulates
    // a mid-lifecycle batch) so the open-batch check doesn't shadow the
    // allocation exclusivity we're testing.
    await db(TABLES.HostedFundingBatch).update({ status: 'settled', updatedAt: new Date() });
    const second = await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId, commissionIds: ids, amountMinor: 8000 }]),
    );
    expect(second.batchId).toBeNull();
    expect(second.skipped).toBe('nothing_eligible');
  });

  it('one open batch per tenant+currency — later commissions roll forward', async () => {
    const a = await seedCommissions(1);
    await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId: a.partnerId, commissionIds: a.ids, amountMinor: 4000 }]),
    );
    const b = await seedCommissions(1);
    const second = await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId: b.partnerId, commissionIds: b.ids, amountMinor: 4000 }]),
    );
    expect(second.skipped).toBe('open_batch_exists');
  });

  it('applies the $25 platform floor', async () => {
    const { partnerId, ids } = await seedCommissions(1, '10.00');
    const result = await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId, commissionIds: ids, amountMinor: 1000 }]),
    );
    expect(result.batchId).toBeNull();
    expect(result.skipped).toBe('below_floor');
  });

  it('non-USD currencies stay unreserved at launch', async () => {
    const { partnerId, ids } = await seedCommissions(1, '100.00');
    const result = await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'gbp', [{ partnerId, commissionIds: ids, amountMinor: 10000 }]),
    );
    expect(result.batchId).toBeNull();
  });

  it('reservation never touches Commission status', async () => {
    const { partnerId, ids } = await seedCommissions(2);
    await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId, commissionIds: ids, amountMinor: 8000 }]),
    );
    const commissions = await db(TABLES.Commission).whereIn('id', ids);
    expect(commissions.every((c: { status: string }) => c.status === 'approved')).toBe(true);
  });
});

describe.skipIf(skipIntegration)('release protocol', () => {
  async function reservedBatch(): Promise<HostedFundingBatchRow> {
    const { partnerId, ids } = await seedCommissions(2);
    const r = await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId, commissionIds: ids, amountMinor: 8000 }]),
    );
    return (await db(TABLES.HostedFundingBatch).where({ id: r.batchId! }).first()) as HostedFundingBatchRow;
  }

  it('releases a never-charged batch: allocations freed, commissions selectable again', async () => {
    const batch = await reservedBatch();
    const outcome = await releaseBatch(db, null, batch, 'test_timeout');
    expect(outcome).toBe('released');
    const allocs = await db(TABLES.HostedFundingAllocation).where({ batchId: batch.id });
    expect(allocs.every((a: { state: string }) => a.state === 'released')).toBe(true);
    // The freed commissions are reservable again in a fresh batch.
    const commissionIds = allocs.map((a: { commissionId: string }) => a.commissionId);
    const partnerId = (allocs[0] as { partnerId: string }).partnerId;
    const again = await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId, commissionIds, amountMinor: 8000 }]),
    );
    expect(again.batchId).not.toBeNull();
  });

  it('a funding webhook landing during release loses the CAS and defers', async () => {
    const batch = await reservedBatch();
    expect(await casBatch(db, batch.id, 'reserved', 'funded')).not.toBeNull();
    const outcome = await releaseBatch(db, null, batch, 'test');
    expect(outcome).toBe('lost_cas');
    const after = await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first();
    expect(after.status).toBe('funded');
  });

  it('payment succeeding against a released batch escalates to recovery_required', async () => {
    const batch = await reservedBatch();
    await releaseBatch(db, null, batch, 'test');
    await db(TABLES.HostedFundingBatch)
      .where({ id: batch.id })
      .update({ stripePaymentIntentId: 'pi_test_late' });
    const outcome = await confirmFundingFromPaymentIntent(db, batch.id, {
      id: 'pi_test_late',
      status: 'succeeded',
      amount_received: 8000,
      currency: 'usd',
      latest_charge: 'ch_test',
    } as never);
    expect(outcome).toBe('verification_failed');
    const after = await db(TABLES.HostedFundingBatch).where({ id: batch.id }).first();
    expect(after.status).toBe('recovery_required');
  });
});

describe.skipIf(skipIntegration)('funding confirmation verification', () => {
  it('refuses amount and currency mismatches', async () => {
    const { partnerId, ids } = await seedCommissions(2);
    const r = await db.transaction((trx) =>
      reserveFundingBatch(trx, TENANT, 'usd', [{ partnerId, commissionIds: ids, amountMinor: 8000 }]),
    );
    await db(TABLES.HostedFundingBatch)
      .where({ id: r.batchId! })
      .update({ status: 'payment_processing', stripePaymentIntentId: 'pi_x' });
    const base = { id: 'pi_x', status: 'succeeded', currency: 'usd', latest_charge: 'ch_x' };
    expect(
      await confirmFundingFromPaymentIntent(db, r.batchId!, { ...base, amount_received: 7999 } as never),
    ).toBe('verification_failed');
    expect(
      await confirmFundingFromPaymentIntent(db, r.batchId!, { ...base, amount_received: 8000, currency: 'eur' } as never),
    ).toBe('verification_failed');
    expect(
      await confirmFundingFromPaymentIntent(db, r.batchId!, { ...base, amount_received: 8000 } as never),
    ).toBe('funded');
  });
});
