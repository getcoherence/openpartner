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
 * Returns the approved rows so the caller can fire commission.approved
 * once the sweep's transaction has committed — this runs inside the
 * scheduler's per-tenant transaction, so dispatching from here would
 * announce approvals a rollback could still undo.
 */

import type { Knex } from 'knex';
import { TABLES, type CommissionRow } from '@openpartner/db';

export interface AutoApproveResult {
  approvedCount: number;
  approved: CommissionRow[];
}

export async function autoApproveMatureCommissions(
  db: Knex,
  tenantId: string,
): Promise<AutoApproveResult> {
  // Find every accrued commission whose effective holdback has
  // elapsed. Effective holdback = the first non-null of: the partner's
  // snapshot scoped to this commission's program (pcp), the partner's
  // partner-wide snapshot (pcw, programId null), then the program's own
  // value. A snapshot's null holdbackDays means "not set", so it defers
  // to the next tier rather than meaning zero. Same order as
  // routes/commissions.ts listQueryBase, which the review queue and
  // manual approve read through.
  //
  // Single statement so two scheduler ticks racing don't double-
  // process the same row. Each join matches at most one row (partial
  // unique indexes on PartnerCommission), so the FROM list can't fan out.
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
      left join "${TABLES.PartnerCommission}" pcp
             on pcp."partnerId" = a."partnerId" and pcp."programId" = a."programId"
      left join "${TABLES.PartnerCommission}" pcw
             on pcw."partnerId" = a."partnerId" and pcw."programId" is null
     where c."tenantId" = ?
       and c.status = 'accrued'
       and c."attributionId" = a.id
       and c."partnerId" = a."partnerId"
       and coalesce(pcp."holdbackDays", pcw."holdbackDays", cp."holdbackDays") is not null
       and coalesce(pcp."holdbackDays", pcw."holdbackDays", cp."holdbackDays") > 0
       and c."accruedAt" + (coalesce(pcp."holdbackDays", pcw."holdbackDays", cp."holdbackDays") * interval '1 day') <= now()
    returning c.*
    `,
    [tenantId],
  )) as { rows: CommissionRow[] };

  return { approvedCount: result.rows.length, approved: result.rows };
}
