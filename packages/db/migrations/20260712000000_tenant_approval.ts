import type { Knex } from 'knex';

/**
 * Brand approval gate (anti-spam).
 *
 * A "Brand" is a Tenant. Until now every signup landed as
 * status='active' and was immediately live — which let spam/phishing
 * brands (e.g. MLM link-cloakers) self-serve onto the platform. This adds
 * a review dimension ORTHOGONAL to the billing `status` column:
 *
 *   approvalStatus  pending | approved | rejected   (review decision)
 *   status          active  | suspended | cancelled (billing lifecycle)
 *
 * A pending brand keeps status='active' so it can sign in and configure,
 * but the router serves no clicks for it and it can't invite partners /
 * go live until a platform operator approves it (see approval-gate.ts and
 * apps/router). Retroactive removal of an already-approved brand is a
 * rejection that ALSO suspends the tenant (status='suspended'), which the
 * existing status='active' filters everywhere take dark automatically.
 *
 * Backfill: every existing tenant → 'approved'. The column default stays
 * 'approved' so non-signup creation paths (the seeded single-host 'default'
 * tenant, imports) don't get trapped behind review; public signup + the
 * authenticated add-brand flow set 'pending' explicitly.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.string('approvalStatus').notNullable().defaultTo('approved'); // pending | approved | rejected
    t.text('approvalReason'); // rejection reason / review note
    t.timestamp('reviewedAt', { useTz: true });
    t.string('reviewedByEmail'); // platform operator who made the last decision
    t.index(['approvalStatus']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropIndex(['approvalStatus']);
    t.dropColumn('approvalStatus');
    t.dropColumn('approvalReason');
    t.dropColumn('reviewedAt');
    t.dropColumn('reviewedByEmail');
  });
}
