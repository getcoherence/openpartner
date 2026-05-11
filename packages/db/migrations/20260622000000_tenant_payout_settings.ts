import type { Knex } from 'knex';

/**
 * Per-tenant payout configuration: rail preference, minimum threshold, cadence.
 *
 * Pre-existing behavior was a single hardcoded path for every tenant: the
 * payouts cron ran every Monday 09:00 UTC, the rail was picked per-partner at
 * payout time (stripe_connect if a Connect account was linked + onboarded,
 * else manual), and approved commissions of any amount went out on every run.
 *
 * Three columns expose those choices as brand settings:
 *
 *   payoutRailPreference  'auto'           current behavior (per-partner pick)
 *                         'stripe_connect' force stripe_connect — partners
 *                                          without a connected account see
 *                                          their payout in 'failed' status
 *                                          with a clear "complete onboarding"
 *                                          message instead of silently
 *                                          falling through to manual
 *                         'manual'         force manual — operator handles
 *                                          all transfers off-platform
 *                         null             treated as 'auto' (legacy)
 *
 *   payoutThresholdCents  Minimum balance (per partner, per currency) before a
 *                         payout is issued. Approved commissions below the
 *                         threshold stay 'approved' and accumulate to the next
 *                         run. Null / 0 = no threshold (legacy behavior).
 *                         Cap at 100_000 cents ($1,000) — anything above that
 *                         is a misconfiguration, not a knob.
 *
 *   payoutCadence         'weekly'    every Monday (legacy)
 *                         'biweekly'  every other Monday (even ISO weeks)
 *                         'monthly'   first Monday of each month
 *                         'manual'    never run automatically; brand triggers
 *                                     payouts from the admin UI
 *                         null        treated as 'weekly' (legacy)
 *
 * All three are nullable with null == legacy behavior, so existing tenants
 * keep their current payout shape until an admin sets them.
 */

const RAIL_VALUES = ['auto', 'stripe_connect', 'manual'] as const;
const CADENCE_VALUES = ['weekly', 'biweekly', 'monthly', 'manual'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.string('payoutRailPreference', 32).nullable();
    t.integer('payoutThresholdCents').nullable();
    t.string('payoutCadence', 32).nullable();
  });

  const railAllowed = RAIL_VALUES.map((v) => `'${v}'`).join(', ');
  const cadenceAllowed = CADENCE_VALUES.map((v) => `'${v}'`).join(', ');
  await knex.raw(
    `alter table "Tenant" add constraint "Tenant_payoutRailPreference_check" check ("payoutRailPreference" is null or "payoutRailPreference" in (${railAllowed}))`,
  );
  await knex.raw(
    `alter table "Tenant" add constraint "Tenant_payoutThresholdCents_check" check ("payoutThresholdCents" is null or ("payoutThresholdCents" >= 0 and "payoutThresholdCents" <= 100000))`,
  );
  await knex.raw(
    `alter table "Tenant" add constraint "Tenant_payoutCadence_check" check ("payoutCadence" is null or "payoutCadence" in (${cadenceAllowed}))`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropColumn('payoutRailPreference');
    t.dropColumn('payoutThresholdCents');
    t.dropColumn('payoutCadence');
  });
}
