import type { Knex } from 'knex';

/**
 * Outbound webhooks.
 *
 * Two tables:
 *
 *   WebhookEndpoint  — a URL the operator wants us to POST events to.
 *                      Holds the signing secret in plaintext (same pattern
 *                      Stripe uses — we need it back at dispatch time
 *                      to HMAC each payload), the list of subscribed event types as
 *                      jsonb, and an active flag so endpoints can be
 *                      soft-disabled without losing their history.
 *
 *   WebhookDelivery  — one row per dispatch attempt per endpoint. Captures
 *                      the event envelope (so retries replay the exact
 *                      original payload), HTTP response status, error
 *                      message, attempt count, and timestamps. This is the
 *                      observability surface — admins read it back to
 *                      debug "why didn't Slack get my commission.paid
 *                      event."
 *
 * The signing secret is stored as plaintext on purpose — unlike an API
 * key, the server needs it back at dispatch time to HMAC-sign every
 * outgoing payload. This is the same compromise Stripe + every webhook
 * provider makes: a DB leak exposes secrets, but HMAC is meaningless if
 * we only keep a hash. We do show `secretPrefix` in the UI so operators
 * can identify which secret belongs to which endpoint without reading
 * it back.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('WebhookEndpoint', (t) => {
    t.string('id').primary();
    t.string('url').notNullable();
    t.string('secretPrefix').notNullable();
    t.string('secret').notNullable();
    t.jsonb('events').notNullable(); // ['commission.paid', ...]
    t.boolean('active').notNullable().defaultTo(true);
    t.string('label');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('lastUsedAt', { useTz: true });
    t.index(['active']);
  });

  await knex.schema.createTable('WebhookDelivery', (t) => {
    t.string('id').primary();
    t.string('endpointId').notNullable().references('id').inTable('WebhookEndpoint');
    t.string('eventId').notNullable(); // the stable event id (evt_...)
    t.string('eventType').notNullable();
    t.jsonb('payload').notNullable();
    t.string('status').notNullable(); // 'pending' | 'delivered' | 'failed'
    t.integer('httpStatus');
    t.text('error');
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('deliveredAt', { useTz: true });
    t.timestamp('lastAttemptAt', { useTz: true });
    t.index(['endpointId', 'createdAt']);
    t.index(['status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('WebhookDelivery');
  await knex.schema.dropTableIfExists('WebhookEndpoint');
}
