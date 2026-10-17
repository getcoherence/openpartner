import type { Knex } from 'knex';

/**
 * Indexes for two hot lookups that no existing index could answer.
 *
 *   Coupon ("tenantId", lower(code)) — findCouponByCode's case-insensitive
 *     fallback (/coupons/redeem misses, and the self-host Stripe
 *     auto-redeem's lookups of the brand's own promo codes). The
 *     (tenantId, code) unique can't serve lower(code), so each one read
 *     the tenant's whole coupon list: a seq scan once a headless program
 *     mints a code per partner. Only connections that bypass RLS use it
 *     (self-host's default superuser): on an RLS table Postgres won't put
 *     a non-leakproof function like lower() in an index condition, which
 *     is why findCouponByCode tries the exact upper-case code first.
 *
 *   Link ("linkKey") — the router's key-only route (/r/:linkKey, used by
 *     single-tenant installs and hosts it doesn't recognise) looks a link
 *     up by key alone, so the (tenantId, linkKey) unique is no use to it
 *     and every click was a seq scan of Link. Not unique: keys are only
 *     unique per tenant.
 *
 * Plain indexes, not constraints: codes that differ only in case can
 * already coexist, and adding these changes no behaviour. Both tables are
 * small next to Click/Event, so a regular (locking) build is brief.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('create index "Coupon_tenantId_lower_code_index" on "Coupon" ("tenantId", lower("code"))');
  await knex.schema.alterTable('Link', (t) => {
    t.index(['linkKey'], 'Link_linkKey_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Link', (t) => {
    t.dropIndex(['linkKey'], 'Link_linkKey_index');
  });
  await knex.raw('drop index "Coupon_tenantId_lower_code_index"');
}
