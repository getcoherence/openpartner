import type { Knex } from 'knex';

/**
 * UTM + country capture on Click.
 *
 * Powers the partner-facing Analytics tab (top sources / mediums /
 * campaigns / countries breakdowns) and is the foundation for any
 * future first-touch / last-touch UTM-based attribution work.
 *
 * Capture sites:
 *   - apps/router (vendor-direct /r/<key> hits) — parses ?utm_* off the
 *     inbound URL, reads cf-ipcountry from the request headers
 *   - openpartner-network share-router (creator-domain hits) — same
 *     extraction, then federates the values via POST /clicks
 *   - apps/api/src/routes/clicks.ts (federation receiver) — accepts
 *     the values from the Network and persists them
 *
 * No backfill: existing rows stay NULL. UA-derived dimensions
 * (device/browser/os) are parse-on-read from the existing userAgent
 * column — no schema change needed for those.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Click', (t) => {
    t.string('utmSource', 255).nullable();
    t.string('utmMedium', 255).nullable();
    t.string('utmCampaign', 255).nullable();
    t.string('utmTerm', 255).nullable();
    t.string('utmContent', 255).nullable();
    /** ISO 3166-1 alpha-2, lowercased. Sourced from the Cloudflare
     *  cf-ipcountry header (free on every CF plan). When clicks bypass
     *  Cloudflare (direct origin hit) the column stays null. */
    t.string('country', 2).nullable();
  });
  // Indexes only on the dimensions we expect to filter / group on
  // heavily. utmTerm + utmContent are kept for export fidelity but
  // rarely queried; skip the index cost.
  await knex.schema.alterTable('Click', (t) => {
    t.index(['partnerId', 'utmSource'], 'click_partner_utm_source_idx');
    t.index(['partnerId', 'country'], 'click_partner_country_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Click', (t) => {
    t.dropIndex(['partnerId', 'utmSource'], 'click_partner_utm_source_idx');
    t.dropIndex(['partnerId', 'country'], 'click_partner_country_idx');
    t.dropColumn('utmSource');
    t.dropColumn('utmMedium');
    t.dropColumn('utmCampaign');
    t.dropColumn('utmTerm');
    t.dropColumn('utmContent');
    t.dropColumn('country');
  });
}
