import type { Knex } from 'knex';

/**
 * Partner.portalAccess — whether the partner may sign in to the partner
 * portal.
 *
 * A headless (in-app) program creates its partners with `sendInvite: false`,
 * which makes them active at once. Before this column every active partner
 * could ask `POST /auth/signin` for a magic link, so anyone who knew a
 * customer's email could make OpenPartner email that customer, and the
 * customer could then use the hosted portal the brand never meant them to
 * see. With portalAccess false the sign-in request sends nothing (and
 * answers exactly as it does for an unknown email), magic links don't
 * verify and existing sessions stop resolving.
 *
 * NOT NULL with a constant default of true: every existing partner keeps
 * the access they have today, and Postgres 11+ adds the column without
 * rewriting the table. Core column, exported with the rest of Partner
 * (export schemaVersion 5); it applies to every deployment shape, so it is
 * not hosted-only metadata.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Partner', (t) => {
    t.boolean('portalAccess').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Partner', (t) => {
    t.dropColumn('portalAccess');
  });
}
