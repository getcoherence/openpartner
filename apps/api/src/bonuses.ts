/**
 * Bonuses: rewards paid to a partner that aren't tied to an attributed sale
 * (docs/bounties.md §2–§5).
 *
 * A Bonus is the record of the decision to pay; its one Commission (bonusId
 * set, attributionId null) is what approval, holdback, payouts, reversal and
 * the partner's earnings run on. Nothing here touches the raw event log, so
 * a bonus never shows up as a sale, a lead or a tier metric.
 *
 * Every way in calls awardBonus:
 *   - POST /bonuses from an admin ('manual') or the brand's Network
 *     federation key ('network'), routes/bonuses.ts;
 *   - the performance-bounty sweep ('performance_bounty').
 *
 * Status at award:
 *   manual              approved: paid in the next payout run. `hold` leaves
 *                       it accrued for the program's holdback instead.
 *   network             approved: the Network reviewed the submission.
 *   performance_bounty  accrued: held for the program's holdback, and the
 *                       goal is re-checked when it matures.
 * The auto-approve job finds a held bonus's holdback through Bonus.programId
 * (commission-auto-approve.ts). With no holdback set anywhere it waits for
 * an admin, like any commission.
 *
 * Idempotent on `externalRef`, unique per (tenant, source): a replay returns
 * the original bonus and commission. The same ref with a different partner,
 * program, amount or currency is a conflict, not a second award. The bonus
 * and its commission are written together on the caller's handle, so a
 * request transaction (or the sweep's per-tenant one) commits both or
 * neither, and the bonus.awarded webhook goes out only after COMMIT.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type BonusRow,
  type BonusSource,
  type CommissionRow,
  type CommissionStatus,
  type PartnerRow,
} from '@openpartner/db';
import type { WebhookPayload } from './openapi/webhook-events.js';
import { onCommit } from './on-commit.js';
import { dispatchEvent } from './webhook-dispatcher.js';

export { BONUS_SOURCES } from './openapi/enums.js';

/** A note is shown to the partner; keep it a sentence or two. */
export const MAX_BONUS_NOTE_LENGTH = 1000;
export const MAX_BONUS_EXTERNAL_REF_LENGTH = 200;

export interface AwardBonusInput {
  partnerId: string;
  programId?: string | null;
  /** Major units, > 0, at most two decimals. */
  amount: number;
  /** Upper-case ISO 4217. */
  currency: string;
  source: BonusSource;
  bountyId?: string | null;
  externalRef?: string | null;
  note?: string | null;
  createdBy?: string | null;
  /** Leave the commission accrued for the holdback. Performance-bounty
   *  bonuses are always held. */
  hold?: boolean;
}

export type AwardBonusError = 'partner_not_found' | 'partner_revoked' | 'program_not_found' | 'external_ref_conflict';

export type AwardBonusResult =
  | { ok: true; replayed: boolean; bonus: BonusRow; commission: CommissionRow }
  | { ok: false; status: 404 | 409; error: AwardBonusError; bonus?: BonusRow };

export async function awardBonus(db: Knex, tenantId: string, input: AwardBonusInput): Promise<AwardBonusResult> {
  const programId = input.programId ?? null;
  const externalRef = input.externalRef ?? null;
  const amount = input.amount.toFixed(2);

  if (externalRef) {
    const existing = await findByExternalRef(db, tenantId, input.source, externalRef);
    if (existing) return replayOf(db, tenantId, existing, { ...input, programId, amount });
  }

  // Tenant named explicitly as well as by RLS: a pool that bypasses RLS
  // must not pay a partner from another tenant.
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: input.partnerId, tenantId }).first('id', 'revokedAt');
  if (!partner) return { ok: false, status: 404, error: 'partner_not_found' };
  // Revoked partners earn nothing new; reinstate them first.
  if (partner.revokedAt) return { ok: false, status: 409, error: 'partner_revoked' };
  if (programId) {
    const program = await db(TABLES.Program).where({ id: programId, tenantId }).first('id');
    if (!program) return { ok: false, status: 404, error: 'program_not_found' };
  }

  const now = new Date();
  const insert = db(TABLES.Bonus).insert({
    id: ulid(),
    tenantId,
    partnerId: input.partnerId,
    programId,
    amount,
    currency: input.currency,
    source: input.source,
    bountyId: input.bountyId ?? null,
    externalRef,
    note: input.note ?? null,
    createdBy: input.createdBy ?? null,
    createdAt: now,
  });
  // Two concurrent awards with one ref (overlapping sweeps, a client retry):
  // the loser's insert waits for the winner, then does nothing, and reads the
  // winner's row. Postgres only accepts a partial unique index as the
  // arbiter when the statement repeats its predicate.
  const [bonus] = (await (externalRef
    ? insert.onConflict(db.raw('("tenantId", source, "externalRef") where "externalRef" is not null')).ignore()
    : insert
  ).returning('*')) as BonusRow[];
  if (!bonus) {
    const winner = await findByExternalRef(db, tenantId, input.source, externalRef!);
    if (!winner) throw new Error(`[bonuses] externalRef ${externalRef} conflicted but no bonus holds it`);
    return replayOf(db, tenantId, winner, { ...input, programId, amount });
  }

  const status: CommissionStatus = input.source === 'performance_bounty' || input.hold ? 'accrued' : 'approved';
  const [commission] = (await db(TABLES.Commission)
    .insert({
      id: ulid(),
      tenantId,
      attributionId: null,
      bonusId: bonus.id,
      partnerId: bonus.partnerId,
      amount: bonus.amount,
      currency: bonus.currency,
      status,
      accruedAt: now,
      // Fee and reporting code reads rateType: a bonus is a fixed amount,
      // not a share of a sale.
      metadata: { rateType: 'fixed' },
    })
    .returning('*')) as CommissionRow[];

  onCommit(db, 'bonus.awarded webhook', () => announceAward(tenantId, bonus, commission!));
  return { ok: true, replayed: false, bonus, commission: commission! };
}

async function findByExternalRef(db: Knex, tenantId: string, source: string, externalRef: string): Promise<BonusRow | undefined> {
  return db<BonusRow>(TABLES.Bonus).where({ tenantId, source, externalRef }).first();
}

async function replayOf(
  db: Knex,
  tenantId: string,
  existing: BonusRow,
  input: { partnerId: string; programId: string | null; amount: string; currency: string },
): Promise<AwardBonusResult> {
  const same =
    existing.partnerId === input.partnerId &&
    (existing.programId ?? null) === input.programId &&
    Number(existing.amount).toFixed(2) === input.amount &&
    existing.currency === input.currency;
  if (!same) return { ok: false, status: 409, error: 'external_ref_conflict', bonus: existing };
  const commission = await db<CommissionRow>(TABLES.Commission).where({ tenantId, bonusId: existing.id }).first();
  if (!commission) throw new Error(`[bonuses] bonus ${existing.id} has no commission`);
  return { ok: true, replayed: true, bonus: existing, commission };
}

/** The fields every bonus.* webhook carries. */
export function bonusPayload(
  bonus: Pick<BonusRow, 'id' | 'partnerId' | 'programId' | 'bountyId' | 'source' | 'amount' | 'currency' | 'note'>,
  commissionId: string,
) {
  return {
    bonusId: bonus.id,
    commissionId,
    partnerId: bonus.partnerId,
    programId: bonus.programId,
    bountyId: bonus.bountyId,
    source: bonus.source as BonusSource,
    amount: bonus.amount,
    currency: bonus.currency,
    note: bonus.note,
  };
}

/** bonus.awarded, and bonus.approved too when it was approved on award, so
 *  a subscriber to approvals sees every bonus that will be paid. */
function announceAward(tenantId: string, bonus: BonusRow, commission: CommissionRow): void {
  const base = bonusPayload(bonus, commission.id);
  dispatchEvent(tenantId, 'bonus.awarded', {
    ...base,
    status: commission.status === 'approved' ? 'approved' : 'accrued',
  } satisfies WebhookPayload<'bonus.awarded'>);
  if (commission.status === 'approved') {
    dispatchEvent(tenantId, 'bonus.approved', base satisfies WebhookPayload<'bonus.approved'>);
  }
}
