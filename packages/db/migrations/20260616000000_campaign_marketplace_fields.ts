import type { Knex } from 'knex';

/**
 * Collapse the Campaign + Offering split into a single brand-facing concept.
 *
 * Before: brands created a Campaign (commission rule + attribution config),
 * then went to a separate Network → Offerings page and re-entered marketing
 * copy + bound the offering to the campaign. The Offering existed as its
 * own admin object.
 *
 * After: the Campaign owns its marketplace presence. A `shareOnNetwork`
 * toggle (defaults true when the brand is connected to the Network)
 * triggers an auto-upsert of the underlying Network Offering on every save.
 * The Offering still exists as storage on the Network side — it just stops
 * being something the brand admin interacts with directly.
 *
 * Three new columns:
 *   shareOnNetwork         — flip-on bool. When true + Network connected,
 *                            saves auto-publish/update the Network listing.
 *   marketplaceDescription — public-facing copy shown on the discover card.
 *                            Falls back to nothing (just brand mark + chips
 *                            + CTA) when null.
 *   networkOfferingId      — the Network's row id. Null until the first
 *                            successful upsert. Used to route subsequent
 *                            edits to PATCH instead of POST.
 *
 * Existing rows: shareOnNetwork defaults FALSE so we don't auto-publish
 * already-existing campaigns the brand may not have meant to list. Brand
 * flips them on per-campaign. (No live users to backfill at the time of
 * this change — see commit message.)
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.boolean('shareOnNetwork').notNullable().defaultTo(false);
    t.text('marketplaceDescription').nullable();
    t.string('networkOfferingId').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.dropColumn('shareOnNetwork');
    t.dropColumn('marketplaceDescription');
    t.dropColumn('networkOfferingId');
  });
}
