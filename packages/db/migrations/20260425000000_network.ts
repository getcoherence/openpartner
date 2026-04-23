import type { Knex } from 'knex';

/**
 * OpenPartner Network — directory + handshake layer that sits above
 * individual OpenPartner deployments.
 *
 * Key architectural principle: the Network is a directory and matchmaking
 * service. It never owns attribution data. When a Partnership is approved,
 * the Network federates out to the vendor's OpenPartner instance via its
 * admin API to provision a Partner + Link. Attribution, clicks, events,
 * commissions — all of that continues to live on the vendor's instance,
 * exportable and portable.
 *
 * Table-by-table rationale:
 *
 *   NetworkVendor    — a merchant that joined the Network. Stores the URL
 *                      of their OpenPartner instance and the admin API key
 *                      (hashed at rest, used for federation calls) so we
 *                      can provision partners remotely on approval.
 *   NetworkCreator   — a promoter/influencer profile. Public-ish — their
 *                      handle, bio, and platform links are what vendors
 *                      browse.
 *   Offering         — a public listing of a vendor's referral program.
 *                      References a `vendorCampaignId` on the vendor's own
 *                      instance (Campaigns remain authoritative there).
 *                      `terms` is richer than commissionRule: marketing
 *                      copy for display (percent + duration + bonuses).
 *   PartnershipRequest — directional handshake. Either creator asks to
 *                      promote an offering, or a vendor invites a creator
 *                      to one. Stores a message and status.
 *   Partnership      — the approved, active relationship. Holds the
 *                      federation output: the partnerId + linkKey on the
 *                      vendor's instance, plus the public share URL the
 *                      creator can paste on socials.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('NetworkVendor', (t) => {
    t.string('id').primary();
    t.string('name').notNullable();
    t.string('slug').notNullable().unique();
    t.string('websiteUrl');
    t.string('logoUrl');
    t.text('description');

    // Federation: where the vendor's OpenPartner instance lives + admin key.
    // Key is stored ENCRYPTED (AES-256-GCM) because we need plaintext at
    // federation time to call the vendor's admin API. Hash would be useless
    // here — one-way. The prefix is for display in the vendor's settings UI
    // (e.g. "op_a1b2…") without leaking the whole key.
    t.string('instanceUrl').notNullable();
    t.text('instanceKeyCiphertext').notNullable(); // base64(iv | tag | ciphertext)
    t.string('instanceKeyPrefix').notNullable();

    t.string('status').notNullable().defaultTo('pending'); // pending | active | suspended
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('activatedAt', { useTz: true });
    t.index(['status']);
  });

  await knex.schema.createTable('NetworkCreator', (t) => {
    t.string('id').primary();
    t.string('name').notNullable();
    t.string('handle').notNullable().unique();
    t.string('email').notNullable().unique();
    t.text('bio');
    t.string('avatarUrl');
    // Platforms: [{ platform: 'youtube'|'twitter'|'instagram'|'blog', url, followers? }]
    t.jsonb('platforms').notNullable().defaultTo('[]');
    t.string('status').notNullable().defaultTo('pending'); // pending | active | suspended
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('activatedAt', { useTz: true });
    t.index(['status']);
  });

  await knex.schema.createTable('Offering', (t) => {
    t.string('id').primary();
    t.string('vendorId').notNullable().references('id').inTable('NetworkVendor');
    t.string('title').notNullable();
    t.string('productUrl').notNullable();
    t.text('description');
    t.string('heroImageUrl');

    // The campaign on the vendor's OpenPartner instance that federated
    // partnerships will create Links under. Not a FK — lives on a different
    // DB in production.
    t.string('vendorCampaignId').notNullable();

    // Marketing-flavored terms. The authoritative commission rule lives on
    // the vendor's Campaign; these are for display in the directory.
    t.jsonb('terms').notNullable();

    t.boolean('published').notNullable().defaultTo(false);
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['vendorId']);
    t.index(['published']);
  });

  await knex.schema.createTable('PartnershipRequest', (t) => {
    t.string('id').primary();
    t.string('offeringId').notNullable().references('id').inTable('Offering');
    t.string('vendorId').notNullable();   // denormalized for fast filtering
    t.string('creatorId').notNullable().references('id').inTable('NetworkCreator');
    t.string('direction').notNullable(); // 'creator_to_vendor' | 'vendor_to_creator'
    t.text('message');
    t.string('status').notNullable().defaultTo('pending'); // pending | approved | rejected | cancelled
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('decidedAt', { useTz: true });
    t.text('decisionNote');
    t.unique(['offeringId', 'creatorId']); // one request per (offering, creator)
    t.index(['vendorId', 'status']);
    t.index(['creatorId', 'status']);
  });

  await knex.schema.createTable('Partnership', (t) => {
    t.string('id').primary();
    t.string('requestId').notNullable().references('id').inTable('PartnershipRequest').unique();
    t.string('offeringId').notNullable().references('id').inTable('Offering');
    t.string('vendorId').notNullable();
    t.string('creatorId').notNullable().references('id').inTable('NetworkCreator');

    // Federation result: what exists on the vendor's OpenPartner instance.
    t.string('vendorPartnerId').notNullable();
    t.string('vendorLinkKey').notNullable();
    t.string('publicShareUrl').notNullable();

    t.string('status').notNullable().defaultTo('active'); // active | ended
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('endedAt', { useTz: true });
    t.index(['vendorId', 'status']);
    t.index(['creatorId', 'status']);
  });

  // Extend ApiKey with the new roles. A single row is now one of:
  //   - partnerId set                -> vendor-partner key (existing)
  //   - networkVendorId set          -> vendor manages Network presence
  //   - networkCreatorId set         -> creator browses + applies
  //   - everything null              -> admin key (network_admin or core admin)
  await knex.schema.alterTable('ApiKey', (t) => {
    t.string('networkVendorId').references('id').inTable('NetworkVendor');
    t.string('networkCreatorId').references('id').inTable('NetworkCreator');
    t.index(['networkVendorId']);
    t.index(['networkCreatorId']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ApiKey', (t) => {
    t.dropIndex(['networkVendorId']);
    t.dropIndex(['networkCreatorId']);
    t.dropColumn('networkVendorId');
    t.dropColumn('networkCreatorId');
  });
  await knex.schema.dropTableIfExists('Partnership');
  await knex.schema.dropTableIfExists('PartnershipRequest');
  await knex.schema.dropTableIfExists('Offering');
  await knex.schema.dropTableIfExists('NetworkCreator');
  await knex.schema.dropTableIfExists('NetworkVendor');
}
