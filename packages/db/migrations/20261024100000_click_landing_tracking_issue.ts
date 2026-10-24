import type { Knex } from 'knex';

/**
 * Two tables behind Admin → Tracking health: where partner clicks go
 * missing between the partner link and a credited conversion.
 *
 * ClickLanding — the browser SDK saw this click arrive on the brand's site
 * (POST /attribution/landing). Raw and append-only, one row per click: the
 * first landing is the one that matters, and a reload of the landing page
 * re-sends nothing new. A click with no landing row never reached a page
 * running the SDK: the redirect lost `?cref=`, the script isn't on that
 * page, or a consent banner held it back. Click itself stays immutable.
 *
 *   clickId   the Click that landed. Cascades with it (only the tenant
 *             purge deletes clicks).
 *   landedAt  when the beacon arrived.
 *   host      the page's hostname (never its path or query, which can
 *             carry an email or a token), so a journey that lands on
 *             www. and signs up on app. shows both.
 *
 * Exported (export v12): it's part of the click log, and a restored
 * instance shows the same landing rates.
 *
 * TrackingIssue — inputs OpenPartner had to drop, counted per day: a click
 * id identify() or a conversion named that isn't one of this tenant's
 * clicks, a Checkout Session whose client_reference_id isn't one, a coupon
 * code nobody holds. Each is a conversion that may have belonged to a
 * partner and silently didn't. One row per (tenant, day, kind) with a
 * running count, so an unauthenticated caller spraying junk at identify
 * grows a counter, not the table. `sampleRef` keeps the latest value
 * seen (cut to 64 characters) so the brand can recognise its own typo.
 *
 * Not exported (docs/data-portability.md): a log of rejected input on one
 * deployment, like WebhookDelivery. Nothing re-derives from it, and a
 * restored instance starts counting afresh.
 *
 * RLS follows the canonical tenant_isolation pattern. The app role may
 * only read and append landings; issues it may also update (the upsert
 * that bumps a counter). The tenant purge runs on the privileged pool.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ClickLanding', (t) => {
    t.string('clickId').primary().references('id').inTable('Click').onDelete('CASCADE');
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.timestamp('landedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.string('host', 255);
    t.index(['tenantId', 'landedAt']);
  });

  await knex.schema.createTable('TrackingIssue', (t) => {
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.date('day').notNullable();
    t.string('kind', 40).notNullable();
    t.integer('count').notNullable().defaultTo(0);
    t.string('sampleRef', 64);
    t.timestamp('firstSeenAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('lastSeenAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['tenantId', 'day', 'kind']);
  });

  for (const [table, grant] of [
    ['ClickLanding', 'select, insert'],
    ['TrackingIssue', 'select, insert, update'],
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
  for (const table of ['TrackingIssue', 'ClickLanding']) {
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
}
