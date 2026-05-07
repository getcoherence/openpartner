import type { Knex } from 'knex';

/**
 * Partner-scoped postback URLs.
 *
 * Distinct from the tenant-scoped WebhookEndpoint table: those are the
 * brand's integrations (Zapier, CRM, internal infra). PartnerPostback
 * is the *partner's* own tracker callback — Voluum / Bemob / RedTrack /
 * etc. — that they configure on their dashboard so their attribution
 * platform records the conversion at the same time OpenPartner does.
 *
 * Subscription is restricted to commission.* events at the route layer:
 * partners care about the conversion ledger, not partner-state events.
 *
 * URL contains macro placeholders ({click_id}, {commission_amount},
 * etc.) that the dispatcher substitutes at fire time. URL-encoded
 * values; unknown macros stay literal so the partner notices and fixes
 * the template.
 *
 * Per-delivery rows would be expensive at high partner volume, so
 * audit lives in rolling counters (lastFiredAt / lastStatus /
 * successCount / failureCount) on the row itself. That's enough to
 * answer "is my postback firing?" without a delivery log.
 *
 * RLS: tenant-scoped. The app role gets full DML; cross-tenant access
 * is blocked via RLS on PartnerPostback + the partnerId FK to Partner.
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('PartnerPostback', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('partnerId').notNullable().references('id').inTable('Partner').onDelete('CASCADE');
    t.string('url', 2048).notNullable();
    t.jsonb('events').notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // Rolling delivery audit. successCount / failureCount are bumped
    // by the dispatcher; lastStatus is the most recent HTTP status.
    t.timestamp('lastFiredAt', { useTz: true });
    t.integer('lastStatus');
    t.string('lastError', 500);
    t.integer('successCount').notNullable().defaultTo(0);
    t.integer('failureCount').notNullable().defaultTo(0);
    t.index(['tenantId', 'partnerId']);
  });

  await knex.raw(`alter table "PartnerPostback" enable row level security`);
  await knex.raw(`alter table "PartnerPostback" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "PartnerPostback"
      using (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
      with check (
        "tenantId" = current_setting('app.tenant_id', true)
        or current_setting('app.platform_admin', true) = 'on'
      )
  `);
  await knex.raw(`grant select, insert, update, delete on "PartnerPostback" to openpartner_app`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('PartnerPostback');
}
