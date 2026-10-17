import type { Knex } from 'knex';

/**
 * Track first trial activation so a tenant can't trial-loop.
 *
 * Stripe's trial mechanism doesn't enforce one-trial-per-customer; if
 * we let a tenant cancel their trial sub and re-Checkout, our previous
 * code would happily start another 14-day trial. firstTrialActivatedAt
 * is stamped by the checkout.session.completed webhook the FIRST time
 * a subscription with a trial completes. On subsequent Checkout
 * sessions, billing.ts omits trial_period_days so the user must add
 * a card up front.
 *
 * Null = never trialed. Non-null = trial used; subsequent subs are
 * card-required.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.timestamp('firstTrialActivatedAt', { useTz: true }).nullable();
  });

  // Backfill: any tenant with a current trialEndsAt has used their
  // trial. Set firstTrialActivatedAt to (trialEndsAt - 14 days) so the
  // value reflects when the trial began.
  await knex.raw(`
    update "Tenant"
    set "firstTrialActivatedAt" = "trialEndsAt" - interval '14 days'
    where "trialEndsAt" is not null
      and "firstTrialActivatedAt" is null
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropColumn('firstTrialActivatedAt');
  });
}
