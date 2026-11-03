import type { Knex } from 'knex';

/**
 * PayPal payments as conversions (docs/paypal-payments.md): the brand's own
 * PayPal REST app, the one Pay with PayPal already connects, now also
 * reports the payments its checkout takes. A payment whose `custom_id`
 * names a partner click becomes an Event like a Stripe payment does.
 *
 * PaypalConnection
 *   purpose             'payouts' (every existing row: Pay with PayPal's
 *                       app) or 'checkout' (an app connected only to report
 *                       payments, when the brand's checkout runs on another
 *                       app than the one it pays partners with). One live
 *                       row per tenant, environment and purpose. A checkout
 *                       app never sends payouts: it can't be the active one.
 *   paymentsSince       when payment tracking was turned on for this app;
 *                       null = off. The catch-up never reaches back past it.
 *   lastPaymentEventAt  the last verified payment webhook from this app.
 *   transactionSearch   whether the app may call Transaction Search (PayPal
 *                       turns it on per app): 'ok', 'unavailable', or null
 *                       until the catch-up first tried.
 *
 * PaymentEventLog: one row per provider payment fact this deployment
 * settled (a capture, a sale, a refund, a subscription, a dispute), keyed
 * on the provider's own id for it, whichever way it arrived (webhook or
 * catch-up). Provider-neutral, so the next provider reuses it; Stripe stays
 * on StripeEventLog for now. `outcome` says what became of it ('recorded',
 * 'no_reference', 'unknown_click', …), which is how Tracking health counts
 * payments that arrived without a click reference. A delivery log of one
 * deployment, like StripeEventLog: not exported, pruned after 95 days (one
 * past Tracking health's longest window).
 *
 * PaypalSubscription: the `custom_id` each PayPal subscription was created
 * with, and the click it named in this tenant (null when none). Renewal
 * payments (PAYMENT.SALE.COMPLETED) don't carry it, so each is joined here
 * on its subscription id. A cache of PayPal's own data, not exported: the
 * Events it led to are, with the subscription id in their metadata, and
 * another instance reads a missing subscription back from PayPal.
 *
 * RLS follows the canonical tenant_isolation pattern. The app role reads
 * and appends the log (pruning runs on the privileged pool), and reads,
 * adds and updates subscriptions.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('PaypalConnection', (t) => {
    t.string('purpose', 8).notNullable().defaultTo('payouts');
    t.timestamp('paymentsSince', { useTz: true }).nullable();
    t.timestamp('lastPaymentEventAt', { useTz: true }).nullable();
    t.string('transactionSearch', 12).nullable();
    t.timestamp('transactionSearchCheckedAt', { useTz: true }).nullable();
  });
  await knex.raw(`
    alter table "PaypalConnection"
      add constraint paypal_connection_purpose_check
        check ("purpose" in ('payouts', 'checkout')),
      add constraint paypal_connection_checkout_never_sends
        check ("purpose" = 'payouts' or not "active"),
      add constraint paypal_connection_transaction_search_check
        check ("transactionSearch" is null or "transactionSearch" in ('ok', 'unavailable'))
  `);
  await knex.raw(`drop index "PaypalConnection_one_live_per_environment"`);
  await knex.raw(
    `create unique index "PaypalConnection_one_live_per_purpose" on "PaypalConnection" ("tenantId", "environment", "purpose") where "disconnectedAt" is null`,
  );
  await knex.raw(
    `create index "PaypalConnection_tracking_payments" on "PaypalConnection" ("tenantId") where "disconnectedAt" is null and "paymentsSince" is not null`,
  );

  await knex.schema.createTable('PaymentEventLog', (t) => {
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('provider', 16).notNullable();
    t.string('eventKey', 160).notNullable();
    // No FK: a provider-neutral log names connections of several tables.
    t.string('connectionId', 32).nullable();
    t.string('type', 100).notNullable();
    t.string('via', 16).notNullable();
    t.string('outcome', 24).notNullable();
    t.timestamp('receivedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['tenantId', 'provider', 'eventKey']);
    t.index(['tenantId', 'provider', 'receivedAt']);
  });
  await knex.raw(`
    alter table "PaymentEventLog"
      add constraint payment_event_log_via_check check ("via" in ('webhook', 'catchup'))
  `);

  await knex.schema.createTable('PaypalSubscription', (t) => {
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('subscriptionId', 64).notNullable();
    t.string('connectionId', 32).notNullable().references('id').inTable('PaypalConnection');
    t.string('environment', 8).notNullable();
    t.string('customId', 255).nullable();
    t.string('clickId', 32).nullable();
    t.string('planId', 64).nullable();
    t.string('status', 24).nullable();
    t.timestamp('createdAt', { useTz: true }).nullable();
    t.timestamp('firstSeenAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['tenantId', 'subscriptionId']);
    t.index(['tenantId', 'connectionId', 'createdAt']);
  });

  for (const [table, grant] of [
    ['PaymentEventLog', 'select, insert'],
    ['PaypalSubscription', 'select, insert, update'],
  ] as const) {
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
          execute 'grant ${grant} on "${table}" to openpartner_app';
        end if;
      end
      $$;
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['PaypalSubscription', 'PaymentEventLog']) {
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
    await knex.schema.dropTableIfExists(table);
  }
  // A second live row per environment (a checkout app) can't survive the
  // old index: those rows go back to being disconnected history.
  await knex.raw(`
    update "PaypalConnection"
       set "disconnectedAt" = now(), "disconnectReason" = 'admin', "active" = false,
           "clientSecretEnc" = null, "accessTokenEnc" = null, "accessTokenExpiresAt" = null, "webhookIdEnc" = null
     where "purpose" = 'checkout' and "disconnectedAt" is null
  `);
  await knex.raw(`drop index if exists "PaypalConnection_tracking_payments"`);
  await knex.raw(`drop index if exists "PaypalConnection_one_live_per_purpose"`);
  await knex.raw(
    `create unique index "PaypalConnection_one_live_per_environment" on "PaypalConnection" ("tenantId", "environment") where "disconnectedAt" is null`,
  );
  await knex.raw(`
    alter table "PaypalConnection"
      drop constraint if exists paypal_connection_transaction_search_check,
      drop constraint if exists paypal_connection_checkout_never_sends,
      drop constraint if exists paypal_connection_purpose_check
  `);
  await knex.schema.alterTable('PaypalConnection', (t) => {
    t.dropColumn('transactionSearchCheckedAt');
    t.dropColumn('transactionSearch');
    t.dropColumn('lastPaymentEventAt');
    t.dropColumn('paymentsSince');
    t.dropColumn('purpose');
  });
}
