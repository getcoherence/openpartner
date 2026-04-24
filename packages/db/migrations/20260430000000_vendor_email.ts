import type { Knex } from 'knex';

/**
 * NetworkVendor.email — the signup email we verified via magic-link.
 *
 * Previously we recovered this by walking MagicLinkToken history; that
 * returned the most recent vendor_signup for an email, which silently
 * routed a signin to the wrong vendor when an email had signed up for
 * more than one. Storing email on the vendor row makes the lookup
 * deterministic.
 *
 * Backfill: walk the most-recent consumed vendor_signup token per slug
 * and copy its email over. Rows with no matching token (never possible
 * for real signups, but defensive for hand-inserted test data) fall
 * back to a placeholder that the admin can correct.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('NetworkVendor', (t) => {
    t.string('email').nullable();
  });

  await knex.raw(`
    update "NetworkVendor" v
    set "email" = coalesce(
      (
        select lower(t."email")
        from "MagicLinkToken" t
        where t."purpose" = 'vendor_signup'
          and t."consumedAt" is not null
          and (t."claim"->>'slug') = v."slug"
        order by t."consumedAt" desc
        limit 1
      ),
      'unknown+' || v."id" || '@example.invalid'
    )
    where v."email" is null
  `);

  await knex.schema.alterTable('NetworkVendor', (t) => {
    t.string('email').notNullable().alter();
    t.index(['email']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('NetworkVendor', (t) => {
    t.dropIndex(['email']);
    t.dropColumn('email');
  });
}
