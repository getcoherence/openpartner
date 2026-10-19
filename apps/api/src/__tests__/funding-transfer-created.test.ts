/**
 * The hosted funded rail's transfer.created detector (funding/webhook.ts,
 * detectFundedTransferCreated) — the counterpart of the direct rail's
 * `transfer_created_orphan`. DB-backed. Intents are seeded straight into
 * the state under test; the executor that produces them is covered in
 * funding-executor.test.ts.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type Stripe from 'stripe';
import { ulid } from 'ulid';
import { TABLES, DEFAULT_TENANT_ID } from '@openpartner/db';
import type { FundingTransferState, HostedFundingTransferRow } from '@openpartner/db';

import { db } from '../db.js';
import { handleFundingEvent } from '../funding/webhook.js';
import { fundedTransferKey } from '../funding/executor.js';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const TENANT = DEFAULT_TENANT_ID;
const EVENT_PREFIX = 'evt_ftc_';

// The detector reads no Stripe object: every event carries the transfer as
// created. A client that throws proves it.
const stripe = new Proxy({}, {
  get() {
    throw new Error('the transfer.created detector must not call Stripe');
  },
}) as unknown as Stripe;

const partnerIds: string[] = [];
const batchIds: string[] = [];

async function cleanUp(): Promise<void> {
  await db(TABLES.StripeWebhookInbox).where('stripeEventId', 'like', `${EVENT_PREFIX}%`).del();
  if (batchIds.length) {
    await db(TABLES.HostedFundingTransfer).whereIn('batchId', batchIds).del();
    await db(TABLES.HostedFundingBatch).whereIn('id', batchIds).del();
  }
  if (partnerIds.length) await db(TABLES.Partner).whereIn('id', partnerIds).del();
  batchIds.length = 0;
  partnerIds.length = 0;
}

let alerts: MockInstance<typeof console.error>;

beforeEach(async () => {
  alerts = vi.spyOn(console, 'error').mockImplementation(() => {});
  if (!skipIntegration) await cleanUp();
});

afterEach(() => {
  alerts.mockRestore();
});

afterAll(async () => {
  if (!skipIntegration) await cleanUp();
  await db.destroy();
});

// ---- Seeding --------------------------------------------------------------

async function seedPartner(account = `acct_${ulid().slice(0, 12)}`): Promise<{ partnerId: string; account: string }> {
  const partnerId = ulid();
  partnerIds.push(partnerId);
  await db(TABLES.Partner).insert({
    id: partnerId,
    tenantId: TENANT,
    email: `ftc-${partnerId}@x.test`,
    name: 'Funded partner',
    stripeConnectAccountId: account,
    metadata: { stripe: { payoutsEnabled: true } },
  });
  return { partnerId, account };
}

async function seedBatch(): Promise<string> {
  const id = ulid();
  batchIds.push(id);
  // Settled, so tests can hold more than one batch without tripping the
  // one-open-batch-per-currency index; the detector never reads it.
  await db(TABLES.HostedFundingBatch).insert({
    id,
    tenantId: TENANT,
    currency: 'usd',
    principalMinor: 5000,
    grossChargeMinor: 5000,
    status: 'settled',
    stripeChargeId: `ch_${id.slice(0, 12)}`,
  });
  return id;
}

async function seedIntent(
  batchId: string,
  partner: { partnerId: string; account: string },
  state: FundingTransferState,
  opts: { generation?: number; stripeTransferId?: string | null } = {},
): Promise<HostedFundingTransferRow> {
  const id = ulid();
  const [row] = (await db(TABLES.HostedFundingTransfer)
    .insert({
      id,
      tenantId: TENANT,
      batchId,
      partnerId: partner.partnerId,
      currency: 'usd',
      amountMinor: 5000,
      destinationAccountId: partner.account,
      idempotencyKey: fundedTransferKey(id, opts.generation ?? 0),
      state,
      stripeTransferId: opts.stripeTransferId ?? null,
      postedAt: state === 'pending' ? null : new Date(),
    })
    .returning('*')) as HostedFundingTransferRow[];
  return row!;
}

/** A transfer exactly as the executor creates it for `intent`. */
function createdTransfer(
  intent: HostedFundingTransferRow,
  patch: Partial<{ id: string; destination: string; transfer_group: string | null; metadata: Record<string, string> }> = {},
) {
  return {
    id: `tr_${ulid()}`,
    object: 'transfer',
    amount: Number(intent.amountMinor),
    amount_reversed: 0,
    currency: 'usd',
    reversed: false,
    destination: intent.destinationAccountId,
    transfer_group: intent.batchId,
    metadata: {
      openpartner_transfer_intent_id: intent.id,
      openpartner_funding_batch_id: intent.batchId,
      openpartner_tenant_id: intent.tenantId,
      openpartner_partner_id: intent.partnerId,
      openpartner_key_generation: '0',
    } as Record<string, string>,
    ...patch,
  };
}

function transferCreated(object: Record<string, unknown>): Stripe.Event {
  return {
    id: `${EVENT_PREFIX}${ulid()}`,
    type: 'transfer.created',
    data: { object },
  } as unknown as Stripe.Event;
}

function alertLines(): string[] {
  return alerts.mock.calls.map((args) => String(args[0])).filter((line) => line.includes('ALERT'));
}

async function inboxOutcome(event: Stripe.Event): Promise<string | null | undefined> {
  const row = (await db(TABLES.StripeWebhookInbox).where({ stripeEventId: event.id }).first()) as
    | { outcome: string | null }
    | undefined;
  return row?.outcome;
}

// ---- Tests ----------------------------------------------------------------

describe.skipIf(skipIntegration)('funded transfer.created detector', () => {
  it('a funded transfer.created lands in the funding inbox, not the direct-rail path', async () => {
    const batchId = await seedBatch();
    const intent = await seedIntent(batchId, await seedPartner(), 'posted');
    const event = transferCreated(createdTransfer(intent));

    expect(await handleFundingEvent(db, stripe, event)).toBe('transfer_created_observed');
    expect(await inboxOutcome(event)).toBe('transfer_created_observed');
    expect(alertLines()).toEqual([]);
  });

  it('a direct-rail transfer.created passes through untouched (null return, no inbox row)', async () => {
    const payoutId = ulid();
    const event = transferCreated({
      id: 'tr_direct',
      object: 'transfer',
      amount: 5000,
      currency: 'usd',
      destination: 'acct_direct',
      transfer_group: payoutId,
      metadata: { openpartner_payout_id: payoutId, openpartner_tenant_id: TENANT },
    });

    expect(await handleFundingEvent(db, stripe, event)).toBeNull();
    expect(await inboxOutcome(event)).toBeUndefined();
  });

  it('the recorded transfer, redelivered after finalize, stays quiet', async () => {
    const batchId = await seedBatch();
    const partner = await seedPartner();
    const tr = `tr_${ulid()}`;
    const intent = await seedIntent(batchId, partner, 'confirmed', { stripeTransferId: tr });

    const outcome = await handleFundingEvent(db, stripe, transferCreated(createdTransfer(intent, { id: tr })));
    expect(outcome).toBe('transfer_created_observed');
    expect(alertLines()).toEqual([]);
  });

  it('a transfer for an intent confirmed on a DIFFERENT transfer alarms; nothing is written', async () => {
    const batchId = await seedBatch();
    const recorded = `tr_${ulid()}`;
    const intent = await seedIntent(batchId, await seedPartner(), 'confirmed', { generation: 1, stripeTransferId: recorded });
    // The key generation 0 POST an operator abandoned, landing late.
    const late = createdTransfer(intent);

    const event = transferCreated(late);
    const outcome = await handleFundingEvent(db, stripe, event);
    expect(outcome).toBe(`transfer_created_orphan:${intent.id}`);
    expect(await inboxOutcome(event)).toBe(outcome);
    const [line, ...rest] = alertLines();
    expect(rest).toEqual([]);
    expect(line).toContain(late.id);
    expect(line).toContain(`${intent.id} (confirmed, key generation 1, on transfer ${recorded})`);

    // Detector only: the intent is exactly as it was.
    const after = (await db(TABLES.HostedFundingTransfer).where({ id: intent.id }).first()) as HostedFundingTransferRow;
    expect(after.state).toBe('confirmed');
    expect(after.stripeTransferId).toBe(recorded);
    expect(after.lastError).toBeNull();
    expect(after.updatedAt).toEqual(intent.updatedAt);
  });

  it('a transfer for a failed intent alarms', async () => {
    const batchId = await seedBatch();
    const intent = await seedIntent(batchId, await seedPartner(), 'failed');

    const outcome = await handleFundingEvent(db, stripe, transferCreated(createdTransfer(intent)));
    expect(outcome).toBe(`transfer_created_orphan:${intent.id}`);
    expect(alertLines()).toHaveLength(1);
  });

  it('after a re-arm, the abandoned key landing alarms at once, while the current key stays quiet', async () => {
    const batchId = await seedBatch();
    // Re-armed onto generation 1 and not yet posted: open, nothing recorded.
    const intent = await seedIntent(batchId, await seedPartner(), 'pending', { generation: 1 });

    const straggler = await handleFundingEvent(db, stripe, transferCreated(createdTransfer(intent)));
    expect(straggler).toBe(`transfer_created_orphan:${intent.id}`);
    expect(alertLines()[0]).toContain('key generation 0');

    const current = createdTransfer(intent, {
      metadata: { ...createdTransfer(intent).metadata, openpartner_key_generation: '1' },
    });
    expect(await handleFundingEvent(db, stripe, transferCreated(current))).toBe('transfer_created_observed');
    expect(alertLines()).toHaveLength(1);
  });

  it('an unstamped transfer in the batch group is matched by destination', async () => {
    const batchId = await seedBatch();
    const intent = await seedIntent(batchId, await seedPartner(), 'confirmed', { stripeTransferId: `tr_${ulid()}` });
    // No funding metadata at all: only the group says it is ours.
    const bare = createdTransfer(intent, { metadata: {} });

    const outcome = await handleFundingEvent(db, stripe, transferCreated(bare));
    expect(outcome).toBe(`transfer_created_orphan:${intent.id}`);

    // An open intent on that destination is the recheck's benign case.
    const openBatch = await seedBatch();
    const open = await seedIntent(openBatch, await seedPartner(), 'reconcile_required');
    const openBare = createdTransfer(open, { metadata: {} });
    expect(await handleFundingEvent(db, stripe, transferCreated(openBare))).toBe('transfer_created_observed');
  });

  it('two partners sharing a Connect account: the stamped intent owns the transfer', async () => {
    const batchId = await seedBatch();
    const shared = `acct_${ulid().slice(0, 12)}`;
    await seedIntent(batchId, await seedPartner(shared), 'confirmed', { stripeTransferId: `tr_${ulid()}` });
    const posting = await seedIntent(batchId, await seedPartner(shared), 'posted');

    // posting's own POST lands. The other intent matches on destination
    // alone and is confirmed elsewhere: judging it would alarm on an
    // ordinary payout.
    const outcome = await handleFundingEvent(db, stripe, transferCreated(createdTransfer(posting)));
    expect(outcome).toBe('transfer_created_observed');
    expect(alertLines()).toEqual([]);
  });

  it("a transfer stamped for one intent but paying another's account alarms", async () => {
    const batchId = await seedBatch();
    const stamped = await seedIntent(batchId, await seedPartner(), 'posted');
    const other = await seedIntent(batchId, await seedPartner(), 'posted');

    const outcome = await handleFundingEvent(
      db,
      stripe,
      transferCreated(createdTransfer(stamped, { destination: other.destinationAccountId })),
    );
    // stamped: not its frozen destination. other: open, destination-only → benign.
    expect(outcome).toBe(`transfer_created_orphan:${stamped.id}`);
  });

  it('a transfer in a batch group that no intent matches alarms as unmatched', async () => {
    const batchId = await seedBatch();
    const intent = await seedIntent(batchId, await seedPartner(), 'confirmed', { stripeTransferId: `tr_${ulid()}` });
    const stray = createdTransfer(intent, { destination: 'acct_nobody', metadata: {} });

    const outcome = await handleFundingEvent(db, stripe, transferCreated(stray));
    expect(outcome).toBe('transfer_created_unmatched');
    expect(alertLines()[0]).toContain(`funded batch ${batchId}'s group`);

    // A stamp naming an intent that does not exist is the same finding.
    const ghost = createdTransfer(intent, {
      metadata: { openpartner_transfer_intent_id: ulid(), openpartner_funding_batch_id: batchId },
      destination: 'acct_nobody',
    });
    expect(await handleFundingEvent(db, stripe, transferCreated(ghost))).toBe('transfer_created_unmatched');
  });

  it('a redelivery is an inbox replay: one alarm per event', async () => {
    const batchId = await seedBatch();
    const intent = await seedIntent(batchId, await seedPartner(), 'failed');
    const event = transferCreated(createdTransfer(intent));

    expect(await handleFundingEvent(db, stripe, event)).toBe(`transfer_created_orphan:${intent.id}`);
    expect(await handleFundingEvent(db, stripe, event)).toBe('inbox_replay');
    expect(alertLines()).toHaveLength(1);
  });
});
