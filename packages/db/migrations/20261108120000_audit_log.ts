import type { Knex } from 'knex';

/**
 * AuditLog — what the brand's own admins and API keys did, one row per
 * action (apps/api/src/audit-log.ts, docs/audit-log.md). Written in the
 * request's own transaction just before it commits, so a change can't land
 * without its entry.
 *
 *   actorKind   'admin' (a signed-in admin), 'api_key' (an ApiKey row,
 *               scoped keys included) or 'operator_key' (the deployment's
 *               ADMIN_API_KEY).
 *   actorId     Admin.id or ApiKey.id; null for the operator key. No FK: the
 *               log outlives the admins and keys it names.
 *   actorLabel  the admin's email or the key's label when it happened.
 *   action      the route as registered ("PATCH /programs/:id"), or an event
 *               name for what isn't one request ("signin").
 *   targetId    the record acted on: the route's first parameter, or the id
 *               a create returned.
 *   params      the route parameters.
 *   fields      the names of the body's top-level fields, never their values.
 *   detail      what changed, from routes that say (before and after).
 *   status      the HTTP status sent.
 *   ip          the caller's address.
 *
 * Not exported (docs/data-portability.md): like PartnerSigninLinkLog it
 * records access to one deployment, its actorIds name Admin and ApiKey rows,
 * which never travel, and a restore that could write it could write history.
 *
 * RLS follows the canonical tenant_isolation pattern. The app role may only
 * read and append: no request can edit or delete an entry. The tenant purge
 * runs on the privileged pool.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('AuditLog', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('actorKind', 16).notNullable();
    t.string('actorId');
    t.text('actorLabel');
    t.string('action', 200).notNullable();
    t.string('targetId', 200);
    t.jsonb('params');
    t.jsonb('fields');
    t.jsonb('detail');
    t.smallint('status');
    t.string('ip', 64);
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId', 'createdAt', 'id']);
    t.index(['tenantId', 'targetId']);
    t.index(['tenantId', 'actorId']);
  });
  await knex.raw(`
    alter table "AuditLog"
      add constraint audit_log_actor_check
        check (
          ("actorKind" in ('admin', 'api_key') and "actorId" is not null)
          or ("actorKind" = 'operator_key' and "actorId" is null)
        )
  `);

  await knex.raw(`alter table "AuditLog" enable row level security`);
  await knex.raw(`alter table "AuditLog" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "AuditLog"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert on "AuditLog" to openpartner_app';
      end if;
    end
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'revoke all privileges on "AuditLog" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "AuditLog"`);
  await knex.schema.dropTableIfExists('AuditLog');
}
