import type { Knex } from 'knex';

/**
 * Program.couponsYieldToLinks — whether a partner's link click beats a
 * coupon code from another partner.
 *
 * A coupon redemption writes a synthetic click stamped at checkout
 * (routes/coupons.ts ensureCouponClickAndIdentity), so under last click it
 * always wins against the link click that brought the customer, days
 * earlier. That's a policy, and until now an invisible one: Admin →
 * Tracking health counts how often it happens. Off (false, today's
 * behaviour, the default for every existing program): the code competes as
 * the most recent touch. On: the program's coupon clicks drop out of a
 * conversion whenever the customer has a link click inside the window, so
 * a code only credits when no link did.
 *
 * Decided per coupon click, by the program the code belongs to
 * (attribution.ts). It decides who wins a customer's first conversion of
 * each type; with renewalsStayWithPartner on, renewals then follow that
 * winner, so turning it on doesn't move an existing customer's renewals.
 * Derived like everything else: changing it re-decides future first
 * conversions, never ones already attributed. Exported on the
 * Program row (export v12; older bundles restore it as false).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.boolean('couponsYieldToLinks').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.dropColumn('couponsYieldToLinks');
  });
}
