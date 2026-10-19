import type { Knex } from 'knex';

/**
 * Bonus — a reward paid to a partner that isn't tied to an attributed sale
 * (docs/bounties.md §2).
 *
 * Until now every payable row was a Commission, and Commission.attributionId
 * was NOT NULL, so the only way to pay a partner was through an attributed
 * Event. A manual bonus, a performance bounty or a Network submission bounty
 * had nowhere to go except a synthetic conversion, which pollutes the raw
 * event log (CLAUDE.md principle 1: a reward is a derived decision, not a
 * customer event).
 *
 * Bonus is the record of the decision to pay. Each bonus gets exactly one
 * Commission (bonusId set, attributionId null), so approval, holdback,
 * payouts, reversal and the partner's earnings keep working on one table.
 *
 *   Commission  attributionId becomes nullable; new bonusId (FK Bonus).
 *               A CHECK requires exactly one of the two. A unique partial
 *               index on bonusId keeps it one commission per bonus.
 *   UsageLedger eventId becomes nullable; new bonusId. The platform fee
 *               bills a bonus on the commission-floor rule (usage-ledger.ts).
 *               Hosted sidecar, not exported.
 *
 * Bonus.source is a plain string ('manual' | 'performance_bounty' |
 * 'network'), validated in apps/api/src/bonuses.ts, so a new source needs
 * no migration. bountyId gets its foreign key with the Bounty table.
 * externalRef is the caller's idempotency key: unique per (tenant, source)
 * where set. The Network sends its submission id; the bounty sweep sends
 * bounty:<bountyId>:<partnerId>.
 *
 * Core table, exported (export schemaVersion 6). Immutable once written:
 * reversing a bonus reverses its commission.
 *
 * RLS + app-role grant follow the canonical tenant_isolation pattern, with
 * the plain predicate 20261017100000_rls_plain_tenant_policies settled on.
 */
export async function up(knex: Knex): Promise<void> {
  // Altering Commission takes an ACCESS EXCLUSIVE lock until commit. Behind
  // a long-running query that request would queue every later query on the
  // table; failing the deploy and retrying is the better outcome.
  await knex.raw(`set local lock_timeout = '5s'`);

  await knex.schema.createTable('Bonus', (t) => {
    t.string('id').primary();
    t.string('tenantId').notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    // No cascade: a paid reward is ledger history. Partners and programs
    // are revoked or archived, never deleted, by the app.
    t.string('partnerId').notNullable().references('id').inTable('Partner');
    t.string('programId').references('id').inTable('Program');
    t.decimal('amount', 14, 2).notNullable();
    t.string('currency', 3).notNullable();
    t.string('source', 32).notNullable();
    t.string('bountyId');
    t.string('externalRef', 200);
    t.text('note');
    t.string('createdBy', 64);
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['tenantId', 'partnerId', 'createdAt']);
  });
  await knex.raw(`
    alter table "Bonus"
      add constraint bonus_amount_positive check (amount > 0),
      add constraint bonus_currency_upper check (currency = upper(currency) and length(currency) = 3)
  `);
  await knex.raw(`
    create unique index "Bonus_tenantId_source_externalRef_unique"
      on "Bonus" ("tenantId", source, "externalRef")
      where "externalRef" is not null
  `);
  await knex.raw(`
    create index "Bonus_bountyId_index" on "Bonus" ("bountyId") where "bountyId" is not null
  `);

  await knex.raw(`alter table "Bonus" enable row level security`);
  await knex.raw(`alter table "Bonus" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "Bonus"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert, update, delete on "Bonus" to openpartner_app';
      end if;
    end
    $$;
  `);

  // Commission: one of attributionId / bonusId. Dropping NOT NULL and adding
  // a nullable column are catalogue-only; the CHECK scans the table once.
  await knex.raw(`alter table "Commission" alter column "attributionId" drop not null`);
  await knex.schema.alterTable('Commission', (t) => {
    t.string('bonusId').references('id').inTable('Bonus');
  });
  await knex.raw(`
    alter table "Commission"
      add constraint commission_source_exactly_one
        check (("attributionId" is null) <> ("bonusId" is null))
  `);
  await knex.raw(`
    create unique index "Commission_bonusId_unique" on "Commission" ("bonusId") where "bonusId" is not null
  `);

  // UsageLedger: a row bills either a conversion or a bonus.
  await knex.raw(`alter table "UsageLedger" alter column "eventId" drop not null`);
  await knex.schema.alterTable('UsageLedger', (t) => {
    t.string('bonusId');
  });
  await knex.raw(`
    alter table "UsageLedger"
      add constraint usage_ledger_source_exactly_one
        check (("eventId" is null) <> ("bonusId" is null))
  `);
  // Same last line as the eventId unique: one row per bonus per report.
  await knex.raw(`
    create unique index "UsageLedger_tenantId_reportKey_bonusId_currency_unique"
      on "UsageLedger" ("tenantId", "reportKey", "bonusId", currency)
      where "bonusId" is not null
  `);
  await knex.raw(`
    create index "UsageLedger_tenantId_bonusId_index" on "UsageLedger" ("tenantId", "bonusId") where "bonusId" is not null
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Bonus rows can't be represented once these columns go: refuse rather
  // than drop money.
  const [row] = (await knex('Bonus').count({ n: '*' })) as Array<{ n: string | number }>;
  if (Number(row?.n ?? 0) > 0) {
    throw new Error('[bonuses] down refused: Bonus has rows; their commissions would lose their source');
  }
  await knex.raw('drop index if exists "UsageLedger_tenantId_bonusId_index"');
  await knex.raw('drop index if exists "UsageLedger_tenantId_reportKey_bonusId_currency_unique"');
  await knex.raw('alter table "UsageLedger" drop constraint if exists usage_ledger_source_exactly_one');
  await knex.schema.alterTable('UsageLedger', (t) => {
    t.dropColumn('bonusId');
  });
  await knex.raw(`alter table "UsageLedger" alter column "eventId" set not null`);

  await knex.raw('drop index if exists "Commission_bonusId_unique"');
  await knex.raw('alter table "Commission" drop constraint if exists commission_source_exactly_one');
  await knex.schema.alterTable('Commission', (t) => {
    t.dropColumn('bonusId');
  });
  await knex.raw(`alter table "Commission" alter column "attributionId" set not null`);

  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'revoke all privileges on "Bonus" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.raw(`drop policy if exists tenant_isolation on "Bonus"`);
  await knex.schema.dropTableIfExists('Bonus');
}
