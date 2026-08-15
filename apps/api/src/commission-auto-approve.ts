/**
 * Auto-approve accrued commissions whose holdback has elapsed.
 *
 * Scoped per-tenant. Only acts on commissions whose Campaign has
 * holdbackDays > 0 — campaigns with null/0 holdback continue to
 * require manual approval (no behavior change for legacy / opted-out
 * brands). The job is safe to re-run; the WHERE clause is the source
 * of truth and a no-op once everything's been swept.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';

export interface AutoApproveResult {
  approvedCount: number;
}

export async function autoApproveMatureCommissions(
  db: Knex,
): Promise<AutoApproveResult> {
  // Find every accrued commission whose effective holdback has
  // elapsed. Effective holdback = the partner's snapshotted value
  // (PartnerCommission.holdbackDays, set at PartnershipRequest
  // approval time via federation), with fallback to the campaign's
  // value for legacy / non-Network partners. COALESCE picks the
  // first non-null in order — partner snapshot, then campaign.
  //
  // Single statement so two scheduler ticks racing don't double-
  // process the same row.
  //
  // PartnerCommission is keyed on the partner via the Attribution row
  // (a."partnerId"), NOT the UPDATE target c."partnerId": Postgres forbids
  // referencing an UPDATE's target table inside its FROM-clause join
  // conditions ("invalid reference to FROM-clause entry for table c").
  // c."attributionId" = a.id already pairs them, and a commission's
  // partnerId equals its attribution's partnerId by construction, so the
  // two are equivalent — but only the a. form is legal here.
  const result = (await db.raw(
    `
    update "${TABLES.Commission}" c
       set status = 'approved'
      from "${TABLES.Attribution}" a
      join "${TABLES.Program}" cp on a."programId" = cp.id
      left join "${TABLES.PartnerCommission}" pc on pc."partnerId" = a."partnerId"
     where c.status = 'accrued'
       and c."attributionId" = a.id
       and c."partnerId" = a."partnerId"
       and coalesce(pc."holdbackDays", cp."holdbackDays") is not null
       and coalesce(pc."holdbackDays", cp."holdbackDays") > 0
       and c."accruedAt" + (coalesce(pc."holdbackDays", cp."holdbackDays") * interval '1 day') <= now()
    returning c.id
    `,
  )) as { rows: Array<{ id: string }> };

  return { approvedCount: result.rows.length };
}
