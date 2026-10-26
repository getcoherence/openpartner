import type { Knex } from 'knex';

/**
 * TrackingAlert — which Tracking health flags (tracking-flags.ts) the daily
 * alert job (tracking-alerts.ts) has already told the brand about, so an
 * open flag is emailed once rather than every day it stays open.
 *
 * The flags themselves are derived from the raw tables on every read; this
 * only records the job's own bookkeeping. One row per episode of a flag:
 *
 *   kind        'linkage_drop' | 'fast_sales'
 *   subject     what the flag is about: `<browser>|<device>|<metric>` for a
 *               linkage drop, the partner id for fast sales
 *   openedAt    the run that first saw this episode
 *   lastSeenAt  the latest run that still saw it. An episode not seen for a
 *               few days is closed (resolvedAt), so a flag that flickers
 *               across a threshold doesn't email each time it returns.
 *   notifiedAt  when the email naming it went out. Null when the episode
 *               came back within the re-notify cooldown, or the send failed
 *               (the next run retries it).
 *   resolvedAt  when the episode closed. At most one open episode per
 *               (tenant, kind, subject): the partial unique index is the
 *               dedupe, so two overlapping runs can't both open one.
 *   detail      the numbers the job saw last, for support.
 *
 * Not exported (docs/data-portability.md): a log of what one deployment
 * emailed, like WebhookDelivery. A restored instance re-derives the same
 * flags from the exported raw tables, and its first run emails the open
 * ones once.
 *
 * RLS follows the canonical tenant_isolation pattern. The app role reads,
 * opens and updates episodes; nothing deletes one but the tenant purge,
 * which runs on the privileged pool.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('TrackingAlert', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('kind', 40).notNullable();
    t.string('subject', 255).notNullable();
    t.timestamp('openedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('lastSeenAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('notifiedAt', { useTz: true });
    t.timestamp('resolvedAt', { useTz: true });
    t.jsonb('detail').notNullable().defaultTo('{}');
    t.index(['tenantId', 'kind', 'subject', 'notifiedAt']);
  });
  await knex.raw(
    `create unique index "TrackingAlert_open_uniq" on "TrackingAlert" ("tenantId", kind, subject) where "resolvedAt" is null`,
  );

  await knex.raw(`alter table "TrackingAlert" enable row level security`);
  await knex.raw(`alter table "TrackingAlert" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "TrackingAlert"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update on "TrackingAlert" to openpartner_app';
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
        execute 'revoke all privileges on "TrackingAlert" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "TrackingAlert"`);
  await knex.schema.dropTableIfExists('TrackingAlert');
}
