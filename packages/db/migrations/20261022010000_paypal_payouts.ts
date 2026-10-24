import type { Knex } from 'knex';

/**
 * Pay with PayPal: the brand's own PayPal REST app sends manual-rail
 * payouts through the PayPal Payouts API (docs/paypal-payouts.md).
 *
 * Same money flow as the PayPal batch file (manual-payout-files.ts): the
 * brand's PayPal balance pays the partner's PayPal account. OpenPartner
 * only makes the API call, with the brand's credentials, the way the
 * brand's own script would. Money never touches OpenPartner.
 *
 * PaypalConnection — the brand's PayPal REST app credentials, one row per
 * environment ('live' | 'sandbox'). Credentials for one deployment, so
 * never exported (docs/data-portability.md), like TenantStripeConnection.
 *
 *   clientId            PayPal's public app identifier, in the clear (it
 *                       is also what PayPal's browser SDK embeds).
 *   clientSecretEnc     AES-GCM envelope (apps/api/src/crypto.ts). Null
 *                       once disconnected.
 *   accessTokenEnc      The OAuth token (about 9 hours), sealed and cached
 *                       so each send doesn't fetch one.
 *   payoutsScope        The token was granted PayPal's Payouts scope.
 *                       False means Payouts isn't enabled on the account
 *                       or app yet; sends would be refused.
 *   webhookIdEnc        The webhook OpenPartner registered on the brand's
 *                       app, sealed. Signature verification needs it.
 *                       Null when none could be registered (a non-HTTPS
 *                       deployment): batches are then polled only.
 *   active              The environment "Pay with PayPal" uses. At most
 *                       one per tenant.
 *   disconnectedAt      Admin disconnect, or replaced by new credentials
 *                       for the same environment. Rows are kept as history
 *                       with their secrets wiped.
 *
 * PaypalPayoutBatch — one PayPal Payouts batch, the durable intent behind
 * a send. Its id is the export id stamped on its payouts
 * (`Payout.metadata.manualExport`, `via: 'api'`), PayPal's
 * `sender_batch_id`, and the `PayPal-Request-Id`, so a retry after a crash
 * or a timeout can only ever reach the same batch: PayPal refuses a second
 * batch with the same sender_batch_id for 30 days.
 *
 *   state               intent → posted → submitted → completed, or
 *                       failed / denied / released, or reconcile_required
 *                       (outcome unknown, held for the admin). See
 *                       apps/api/src/paypal-payouts.ts.
 *   requestEnc          The request body, frozen and sealed (it holds the
 *                       partners' PayPal emails), so every retry sends the
 *                       same bytes. Wiped once PayPal has the batch, or
 *                       once it can never be sent.
 *   payoutBatchId       PayPal's id, once PayPal accepted the batch.
 *   postedAt            When the first POST went out. Anchors PayPal's
 *                       30-day duplicate window and never moves.
 *   leaseAt             Compare-and-set token: one worker at a time posts
 *                       or syncs a batch.
 *
 * Operational state for one deployment's credentials, like
 * WebhookDelivery, so not exported either; each payout carries its PayPal
 * batch, item and transaction ids in its own metadata, which is.
 *
 * RLS + app-role grant follow the canonical tenant_isolation pattern. No
 * DELETE grant: rows end with an UPDATE. The tenant purge deletes them
 * (scheduler.ts TENANT_PURGE_ORDER).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PaypalConnection', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('environment', 8).notNullable();
    t.string('clientId', 128).notNullable();
    t.text('clientSecretEnc').nullable();
    t.text('accessTokenEnc').nullable();
    t.timestamp('accessTokenExpiresAt', { useTz: true }).nullable();
    t.string('appId', 64).nullable();
    t.boolean('payoutsScope').notNullable().defaultTo(false);
    t.text('webhookIdEnc').nullable();
    t.text('webhookError').nullable();
    t.boolean('active').notNullable().defaultTo(false);
    // The admin who connected. No FK: Admin rows are never exported, and a
    // connection outlives the admin who made it.
    t.string('connectedByAdminId', 32).nullable();
    t.timestamp('connectedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('verifiedAt', { useTz: true }).nullable();
    t.text('lastError').nullable();
    t.timestamp('lastErrorAt', { useTz: true }).nullable();
    t.timestamp('disconnectedAt', { useTz: true }).nullable();
    t.string('disconnectReason', 16).nullable();
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId']);
  });
  await knex.raw(`
    alter table "PaypalConnection"
      add constraint paypal_connection_environment_check
        check ("environment" in ('live', 'sandbox')),
      add constraint paypal_connection_disconnect_reason_check
        check ("disconnectReason" is null or "disconnectReason" in ('admin', 'replaced')),
      add constraint paypal_connection_shape_check
        check (
          ("disconnectedAt" is null and "disconnectReason" is null and "clientSecretEnc" is not null)
          or ("disconnectedAt" is not null and "disconnectReason" is not null and not "active"
              and "clientSecretEnc" is null and "accessTokenEnc" is null and "webhookIdEnc" is null)
        )
  `);
  await knex.raw(
    `create unique index "PaypalConnection_one_live_per_environment" on "PaypalConnection" ("tenantId", "environment") where "disconnectedAt" is null`,
  );
  await knex.raw(`create unique index "PaypalConnection_one_active" on "PaypalConnection" ("tenantId") where "active"`);

  await knex.schema.createTable('PaypalPayoutBatch', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('connectionId', 32).notNullable().references('id').inTable('PaypalConnection');
    t.string('environment', 8).notNullable();
    t.string('runId', 64).notNullable();
    t.string('currency', 3).notNullable();
    t.integer('itemCount').notNullable();
    t.decimal('total', 14, 2).notNullable();
    t.string('state', 24).notNullable().defaultTo('intent');
    t.text('requestEnc').nullable();
    t.string('payoutBatchId', 64).nullable();
    t.string('batchStatus', 16).nullable();
    t.jsonb('itemSummary').notNullable().defaultTo('{}');
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('postedAt', { useTz: true }).nullable();
    t.timestamp('leaseAt', { useTz: true }).nullable();
    t.timestamp('lastSyncedAt', { useTz: true }).nullable();
    t.timestamp('nextSyncAt', { useTz: true }).nullable();
    t.text('lastError').nullable();
    t.string('createdBy', 8).notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('completedAt', { useTz: true }).nullable();
    t.string('resolution', 16).nullable();
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId', 'runId']);
    t.index(['state', 'nextSyncAt']);
  });
  await knex.raw(`
    alter table "PaypalPayoutBatch"
      add constraint paypal_payout_batch_state_check
        check ("state" in ('intent', 'posted', 'submitted', 'completed', 'failed', 'denied', 'released', 'reconcile_required')),
      add constraint paypal_payout_batch_environment_check
        check ("environment" in ('live', 'sandbox')),
      add constraint paypal_payout_batch_created_by_check
        check ("createdBy" in ('admin', 'api')),
      add constraint paypal_payout_batch_resolution_check
        check ("resolution" is null or "resolution" in ('released', 'linked'))
  `);
  await knex.raw(
    `create unique index "PaypalPayoutBatch_payout_batch_id" on "PaypalPayoutBatch" ("connectionId", "payoutBatchId") where "payoutBatchId" is not null`,
  );

  for (const table of ['PaypalConnection', 'PaypalPayoutBatch']) {
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
          execute 'grant select, insert, update on "${table}" to openpartner_app';
        end if;
      end
      $$;
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['PaypalPayoutBatch', 'PaypalConnection']) {
    await knex.raw(`
      do $$
      begin
        if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
          execute 'revoke all privileges on "${table}" from openpartner_app';
        end if;
      end
      $$;
    `);
    await knex.raw(`drop policy if exists tenant_isolation on "${table}"`);
  }
  await knex.schema.dropTableIfExists('PaypalPayoutBatch');
  await knex.schema.dropTableIfExists('PaypalConnection');
}
