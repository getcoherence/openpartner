import type { Knex } from 'knex';

/**
 * Append-only coupon model: a partner can have multiple codes per program
 * over time. Renaming becomes "add new + deactivate old"; the old code
 * keeps redeeming until the partner deactivates it, so links/posts they
 * already shared don't break.
 *
 * Schema changes:
 *   - Drop the unique on (tenantId, partnerId, programId) — multiple
 *     coupons per partner+program now allowed.
 *   - Add Coupon.deactivatedAt timestamp. NULL = active and redeemable;
 *     non-NULL = the partner / admin has retired it. The (tenantId, code)
 *     unique stays in place, so a deactivated code's string can't be
 *     re-used (avoids confusing customers who saved an old code).
 *
 * Auto-mint and the active-codes cap (5 per partner+program) check
 * `where deactivatedAt is null` — pre-existing rows have NULL by default,
 * so no behavior change for already-minted coupons.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Coupon', (t) => {
    t.timestamp('deactivatedAt', { useTz: true }).nullable();
    // The unique was named by Knex's default (table_col1_col2_col3_unique).
    // Drop it by column list so we don't have to know the generated name.
    t.dropUnique(['tenantId', 'partnerId', 'programId']);
  });
}

export async function down(knex: Knex): Promise<void> {
  // Re-adding the unique would fail if any partner now has multiple
  // coupons for a program — can't safely roll back once the new model is
  // in use. Drop the column; leave the unique off.
  await knex.schema.alterTable('Coupon', (t) => {
    t.dropColumn('deactivatedAt');
  });
}
