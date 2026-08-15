import type { Knex } from 'knex';

/**
 * Coupon-code attribution.
 *
 * A coupon is the second-class attribution path: instead of a click on
 * a partner share-link, the customer enters a code at checkout and the
 * brand calls /coupons/redeem on conversion. Same downstream attribution
 * + commission flow — internally we synthesize a Click + Identity + Event
 * so the existing engine runs unchanged.
 *
 * v1 scope: one Coupon per (partnerId, campaignId). Auto-minted when
 * the partner is granted access to a campaign (via PartnerCampaign
 * insert in the application layer). No expiration, no usage cap, no
 * per-customer dedup beyond the standard Event.externalEventId path.
 *
 * Code format is a-handle-or-id-suffix-with-random4 uppercased — short
 * enough to type, recognizable enough to feel branded.
 */

export async function up(knex: Knex): Promise<void> {
  // Click.linkId becomes nullable — coupon redemptions create a
  // synthetic Click without a real Link (the customer entered a code,
  // not clicked a URL). Existing rows all have a linkId; nothing to
  // backfill.
  await knex.schema.alterTable('Click', (t) => {
    t.string('linkId').nullable().alter();
  });

  await knex.schema.createTable('Coupon', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable();
    t.string('partnerId').notNullable().references('id').inTable('Partner').onDelete('CASCADE');
    t.string('campaignId').notNullable().references('id').inTable('Campaign').onDelete('CASCADE');
    // Code is the user-facing string customers enter. Per-tenant unique
    // so two brands' partners can both have CREATOR15. Case-insensitive
    // lookup is enforced at the route layer.
    t.string('code').notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['tenantId', 'code']);
    t.unique(['tenantId', 'partnerId', 'campaignId']);
    t.index(['tenantId', 'partnerId']);
  });

  // RLS: coupons are tenant-scoped, same pattern as the rest of the
  // multi-tenant tables. Privileged role bypasses; app role enforces
  // the per-tenant filter via app.tenant_id GUC.
  await knex.raw('alter table "Coupon" enable row level security');
  await knex.raw(`
    create policy "Coupon_tenant_isolation" on "Coupon"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  // App-role grant. Idempotent — if openpartner_app doesn't exist
  // (OPENPARTNER_APP_DB_PASSWORD unset; the app runs as the migration
  // role and bypasses RLS), this is a no-op via DO block.
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "Coupon" to openpartner_app';
      end if;
    end
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('Coupon');
  // Restoring the NOT NULL is unsafe if any coupon-redemption rows
  // already exist (their linkId is null). Leave the column nullable —
  // application code already tolerates either shape.
}
