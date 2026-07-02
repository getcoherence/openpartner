import type { Knex } from 'knex';

/**
 * White-label entitlement flag.
 *
 * When true — AND the tenant is on an entitling billing state (see
 * apps/api/src/white-label.ts `isWhiteLabelEntitled`) — the partner-facing
 * portal drops all OpenPartner platform branding: the "Powered by" footer,
 * the OpenPartner Network / Discover surfaces, and the "via OpenPartner"
 * email From suffix. The portal then renders purely as the tenant's own
 * brand (programName + logoUrl + brandColor).
 *
 * `whiteLabel` is the *provisioned* flag (set by the hosted billing add-on).
 * The *effective* entitlement additionally requires an active subscription,
 * an in-flight trial, or an enterprise plan — so a lapsed unpaid trial can't
 * keep white-label (and a live custom-domain cert) for free.
 *
 * Portability (CLAUDE.md §2/§5): a hosted-only concept, but stored as a
 * plain boolean so it exports losslessly to CSV/JSON/SQL and is an inert
 * no-op on self-hosted import — a self-hosted single-tenant install is
 * already its own brand.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.boolean('whiteLabel').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropColumn('whiteLabel');
  });
}
