import type { Knex } from 'knex';

/**
 * PortalCustomDomain: white-label custom-domain registrations (spec §3.2).
 *
 * A sidecar table (NOT a core attribution table — CLAUDE.md §2): a tenant can
 * hold a pending + a verified domain during cutover, and the rows keep an
 * audit trail of verification history. `Tenant.customDomain` stays the
 * denormalized "primary verified domain" used on the host-resolution hot
 * path; this table is touched by the register/verify admin flows, the
 * cert/entitlement allow-gate, and the re-verification job.
 *
 *   domain             Globally unique — prevents two tenants racing to claim
 *                      the same host.
 *   verificationToken  Hex proof placed in the `_openpartner.<domain>` TXT
 *                      record. Rotated on registration and on every failed
 *                      (re-)verification cycle — never static (§7.6).
 *   status             pending | verified | failed. NOT terminal: the
 *                      re-verification job demotes verified → failed when the
 *                      TXT record disappears (dangling-CNAME takeover guard).
 *   edgeKind           do_native (DO App Platform custom domain, MVP) |
 *                      droplet (Phase-3 Caddy on-demand edge). Drives the DNS
 *                      instructions handed to the customer.
 *   verifiedAt         Last successful DNS verification.
 *   lastCheckedAt      Last re-verification poll (§7.6 staleness TTL input).
 */

const STATUSES = ['pending', 'verified', 'failed'] as const;
const EDGE_KINDS = ['do_native', 'droplet'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PortalCustomDomain', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('domain', 253).notNullable().unique();
    t.string('verificationToken', 64).notNullable();
    t.string('status', 16).notNullable().defaultTo('pending');
    t.string('edgeKind', 16).notNullable().defaultTo('do_native');
    t.timestamp('verifiedAt', { useTz: true }).nullable();
    t.timestamp('lastCheckedAt', { useTz: true }).nullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId']);
    // The allow-gate's hot lookup: WHERE domain = ? AND status = 'verified'.
    t.index(['domain', 'status']);
  });
  const statuses = STATUSES.map((s) => `'${s}'`).join(', ');
  await knex.raw(
    `alter table "PortalCustomDomain" add constraint "PortalCustomDomain_status_check" check ("status" in (${statuses}))`,
  );
  const edgeKinds = EDGE_KINDS.map((k) => `'${k}'`).join(', ');
  await knex.raw(
    `alter table "PortalCustomDomain" add constraint "PortalCustomDomain_edgeKind_check" check ("edgeKind" in (${edgeKinds}))`,
  );

  // RLS — same pattern as every other tenanted table. The admin
  // register/verify endpoints run on the RLS-scoped app pool, so a tenant
  // physically cannot insert/read a row under another tenantId. The
  // allow-gate and host-resolver run on the privileged pool (bypasses RLS)
  // for the legitimate cross-tenant domain → tenant lookup.
  await knex.raw(`alter table "PortalCustomDomain" enable row level security`);
  await knex.raw(`alter table "PortalCustomDomain" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "PortalCustomDomain"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  // Grant DML to the app role (idempotent guard: role absent on CI /
  // single-tenant installs that run as the migration role).
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "PortalCustomDomain" to openpartner_app';
      end if;
    end
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop policy if exists tenant_isolation on "PortalCustomDomain"');
  await knex.schema.dropTableIfExists('PortalCustomDomain');
}
