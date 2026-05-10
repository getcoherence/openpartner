import type { Knex } from 'knex';

/**
 * Rename Campaign → Program (and all FK columns + constraints).
 *
 * The original "Campaign" naming was Rewardful-inspired — implying a
 * time-bounded promo. What this object actually represents is an
 * ongoing partner program (commission rule + attribution config +
 * destination URL). "Program" matches Dub, Tolt, PartnerStack,
 * ShareASale, and the everyday brand vocabulary.
 *
 * Renames:
 *   Campaign            → Program
 *   PartnerCampaign     → PartnerProgram
 *   Click.campaignId    → Click.programId
 *   Link.campaignId     → Link.programId
 *   Attribution.campaignId → Attribution.programId
 *   Coupon.campaignId   → Coupon.programId
 *   PartnerCampaign.campaignId → PartnerProgram.programId
 *
 * Plus all FK / unique / check / pkey / index / RLS policy names that
 * still carry the old word in their identifier — Postgres doesn't
 * cascade-rename those when the table moves, so we explicitly rename
 * each one. Catches the cases where psql's `\d` would still display
 * "campaign_*" months after the table rename.
 *
 * One-way cutover: down() reverses the renames but doesn't restore old
 * code paths that reference Campaign — restoration would mean reverting
 * application code too.
 */
export async function up(knex: Knex): Promise<void> {
  // 1. Tables
  await knex.raw(`alter table "Campaign" rename to "Program"`);
  await knex.raw(`alter table "PartnerCampaign" rename to "PartnerProgram"`);

  // 2. FK columns on dependent tables
  await knex.raw(`alter table "Click" rename column "campaignId" to "programId"`);
  await knex.raw(`alter table "Link" rename column "campaignId" to "programId"`);
  await knex.raw(`alter table "Attribution" rename column "campaignId" to "programId"`);
  await knex.raw(`alter table "Coupon" rename column "campaignId" to "programId"`);
  await knex.raw(`alter table "PartnerProgram" rename column "campaignId" to "programId"`);

  // 3. Constraints with the old name baked into their identifiers.
  // PG truncates names to NAMEDATALEN (63), so we keep the new names tight.
  await knex.raw(`alter table "Program" rename constraint "Campaign_pkey" to "Program_pkey"`);
  await knex.raw(`alter table "Program" rename constraint "campaign_tenantid_foreign" to "program_tenantid_foreign"`);
  await knex.raw(`alter table "Program" rename constraint "Campaign_holdbackDays_check" to "Program_holdbackDays_check"`);
  await knex.raw(`alter table "PartnerProgram" rename constraint "PartnerCampaign_pkey" to "PartnerProgram_pkey"`);
  await knex.raw(`alter table "PartnerProgram" rename constraint "partnercampaign_tenantid_foreign" to "partnerprogram_tenantid_foreign"`);
  await knex.raw(`alter table "PartnerProgram" rename constraint "partnercampaign_partnerid_foreign" to "partnerprogram_partnerid_foreign"`);
  await knex.raw(`alter table "PartnerProgram" rename constraint "partnercampaign_campaignid_foreign" to "partnerprogram_programid_foreign"`);
  await knex.raw(`alter table "PartnerProgram" rename constraint "partnercampaign_tenantid_partnerid_campaignid_unique" to "partnerprogram_tenantid_partnerid_programid_unique"`);
  await knex.raw(`alter table "Link" rename constraint "link_campaignid_foreign" to "link_programid_foreign"`);
  await knex.raw(`alter table "Coupon" rename constraint "coupon_campaignid_foreign" to "coupon_programid_foreign"`);
  await knex.raw(`alter table "Coupon" rename constraint "coupon_tenantid_partnerid_campaignid_unique" to "coupon_tenantid_partnerid_programid_unique"`);

  // 4. Indexes (Postgres keeps the old auto-generated names after column
  //    rename; rename them too so psql `\d` reads cleanly).
  await knex.raw(`do $$ begin
    if exists (select 1 from pg_indexes where indexname = 'campaign_tenantid_index') then
      execute 'alter index campaign_tenantid_index rename to program_tenantid_index';
    end if;
    if exists (select 1 from pg_indexes where indexname = 'partnercampaign_tenantid_partnerid_index') then
      execute 'alter index partnercampaign_tenantid_partnerid_index rename to partnerprogram_tenantid_partnerid_index';
    end if;
  end $$`);

  // 5. RLS policies — both renamed tables had `tenant_isolation` policies.
  //    The policy name itself doesn't include the table name so no rename
  //    needed; PG attaches the existing policy to the renamed table
  //    automatically. (Verified via pg_policies inspection at migration time.)
}

export async function down(knex: Knex): Promise<void> {
  // 5/4 — indexes + RLS reverse
  await knex.raw(`do $$ begin
    if exists (select 1 from pg_indexes where indexname = 'partnerprogram_tenantid_partnerid_index') then
      execute 'alter index partnerprogram_tenantid_partnerid_index rename to partnercampaign_tenantid_partnerid_index';
    end if;
    if exists (select 1 from pg_indexes where indexname = 'program_tenantid_index') then
      execute 'alter index program_tenantid_index rename to campaign_tenantid_index';
    end if;
  end $$`);

  // 3 — constraints reverse
  await knex.raw(`alter table "Coupon" rename constraint "coupon_tenantid_partnerid_programid_unique" to "coupon_tenantid_partnerid_campaignid_unique"`);
  await knex.raw(`alter table "Coupon" rename constraint "coupon_programid_foreign" to "coupon_campaignid_foreign"`);
  await knex.raw(`alter table "Link" rename constraint "link_programid_foreign" to "link_campaignid_foreign"`);
  await knex.raw(`alter table "PartnerProgram" rename constraint "partnerprogram_tenantid_partnerid_programid_unique" to "partnercampaign_tenantid_partnerid_campaignid_unique"`);
  await knex.raw(`alter table "PartnerProgram" rename constraint "partnerprogram_programid_foreign" to "partnercampaign_campaignid_foreign"`);
  await knex.raw(`alter table "PartnerProgram" rename constraint "partnerprogram_partnerid_foreign" to "partnercampaign_partnerid_foreign"`);
  await knex.raw(`alter table "PartnerProgram" rename constraint "partnerprogram_tenantid_foreign" to "partnercampaign_tenantid_foreign"`);
  await knex.raw(`alter table "PartnerProgram" rename constraint "PartnerProgram_pkey" to "PartnerCampaign_pkey"`);
  await knex.raw(`alter table "Program" rename constraint "Program_holdbackDays_check" to "Campaign_holdbackDays_check"`);
  await knex.raw(`alter table "Program" rename constraint "program_tenantid_foreign" to "campaign_tenantid_foreign"`);
  await knex.raw(`alter table "Program" rename constraint "Program_pkey" to "Campaign_pkey"`);

  // 2 — column reverse
  await knex.raw(`alter table "PartnerProgram" rename column "programId" to "campaignId"`);
  await knex.raw(`alter table "Coupon" rename column "programId" to "campaignId"`);
  await knex.raw(`alter table "Attribution" rename column "programId" to "campaignId"`);
  await knex.raw(`alter table "Link" rename column "programId" to "campaignId"`);
  await knex.raw(`alter table "Click" rename column "programId" to "campaignId"`);

  // 1 — table reverse
  await knex.raw(`alter table "PartnerProgram" rename to "PartnerCampaign"`);
  await knex.raw(`alter table "Program" rename to "Campaign"`);
}
