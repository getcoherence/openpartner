import type { Knex } from 'knex';

/**
 * TenantStripeConnection — a hosted brand's own Stripe account, connected
 * through the OpenPartner Stripe App (OAuth install).
 *
 * Until now a hosted brand's Stripe events never reached OpenPartner:
 * /webhooks/stripe verifies only OpenPartner's own signing secrets, so
 * Payment Link buyers, Stripe-billed invoices, refunds and customer-reward
 * promo codes all needed the brand's server (or an admin) in the loop. With
 * the app installed, the brand's events arrive at /webhooks/stripe-app and
 * run through the same mapping single-tenant self-host uses
 * (docs/stripe-app.md).
 *
 * Hosted-only sidecar (CLAUDE.md principle 2): nothing on Tenant changes,
 * and self-host never writes a row. Credentials, so never exported
 * (docs/data-portability.md). The Events the connection records are
 * ordinary raw Event rows and export like any other.
 *
 *   stripeAccountId       acct_… the brand installed the app on.
 *   livemode              From the token response. Events whose livemode
 *                         differs are ignored (a live Connect endpoint also
 *                         receives test-mode events).
 *   keyMode               Which OpenPartner developer key issued the tokens
 *                         ('live' | 'test' | 'sandbox'). A refresh must use
 *                         the same key.
 *   refreshTokenEnc       AES-GCM envelope (crypto.ts). Stripe rotates the
 *                         refresh token on every refresh, so the stored one
 *                         is replaced each time. Null once disconnected.
 *   accessTokenEnc        The 1-hour access token, cached so every process
 *                         doesn't refresh (and rotate) on its own.
 *   permissionsVersion    STRIPE_APP_PERMISSIONS_VERSION when connected:
 *                         which manifest permission set the brand accepted.
 *   permissionsGranted    What Stripe says was granted (apps.install.* event),
 *                         when it has told us.
 *   refreshFailedAt       A refresh was refused (revoked / expired grant).
 *                         The portal shows "reconnect needed"; events for the
 *                         connection are acknowledged and skipped meanwhile.
 *   disconnectedAt        Admin disconnect, Stripe uninstall (deauthorized),
 *                         or replaced by a different account. Rows are kept
 *                         as history with their tokens wiped.
 *
 * At most one live connection per tenant and one per Stripe account
 * (partial unique indexes): an account connected to one tenant can't be
 * connected to another.
 *
 * RLS + app-role grant follow the canonical tenant_isolation pattern. No
 * DELETE grant: a connection ends with an UPDATE of disconnectedAt.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('TenantStripeConnection', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('stripeAccountId', 64).notNullable();
    t.boolean('livemode').notNullable();
    t.string('keyMode', 16).notNullable();
    t.text('refreshTokenEnc').nullable();
    t.text('accessTokenEnc').nullable();
    t.timestamp('accessTokenExpiresAt', { useTz: true }).nullable();
    t.integer('permissionsVersion').notNullable();
    t.jsonb('permissionsGranted').nullable();
    // The admin who connected. No FK: Admin rows are never exported, and a
    // connection outlives the admin who made it.
    t.string('connectedByAdminId', 32).nullable();
    t.timestamp('connectedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('lastRefreshedAt', { useTz: true }).nullable();
    t.timestamp('refreshFailedAt', { useTz: true }).nullable();
    t.text('refreshError').nullable();
    t.timestamp('lastEventAt', { useTz: true }).nullable();
    t.timestamp('disconnectedAt', { useTz: true }).nullable();
    t.string('disconnectReason', 16).nullable();
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['stripeAccountId']);
    t.index(['tenantId']);
  });
  await knex.raw(`
    alter table "TenantStripeConnection"
      add constraint tenant_stripe_connection_key_mode_check
        check ("keyMode" in ('live', 'test', 'sandbox')),
      add constraint tenant_stripe_connection_disconnect_reason_check
        check ("disconnectReason" is null or "disconnectReason" in ('admin', 'deauthorized', 'replaced')),
      add constraint tenant_stripe_connection_shape_check
        check (
          ("disconnectedAt" is null and "disconnectReason" is null and "refreshTokenEnc" is not null)
          or ("disconnectedAt" is not null and "disconnectReason" is not null
              and "refreshTokenEnc" is null and "accessTokenEnc" is null)
        )
  `);
  await knex.raw(
    `create unique index "TenantStripeConnection_one_live_per_tenant" on "TenantStripeConnection" ("tenantId") where "disconnectedAt" is null`,
  );
  await knex.raw(
    `create unique index "TenantStripeConnection_one_live_per_account" on "TenantStripeConnection" ("stripeAccountId") where "disconnectedAt" is null`,
  );

  await knex.raw(`alter table "TenantStripeConnection" enable row level security`);
  await knex.raw(`alter table "TenantStripeConnection" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "TenantStripeConnection"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update on "TenantStripeConnection" to openpartner_app';
      end if;
    end
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'revoke all privileges on "TenantStripeConnection" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw('drop policy if exists tenant_isolation on "TenantStripeConnection"');
  await knex.schema.dropTableIfExists('TenantStripeConnection');
}
