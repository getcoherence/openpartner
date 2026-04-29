/**
 * PartnerCampaign join — which Campaigns each Partner is allowed to
 * create share-links for. Closes the leak where any active Partner
 * could create a Link against any Campaign the brand had.
 *
 * Source field captures *why* the grant exists:
 *   - 'admin'    : brand admin granted at invite or after the fact
 *   - 'offering' : auto-granted by Network federation when an
 *                  application was approved, scoped to the Offering's
 *                  vendorCampaignId
 *
 * Backfill: every existing (partner, campaign) gets an 'admin' grant
 * so current behavior is preserved. Brands wanting to lock down later
 * can revoke per-pair via the admin UI.
 */

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PartnerCampaign', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant');
    t.string('partnerId').notNullable().references('id').inTable('Partner').onDelete('CASCADE');
    t.string('campaignId').notNullable().references('id').inTable('Campaign').onDelete('CASCADE');
    t.string('source').notNullable(); // 'admin' | 'offering'
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['tenantId', 'partnerId', 'campaignId']);
    t.index(['partnerId']);
    t.index(['campaignId']);
    t.index(['tenantId']);
  });

  // Cross product backfill: every existing partner gets access to every
  // existing Campaign in their tenant (matches today's effective
  // behavior). Stamped 'admin' so it's clear these are operator grants,
  // not Network-driven.
  await knex.raw(`
    insert into "PartnerCampaign" (id, "tenantId", "partnerId", "campaignId", source)
    select
      'pc_' || md5(p.id || '|' || c.id),
      p."tenantId",
      p.id,
      c.id,
      'admin'
    from "Partner" p
    join "Campaign" c on c."tenantId" = p."tenantId"
    on conflict do nothing
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('PartnerCampaign');
}
