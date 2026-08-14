/**
 * Operator-recovery apply loop (decision B, audit handoff §0.4).
 *
 * DB-backed; Stripe is a hand-rolled mock so every test pins exactly what
 * reached the money API. The properties under test, in order of blood
 * spilled getting here:
 *
 *   - the apply loop calls the EXISTING operator functions and inherits
 *     their verification — a refused premise refuses the request
 *   - the tenant boundary holds on the privileged pool
 *   - retryable outcomes stay pending with PACED retries, and the attempt
 *     budget closes them as failed instead of spinning forever
 *   - writes are lease/token-fenced, so a raced claim settles once
 *   - the post-apply recheck alarms on a late-landing transfer without
 *     writing any payout state
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { ulid } from 'ulid';
import {
  TABLES,
  DEFAULT_TENANT_ID,
  type OperatorRecoveryRequestRow,
  type TenantRow,
} from '@openpartner/db';
import { db } from '../db.js';
import { runPayouts } from '../payouts.js';
import { applyRecoveryRequests } from '../operator-recovery.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;
const TENANT_B = 'recovery-test-tenant-b';

// ---- Stripe mock ----------------------------------------------------------

interface FakeTransfer {
  id: string;
  amount: number;
  currency: string;
  transfer_group?: string;
  metadata: Record<string, string>;
  amount_reversed?: number;
  reversed?: boolean;
  destination?: string;
  created?: number;
}

function mockStripe(
  opts: {
    listed?: FakeTransfer[];
    listThrows?: boolean;
    /** PaymentIntents visible to the funding metadata search. */
    searchData?: Array<{ id: string; status: string }>;
  } = {},
) {
  const transfersList = vi.fn(async ({ transfer_group }: { transfer_group?: string }) => {
    if (opts.listThrows) throw new Error('stripe unreachable');
    return {
      data: (opts.listed ?? []).filter((t) => !transfer_group || t.transfer_group === transfer_group),
      has_more: false,
    };
  });
  const transfersRetrieve = vi.fn(async (id: string) => {
    const known = (opts.listed ?? []).find((t) => t.id === id);
    if (!known) throw Object.assign(new Error('no such transfer'), { code: 'resource_missing' });
    return known;
  });
  const paymentIntentsSearch = vi.fn(async () => ({ data: opts.searchData ?? [], has_more: false }));
  const paymentIntentsList = vi.fn(async () => ({ data: [], has_more: false }));
  const stripe = {
    transfers: { list: transfersList, retrieve: transfersRetrieve },
    paymentIntents: { search: paymentIntentsSearch, list: paymentIntentsList },
  } as unknown as Stripe;
  return { stripe, transfersList, transfersRetrieve, paymentIntentsSearch };
}

// ---- Seeding --------------------------------------------------------------

async function seedPartner(): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: TENANT,
    email: `p${id}@x.test`,
    name: 'P',
    stripeConnectAccountId: `acct_${id.slice(0, 10)}`,
    metadata: { stripe: { payoutsEnabled: true } },
  });
  return id;
}

async function seedApproved(partnerId: string, n: number, amount = '50.00'): Promise<string[]> {
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
  return ids;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

/** A committed intent moved into a held state, the way prod gets there. */
async function seedHeldIntent(
  state = 'reconcile_required',
  extra: Record<string, unknown> = {},
): Promise<{ payoutId: string; commissionIds: string[]; destination: string }> {
  const partnerId = await seedPartner();
  const commissionIds = await seedApproved(partnerId, 1, '50.00');
  const { payouts } = await db.transaction((trx) => runPayouts(trx, TENANT));
  const payoutId = payouts[0]!.payoutId;
  await db(TABLES.Payout)
    .where({ id: payoutId })
    .update({
      metadata: db.raw(`"metadata" || ?::jsonb`, [
        JSON.stringify({ transferState: state, postedAt: hoursAgo(25).toISOString(), ...extra }),
      ]),
    });
  return { payoutId, commissionIds, destination: `acct_${partnerId.slice(0, 10)}` };
}

async function insertRequest(spec: {
  kind: string;
  targetId: string;
  params?: Record<string, unknown>;
  tenantId?: string;
}): Promise<string> {
  const id = ulid();
  await db(TABLES.OperatorRecoveryRequest).insert({
    id,
    tenantId: spec.tenantId ?? TENANT,
    rail: 'direct_connect',
    kind: spec.kind,
    targetId: spec.targetId,
    params: JSON.stringify(spec.params ?? {}),
    requestedBy: 'test@op.example',
    status: 'pending',
  });
  return id;
}

async function requestOf(id: string): Promise<OperatorRecoveryRequestRow> {
  return (await db(TABLES.OperatorRecoveryRequest)
    .where({ id })
    .first()) as OperatorRecoveryRequestRow;
}

async function payoutOf(payoutId: string) {
  return (await db(TABLES.Payout).where({ id: payoutId }).first()) as {
    id: string;
    status: string;
    stripeTransferId: string | null;
    metadata: { transferState?: string; keyGeneration?: number; lastError?: string };
  };
}

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of [
    TABLES.OperatorRecoveryRequest,
    TABLES.HostedFundingAllocation,
    TABLES.HostedFundingBatch,
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
  await db<TenantRow>(TABLES.Tenant)
    .insert({ id: TENANT_B, slug: 'recovery-b', displayName: 'B', status: 'active' })
    .onConflict('id')
    .ignore();
});

afterAll(async () => {
  if (!skipIntegration) {
    await db(TABLES.OperatorRecoveryRequest).del();
    await db(TABLES.Tenant).where({ id: TENANT_B }).del();
    for (const t of [TABLES.Commission, TABLES.Payout]) await db(t).del();
  }
  await db.destroy();
});

// ---- Apply: outcome mapping ----------------------------------------------

describe.skipIf(skipIntegration)('applyRecoveryRequests — outcome mapping', () => {
  it('release_intent_for_retry: applied, generation bumped, recheck scheduled', async () => {
    const { payoutId } = await seedHeldIntent();
    const requestId = await insertRequest({
      kind: 'release_intent_for_retry',
      targetId: payoutId,
      params: { observedGeneration: 0 },
    });
    const { stripe } = mockStripe({ listed: [] });

    const result = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(result.applied).toEqual([{ requestId, targetId: payoutId, outcome: 'rearmed' }]);

    const request = await requestOf(requestId);
    expect(request.status).toBe('applied');
    expect(request.outcome).toBe('rearmed');
    expect(request.appliedAt).not.toBeNull();
    expect(request.attempts).toBe(1);
    expect(request.leaseToken).toBeNull();
    // the §0.2 backstop is scheduled, in the future
    expect(request.recheckDueAt).not.toBeNull();
    expect(new Date(request.recheckDueAt!).getTime()).toBeGreaterThan(Date.now());

    const payout = await payoutOf(payoutId);
    expect(payout.metadata.transferState).toBe('intent');
    expect(payout.metadata.keyGeneration).toBe(1);
  });

  it('a transfer in the group refuses the re-arm — the function IS the verification layer', async () => {
    const { payoutId, commissionIds } = await seedHeldIntent();
    const requestId = await insertRequest({
      kind: 'release_intent_for_retry',
      targetId: payoutId,
      params: { observedGeneration: 0 },
    });
    const { stripe } = mockStripe({
      listed: [
        { id: 'tr_live', amount: 5000, currency: 'usd', transfer_group: payoutId, metadata: {} },
      ],
    });

    const result = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(result.refused).toEqual([
      { requestId, targetId: payoutId, outcome: 'transfer_exists' },
    ]);
    expect((await requestOf(requestId)).status).toBe('refused');
    // held intent untouched, commissions still frozen
    expect((await payoutOf(payoutId)).metadata.transferState).toBe('reconcile_required');
    const c = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(c.payoutId).toBe(payoutId);
  });

  it('dispose_intent: applied on an empty group, commissions returned, recheck scheduled', async () => {
    const { payoutId, commissionIds } = await seedHeldIntent();
    const requestId = await insertRequest({
      kind: 'dispose_intent',
      targetId: payoutId,
      params: { reason: 'post never reached stripe' },
    });
    const { stripe } = mockStripe({ listed: [] });

    const result = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(result.applied).toEqual([{ requestId, targetId: payoutId, outcome: 'disposed' }]);

    const request = await requestOf(requestId);
    expect(request.status).toBe('applied');
    expect(request.recheckDueAt).not.toBeNull();
    const payout = await payoutOf(payoutId);
    expect(payout.metadata.transferState).toBe('canceled');
    const c = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(c.payoutId).toBeNull(); // payable again — the operator's documented risk decision
  });

  it('dispose_intent refuses while any group member still holds money', async () => {
    const { payoutId, commissionIds } = await seedHeldIntent();
    const requestId = await insertRequest({
      kind: 'dispose_intent',
      targetId: payoutId,
      params: { reason: 'oops' },
    });
    const { stripe } = mockStripe({
      listed: [
        {
          id: 'tr_live',
          amount: 5000,
          amount_reversed: 1000, // partial clawback — $40 still with the partner
          currency: 'usd',
          transfer_group: payoutId,
          metadata: {},
        },
      ],
    });

    const result = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(result.refused).toEqual([
      { requestId, targetId: payoutId, outcome: 'money_with_partner' },
    ]);
    const c = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(c.payoutId).toBe(payoutId); // still frozen
  });

  it('resolve_duplicate_review { allReversed } settles only when every transfer is fully reversed', async () => {
    const { payoutId, commissionIds } = await seedHeldIntent('duplicate_review');
    const requestId = await insertRequest({
      kind: 'resolve_duplicate_review',
      targetId: payoutId,
      params: { allReversed: true },
    });
    const { stripe } = mockStripe({
      listed: [
        {
          id: 'tr_dead',
          amount: 5000,
          amount_reversed: 5000,
          reversed: true,
          currency: 'usd',
          transfer_group: payoutId,
          metadata: {},
        },
      ],
    });

    const result = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(result.applied).toEqual([{ requestId, targetId: payoutId, outcome: 'resolved' }]);
    expect((await payoutOf(payoutId)).metadata.transferState).toBe('canceled');
    const c = await db(TABLES.Commission).where({ id: commissionIds[0]! }).first();
    expect(c.payoutId).toBeNull();
  });

  it('ABSENT observedGeneration refuses — it must never default to generation 0', async () => {
    // readGeneration treats absent as 0 (right for stored metadata, wrong
    // for an operator assertion). If the loop ever adopts that default,
    // this request would re-arm the intent and this test fails.
    const { payoutId } = await seedHeldIntent();
    const requestId = await insertRequest({
      kind: 'release_intent_for_retry',
      targetId: payoutId,
      params: {},
    });
    const { stripe, transfersList } = mockStripe({ listed: [] });

    await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    const request = await requestOf(requestId);
    expect(request.status).toBe('refused');
    expect(request.outcome).toBe('invalid_request:params');
    expect(transfersList).not.toHaveBeenCalled();
    expect((await payoutOf(payoutId)).metadata.transferState).toBe('reconcile_required');
  });

  it('a hosted-funding kind on the direct rail refuses without touching anything', async () => {
    const { payoutId } = await seedHeldIntent();
    const requestId = await insertRequest({
      kind: 'force_release_batch',
      targetId: payoutId,
      params: { reason: 'x' },
    });
    const { stripe, transfersList } = mockStripe({ listed: [] });

    await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    const request = await requestOf(requestId);
    expect(request.status).toBe('refused');
    expect(request.outcome).toBe('invalid_request:kind_rail_mismatch');
    expect(transfersList).not.toHaveBeenCalled();
  });
});

// ---- Apply: tenancy, pacing, fencing --------------------------------------

describe.skipIf(skipIntegration)('applyRecoveryRequests — tenancy, pacing, fencing', () => {
  it('THE tenant boundary: a request from tenant B cannot act on tenant A payouts', async () => {
    const { payoutId } = await seedHeldIntent(); // tenant A (default)
    const id = ulid();
    // Written the only way it can be — around the API, straight into the
    // privileged pool. The loop must still refuse it.
    await db(TABLES.OperatorRecoveryRequest).insert({
      id,
      tenantId: TENANT_B,
      rail: 'direct_connect',
      kind: 'release_intent_for_retry',
      targetId: payoutId,
      params: JSON.stringify({ observedGeneration: 0 }),
      requestedBy: 'rogue@b.example',
      status: 'pending',
    });
    const { stripe, transfersList } = mockStripe({ listed: [] });

    await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    const request = await requestOf(id);
    expect(request.status).toBe('refused');
    expect(request.outcome).toBe('tenant_mismatch');
    // Nothing reached Stripe, nothing moved: the check runs before the
    // operator function, not after.
    expect(transfersList).not.toHaveBeenCalled();
    expect((await payoutOf(payoutId)).metadata.transferState).toBe('reconcile_required');
  });

  it('a retryable outcome stays pending with a paced nextAttemptAt, and is NOT re-claimed early', async () => {
    const { payoutId } = await seedHeldIntent();
    const requestId = await insertRequest({
      kind: 'release_intent_for_retry',
      targetId: payoutId,
      params: { observedGeneration: 0 },
    });
    const { stripe } = mockStripe({ listThrows: true });

    const first = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(first.retrying).toEqual([
      { requestId, targetId: payoutId, outcome: 'cannot_verify' },
    ]);
    const afterFirst = await requestOf(requestId);
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.nextAttemptAt).not.toBeNull();
    expect(new Date(afterFirst.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now());

    // The very next tick claims nothing: pacing, not spinning. Without
    // nextAttemptAt this second pass would claim and burn attempt 2.
    const second = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(second.processed).toBe(0);
    expect((await requestOf(requestId)).attempts).toBe(1);
  });

  it('the attempt budget closes a never-verifiable request as failed', async () => {
    const { payoutId } = await seedHeldIntent();
    const requestId = await insertRequest({
      kind: 'release_intent_for_retry',
      targetId: payoutId,
      params: { observedGeneration: 0 },
    });
    // 9 attempts already burned; this claim is the 10th.
    await db(TABLES.OperatorRecoveryRequest).where({ id: requestId }).update({ attempts: 9 });
    const { stripe } = mockStripe({ listThrows: true });

    const result = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(result.failed).toEqual([{ requestId, targetId: payoutId, outcome: 'cannot_verify' }]);
    const request = await requestOf(requestId);
    expect(request.status).toBe('failed');
    expect(request.attempts).toBe(10);
  });

  it('a warm lease held by another worker is not stolen', async () => {
    const { payoutId } = await seedHeldIntent();
    const requestId = await insertRequest({
      kind: 'release_intent_for_retry',
      targetId: payoutId,
      params: { observedGeneration: 0 },
    });
    await db(TABLES.OperatorRecoveryRequest)
      .where({ id: requestId })
      .update({ leaseAt: db.fn.now(), leaseToken: 'someone-else' });
    const { stripe, transfersList } = mockStripe({ listed: [] });

    const result = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(result.processed).toBe(0);
    expect(transfersList).not.toHaveBeenCalled();
    const request = await requestOf(requestId);
    expect(request.status).toBe('pending');
    expect(request.leaseToken).toBe('someone-else');
  });

  it('requestId scoping claims exactly that request', async () => {
    const a = await seedHeldIntent();
    const b = await seedHeldIntent();
    const requestA = await insertRequest({
      kind: 'dispose_intent',
      targetId: a.payoutId,
      params: { reason: 'x' },
    });
    const requestB = await insertRequest({
      kind: 'dispose_intent',
      targetId: b.payoutId,
      params: { reason: 'y' },
    });
    const { stripe } = mockStripe({ listed: [] });

    const result = await applyRecoveryRequests(db, {
      rail: 'direct_connect',
      tenantId: TENANT,
      requestId: requestA,
      stripe,
    });
    expect(result.processed).toBe(1);
    expect((await requestOf(requestA)).status).toBe('applied');
    expect((await requestOf(requestB)).status).toBe('pending');
  });

  // Meaningful only when the process has no STRIPE_SECRET_KEY (CI, and the
  // documented local run) — the default client is baked at module load.
  it.skipIf(!!process.env.STRIPE_SECRET_KEY)('without a Stripe client nothing is claimed and no attempt is burned', async () => {
    const { payoutId } = await seedHeldIntent();
    const requestId = await insertRequest({
      kind: 'dispose_intent',
      targetId: payoutId,
      params: { reason: 'x' },
    });
    const result = await applyRecoveryRequests(db, { rail: 'direct_connect' });
    // No STRIPE_SECRET_KEY in the test env, so the default client is null.
    expect(result.skipped).toBe('stripe_not_configured');
    const request = await requestOf(requestId);
    expect(request.status).toBe('pending');
    expect(request.attempts).toBe(0);
  });
});

// ---- Apply: hosted funding rail -------------------------------------------

describe.skipIf(skipIntegration)('applyRecoveryRequests — hosted funding rail', () => {
  async function seedStuckBatch(patch: Record<string, unknown> = {}): Promise<string> {
    const id = ulid();
    await db(TABLES.HostedFundingBatch).insert({
      id,
      tenantId: TENANT,
      currency: 'usd',
      principalMinor: 8000,
      grossChargeMinor: 8000,
      status: 'release_requested',
      fundingAttempts: 0,
      ...patch,
    });
    return id;
  }

  it('force_release_batch: applied once the quiet gate has passed and Stripe shows nothing', async () => {
    const batchId = await seedStuckBatch({ updatedAt: hoursAgo(2) });
    const id = ulid();
    await db(TABLES.OperatorRecoveryRequest).insert({
      id,
      tenantId: TENANT,
      rail: 'hosted_funding',
      kind: 'force_release_batch',
      targetId: batchId,
      params: JSON.stringify({ reason: 'no PI ever existed' }),
      requestedBy: 'test@op.example',
      status: 'pending',
    });
    const { stripe } = mockStripe();

    const result = await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe });
    expect(result.applied).toEqual([{ requestId: id, targetId: batchId, outcome: 'released' }]);
    const request = await requestOf(id);
    expect(request.status).toBe('applied');
    // no transfer-group recheck on this rail — the funding inbox owns the
    // late-PI case
    expect(request.recheckDueAt).toBeNull();
    const batch = await db(TABLES.HostedFundingBatch).where({ id: batchId }).first();
    expect(batch.status).toBe('released');
  });

  it('force_release_batch inside the quiet gate is too_recent — pending, paced', async () => {
    const batchId = await seedStuckBatch(); // updatedAt = now
    const id = ulid();
    await db(TABLES.OperatorRecoveryRequest).insert({
      id,
      tenantId: TENANT,
      rail: 'hosted_funding',
      kind: 'force_release_batch',
      targetId: batchId,
      params: JSON.stringify({ reason: 'impatient' }),
      requestedBy: 'test@op.example',
      status: 'pending',
    });
    const { stripe } = mockStripe();

    const result = await applyRecoveryRequests(db, { rail: 'hosted_funding', stripe });
    expect(result.retrying).toEqual([{ requestId: id, targetId: batchId, outcome: 'too_recent' }]);
    const request = await requestOf(id);
    expect(request.status).toBe('pending');
    expect(request.nextAttemptAt).not.toBeNull();
    expect((await db(TABLES.HostedFundingBatch).where({ id: batchId }).first()).status).toBe(
      'release_requested',
    );
  });
});

// ---- Recheck --------------------------------------------------------------

describe.skipIf(skipIntegration)('post-apply group recheck (§0.2 backstop)', () => {
  async function seedAppliedWithDueRecheck(
    payoutId: string,
    kind = 'dispose_intent',
  ): Promise<string> {
    const id = ulid();
    await db(TABLES.OperatorRecoveryRequest).insert({
      id,
      tenantId: TENANT,
      rail: 'direct_connect',
      kind,
      targetId: payoutId,
      params: JSON.stringify({ reason: 'x' }),
      requestedBy: 'test@op.example',
      status: 'applied',
      outcome: 'disposed',
      appliedAt: hoursAgo(25),
      recheckDueAt: hoursAgo(1),
    });
    return id;
  }

  it('ALARMS on a live transfer that landed after a dispose — and writes no payout state', async () => {
    const { payoutId } = await seedHeldIntent('canceled');
    await db(TABLES.Payout).where({ id: payoutId }).update({ status: 'failed' });
    const requestId = await seedAppliedWithDueRecheck(payoutId);
    const late: FakeTransfer = {
      id: 'tr_late_landing',
      amount: 5000,
      currency: 'usd',
      transfer_group: payoutId,
      metadata: {},
    };
    const { stripe } = mockStripe({ listed: [late] });

    const before = await payoutOf(payoutId);
    const result = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(result.recheck.processed).toBe(1);
    expect(result.recheck.orphaned).toEqual([payoutId]);

    const request = await requestOf(requestId);
    expect(request.recheckOutcome).toBe('orphan_transfers:tr_late_landing');
    expect(request.recheckDueAt).toBeNull(); // settled — no re-alarm loop
    expect(request.status).toBe('applied'); // the decision row is never edited
    // detector only: the payout is exactly as it was
    const after = await payoutOf(payoutId);
    expect(after.status).toBe(before.status);
    expect(after.metadata).toEqual(before.metadata);
  });

  it('a fully-reversed member does not alarm — it was the premise, not a violation', async () => {
    const { payoutId } = await seedHeldIntent('canceled');
    const requestId = await seedAppliedWithDueRecheck(payoutId);
    const { stripe } = mockStripe({
      listed: [
        {
          id: 'tr_dead',
          amount: 5000,
          amount_reversed: 5000,
          reversed: true,
          currency: 'usd',
          transfer_group: payoutId,
          metadata: {},
        },
      ],
    });

    await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    const request = await requestOf(requestId);
    expect(request.recheckOutcome).toBe('clear');
    expect(request.recheckDueAt).toBeNull();
  });

  it('an unreadable Stripe defers the recheck instead of concluding anything', async () => {
    const { payoutId } = await seedHeldIntent('canceled');
    const requestId = await seedAppliedWithDueRecheck(payoutId);
    const { stripe } = mockStripe({ listThrows: true });

    const result = await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    expect(result.recheck.deferred).toBe(1);
    const request = await requestOf(requestId);
    expect(request.recheckOutcome).toBe('cannot_verify');
    expect(request.recheckDueAt).not.toBeNull(); // rescheduled, not settled
    expect(request.recheckAttempts).toBe(1);
  });

  it('an open re-armed intent with live group members stays benign (executor mid-flight)', async () => {
    const { payoutId } = await seedHeldIntent('posted', { keyGeneration: 1 });
    const requestId = await seedAppliedWithDueRecheck(payoutId, 'release_intent_for_retry');
    const { stripe } = mockStripe({
      listed: [
        { id: 'tr_gen1_inflight', amount: 5000, currency: 'usd', transfer_group: payoutId, metadata: {} },
      ],
    });

    await applyRecoveryRequests(db, { rail: 'direct_connect', stripe });
    const request = await requestOf(requestId);
    expect(request.recheckOutcome).toBe('clear');
  });
});
