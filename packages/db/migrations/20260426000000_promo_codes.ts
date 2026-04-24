import type { Knex } from 'knex';

/**
 * Creator-controlled share-link slugs.
 *
 * The share URL is `<NetworkVendor.routerUrl>/r/<PartnershipRequest.promoCode>`.
 *
 * - NetworkVendor.routerUrl: where the vendor runs apps/router. Vendors will
 *   typically host on a branded apex (getcoherence.io) or a subdomain
 *   (go.acme.com). Optional because the port-swap dev convention still works
 *   for localhost testing; prod vendors must set it.
 *
 * - NetworkCreator.defaultPromoCode: Grace sets "gracie" once, the Apply
 *   modal pre-fills it per application so she doesn't retype.
 *
 * - PartnershipRequest.promoCode: the actual code to use for this
 *   partnership's Link. Nullable → federation falls back to the creator's
 *   handle, which keeps existing requests working.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('NetworkVendor', (t) => {
    t.string('routerUrl');
  });
  await knex.schema.alterTable('NetworkCreator', (t) => {
    t.string('defaultPromoCode');
  });
  await knex.schema.alterTable('PartnershipRequest', (t) => {
    t.string('promoCode');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('PartnershipRequest', (t) => {
    t.dropColumn('promoCode');
  });
  await knex.schema.alterTable('NetworkCreator', (t) => {
    t.dropColumn('defaultPromoCode');
  });
  await knex.schema.alterTable('NetworkVendor', (t) => {
    t.dropColumn('routerUrl');
  });
}
