import type { Knex } from 'knex';

/**
 * Velocity / basic fraud flagging on Click rows.
 *
 * We keep flagged clicks in the table (audit trail > silent drop) but the
 * attribution engine ignores them. A null value means "clean".
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Click', (t) => {
    t.string('fraudFlag'); // 'velocity' | 'manual' | null
    t.index(['fraudFlag']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Click', (t) => {
    t.dropIndex(['fraudFlag']);
    t.dropColumn('fraudFlag');
  });
}
