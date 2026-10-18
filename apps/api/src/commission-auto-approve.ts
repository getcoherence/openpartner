/**
 * Auto-approve accrued commissions whose holdback has elapsed.
 *
 * Scoped per-tenant, explicitly: the UPDATE filters on the tenantId
 * it's handed, not just on RLS. The scheduler announces the returned
 * rows to that tenant's webhooks, so with RLS bypassed (a multi-tenant
 * install without DATABASE_URL_APP) an RLS-only scope would approve and
 * announce every tenant's matured commissions on each tenant's pass.
 *
 * Only acts on commissions whose Campaign has
 * holdbackDays > 0 — campaigns with null/0 holdback continue to
 * require manual approval (no behavior change for legacy / opted-out
 * brands). The job is safe to re-run; the WHERE clause is the source
 * of truth and a no-op once everything's been swept.
 *
 * A bonus's commission (bonuses.ts) has no Attribution: its program, and
 * so its holdback, comes through Bonus.programId. A bonus with no program
 * takes the partner-wide holdback, or waits for an admin like any
 * commission with none.
 *
 * Returns the approved rows so the caller can fire commission.approved
 * once the sweep's transaction has committed — this runs inside the
 * scheduler's per-tenant transaction, so dispatching from here would
 * announce approvals a rollback could still undo.
 */

import type { Knex } from 'knex';
import { TABLES, type CommissionRow } from '@openpartner/db';
import { EFFECTIVE_HOLDBACK_SQL } from './partner-commission.js';

export interface AutoApproveResult {
  approvedCount: number;
  approved: CommissionRow[];
}

export async function autoApproveMatureCommissions(
  db: Knex,
  tenantId: string,
): Promise<AutoApproveResult> {
  // Find every accrued commission whose effective holdback has
  // elapsed. Effective holdback (EFFECTIVE_HOLDBACK_SQL): the partner's
  // snapshot scoped to this commission's program (pcp) if one exists —
  // falling back to the program's own value when it leaves holdback
  // unset — else their partner-wide snapshot (pcw, programId null), else
  // the program's value. Same expression as routes/commissions.ts
  // listQueryBase, which the review queue and manual approve read through.
  //
  // Single statement so two scheduler ticks racing don't double-
  // process the same row: the second UPDATE re-checks `status =
  // 'accrued'` on the row the first committed, and skips it. Each join
  // matches at most one row (partial unique indexes on PartnerCommission;
  // a commission has one attribution or one bonus), so `due` can't fan out.
  //
  // The candidates are picked in a CTE rather than the UPDATE's FROM list
  // because a bonus's commission has no Attribution to inner-join, and
  // Postgres forbids referencing the UPDATE target inside FROM-clause join
  // conditions, which the left joins below need.
  const result = (await db.raw(
    `
    with due as (
      select c.id
        from "${TABLES.Commission}" c
        left join "${TABLES.Attribution}" a on a.id = c."attributionId" and a."partnerId" = c."partnerId"
        left join "${TABLES.Bonus}" b on b.id = c."bonusId"
        -- Every attribution has its program; a bonus may have none, and
        -- then (no cp, so no pcp) the partner-wide holdback applies.
        left join "${TABLES.Program}" cp on cp.id = coalesce(a."programId", b."programId")
        left join "${TABLES.PartnerCommission}" pcp
               on pcp."partnerId" = c."partnerId" and pcp."programId" = cp.id
        left join "${TABLES.PartnerCommission}" pcw
               on pcw."partnerId" = c."partnerId" and pcw."programId" is null
       where c."tenantId" = ?
         and c.status = 'accrued'
         and (a.id is not null or b.id is not null)
         and ${EFFECTIVE_HOLDBACK_SQL} is not null
         and ${EFFECTIVE_HOLDBACK_SQL} > 0
         and c."accruedAt" + (${EFFECTIVE_HOLDBACK_SQL} * interval '1 day') <= now()
    )
    update "${TABLES.Commission}" c
       set status = 'approved'
      from due
     where c.id = due.id
       and c."tenantId" = ?
       and c.status = 'accrued'
    returning c.*
    `,
    [tenantId, tenantId],
  )) as { rows: CommissionRow[] };

  return { approvedCount: result.rows.length, approved: result.rows };
}
