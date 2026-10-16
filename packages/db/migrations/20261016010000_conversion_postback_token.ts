import type { Knex } from 'knex';

/**
 * ConversionPostbackToken — the credential for GET /postback, the inbound
 * conversion URL affiliate networks and lenders fire when all they can do is
 * request a URL.
 *
 * Not an ApiKey row. The token travels in a query string, where proxies,
 * browser history and the sender's own logs keep it, so it must be worth
 * little when it leaks: it records conversions and nothing else, and it is
 * never accepted as a Bearer key. Its own `opcp_` prefix keeps it from being
 * mistaken for one.
 *
 *   prefix       First 13 chars of the token (`opcp_` + 8), for an indexed
 *                lookup; the token itself is stored only as a sha256 hash.
 *   ipAllowlist  IPs / CIDRs postbacks may come from. Empty = any source.
 *   revokedAt    Set on rotation or when postbacks are turned off.
 *
 * At most one live token per tenant (partial unique index); rotating revokes
 * the old row and inserts a new one in one transaction. Credentials, so
 * never exported (docs/data-portability.md).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ConversionPostbackToken', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('prefix', 16).notNullable();
    t.string('tokenHash', 64).notNullable();
    t.jsonb('ipAllowlist').notNullable().defaultTo('[]');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('lastUsedAt', { useTz: true }).nullable();
    t.timestamp('revokedAt', { useTz: true }).nullable();
    t.index(['tenantId', 'prefix']);
  });
  await knex.raw(
    `create unique index "ConversionPostbackToken_one_live_per_tenant" on "ConversionPostbackToken" ("tenantId") where "revokedAt" is null`,
  );

  // RLS — same pattern as every other tenanted table on the openpartner_app role.
  await knex.raw(`alter table "ConversionPostbackToken" enable row level security`);
  await knex.raw(`alter table "ConversionPostbackToken" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "ConversionPostbackToken"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  // No DELETE: retiring a token is an UPDATE of revokedAt, which keeps the
  // rotation history. No-op without the role (CI, single-tenant deploys
  // running as the migration role) — the DO-block guard the other tables use.
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update on "ConversionPostbackToken" to openpartner_app';
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
        execute 'revoke all privileges on "ConversionPostbackToken" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw('drop policy if exists tenant_isolation on "ConversionPostbackToken"');
  await knex.schema.dropTableIfExists('ConversionPostbackToken');
}
