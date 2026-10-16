/**
 * PartnerCommission reads and writes shared by the partner routes and the
 * snapshot backfill.
 *
 * A row is scoped by `programId`: null = the partner-wide default, set =
 * one program. Readers that price a commission resolve program-specific →
 * partner-wide → Program rule (attribution.ts resolveCommissionRule, the
 * holdback joins in commission-auto-approve.ts and routes/commissions.ts).
 * The helpers here address ONE scope exactly — they never fall back.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type CommissionSubRule, type PartnerCommissionRow } from '@openpartner/db';

/** What the snapshot endpoints return. */
export const PARTNER_COMMISSION_COLUMNS = [
  'id',
  'partnerId',
  'programId',
  'commissionType',
  'commissionValue',
  'recurring',
  'commissionRules',
  'holdbackDays',
  'source',
  'snapshottedAt',
] as const;

export function newPartnerCommissionId(): string {
  return `pcm_${ulid()}`;
}

/** The row for exactly this scope (null = partner-wide), or undefined. */
export async function findPartnerCommission(
  db: Knex,
  partnerId: string,
  programId: string | null,
): Promise<Omit<PartnerCommissionRow, 'tenantId'> | undefined> {
  const q = db<PartnerCommissionRow>(TABLES.PartnerCommission).where({ partnerId });
  if (programId === null) q.whereNull('programId');
  else q.andWhere({ programId });
  return q.first(...PARTNER_COMMISSION_COLUMNS);
}

/**
 * ON CONFLICT target for one scope. Each scope's uniqueness is a PARTIAL
 * unique index, and Postgres only accepts a partial index as the arbiter
 * when the statement repeats its predicate — a bare column list fails with
 * 42P10.
 */
export function partnerCommissionConflictTarget(db: Knex, programScoped: boolean): Knex.Raw {
  return programScoped
    ? db.raw('("tenantId", "partnerId", "programId") where "programId" is not null')
    : db.raw('("tenantId", "partnerId") where "programId" is null');
}

export type PartnerCommissionWrite = {
  tenantId: string;
  partnerId: string;
  programId: string | null;
} & Record<string, unknown>;

/**
 * Insert or replace the row for `values`' scope. Only the columns present
 * in `values` are overwritten on conflict, and the existing row keeps its
 * id, so a re-PUT doesn't churn the key that exports and re-imports line
 * up on.
 */
export async function upsertPartnerCommission(db: Knex, values: PartnerCommissionWrite): Promise<void> {
  const identity = new Set(['id', 'tenantId', 'partnerId', 'programId']);
  await db(TABLES.PartnerCommission)
    .insert({ id: newPartnerCommissionId(), ...values })
    .onConflict(partnerCommissionConflictTarget(db, values.programId !== null))
    .merge(Object.keys(values).filter((k) => !identity.has(k)));
}

/**
 * The legacy NOT NULL single-rule columns for a rule array: the first
 * every-trigger rule, else the first rule. A best-effort summary only —
 * the engine reads `commissionRules` whenever it's set.
 */
export function legacyRuleColumns(rules: readonly CommissionSubRule[]): {
  commissionType: CommissionSubRule['type'];
  commissionValue: string;
  recurring: boolean;
} {
  const legacy = rules.find((r) => r.trigger === 'every') ?? rules[0]!;
  return {
    commissionType: legacy.type,
    commissionValue: legacy.value.toFixed(4),
    recurring: legacy.recurring ?? false,
  };
}
