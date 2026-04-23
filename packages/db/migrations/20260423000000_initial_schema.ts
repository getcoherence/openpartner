import type { Knex } from 'knex';

/**
 * Initial schema — the core event-sourced attribution tables.
 *
 * Design principle: raw data is immutable (Click, Event), derived state is a
 * view over raw (Identity, Attribution, Commission). This is what enables
 * re-running attribution models without re-collecting data, and what makes
 * one-click export → round-trip import into self-hosted possible.
 */
export async function up(knex: Knex): Promise<void> {
  // Partners = the people/orgs who drive traffic to the merchant.
  await knex.schema.createTable('Partner', (t) => {
    t.string('id').primary(); // ULID
    t.string('email').notNullable().unique();
    t.string('name').notNullable();
    t.string('stripeConnectAccountId'); // set when partner connects Stripe for payouts
    t.jsonb('metadata').notNullable().defaultTo('{}');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Campaigns = logical grouping of links with shared commission rules.
  await knex.schema.createTable('Campaign', (t) => {
    t.string('id').primary();
    t.string('name').notNullable();
    t.jsonb('commissionRule').notNullable(); // { type: 'percent'|'fixed', value, recurring }
    t.integer('attributionWindowDays').notNullable().defaultTo(60);
    t.string('attributionModel').notNullable().defaultTo('last_click');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Links = the individual short links partners share.
  await knex.schema.createTable('Link', (t) => {
    t.string('id').primary();
    t.string('linkKey').notNullable().unique(); // the short code in /r/:linkKey
    t.string('partnerId').notNullable().references('id').inTable('Partner');
    t.string('campaignId').notNullable().references('id').inTable('Campaign');
    t.string('destinationUrl').notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['partnerId']);
    t.index(['campaignId']);
  });

  // Click = raw, immutable. Every click through the router.
  await knex.schema.createTable('Click', (t) => {
    t.string('id').primary(); // clickId, also written to the _cref cookie
    t.string('linkId').notNullable().references('id').inTable('Link');
    t.string('partnerId').notNullable(); // denormalized for fast reads, FK not required
    t.string('campaignId').notNullable();
    t.string('landingUrl').notNullable();
    t.string('ipHash'); // hashed for privacy, not raw IP
    t.string('userAgent');
    t.string('referer');
    t.timestamp('ts', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['partnerId', 'ts']);
    t.index(['campaignId', 'ts']);
  });

  // Identity = stitch. Written when a user authenticates with an active cref.
  // Chain: Click.id → Identity.clickId, Identity.userId → customer's user.
  await knex.schema.createTable('Identity', (t) => {
    t.string('id').primary();
    t.string('clickId').notNullable().references('id').inTable('Click');
    t.string('userId').notNullable(); // opaque — customer's user identifier
    t.timestamp('stitchedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['userId']); // one stitched click per user — first stitch wins (configurable later)
    t.index(['clickId']);
  });

  // Event = raw, immutable conversion events. Received via API or Stripe webhook.
  await knex.schema.createTable('Event', (t) => {
    t.string('id').primary();
    t.string('userId').notNullable();
    t.string('type').notNullable(); // signup | trial_started | subscription_created | invoice_paid | custom
    t.decimal('value', 14, 2); // revenue in minor units' parent currency
    t.string('currency').defaultTo('USD');
    t.jsonb('metadata').notNullable().defaultTo('{}');
    t.timestamp('ts', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['userId', 'ts']);
    t.index(['type', 'ts']);
  });

  // Attribution = derived view. Written by the attribution job for each Event
  // that can be attributed. Re-derivable from raw (Click, Identity, Event).
  await knex.schema.createTable('Attribution', (t) => {
    t.string('id').primary();
    t.string('eventId').notNullable().references('id').inTable('Event');
    t.string('partnerId').notNullable();
    t.string('campaignId').notNullable();
    t.string('clickId').notNullable();
    t.string('model').notNullable(); // last_click | first_click | linear | position
    t.decimal('weight', 6, 4).notNullable().defaultTo(1.0); // 1.0 for single-touch, fractional for multi
    t.timestamp('computedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['eventId', 'model']); // one attribution per event per model
    t.index(['partnerId', 'computedAt']);
  });

  // Commission = derived + immutable ledger. Computed from Attribution + Campaign.commissionRule.
  await knex.schema.createTable('Commission', (t) => {
    t.string('id').primary();
    t.string('attributionId').notNullable().references('id').inTable('Attribution');
    t.string('partnerId').notNullable();
    t.decimal('amount', 14, 2).notNullable();
    t.string('currency').notNullable().defaultTo('USD');
    t.string('status').notNullable().defaultTo('accrued'); // accrued | approved | paid | reversed
    t.timestamp('accruedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('paidAt', { useTz: true });
    t.string('payoutId');
    t.index(['partnerId', 'status']);
  });

  // Payout = Stripe Connect transfer record (revenue-share tier) or manual-payout ledger entry.
  await knex.schema.createTable('Payout', (t) => {
    t.string('id').primary();
    t.string('partnerId').notNullable();
    t.decimal('amount', 14, 2).notNullable();
    t.string('currency').notNullable().defaultTo('USD');
    t.string('method').notNullable(); // stripe_connect | manual | external
    t.string('stripeTransferId');
    t.string('status').notNullable().defaultTo('pending'); // pending | paid | failed
    t.jsonb('metadata').notNullable().defaultTo('{}');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('completedAt', { useTz: true });
    t.index(['partnerId', 'status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('Payout');
  await knex.schema.dropTableIfExists('Commission');
  await knex.schema.dropTableIfExists('Attribution');
  await knex.schema.dropTableIfExists('Event');
  await knex.schema.dropTableIfExists('Identity');
  await knex.schema.dropTableIfExists('Click');
  await knex.schema.dropTableIfExists('Link');
  await knex.schema.dropTableIfExists('Campaign');
  await knex.schema.dropTableIfExists('Partner');
}
