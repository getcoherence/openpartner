import type { Knex } from 'knex';

/**
 * Coupon-integration verification gate.
 *
 * Tracks whether the brand's coupon-redemption integration has been
 * proven to work — i.e. at least one synthetic Click was created via
 * either /coupons/redeem or the Stripe webhook auto-redemption path.
 *
 * The route layer reads this to gate manual coupon mints past a
 * small free-trial threshold. Without it, a brand could happily mint
 * 50 coupons for partners to promote, never wire up their checkout
 * integration, and silently stiff every partner.
 *
 * Stamp set on the FIRST successful coupon redemption ever; never
 * unset. Idempotent: subsequent redemptions don't re-stamp.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.timestamp('couponIntegrationVerifiedAt', { useTz: true });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropColumn('couponIntegrationVerifiedAt');
  });
}
