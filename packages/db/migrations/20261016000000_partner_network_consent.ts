import type { Knex } from 'knex';

/**
 * PartnerNetworkConsent — the partner's own opt-in to the OpenPartner
 * Network.
 *
 * Until now Network membership was a brand decision: with `autoEnroll` on,
 * every partner's name and email was pushed to the Network from
 * POST /partners, self-signup and the roster backfill, and the partner was
 * never asked. For a customer referral program that sends a brand's
 * customers' emails to a separate service. Partners now opt in themselves
 * (join-page checkbox, a one-time portal prompt, a portal setting), and
 * nothing is pushed for a partner without a `granted` row here.
 *
 * Sidecar to Partner (1:1, partnerId is both PK and FK), like
 * PartnerCommission: the Network is optional, so Partner stays clean.
 * Current state, not a history: the row records how and when consent was
 * given and when it was withdrawn or declined (see NetworkConsentStatus in
 * packages/db/src/types.ts). Exported in the portability bundle.
 *
 * Grandfathering: partners already on the Network are recorded as
 * consented, so nothing changes for them until they choose otherwise in
 * the portal setting.
 *   - Network-originated partners (Partner.metadata.source =
 *     'openpartner_network', set only by the Network's approve
 *     federation) joined by applying on the Network: source
 *     'network_offering', consentedAt = when the partner was provisioned.
 *   - Partners carrying the push stamp (metadata.network.creatorId) were
 *     pushed under auto-enroll: source 'grandfathered', consentedAt = now
 *     (when this assumption was recorded — no consent was asked before).
 * A push that only ever landed through the outbox retry left no stamp, so
 * those partners start undecided: no further pushes, and they get the
 * prompt.
 *
 * RLS + app-role grant follow the canonical tenant_isolation pattern
 * (20260807000000_partner_program_rls.ts).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PartnerNetworkConsent', (t) => {
    t.string('partnerId').primary().references('id').inTable('Partner').onDelete('CASCADE');
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('status', 16).notNullable(); // 'granted' | 'withdrawn' | 'declined'
    // How consent was given. Null only for a partner who declined the
    // prompt without ever consenting.
    t.string('source', 32);
    t.timestamp('consentedAt', { useTz: true });
    t.timestamp('withdrawnAt', { useTz: true });
    t.timestamp('declinedAt', { useTz: true });
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId', 'status']);
  });
  await knex.raw(`
    alter table "PartnerNetworkConsent"
      add constraint partner_network_consent_status_check
        check (status in ('granted', 'withdrawn', 'declined')),
      add constraint partner_network_consent_source_check
        check (source is null or source in ('join_page', 'portal_prompt', 'portal_setting', 'network_offering', 'grandfathered')),
      add constraint partner_network_consent_shape_check
        check (
          (status = 'granted' and source is not null and "consentedAt" is not null and "withdrawnAt" is null)
          or (status = 'withdrawn' and source is not null and "consentedAt" is not null and "withdrawnAt" is not null)
          or (status = 'declined' and "declinedAt" is not null)
        )
  `);

  await knex.raw(`alter table "PartnerNetworkConsent" enable row level security`);
  await knex.raw(`alter table "PartnerNetworkConsent" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "PartnerNetworkConsent"
      using (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
      with check (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "PartnerNetworkConsent" to openpartner_app';
      end if;
    end
    $$;
  `);

  // Grandfather partners already on the Network (see header). Cross-tenant
  // insert-select, same as the PartnerCampaign backfill — the migration
  // runner bypasses RLS.
  await knex.raw(`
    insert into "PartnerNetworkConsent" ("partnerId", "tenantId", status, source, "consentedAt", "updatedAt")
    select
      p.id,
      p."tenantId",
      'granted',
      case when p.metadata->>'source' = 'openpartner_network' then 'network_offering' else 'grandfathered' end,
      case when p.metadata->>'source' = 'openpartner_network' then p."createdAt" else now() end,
      now()
    from "Partner" p
    where p.metadata->>'source' = 'openpartner_network'
       or p.metadata->'network'->>'creatorId' is not null
    on conflict ("partnerId") do nothing
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'revoke all privileges on "PartnerNetworkConsent" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "PartnerNetworkConsent"`);
  await knex.schema.dropTableIfExists('PartnerNetworkConsent');
}
