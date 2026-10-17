import type { Knex } from 'knex';

/**
 * HostedFundingAuthorization.adminId → nullable.
 *
 * The authorization flow records WHICH admin accepted the funding terms.
 * Portal sessions always have one, but an operator using the env admin
 * key (bootstrap installs, support interventions) has no Admin row — the
 * FK made that path impossible. Null = "authorized via operator key";
 * the FK still validates non-null values.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('HostedFundingAuthorization', (t) => {
    t.string('adminId', 32).nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('HostedFundingAuthorization', (t) => {
    t.string('adminId', 32).notNullable().alter();
  });
}
