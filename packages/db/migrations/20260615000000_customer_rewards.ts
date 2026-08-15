import type { Knex } from 'knex';

/**
 * Customer-side rewards (dual-sided incentives, Path A — coupon-based).
 *
 * A Campaign can now offer a customer-facing discount alongside the
 * partner commission. When a Coupon is auto-minted for a partner, we
 * also provision a matching Stripe Coupon + PromotionCode so the
 * customer's discount is applied automatically at checkout — the
 * partner's existing attribution flow is unchanged.
 *
 * Schema:
 *   Campaign.customerReward (jsonb, nullable) — { type, value, duration, ... }
 *     null = partner-only program (current behavior).
 *   Coupon.stripeCouponId / Coupon.stripePromotionCodeId — set when the
 *     Stripe provisioning succeeded; null when Stripe wasn't configured at
 *     mint time, or when customerReward was added later (the existing
 *     codes won't retroactively get Stripe coupons — admin can re-mint).
 *
 * Path B (link-based dual-sided) is not implemented here; see the
 * project_dual_sided_link_rewards memory.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.jsonb('customerReward').nullable();
  });
  await knex.schema.alterTable('Coupon', (t) => {
    t.string('stripeCouponId').nullable();
    t.string('stripePromotionCodeId').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Coupon', (t) => {
    t.dropColumn('stripeCouponId');
    t.dropColumn('stripePromotionCodeId');
  });
  await knex.schema.alterTable('Campaign', (t) => {
    t.dropColumn('customerReward');
  });
}
