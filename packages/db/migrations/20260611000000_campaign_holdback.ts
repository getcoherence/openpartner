import type { Knex } from 'knex';

/**
 * Per-campaign payout holdback in days.
 *
 * Brands with a refund window or trial period (e.g. SaaS with a 30-day
 * money-back guarantee) shouldn't pay partners out before the conversion
 * is settled. Without this column, the only mechanism was the manual
 * approval gate — brand admin had to remember to wait. holdbackDays
 * makes the policy explicit, enforced by the approval endpoint, and
 * surfaceable to partners on the offering listing so they see the terms
 * before applying.
 *
 * Semantics:
 *   null / 0  no holdback (current behavior — accrued can be approved
 *             immediately)
 *   N > 0     commission can't transition to 'approved' until
 *             accruedAt + N days has elapsed. A daily auto-approve
 *             scheduler sweeps elapsed accruals.
 *
 * Range cap (365) matches attributionWindowDays for symmetry — both
 * are durations measured from a click/conversion event.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.integer('holdbackDays').nullable();
  });
  await knex.raw(
    `alter table "Campaign" add constraint "Campaign_holdbackDays_check" check ("holdbackDays" is null or ("holdbackDays" >= 0 and "holdbackDays" <= 365))`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Campaign', (t) => {
    t.dropColumn('holdbackDays');
  });
}
