import type { Knex } from 'knex';

/**
 * Bounty — a goal on a program that pays a bonus once a partner reaches it
 * (docs/bounties.md §7): "10 sales between Nov 1 and Dec 31 earns $500".
 *
 * The hourly sweep (apps/api/src/performance-bounties.ts) measures each
 * eligible partner against the goal and pays the reward through the bonus
 * path (bonuses.ts) with source 'performance_bounty', bountyId and
 * externalRef `bounty:<bountyId>:<partnerId>`. A partner earns a bounty
 * once: the externalRef unique and the (bountyId, partnerId) unique below
 * both say so.
 *
 *   metric       conversions | revenue | leads | commissions
 *   eventType    conversions / revenue only: one event type
 *   threshold    > 0; a currency amount for revenue and commissions
 *   scope        new (activity in [startsAt, endsAt)) | lifetime (all
 *                history before endsAt)
 *   partnerIds   null = every partner in the program; else an allowlist
 *   status       draft | active | ended | archived
 *
 * Plain strings with CHECKs, like PartnerNetworkConsent. Once a bounty has
 * awarded anything its goal is locked (routes/bounties.ts).
 * startNotifiedAt / endingSoonNotifiedAt stamp the partner emails so a
 * re-run never sends one twice.
 *
 * Core table, exported (export schemaVersion 7), ahead of Bonus, which now
 * references it.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`set local lock_timeout = '5s'`);

  await knex.schema.createTable('Bounty', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    // No cascade: a bounty that paid anyone is reward history. Programs are
    // archived, never deleted, by the app.
    t.string('programId').notNullable().references('id').inTable('Program');
    t.string('name', 200).notNullable();
    t.text('description');
    t.string('metric', 32).notNullable();
    t.string('eventType', 255);
    t.decimal('threshold', 18, 4).notNullable();
    t.string('scope', 16).notNullable().defaultTo('new');
    t.timestamp('startsAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('endsAt', { useTz: true });
    t.decimal('rewardAmount', 14, 2).notNullable();
    t.string('currency', 3).notNullable();
    t.jsonb('partnerIds');
    t.string('status', 16).notNullable().defaultTo('draft');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('endedAt', { useTz: true });
    t.timestamp('startNotifiedAt', { useTz: true });
    t.timestamp('endingSoonNotifiedAt', { useTz: true });
    t.index(['tenantId', 'status']);
    t.index(['tenantId', 'programId']);
  });
  await knex.raw(`
    alter table "Bounty"
      add constraint bounty_metric_check check (metric in ('conversions', 'revenue', 'leads', 'commissions')),
      add constraint bounty_event_type_check check ("eventType" is null or metric in ('conversions', 'revenue')),
      add constraint bounty_scope_check check (scope in ('new', 'lifetime')),
      add constraint bounty_status_check check (status in ('draft', 'active', 'ended', 'archived')),
      add constraint bounty_threshold_positive check (threshold > 0),
      add constraint bounty_reward_positive check ("rewardAmount" > 0),
      add constraint bounty_currency_upper check (currency = upper(currency) and length(currency) = 3),
      add constraint bounty_description_length check (description is null or length(description) <= 5000),
      add constraint bounty_window_check check ("endsAt" is null or "endsAt" > "startsAt"),
      add constraint bounty_partner_ids_array check ("partnerIds" is null or jsonb_typeof("partnerIds") = 'array')
  `);

  await knex.raw(`alter table "Bounty" enable row level security`);
  await knex.raw(`alter table "Bounty" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "Bounty"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "Bounty" to openpartner_app';
      end if;
    end
    $$;
  `);

  // Bonus.bountyId has been a plain column since the bonuses migration; no
  // bounty existed, so every row is null and the FK validates at once.
  await knex.raw(`
    alter table "Bonus"
      add constraint bonus_bountyid_foreign foreign key ("bountyId") references "Bounty"(id),
      add constraint bonus_bounty_source_check check (("bountyId" is not null) = (source = 'performance_bounty'))
  `);
  // A partner earns a bounty once.
  await knex.raw(`
    create unique index "Bonus_bountyId_partnerId_unique" on "Bonus" ("bountyId", "partnerId") where "bountyId" is not null
  `);
}

export async function down(knex: Knex): Promise<void> {
  const [row] = (await knex('Bounty').count({ n: '*' })) as Array<{ n: string | number }>;
  if (Number(row?.n ?? 0) > 0) {
    throw new Error('[performance_bounties] down refused: Bounty has rows; their bonuses would lose their goal');
  }
  await knex.raw('drop index if exists "Bonus_bountyId_partnerId_unique"');
  await knex.raw('alter table "Bonus" drop constraint if exists bonus_bounty_source_check');
  await knex.raw('alter table "Bonus" drop constraint if exists bonus_bountyid_foreign');
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'revoke all privileges on "Bounty" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "Bounty"`);
  await knex.schema.dropTableIfExists('Bounty');
}
