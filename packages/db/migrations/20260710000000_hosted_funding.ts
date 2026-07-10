import type { Knex } from 'knex';

/**
 * Hosted payout funding — data model (docs/payout-funding.md §4).
 *
 * Money only moves after money has arrived: approved commissions are
 * reserved into a HostedFundingBatch, the brand is charged the batch
 * principal by bank debit, and partner transfers execute only after the
 * funding payment settles. All money columns are INTEGER MINOR UNITS with
 * canonical lowercase currency.
 *
 * Every Hosted* table is a hosted-only SIDECAR (CLAUDE.md §2): exported
 * like everything else, inert on self-hosted import. CommissionAdjustment
 * is core + portable — a generic compensating-entry ledger any deployment
 * benefits from. No Stripe IDs land on core tables.
 */

const BATCH_STATUSES = [
  'reserved',
  'invoicing',
  'payment_processing',
  'funded',
  'transferring',
  'settled',
  'settled_with_residual',
  'funding_failed',
  'funding_disputed',
  'release_requested',
  'released',
  'recovery_required',
] as const;

const ALLOCATION_STATES = [
  'reserved',
  'canceled',
  'transfer_pending',
  'transferred',
  'released',
  'recovery_required',
] as const;

const TRANSFER_STATES = ['pending', 'posted', 'confirmed', 'failed', 'reconcile_required'] as const;

function checkIn(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

async function tenantRls(knex: Knex, table: string): Promise<void> {
  await knex.raw(`alter table "${table}" enable row level security`);
  await knex.raw(`alter table "${table}" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "${table}"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "${table}" to openpartner_app';
      end if;
    end
    $$;
  `);
}

export async function up(knex: Knex): Promise<void> {
  // ---------- HostedFundingBatch ----------
  await knex.schema.createTable('HostedFundingBatch', (t) => {
    t.string('id', 32).primary(); // ulid; doubles as the Stripe transfer_group
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('currency', 3).notNullable();
    t.bigInteger('principalMinor').notNullable();
    t.bigInteger('grossChargeMinor').notNullable(); // principal + any funding fee (launch: = principal)
    t.bigInteger('quotedFeeMinor').notNullable().defaultTo(0);
    t.bigInteger('actualStripeFeeMinor').nullable(); // balance_transaction.fee — rail-cost telemetry / future true-up
    t.string('paymentMethodType', 32).nullable(); // us_bank_account | bacs_debit | card (counsel-gated)
    t.string('pricingVersion', 32).notNullable().defaultTo('launch-ach-v1');
    t.string('status', 32).notNullable().defaultTo('reserved');
    t.string('stripePaymentIntentId', 64).nullable().unique();
    t.string('stripeChargeId', 64).nullable();
    t.bigInteger('residualMinor').notNullable().defaultTo(0);
    t.string('residualDisposition', 32).nullable(); // refund | manual_payout | credit_next_batch
    t.text('failureReason').nullable();
    t.integer('fundingAttempts').notNullable().defaultTo(0);
    t.timestamp('fundedAt', { useTz: true }).nullable();
    t.timestamp('settledAt', { useTz: true }).nullable();
    t.timestamp('releasedAt', { useTz: true }).nullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId', 'status']);
    t.index(['status']); // executor/collector scans
  });
  await knex.raw(
    `alter table "HostedFundingBatch" add constraint "HostedFundingBatch_status_check" check ("status" in (${checkIn(BATCH_STATUSES)}))`,
  );
  // One non-terminal batch per tenant × currency (spec §5 / founder decision).
  await knex.raw(`
    create unique index "HostedFundingBatch_open_per_tenant_currency"
      on "HostedFundingBatch" ("tenantId", "currency")
      where "status" not in ('settled', 'settled_with_residual', 'released')
  `);
  await tenantRls(knex, 'HostedFundingBatch');

  // ---------- HostedFundingAllocation ----------
  await knex.schema.createTable('HostedFundingAllocation', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('batchId', 32).notNullable().references('id').inTable('HostedFundingBatch').onDelete('CASCADE');
    t.string('commissionId', 32).notNullable().references('id').inTable('Commission');
    t.string('partnerId', 32).notNullable().references('id').inTable('Partner');
    t.bigInteger('amountMinor').notNullable();
    t.string('state', 32).notNullable().defaultTo('reserved');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['batchId', 'state']);
    t.index(['partnerId']);
  });
  await knex.raw(
    `alter table "HostedFundingAllocation" add constraint "HostedFundingAllocation_state_check" check ("state" in (${checkIn(ALLOCATION_STATES)}))`,
  );
  // THE mutual exclusion: a commission can be live in at most one batch,
  // ever (spec blocker 1). Released/canceled allocations stop counting.
  await knex.raw(`
    create unique index "HostedFundingAllocation_live_commission"
      on "HostedFundingAllocation" ("commissionId")
      where "state" not in ('released', 'canceled')
  `);
  await tenantRls(knex, 'HostedFundingAllocation');

  // ---------- HostedFundingTransfer (transfer intents) ----------
  await knex.schema.createTable('HostedFundingTransfer', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('batchId', 32).notNullable().references('id').inTable('HostedFundingBatch').onDelete('CASCADE');
    t.string('partnerId', 32).notNullable().references('id').inTable('Partner');
    t.string('currency', 3).notNullable();
    t.bigInteger('amountMinor').notNullable();
    // Snapshotted at intent creation — changing destination under a
    // retained idempotency key is a Stripe parameter-mismatch error.
    t.string('destinationAccountId', 64).notNullable();
    t.string('idempotencyKey', 64).notNullable().unique();
    t.string('state', 32).notNullable().defaultTo('pending');
    t.string('stripeTransferId', 64).nullable().unique();
    t.string('payoutId', 32).nullable(); // the Payout row written on confirmation
    t.text('lastError').nullable();
    t.timestamp('postedAt', { useTz: true }).nullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['batchId', 'partnerId', 'currency']);
    t.index(['state']);
  });
  await knex.raw(
    `alter table "HostedFundingTransfer" add constraint "HostedFundingTransfer_state_check" check ("state" in (${checkIn(TRANSFER_STATES)}))`,
  );
  await tenantRls(knex, 'HostedFundingTransfer');

  // ---------- HostedFundingAuthorization ----------
  // The per-tenant gate: explicit off-session-collection acceptance + a
  // verified bank-debit instrument. No batch is created without one.
  await knex.schema.createTable('HostedFundingAuthorization', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().unique().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('adminId', 32).notNullable().references('id').inTable('Admin');
    t.string('termsVersion', 32).notNullable();
    t.string('stripePaymentMethodId', 64).notNullable(); // the bank-debit instrument
    t.string('paymentMethodType', 32).notNullable(); // us_bank_account | bacs_debit
    t.timestamp('acceptedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('revokedAt', { useTz: true }).nullable();
  });
  await tenantRls(knex, 'HostedFundingAuthorization');

  // ---------- HostedBillingState (webhook-mirrored subscription status) ----------
  await knex.schema.createTable('HostedBillingState', (t) => {
    t.string('tenantId', 32).primary().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('subscriptionStatus', 32).nullable(); // active|trialing|past_due|unpaid|paused|canceled
    t.integer('delinquentFundingCount').notNullable().defaultTo(0);
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await tenantRls(knex, 'HostedBillingState');

  // ---------- StripeWebhookInbox (event dedup; platform-wide, no tenant) ----------
  await knex.schema.createTable('StripeWebhookInbox', (t) => {
    t.string('stripeEventId', 64).primary();
    t.string('type', 64).notNullable();
    t.string('outcome', 128).nullable();
    t.timestamp('processedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  // Platform-scoped (webhooks arrive before tenant resolution) — RLS off,
  // privileged-pool access only; contains no tenant data beyond event ids.

  // ---------- PayoutReversal ----------
  await knex.schema.createTable('PayoutReversal', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('payoutId', 32).notNullable().references('id').inTable('Payout');
    t.string('stripeReversalId', 64).notNullable().unique();
    t.bigInteger('amountMinor').notNullable();
    t.string('reason', 128).nullable();
    t.string('balanceTransactionId', 64).nullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['payoutId']);
  });
  await tenantRls(knex, 'PayoutReversal');

  // ---------- CommissionAdjustment (CORE, portable) ----------
  // Generic compensating-entry ledger: paid commissions are immutable
  // history; clawbacks/corrections append here instead of mutating rows.
  await knex.schema.createTable('CommissionAdjustment', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('commissionId', 32).notNullable().references('id').inTable('Commission');
    t.decimal('amount', 14, 2).notNullable(); // negative = clawback; core tables keep major units
    t.string('currency', 3).notNullable();
    t.string('reason', 64).notNullable(); // transfer_reversed | funding_disputed | admin_correction | refund_clawback
    t.string('actorAdminId', 32).nullable();
    t.jsonb('metadata').notNullable().defaultTo('{}');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['commissionId']);
  });
  await tenantRls(knex, 'CommissionAdjustment');

  // ---------- Core hardening ----------
  // Double-recording a Stripe transfer is now a constraint violation.
  await knex.raw(`
    create unique index "Payout_stripeTransferId_unique"
      on "Payout" ("stripeTransferId")
      where "stripeTransferId" is not null
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop index if exists "Payout_stripeTransferId_unique"');
  for (const t of [
    'CommissionAdjustment',
    'PayoutReversal',
    'StripeWebhookInbox',
    'HostedBillingState',
    'HostedFundingAuthorization',
    'HostedFundingTransfer',
    'HostedFundingAllocation',
    'HostedFundingBatch',
  ]) {
    await knex.raw(`drop policy if exists tenant_isolation on "${t}"`).catch(() => {});
    await knex.schema.dropTableIfExists(t);
  }
}
