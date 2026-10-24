import type { Knex } from 'knex';

/**
 * StripeEventLog — every brand Stripe event the attribution pipeline has
 * processed (processBrandStripeEvent, apps/api/src/routes/stripe-webhook.ts),
 * whether a webhook delivered it or the catch-up found it
 * (apps/api/src/stripe-event-catchup.ts).
 *
 * The catch-up lists a connected brand's recent events through the Stripe
 * App and replays the ones with no row here: a webhook Stripe gave up on
 * (an outage longer than its retries, an endpoint misconfigured for a day)
 * would otherwise lose those conversions for good, with nothing to show
 * they were ever missing.
 *
 *   stripeEventId  Stripe's evt_ id (unique across Stripe)
 *   type           the event type, for the operator reading the log
 *   via            'webhook' | 'catchup'
 *   receivedAt     when it was processed
 *
 * Rows older than Stripe's 30-day event retention are pruned by the
 * catch-up: nothing past it can be listed again. Not exported
 * (docs/data-portability.md): a delivery log of one deployment, like
 * WebhookDelivery. What the events recorded is in the exported Event rows.
 *
 * TenantStripeConnection.eventLogSince — the moment this connection's
 * events started being logged: the migration for connections that exist
 * now, the connect itself for new ones. The catch-up never reaches back
 * past it, so its first run doesn't replay events delivered before the log
 * existed, and a new connection doesn't backfill the time the brand was
 * disconnected. (An event an older instance handled during the rolling
 * deploy, after this migration, has no row and may be replayed: harmless,
 * because the pipeline is idempotent per event.)
 *
 * RLS follows the canonical tenant_isolation pattern; the app role may read
 * and append (pruning runs on the privileged pool).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('StripeEventLog', (t) => {
    t.string('stripeEventId', 255).primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('type', 100).notNullable();
    t.string('via', 16).notNullable();
    t.timestamp('receivedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId', 'receivedAt']);
  });
  await knex.raw(`
    alter table "StripeEventLog"
      add constraint stripe_event_log_via_check check ("via" in ('webhook', 'catchup'))
  `);
  await knex.raw(`alter table "StripeEventLog" enable row level security`);
  await knex.raw(`alter table "StripeEventLog" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "StripeEventLog"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert on "StripeEventLog" to openpartner_app';
      end if;
    end
    $$;
  `);

  await knex.schema.alterTable('TenantStripeConnection', (t) => {
    t.timestamp('eventLogSince', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('TenantStripeConnection', (t) => {
    t.dropColumn('eventLogSince');
  });
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'revoke all privileges on "StripeEventLog" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "StripeEventLog"`);
  await knex.schema.dropTableIfExists('StripeEventLog');
}
