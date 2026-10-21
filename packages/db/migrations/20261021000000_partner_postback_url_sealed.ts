import type { Knex } from 'knex';

/**
 * PartnerPostback.url sealed at rest (apps/api/src/postback-url.ts).
 *
 * Partners put their tracker's shared secret in the URL (`?secret=…`), so
 * the API now stores it sealed with AES-256-GCM under
 * SECRETS_ENCRYPTION_KEY and opens it only to fire the postback.
 *
 *   - `url` becomes text: the envelope is base64 of IV + tag + URL, so a
 *     2048-character URL seals to about 2,770 characters. varchar → text
 *     is binary-coercible, so this rewrites nothing; it only needs the
 *     table lock for a moment.
 *   - `urlPreview` is the URL with its path and query values masked
 *     (maskPostbackUrl), kept in the clear so lists show which tracker a
 *     postback goes to without opening it, as WebhookEndpoint.secretPrefix
 *     does for a signing secret. Null on existing rows: they are still
 *     plaintext, and the API masks those as it reads them until the sweep
 *     seals them and writes the preview.
 *
 * Nothing is sealed here. The API's sweep does that, ten minutes after it
 * starts, once a rolling deploy's previous build (which fires whatever
 * `url` holds) has stopped.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`set local lock_timeout = '5s'`);
  await knex.raw(`alter table "PartnerPostback" alter column "url" type text`);
  await knex.schema.alterTable('PartnerPostback', (t) => {
    t.text('urlPreview');
  });
}

/**
 * Leaves `url` as text: a sealed URL doesn't fit varchar(2048), and a
 * build from before sealing can't fire one anyway. Rolling the code back
 * past this needs the URLs opened first (see the PR that added it).
 */
export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('PartnerPostback', (t) => {
    t.dropColumn('urlPreview');
  });
}
