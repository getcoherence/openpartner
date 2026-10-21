import type { Knex } from 'knex';

/**
 * Coupon.brandChosen — the brand's admin typed this code, rather than it
 * being generated or chosen by the partner.
 *
 * The Stripe webhook matches a discount to a partner code by its string
 * (apps/api/src/routes/stripe-webhook.ts findCouponByDiscountCode). A
 * promotion code or Stripe Coupon in the brand's account that already
 * existed when the partner's code was minted is the brand's own promo, and
 * a partner code equal to it would be credited with every order using it.
 * The one exception is a code the admin chose: mapping a promo the brand
 * already runs onto a partner is a supported choice (routes/coupons.ts).
 * This column is how the webhook tells that exception apart.
 *
 * Existing rows get false. Who chose an existing code isn't recorded
 * anywhere, and false is the side that can't pay a partner for the brand's
 * own promo. An admin who did map an existing promo onto a partner before
 * this column sets it to true on that row.
 *
 * Core raw column, exported with the rest of Coupon at export
 * schemaVersion 10 (docs/data-portability.md).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Coupon', (t) => {
    t.boolean('brandChosen').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Coupon', (t) => {
    t.dropColumn('brandChosen');
  });
}
