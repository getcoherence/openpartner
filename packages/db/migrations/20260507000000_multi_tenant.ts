import type { Knex } from 'knex';

/**
 * Multi-tenant foundation.
 *
 * One codebase, two tenancy modes:
 *   OPENPARTNER_TENANCY=single  → self-hosters; tenantId = 'default'
 *   OPENPARTNER_TENANCY=multi   → hosted; tenantId resolved per request
 *
 * Schema strategy: shared schema, tenantId column on every data table,
 * unique-constraints scoped to (tenantId, ...) so two tenants can have a
 * partner with the same email, an admin with the same email, etc.
 *
 * Backfill: every existing row gets tenantId='default'. Self-hosters
 * upgrading via `pnpm migrate` see no behavior change — their single
 * tenant just happens to be named 'default'.
 *
 * Reserved tenant slugs (cannot be claimed): default, www, api, app,
 * admin, signup, network, dashboard, status. Reservations enforced at
 * the application layer (POST /signup), not in the schema, so we can
 * adjust without a migration.
 */
export async function up(knex: Knex): Promise<void> {
  // ---- Tenant: the new top-level entity ---------------------------------
  await knex.schema.createTable('Tenant', (t) => {
    t.string('id').primary(); // ULID
    t.string('slug').notNullable().unique(); // URL piece (acme.openpartner.app)
    t.string('displayName').notNullable();
    t.string('status').notNullable().defaultTo('active'); // active | suspended | cancelled
    // Per-tenant Stripe linkage. The platform Stripe account stays single;
    // each tenant has their own Customer + Subscription within it.
    t.string('stripeCustomerId');
    t.string('stripeSubscriptionId');
    // Optional custom domain (deferred to v2 — column reserved now to avoid
    // a follow-up migration when we wire it up).
    t.string('customDomain').unique();
    t.jsonb('metadata').notNullable().defaultTo('{}');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('suspendedAt', { useTz: true });
    t.index(['status']);
  });

  // Seed the 'default' tenant — used by self-hosters and as the bucket
  // we backfill all existing rows into. Pre-existing self-host installs
  // upgrade transparently because every legacy query starts filtering by
  // tenantId='default' once the middleware lands.
  await knex('Tenant').insert({
    id: '01J0000000DEFAULTTENANT0000',
    slug: 'default',
    displayName: 'Default tenant',
    status: 'active',
    metadata: '{"createdBy":"migration","reason":"single-tenant default"}' as unknown as never,
  });

  // ---- Add tenantId to every data table, backfill, then NOT NULL --------
  // We do this in three steps per table: add nullable column, backfill,
  // alter to NOT NULL. Keeps the migration safe to run against a non-empty
  // production DB without write-locking everything at once.
  const TENANT_TABLES = [
    'Partner',
    'Campaign',
    'Link',
    'Click',
    'Identity',
    'Event',
    'Attribution',
    'Commission',
    'Payout',
    'ApiKey',
    'Config',
    'Admin',
    'MagicLinkToken',
    'Session',
    'WebhookEndpoint',
    'WebhookDelivery',
  ];

  for (const tbl of TENANT_TABLES) {
    await knex.schema.alterTable(tbl, (t) => {
      t.string('tenantId');
    });
    await knex.raw(`update "${tbl}" set "tenantId" = '01J0000000DEFAULTTENANT0000' where "tenantId" is null`);
    await knex.schema.alterTable(tbl, (t) => {
      t.string('tenantId').notNullable().alter();
      t.foreign('tenantId').references('id').inTable('Tenant');
      t.index(['tenantId']);
    });
  }

  // ---- Re-scope unique constraints to be per-tenant ---------------------
  // Two tenants must be able to have, e.g., a Partner with email
  // 'alice@example.com'. Drop the original global uniques, replace with
  // (tenantId, ...) composite uniques.

  // Partner.email global → per-tenant
  await knex.schema.alterTable('Partner', (t) => {
    t.dropUnique(['email']);
    t.unique(['tenantId', 'email']);
  });

  // Admin.email global → per-tenant
  await knex.schema.alterTable('Admin', (t) => {
    t.dropUnique(['email']);
    t.unique(['tenantId', 'email']);
  });

  // Link.linkKey global → per-tenant. The router resolves a click by
  // (host, linkKey) anyway; the host gives us tenant.
  await knex.schema.alterTable('Link', (t) => {
    t.dropUnique(['linkKey']);
    t.unique(['tenantId', 'linkKey']);
  });

  // Config.key global → per-tenant. This is a real shape change for
  // self-hosters but the migration backfills everything to 'default' so
  // their existing config keys keep working.
  await knex.schema.alterTable('Config', (t) => {
    t.dropPrimary();
    t.primary(['tenantId', 'key']);
  });

  // ApiKey.keyHash global → per-tenant. A hash collision across tenants
  // is astronomically unlikely; the constraint just makes the intent
  // explicit and lets us scope queries cleanly.
  await knex.schema.alterTable('ApiKey', (t) => {
    // ApiKey doesn't have a global unique on keyHash in the existing
    // schema (it relies on the random length to avoid collisions), so
    // there's nothing to drop. Add a per-tenant index for fast lookup.
    t.index(['tenantId', 'keyHash']);
  });
}

export async function down(knex: Knex): Promise<void> {
  // Reversing means: restore the original global uniques, drop the
  // per-tenant composite uniques, drop tenantId columns, drop Tenant.
  // Self-hosters with a single 'default' tenant land back where they
  // started; multi-tenant deployments lose isolation (don't run this in
  // production multi-tenant mode without a separate data audit).

  await knex.schema.alterTable('ApiKey', (t) => {
    t.dropIndex(['tenantId', 'keyHash']);
  });
  await knex.schema.alterTable('Config', (t) => {
    t.dropPrimary();
    t.primary(['key']);
  });
  await knex.schema.alterTable('Link', (t) => {
    t.dropUnique(['tenantId', 'linkKey']);
    t.unique(['linkKey']);
  });
  await knex.schema.alterTable('Admin', (t) => {
    t.dropUnique(['tenantId', 'email']);
    t.unique(['email']);
  });
  await knex.schema.alterTable('Partner', (t) => {
    t.dropUnique(['tenantId', 'email']);
    t.unique(['email']);
  });

  const TENANT_TABLES = [
    'WebhookDelivery',
    'WebhookEndpoint',
    'Session',
    'MagicLinkToken',
    'Admin',
    'Config',
    'ApiKey',
    'Payout',
    'Commission',
    'Attribution',
    'Event',
    'Identity',
    'Click',
    'Link',
    'Campaign',
    'Partner',
  ];
  for (const tbl of TENANT_TABLES) {
    await knex.schema.alterTable(tbl, (t) => {
      t.dropForeign(['tenantId']);
      t.dropIndex(['tenantId']);
      t.dropColumn('tenantId');
    });
  }

  await knex.schema.dropTableIfExists('Tenant');
}
