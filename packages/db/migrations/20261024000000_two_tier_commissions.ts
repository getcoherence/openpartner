import type { Knex } from 'knex';

/**
 * Two-tier (recruiter) commissions (docs/two-tier-commissions.md).
 *
 * A partner who recruits another partner earns a share of what the recruit
 * earns, in programs that turn it on. Two levels only: the recruiter never
 * earns on partners their recruits bring in.
 *
 *   Partner     recruitedByPartnerId + recruitedAt: who recruited this
 *               partner and when that started. Set from the recruiter's
 *               join-page link, or by an admin. recruitCode: the partner's
 *               own code for that link, minted the first time they ask.
 *   Program     recruiterCommissionPercent: the recruiter's share of a
 *               recruit's commission, as a percent (10 = 10%). Null = off,
 *               the default. recruiterCommissionMonths: how long after
 *               recruitedAt the recruiter keeps earning. Null = for as long
 *               as the recruit earns.
 *   Commission  sourceCommissionId: set on a recruiter commission, naming
 *               the recruit's commission it is a share of. It sits on the
 *               same attribution as that commission, so refunds, fraud
 *               review, the platform fee and per-program reporting treat it
 *               as one more commission on the conversion.
 *
 * The two self-references are DEFERRABLE INITIALLY DEFERRED. The SQL dump
 * inserts a table in chunks of 500 rows inside one transaction, and a
 * recruit can land in an earlier chunk than their recruiter (a recruiter
 * commission's id can even sort before its source's, ULIDs from the same
 * millisecond being random). Checked at commit, the order doesn't matter.
 * Neither has an ON DELETE action: SET NULL on the recruiter would leave
 * recruitedAt behind and fail its CHECK, mid-way through a tenant purge
 * that deletes a recruiter and recruit in one statement. Deleting both in
 * one transaction passes at commit; deleting a recruiter whose recruit
 * stays fails, as deleting any partner with history does.
 *
 * Core columns, exported at export schemaVersion 11.
 */
export async function up(knex: Knex): Promise<void> {
  // Altering Commission and Partner takes an ACCESS EXCLUSIVE lock until
  // commit. Behind a long-running query that request would queue every later
  // query on the tables; failing the deploy and retrying is the better outcome.
  await knex.raw(`set local lock_timeout = '5s'`);

  await knex.schema.alterTable('Partner', (t) => {
    t.string('recruitedByPartnerId');
    t.timestamp('recruitedAt', { useTz: true });
    t.string('recruitCode', 32);
  });
  await knex.raw(`
    alter table "Partner"
      add constraint "Partner_recruitedByPartnerId_foreign"
        foreign key ("recruitedByPartnerId") references "Partner" (id)
        deferrable initially deferred,
      add constraint partner_not_own_recruiter check ("recruitedByPartnerId" <> id),
      add constraint partner_recruited_at_with_recruiter
        check (("recruitedByPartnerId" is null) = ("recruitedAt" is null))
  `);
  await knex.raw(`
    create index "Partner_tenantId_recruitedByPartnerId_index"
      on "Partner" ("tenantId", "recruitedByPartnerId") where "recruitedByPartnerId" is not null
  `);
  await knex.raw(`
    create unique index "Partner_tenantId_recruitCode_unique"
      on "Partner" ("tenantId", "recruitCode") where "recruitCode" is not null
  `);

  await knex.schema.alterTable('Program', (t) => {
    t.decimal('recruiterCommissionPercent', 5, 2);
    t.integer('recruiterCommissionMonths');
  });
  await knex.raw(`
    alter table "Program"
      add constraint program_recruiter_percent_range
        check ("recruiterCommissionPercent" is null or ("recruiterCommissionPercent" > 0 and "recruiterCommissionPercent" <= 50)),
      add constraint program_recruiter_months_range
        check ("recruiterCommissionMonths" is null or ("recruiterCommissionMonths" between 1 and 120))
  `);

  await knex.schema.alterTable('Commission', (t) => {
    t.string('sourceCommissionId');
  });
  await knex.raw(`
    alter table "Commission"
      add constraint "Commission_sourceCommissionId_foreign"
        foreign key ("sourceCommissionId") references "Commission" (id)
        deferrable initially deferred,
      add constraint commission_recruiter_on_attribution
        check ("sourceCommissionId" is null or ("attributionId" is not null and "sourceCommissionId" <> id))
  `);
  await knex.raw(`
    create index "Commission_sourceCommissionId_index"
      on "Commission" ("sourceCommissionId") where "sourceCommissionId" is not null
  `);
}

export async function down(knex: Knex): Promise<void> {
  // A recruiter commission can't be told from the recruit's own once the
  // column goes: refuse rather than blur the ledger.
  const [row] = (await knex('Commission').whereNotNull('sourceCommissionId').count({ n: '*' })) as Array<{
    n: string | number;
  }>;
  if (Number(row?.n ?? 0) > 0) {
    throw new Error('[two-tier] down refused: recruiter commissions exist; they would lose their source');
  }
  await knex.raw('drop index if exists "Commission_sourceCommissionId_index"');
  await knex.raw('alter table "Commission" drop constraint if exists commission_recruiter_on_attribution');
  await knex.raw('alter table "Commission" drop constraint if exists "Commission_sourceCommissionId_foreign"');
  await knex.schema.alterTable('Commission', (t) => {
    t.dropColumn('sourceCommissionId');
  });

  await knex.raw('alter table "Program" drop constraint if exists program_recruiter_months_range');
  await knex.raw('alter table "Program" drop constraint if exists program_recruiter_percent_range');
  await knex.schema.alterTable('Program', (t) => {
    t.dropColumn('recruiterCommissionMonths');
    t.dropColumn('recruiterCommissionPercent');
  });

  await knex.raw('drop index if exists "Partner_tenantId_recruitCode_unique"');
  await knex.raw('drop index if exists "Partner_tenantId_recruitedByPartnerId_index"');
  await knex.raw('alter table "Partner" drop constraint if exists partner_recruited_at_with_recruiter');
  await knex.raw('alter table "Partner" drop constraint if exists partner_not_own_recruiter');
  await knex.raw('alter table "Partner" drop constraint if exists "Partner_recruitedByPartnerId_foreign"');
  await knex.schema.alterTable('Partner', (t) => {
    t.dropColumn('recruitCode');
    t.dropColumn('recruitedAt');
    t.dropColumn('recruitedByPartnerId');
  });
}
