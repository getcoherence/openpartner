import type { Knex } from 'knex';

/**
 * Optional reason captured at revoke time — shown to the partner in
 * the notification email and included in the suspension response if
 * they later try to sign in.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Partner', (t) => {
    t.text('revokeReason');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Partner', (t) => {
    t.dropColumn('revokeReason');
  });
}
