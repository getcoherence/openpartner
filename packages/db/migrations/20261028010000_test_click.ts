import type { Knex } from 'knex';

/**
 * TestClick: an admin's test of a program's tracking chain (Admin →
 * Tracking health → Send a test click; apps/api/src/test-clicks.ts).
 *
 * A test click never enters Click. It is recorded here and only here, so
 * attribution, payouts, every click count and the fraud queue can't see it,
 * and no partner is involved: a brand can test before its first partner
 * joins. One row per test:
 *
 *   tokenHash     sha256 of the single-use token in the test link
 *                 (/r/_test/<token>). Only the admin API creates rows, so
 *                 a partner can't mark a click of their own as a test.
 *   expiresAt     the link must be opened by then
 *   clickId       the click id the router sent to the destination (a ULID,
 *                 like a real click's), with clickedAt and the destination
 *                 URL it redirected to; null until the link is opened
 *   landedAt      when the brand's script reported the click landing
 *                 (POST /attribution/landing), with the page's hostname
 *   identifiedAt  when the brand linked it to a signup or login
 *                 (POST /attribution/identify). The user id isn't kept.
 *
 * Not exported (docs/data-portability.md): diagnostics of one deployment,
 * like TrackingIssue, and not partner traffic. Rows are deleted 90 days
 * after creation (the tracking-alerts job), by when the click id the SDK
 * stored in the tester's browser has expired too.
 *
 * RLS follows the canonical tenant_isolation pattern. The app role creates
 * tests and records their steps; the router claims a test on the
 * privileged pool, and only the retention sweep and the tenant purge
 * delete one.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('TestClick', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('programId').notNullable().references('id').inTable('Program').onDelete('CASCADE');
    t.string('tokenHash', 64).notNullable().unique();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expiresAt', { useTz: true }).notNullable();
    t.string('clickId', 26);
    t.timestamp('clickedAt', { useTz: true });
    t.text('destination');
    t.timestamp('landedAt', { useTz: true });
    t.string('landingHost', 255);
    t.timestamp('identifiedAt', { useTz: true });
    t.index(['tenantId', 'createdAt']);
  });
  await knex.raw(`create unique index "TestClick_tenant_click_uniq" on "TestClick" ("tenantId", "clickId") where "clickId" is not null`);

  await knex.raw(`alter table "TestClick" enable row level security`);
  await knex.raw(`alter table "TestClick" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "TestClick"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update on "TestClick" to openpartner_app';
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
        execute 'revoke all privileges on "TestClick" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "TestClick"`);
  await knex.schema.dropTableIfExists('TestClick');
}
