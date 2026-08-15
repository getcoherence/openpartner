import type { Knex } from 'knex';

/**
 * Per-program toggle: can partners self-customize their coupon code?
 *
 * Defaults to false so existing programs preserve admin-only behavior.
 * When true, the partner-facing coupon row exposes a rename action; the
 * vendor's PATCH /partners/:id/coupons/:couponId accepts scoped/federation
 * auth (otherwise admin-only).
 *
 * Rename semantics are in-place: the existing Coupon row gets the new code,
 * any Stripe PromotionCode is replaced (deactivate old + create new). The
 * old code stops working at checkout, which is communicated in the partner
 * UI before save.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.boolean('partnersMayCustomizeCode').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.dropColumn('partnersMayCustomizeCode');
  });
}
