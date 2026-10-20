import type { Knex } from 'knex';

/**
 * Click.subId — the publisher's own sub-ID, passed through a partner link.
 *
 * Tracking tools publishers use to pull conversions from many programs into
 * one dashboard (wecantrack and the like) put their own click id on the
 * partner link as `?sub_id=…`. The router stores it here, raw (trimmed, cut
 * to 255, empty → null) and never forwards it to the destination. It comes
 * back on the commission.* webhooks (`subId`) and as the `{sub_id}` partner
 * postback macro, so the tool can match our conversion to its click.
 *
 * Capture sites, as for the UTM columns (20260621000000_click_utm_country):
 *   - apps/router — `?sub_id` off the inbound partner link
 *   - apps/api/src/routes/clicks.ts — `subId` from a federating caller
 *
 * Nullable, no index (nothing filters on it; the tool matches on its side),
 * no backfill. Core raw column, exported with the rest of Click at export
 * schemaVersion 8 (docs/data-portability.md).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Click', (t) => {
    t.string('subId', 255).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Click', (t) => {
    t.dropColumn('subId');
  });
}
