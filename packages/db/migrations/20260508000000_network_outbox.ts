import type { Knex } from 'knex';

/**
 * NetworkOutbox: durable retry queue for vendor → Network pushes.
 *
 * Vendor → Network calls (creator upsert on signup, revoke, backfill
 * batches) must never fail a vendor request when the Network is down.
 * On HTTP failure we enqueue a row here; the in-process scheduler
 * drains the queue with exponential backoff.
 *
 * Per-tenant: each outbox row carries the tenantId so a hosted
 * deployment with N tenants doesn't entangle their retries. Drained
 * by the scheduler iterating active tenants.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('NetworkOutbox', (t) => {
    t.string('id').primary(); // ULID
    t.string('tenantId').notNullable();
    t.foreign('tenantId').references('id').inTable('Tenant');
    // Operation kind: 'partner_upsert' | 'partner_revoke' | 'backfill_partner'
    // Backfill is a single partner row (we batch on send, not on enqueue,
    // so the outbox row size stays bounded).
    t.string('op').notNullable();
    // Full request payload; the drainer rebuilds the HTTP call from this
    // so we don't depend on the Partner row still existing at drain time
    // (it might have been hard-deleted by then).
    t.jsonb('payload').notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('nextAttemptAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('lastAttemptAt', { useTz: true });
    t.text('lastError');
    // 'pending' (next try due), 'dead' (gave up after max attempts)
    t.string('status').notNullable().defaultTo('pending');
    t.index(['tenantId', 'status', 'nextAttemptAt']);
  });

  // RLS: same per-tenant pattern as the rest of the data model.
  await knex.raw(`alter table "NetworkOutbox" enable row level security`);
  await knex.raw(`alter table "NetworkOutbox" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "NetworkOutbox"
      using (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
      with check (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
  `);

  // App-role grants. Idempotent — if openpartner_app doesn't exist
  // (unset password), this is a no-op via DO block.
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "NetworkOutbox" to openpartner_app';
      end if;
    end
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`drop policy if exists tenant_isolation on "NetworkOutbox"`);
  await knex.schema.dropTableIfExists('NetworkOutbox');
}
