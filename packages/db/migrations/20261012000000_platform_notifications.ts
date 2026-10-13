import type { Knex } from 'knex';

/**
 * Platform → customer notifications: setup reminders to brands, the
 * operator switches that turn reminder sweeps on, and email opt-outs.
 *
 * All three tables are PLATFORM-scoped and hosted-only sidecars (the
 * pattern 20260712010000_platform_admin_review.ts set): only the privileged
 * `db` pool touches them, from the scheduler and the ops console. They are
 * NOT granted to the openpartner_app role, carry no RLS policy, and are not
 * in the export allowlist — none of this is the brand's attribution data.
 */
export async function up(knex: Knex): Promise<void> {
  // Runtime operator switches (owner rule: runtime-adjustable config lives
  // in the DB with an admin UI, not in env). Keyed JSON blobs, e.g.
  // key='notifications' → { brandSetupReminders, creatorProfileReminders }.
  await knex.schema.createTable('PlatformSetting', (t) => {
    t.string('key').primary();
    t.jsonb('value').notNullable().defaultTo('{}');
    t.string('updatedByEmail');
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // One row per reminder actually sent to a brand. The unique key is the
  // dedupe + claim: a sweep inserts the row BEFORE sending (ON CONFLICT DO
  // NOTHING), so two overlapping runs can never both send step N. Cascades
  // with the tenant so hard-delete needs no extra bookkeeping.
  await knex.schema.createTable('BrandNotification', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('kind').notNullable(); // 'setup_incomplete'
    t.integer('step').notNullable();
    t.string('recipientEmail').notNullable();
    t.string('sentByEmail'); // operator, for a manual send from the console; null = scheduled sweep
    t.timestamp('sentAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['tenantId', 'kind', 'step']);
    t.index(['kind', 'sentAt']);
  });

  // Opt-outs from platform-sent, non-essential email (one-click unsubscribe
  // links). Keyed by address + scope so opting out of setup reminders never
  // silences sign-in links or billing notices.
  await knex.schema.createTable('EmailOptOut', (t) => {
    t.string('id').primary();
    t.string('email').notNullable(); // normalized lowercase
    t.string('scope').notNullable(); // 'brand_setup'
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['email', 'scope']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('EmailOptOut');
  await knex.schema.dropTableIfExists('BrandNotification');
  await knex.schema.dropTableIfExists('PlatformSetting');
}
