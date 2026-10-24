import type { Knex } from 'knex';

/**
 * PartnerSigninLinkLog — one row per sign-in link a brand's backend minted
 * for a partner (POST /partners/{id}/signin-link, apps/api/src/routes/
 * partner-signin-link.ts). The link signs whoever opens it in as that
 * partner, so who asked for each one, for whom and when is kept here.
 *
 *   partnerId         the partner the link signs in. No FK: the log is the
 *                     accountability record and must outlive anything.
 *   magicLinkTokenId  the MagicLinkToken the link carries (purpose
 *                     'partner_signin_link'). No FK, for the same reason.
 *   actorKind         'api_key' (an ApiKey row: an admin key, or a scoped
 *                     key holding partners:signin) or 'operator_key' (the
 *                     deployment's ADMIN_API_KEY).
 *   actorId           ApiKey.id; null for the operator key.
 *   returnTo          the portal path the link lands on, if one was asked for.
 *   ip                the caller's address (the brand's server, not the
 *                     partner's browser).
 *   expiresAt         when the link stops working.
 *
 * Not exported (docs/data-portability.md): like Session and
 * MagicLinkToken it records access to one deployment, and its actorIds
 * name ApiKey rows, which never travel either.
 *
 * RLS follows the canonical tenant_isolation pattern, with the plain
 * predicate 20261017100000_rls_plain_tenant_policies settled on. The app
 * role may only read and append: no request can edit or delete the record
 * of a sign-in. The tenant purge runs on the privileged pool.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PartnerSigninLinkLog', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('partnerId').notNullable();
    t.string('magicLinkTokenId').notNullable();
    t.string('actorKind', 16).notNullable();
    t.string('actorId');
    t.text('returnTo');
    t.string('ip', 64);
    t.timestamp('expiresAt', { useTz: true }).notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId', 'createdAt']);
    t.index(['tenantId', 'partnerId']);
  });
  await knex.raw(`
    alter table "PartnerSigninLinkLog"
      add constraint partner_signin_link_log_actor_check
        check (
          ("actorKind" = 'api_key' and "actorId" is not null)
          or ("actorKind" = 'operator_key' and "actorId" is null)
        )
  `);

  await knex.raw(`alter table "PartnerSigninLinkLog" enable row level security`);
  await knex.raw(`alter table "PartnerSigninLinkLog" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "PartnerSigninLinkLog"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert on "PartnerSigninLinkLog" to openpartner_app';
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
        execute 'revoke all privileges on "PartnerSigninLinkLog" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "PartnerSigninLinkLog"`);
  await knex.schema.dropTableIfExists('PartnerSigninLinkLog');
}
