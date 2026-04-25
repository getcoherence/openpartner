import type { Knex } from 'knex';

/**
 * Admin accounts as first-class personas.
 *
 *   Admin                     one row per human admin. Same auth model
 *                             as partners (magic-link → session).
 *   Session, MagicLinkToken   partnerId → (principalKind, principalId).
 *                             Generalizes both tables to hold admin or
 *                             partner tokens with no per-principal
 *                             duplication.
 *
 * The ADMIN_API_KEY env stays as the bootstrap / headless / CI path —
 * it's a shared bearer that behaves like the env-sourced admin principal
 * we had before. Human admins authenticate via their account instead.
 *
 * Backfill strategy: existing Session + MagicLinkToken rows all belong
 * to partners, so we stamp them with principalKind='partner' and copy
 * partnerId → principalId before dropping the old column.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('Admin', (t) => {
    t.string('id').primary();
    t.string('email').notNullable().unique();
    t.string('name').notNullable();
    t.timestamp('activatedAt', { useTz: true });
    t.timestamp('revokedAt', { useTz: true });
    t.text('revokeReason');
    t.timestamp('lastSignInAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['email']);
  });

  // ---- Session: add generic principal columns, backfill, drop partnerId ----
  await knex.schema.alterTable('Session', (t) => {
    t.string('principalKind'); // 'partner' | 'admin'
    t.string('principalId');
  });
  await knex.raw(`
    update "Session"
    set "principalKind" = 'partner',
        "principalId"   = "partnerId"
    where "principalId" is null
  `);
  // Drop the FK + column. We enforce integrity at the app layer now
  // because (kind, id) can point at two different tables.
  await knex.schema.alterTable('Session', (t) => {
    t.dropForeign(['partnerId']);
    t.dropColumn('partnerId');
    t.string('principalKind').notNullable().alter();
    t.string('principalId').notNullable().alter();
    t.index(['principalKind', 'principalId']);
  });

  // ---- MagicLinkToken: same treatment ----
  await knex.schema.alterTable('MagicLinkToken', (t) => {
    t.string('principalKind');
    t.string('principalId');
  });
  await knex.raw(`
    update "MagicLinkToken"
    set "principalKind" = 'partner',
        "principalId"   = "partnerId"
    where "principalId" is null
  `);
  await knex.schema.alterTable('MagicLinkToken', (t) => {
    t.dropForeign(['partnerId']);
    t.dropColumn('partnerId');
    t.string('principalKind').notNullable().alter();
    t.string('principalId').notNullable().alter();
  });

  // Existing magic-link purposes carry over; new ones are added in code:
  //   'partner_invite', 'partner_signin'        ← existing
  //   'admin_invite', 'admin_signin'            ← new
}

export async function down(knex: Knex): Promise<void> {
  // Reversing the generalization means re-adding partnerId + re-populating
  // only the rows whose principalKind='partner'. Admin-kind rows are lost.
  await knex.schema.alterTable('MagicLinkToken', (t) => {
    t.string('partnerId');
  });
  await knex.raw(`
    update "MagicLinkToken"
    set "partnerId" = "principalId"
    where "principalKind" = 'partner'
  `);
  await knex.schema.alterTable('MagicLinkToken', (t) => {
    // (No dropIndex here — up() never added an index on
    // MagicLinkToken's (principalKind, principalId); the index is
    // only on Session.)
    t.dropColumn('principalKind');
    t.dropColumn('principalId');
    t.foreign('partnerId').references('id').inTable('Partner').onDelete('CASCADE');
  });

  await knex.schema.alterTable('Session', (t) => {
    t.string('partnerId');
  });
  await knex.raw(`
    update "Session"
    set "partnerId" = "principalId"
    where "principalKind" = 'partner'
  `);
  await knex.schema.alterTable('Session', (t) => {
    t.dropIndex(['principalKind', 'principalId']);
    t.dropColumn('principalKind');
    t.dropColumn('principalId');
    t.foreign('partnerId').references('id').inTable('Partner').onDelete('CASCADE');
  });

  await knex.schema.dropTableIfExists('Admin');
}
