import type { Knex } from 'knex';

/**
 * Per-tenant billing plan + 14-day trial bookkeeping.
 *
 * Pre-existing state: hosted deployments ran in ONE billing mode set by
 * the OPENPARTNER_MODE env (`flat` | `revshare` | `selfhost`); every
 * tenant on a deployment shared the same mode. With the marketing site
 * surfacing per-tier pricing (Flex / Revshare / Enterprise), each new
 * tenant needs to pick at signup.
 *
 *   billingPlan   the tenant's chosen tier. Null for tenants that
 *                 signed up before this column existed (treated as
 *                 "follow OPENPARTNER_MODE" by the resolver) and for
 *                 enterprise tenants who don't have a Stripe sub.
 *   trialEndsAt   when the 14-day free trial expires. Null for
 *                 tenants that never started a trial (legacy + enterprise)
 *                 or who already converted (reset to null on first paid
 *                 invoice).
 *
 * Also backfills Tenant.stripeCustomerId / stripeSubscriptionId from
 * the existing Config rows (stripe.merchant.customerId /
 * .subscriptionId). Pre-fix billing.ts wrote Stripe IDs to Config but
 * account-deletion.ts read them from Tenant — two stores of truth that
 * were silently divergent. After this migration, Tenant is the single
 * source; billing.ts gets updated in the same commit train.
 */

const BILLING_PLANS = ['flex', 'revshare', 'enterprise'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.string('billingPlan', 32).nullable();
    t.timestamp('trialEndsAt', { useTz: true }).nullable();
  });

  // Postgres CHECK so a future bug can't write an unknown plan value.
  // App-level Zod also enforces this, but a DB constraint is a final
  // line of defense if some path bypasses the validator.
  const allowed = BILLING_PLANS.map((p) => `'${p}'`).join(', ');
  await knex.raw(
    `alter table "Tenant" add constraint "Tenant_billingPlan_check" check ("billingPlan" is null or "billingPlan" in (${allowed}))`,
  );

  // Backfill stripeCustomerId from Config. Per-tenant; the Config rows
  // were written by billing.ts persistMerchantSubscription().
  await knex.raw(`
    update "Tenant" t
    set "stripeCustomerId" = c.value #>> '{}'
    from "Config" c
    where c."tenantId" = t.id
      and c.key = 'stripe.merchant.customerId'
      and t."stripeCustomerId" is null
  `);
  await knex.raw(`
    update "Tenant" t
    set "stripeSubscriptionId" = c.value #>> '{}'
    from "Config" c
    where c."tenantId" = t.id
      and c.key = 'stripe.merchant.subscriptionId'
      and t."stripeSubscriptionId" is null
  `);
  // Leave the Config rows in place; they're harmless and a fallback
  // read path during the rollout. A separate cleanup migration deletes
  // them once we've verified no code reads from Config any more.
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropColumn('billingPlan');
    t.dropColumn('trialEndsAt');
  });
  // We don't reverse the stripeCustomerId / stripeSubscriptionId
  // backfill — those columns existed before and the data is
  // legitimately on Tenant now. Re-applying down + up wouldn't lose
  // the values because they're already in Config too.
}
