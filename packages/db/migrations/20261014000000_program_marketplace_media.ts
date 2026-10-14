import type { Knex } from 'knex';

/**
 * Program marketplace media: a cover image and a video link.
 *
 *   marketplaceCoverUrl — public URL of a wide (≈3:1) banner the brand
 *                         uploaded via POST /uploads/program-cover. Shown
 *                         across the top of the marketplace card and the
 *                         program's detail page. Null = the card falls back
 *                         to a banner washed from the brand logo.
 *   marketplaceVideoUrl — canonical YouTube / Vimeo / Loom share URL (see
 *                         packages/db/src/program-video.ts). Embedded on the
 *                         detail page only.
 *
 * Both sync to the Network Offering (coverImageUrl / videoUrl) alongside
 * marketplaceDescription. Plain nullable columns, exported with the rest of
 * Program — nothing hosted-only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.text('marketplaceCoverUrl').nullable();
    t.text('marketplaceVideoUrl').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('Program', (t) => {
    t.dropColumn('marketplaceCoverUrl');
    t.dropColumn('marketplaceVideoUrl');
  });
}
