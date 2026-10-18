import type { Knex } from 'knex';

/**
 * Program.renewalsStayWithPartner — whether a customer's repeat revenue
 * keeps the attribution of the conversion that first earned it.
 *
 * On (the default, and what existing programs get): the attribution window
 * decides ACQUISITION, i.e. which click gets credit for a customer's first
 * conversion of each event type. A later event of a type the customer has
 * already converted on (the 2nd, 13th, 40th invoice_paid) reuses that first
 * conversion's partners and weights, however old the click is. Recurring
 * rules and their recurringMonths cap then decide what it pays.
 *
 * Off: every event is attributed on its own against the clicks inside the
 * window, as before this column existed.
 *
 * A setting, not state: the renewal attribution itself is derived from the
 * raw Attribution / Event rows each time (see attribution.ts), so nothing
 * here needs backfilling and flipping it is not retroactive. A plain core
 * column, exported with the rest of Program (bundle schemaVersion 5).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.boolean('renewalsStayWithPartner').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.dropColumn('renewalsStayWithPartner');
  });
}
