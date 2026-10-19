import type { Knex } from 'knex';

/**
 * Where a brand or a partner says it is based (docs/country-access.md).
 *
 * The hosted platform refuses brands and partners located in countries it
 * does not serve: US-sanctioned jurisdictions plus any the operator adds
 * (PlatformSetting key 'countryAccess'). Each declaration is kept as a
 * compliance record — OFAC expects screening records for 10 years
 * (31 CFR 501.601) — so rows are append-only and deliberately carry NO
 * foreign key: a tenant hard delete or a partner erasure must not take the
 * record with it, and must not fail on it either.
 *
 * PLATFORM-scoped hosted-only sidecar, same pattern as
 * 20261012000000_platform_notifications.ts: only the privileged `db` pool
 * touches it, it is NOT granted to the openpartner_app role, carries no RLS
 * policy, and is not in the export allowlist.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('LocationDeclaration', (t) => {
    t.string('id').primary();
    t.string('subjectKind').notNullable(); // 'tenant' | 'partner'
    t.string('subjectId').notNullable();
    // The brand the subject belongs to. Equals subjectId for a tenant.
    t.string('tenantId').notNullable();
    t.string('country', 2).notNullable(); // ISO 3166-1 alpha-2, as declared
    // Ukraine only: the declarant confirmed it is outside Crimea, Sevastopol
    // and the Russian-occupied areas of Donetsk, Luhansk, Kherson and
    // Zaporizhzhia. Null for every other country.
    t.boolean('outsideOccupiedRegions');
    // What IP geolocation said at the time. Null when the lookup had no
    // answer (no database loaded, private address).
    t.string('ipCountry', 2);
    t.string('source').notNullable(); // 'signup' | 'add_brand' | 'prompt' | 'join'
    t.string('declaredByEmail');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['subjectKind', 'subjectId', 'createdAt']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('LocationDeclaration');
}
