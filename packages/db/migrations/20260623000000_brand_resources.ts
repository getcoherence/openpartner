import type { Knex } from 'knex';

/**
 * Brand resources surface: brand color, program terms URL, and a per-tenant
 * BrandAsset library partners can pull from.
 *
 * Pattern mirrors Dub's per-program Resources page — logos, palette,
 * marketing copy snippets, documents. Brands previously had only
 * `Tenant.logoUrl` to express their brand; partners had nothing structured
 * to pull marketing assets from and had to email the brand. These columns
 * + the BrandAsset table close that gap.
 *
 *   Tenant.brandColor       Hex color (e.g. "#16a34a"). Optional. Surfaces
 *                           in the partner portal header + on the partner-
 *                           facing program detail card so partners can
 *                           match brand voice without asking.
 *
 *   Tenant.programTermsUrl  Link to a public terms document partners can
 *                           review. Surfaced in the partner portal footer
 *                           + on the program detail card. Null = no
 *                           dedicated terms page.
 *
 *   BrandAsset              Per-tenant downloadable library. Three kinds:
 *                             image    — uploaded image with public URL
 *                             document — uploaded file (PDF, etc.)
 *                             snippet  — short text body (copy lines,
 *                                        product descriptions, taglines)
 *                           url is non-null for image/document; body is
 *                           non-null for snippet. Constraint enforces the
 *                           xor so callers can rely on the shape.
 */

const ASSET_KINDS = ['image', 'document', 'snippet'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Tenant', (t) => {
    t.string('brandColor', 16).nullable();
    t.text('programTermsUrl').nullable();
  });
  // Hex format guard — 3- or 6-digit RGB with leading #. Loose on intent
  // (allows mixed case, alpha channels via 8-digit form) but rejects
  // freeform strings that would break CSS rendering.
  await knex.raw(
    `alter table "Tenant" add constraint "Tenant_brandColor_check" check ("brandColor" is null or "brandColor" ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$')`,
  );

  await knex.schema.createTable('BrandAsset', (t) => {
    t.string('id', 32).primary();
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('kind', 16).notNullable();
    t.string('label', 200).notNullable();
    t.text('description').nullable();
    t.text('url').nullable();
    t.text('body').nullable();
    t.integer('sortOrder').notNullable().defaultTo(0);
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId', 'sortOrder']);
  });
  const allowed = ASSET_KINDS.map((k) => `'${k}'`).join(', ');
  await knex.raw(
    `alter table "BrandAsset" add constraint "BrandAsset_kind_check" check ("kind" in (${allowed}))`,
  );
  // Exactly one of url / body must be set: image/document use url,
  // snippet uses body. Lets the API trust the shape without per-kind
  // null-checks scattered through call sites.
  await knex.raw(
    `alter table "BrandAsset" add constraint "BrandAsset_url_body_xor_check" check (
      (kind in ('image', 'document') and url is not null and body is null) or
      (kind = 'snippet' and body is not null and url is null)
    )`,
  );

  // RLS — same pattern as every other tenanted table on the openpartner_app role.
  await knex.raw(`alter table "BrandAsset" enable row level security`);
  await knex.raw(`alter table "BrandAsset" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "BrandAsset"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop policy if exists tenant_isolation on "BrandAsset"');
  await knex.raw('alter table "BrandAsset" disable row level security');
  await knex.schema.dropTableIfExists('BrandAsset');
  await knex.schema.alterTable('Tenant', (t) => {
    t.dropColumn('brandColor');
    t.dropColumn('programTermsUrl');
  });
}
