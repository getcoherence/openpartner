import type { Knex } from 'knex';

/**
 * TestClick.linkedVia: what linked a test click to a customer, beside
 * identifiedAt. Besides identify(), a Stripe checkout carrying the click id
 * (client_reference_id) or a conversion call naming it now passes the test,
 * so a brand whose site never calls identify() can verify its tracking too
 * (apps/api/src/test-clicks.ts). One of 'identify', 'checkout',
 * 'conversion'; null until linked, and on rows linked before this column,
 * which were all identify().
 *
 * TestClick is a sidecar outside the export bundle.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('TestClick', (t) => {
    t.text('linkedVia').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('TestClick', (t) => {
    t.dropColumn('linkedVia');
  });
}
